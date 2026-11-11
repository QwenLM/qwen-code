/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingToolExecutor } from '../tool-executor/index.js';
import { testModelResolution } from '../test-utils/model-resolution.js';

import { systemPromptFromText } from '../prompts/system-prompt.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  AutoMemoryExtractionService,
  type AutoMemoryTurnContext,
} from './autoMemoryExtractionService.js';
import { getSessionStatePath } from './session-state-paths.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { ensureAutoMemoryDir } from '../memory/structured-memory-store.js';
import { buildMemoryPromptBody } from '../memory/auto-memory-prompt.js';
import type {
  ContentBlockParam,
  ContentBlock,
  Message,
} from '../protocol/transcript/message.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import { EDIT_TOOL_NAME, WRITE_FILE_TOOL_NAME } from '../tools/tool-names.js';
import type { AutoMemoryGenerationSelection } from './auto-memory-generation/strategy-selection.js';
import type { IndependentModelIncrementalMemoryResultCallback } from './auto-memory-generation/independent-model-incremental-agent.js';

const autoMemoryGateMocks = vi.hoisted(() => ({
  extractionEveryNTurns: vi.fn(() => 1),
  turnCompleteEnabled: vi.fn(() => true),
}));

const generationStrategyMocks = vi.hoisted(() => ({
  resolve: vi.fn<() => AutoMemoryGenerationSelection>(() => ({
    kind: 'existing',
  })),
  independentAgentConstructor: vi.fn(),
  independentAgentSchedule: vi.fn(),
  independentAgentDrain: vi.fn(async () => undefined),
}));

vi.mock('../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

vi.mock('../config-service/features/autoMemoryPolicy.js', () => ({
  getAutoMemoryExtractionEveryNTurns: autoMemoryGateMocks.extractionEveryNTurns,
  isAutoMemoryTurnCompleteGenerationEnabled:
    autoMemoryGateMocks.turnCompleteEnabled,
}));

vi.mock('./auto-memory-generation/strategy-selection.js', () => ({
  AutoMemoryGenerationStrategySession: class {
    resolve(): ReturnType<typeof generationStrategyMocks.resolve> {
      return generationStrategyMocks.resolve();
    }
  },
}));

vi.mock(
  './auto-memory-generation/independent-model-incremental-agent.js',
  () => ({
    IndependentModelIncrementalMemoryAgent: class {
      constructor(options: unknown) {
        generationStrategyMocks.independentAgentConstructor(options);
      }
      schedule(
        ctx: unknown,
        onResult?: IndependentModelIncrementalMemoryResultCallback,
      ): void {
        generationStrategyMocks.independentAgentSchedule(ctx, onResult);
      }
      drain(): Promise<void> {
        return generationStrategyMocks.independentAgentDrain();
      }
    },
  }),
);

vi.mock('../memory/structured-memory-store.js', () => ({
  getScopedAutoMemoryDirs: vi.fn(() => [
    { scope: 'project', dir: '/tmp/project-memory' },
  ]),
  getKnownAutoMemoryDirs: vi.fn(() => [
    { scope: 'user', dir: '/tmp/user-memory' },
    { scope: 'project', dir: '/tmp/project-memory' },
  ]),
  ensureAutoMemoryDir: vi.fn(async () => {}),
  listMemoryFileNames: vi.fn(async () => []),
  getMemoryIndexPath: vi.fn(() => '/tmp/project-memory/MEMORY.md'),
  MEMORY_INDEX_FILENAME: 'MEMORY.md',
}));

vi.mock('../memory/memory-index.js', () => ({
  loadMemoryIndex: vi.fn(async () => ''),
}));



function createConfig(): Config {
  const toolExecutor = new StreamingToolExecutor();
  return {
    getToolExecutor: () => toolExecutor,
    storage: {} as Config['storage'],
    getProjectRoot: vi.fn(() => '/workspace'),
    getSessionArtifactProjectRoot: vi.fn(() => '/artifact-project'),
    getWorkingDir: vi.fn(() => '/workspace'),
    getTargetDir: vi.fn(() => '/workspace'),
    getSessionId: vi.fn(() => 'root-session-1'),
    getSessionPersistence: vi.fn(() => true),
    isSdkMemoryRequestActive: vi.fn(() => false),
    getToolRegistry: vi.fn(() => ({
      getFunctionDeclarations: vi.fn(() => []),
      getAllTools: vi.fn(() => []),
    })),
    getModel: vi.fn(() => 'test-model'),
    getWorkspaceContext: vi.fn(() => ({
      getDirectories: vi.fn(() => ['/workspace']),
    })),
    isPlanMode: vi.fn(() => false),
  } as unknown as Config;
}

function createUserMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: text,
    },
  };
}

function createAssistantMessage(
  uuid: string,
  blocks: ContentBlock[],
  options: { promptId?: string; requestId?: string; cwd?: string } = {},
): Message {
  return {
    type: 'assistant',
    uuid,
    promptId: options.promptId,
    requestId: options.requestId,
    cwd: options.cwd,
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: uuid,

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: cloneUsage(),
      content: blocks,
    },
  };
}

function createToolResultMessage(
  uuid: string,
  toolUseId: string,
  isError = false,
  errorType?: string,
): Message {
  const content: ContentBlockParam[] = [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: isError ? 'Error: write failed' : '(WriteFile completed)',
      is_error: isError,
    },
  ];
  return {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
    ...(errorType ? { toolUseResult: { errorType } } : {}),
  };
}

describe('AutoMemoryExtractionService', () => {
  const runForkedAgentMock = vi.mocked(runForkedAgent);

  beforeEach(() => {
    vi.clearAllMocks();
    autoMemoryGateMocks.extractionEveryNTurns.mockReturnValue(1);
    autoMemoryGateMocks.turnCompleteEnabled.mockReturnValue(true);
    generationStrategyMocks.resolve.mockReturnValue({ kind: 'existing' });
    runForkedAgentMock.mockResolvedValue({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });
  });

  it('uses all model-visible messages accumulated since the last extraction', async () => {
    const service = new AutoMemoryExtractionService(createConfig());
    const firstTurn = [
      createUserMessage('u-range-1', 'Investigate the issue.'),
      createAssistantMessage('a-range-tool', [
        {
          type: 'tool_use',
          id: 'read-range',
          name: 'Read',
          input: { file_path: '/workspace/file.ts' },
        },
      ]),
      createToolResultMessage('u-range-tool-result', 'read-range'),
      createAssistantMessage('a-range-1', [
        { type: 'text', text: 'The issue is fixed.' },
      ]),
    ];

    await service.onTurnComplete({
      prompt: 'Investigate the issue.',
      response: 'The issue is fixed.',
      messages: firstTurn,
      systemPrompt: systemPromptFromText('system'),
    });

    expect(runForkedAgentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('recent ~4 messages'),
      }),
    );

    await service.onTurnComplete({
      prompt: 'Remember that result.',
      response: 'Noted.',
      messages: [
        ...firstTurn,
        createUserMessage('u-range-2', 'Remember that result.'),
        createAssistantMessage('a-range-2', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(runForkedAgentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('recent ~2 messages'),
      }),
    );
  });

  it('keeps the existing path on the current session model', async () => {
    const config = createConfig();
    const service = new AutoMemoryExtractionService(config);
    const context = {
      prompt: 'Remember this.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-model', 'Remember this.'),
        createAssistantMessage('a-model', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
    };

    await service.onTurnComplete(context);
    expect(runForkedAgentMock.mock.calls.at(-1)![0]).not.toHaveProperty(
      'model',
    );

    await service.onTurnComplete({
      ...context,
      messages: [
        ...context.messages,
        createUserMessage('u-model-2', 'Remember this too.'),
        createAssistantMessage('a-model-2', [
          { type: 'text', text: 'Noted too.' },
        ]),
      ],
    });
    expect(runForkedAgentMock.mock.calls.at(-1)![0]).not.toHaveProperty(
      'model',
    );
  });

  it('routes an eligible session to the non-blocking fixed-model A executor', async () => {
    autoMemoryGateMocks.extractionEveryNTurns.mockReturnValue(5);
    generationStrategyMocks.resolve.mockReturnValue({
      kind: 'independent_model_incremental',
      model: 'qfmodel',
    });
    const config = createConfig();
    const service = new AutoMemoryExtractionService(config);
    const context = {
      prompt: 'Remember this.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-a', 'Remember this.'),
        createAssistantMessage('a-a', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
      parentRequestId: 'request-a',
    };

    for (let turn = 0; turn < 4; turn += 1) {
      await service.onTurnComplete(context);
    }

    expect(runForkedAgentMock).not.toHaveBeenCalled();
    expect(generationStrategyMocks.resolve).not.toHaveBeenCalled();
    expect(
      generationStrategyMocks.independentAgentConstructor,
    ).not.toHaveBeenCalled();
    expect(
      generationStrategyMocks.independentAgentSchedule,
    ).not.toHaveBeenCalled();

    await service.onTurnComplete(context);

    expect(
      generationStrategyMocks.independentAgentConstructor,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        model: 'qfmodel',
      }),
    );
    const independentAgentOptions = generationStrategyMocks
      .independentAgentConstructor.mock.calls[0]?.[0] as {
      sessionStateStore: { getSessionStatePath(): string };
    };
    expect(
      independentAgentOptions.sessionStateStore.getSessionStatePath(),
    ).toBe(getSessionStatePath('/artifact-project', 'root-session-1'));
    expect(
      generationStrategyMocks.independentAgentSchedule,
    ).toHaveBeenCalledWith(context, expect.any(Function));
  });

  it('reports the A executor result with model request ids and usage', async () => {
    generationStrategyMocks.resolve.mockReturnValue({
      kind: 'independent_model_incremental',
      model: 'qfmodel',
    });
    const onGenerationResult = vi.fn();
    const onMemoriesSaved = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
      onMemoriesSaved,
    });

    await service.onTurnComplete({
      prompt: 'Remember this.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-a-result', 'Remember this.'),
        createAssistantMessage(
          'a-a-result',
          [{ type: 'text', text: 'Noted.' }],
          { promptId: 'prompt-a', requestId: 'parent-request-a' },
        ),
      ],
      systemPrompt: systemPromptFromText('system'),
      parentRequestId: 'parent-request-a',
      parentRequestSetId: 'request-set-a',
    });

    const resultCallback = generationStrategyMocks.independentAgentSchedule.mock
      .calls[0]?.[1] as IndependentModelIncrementalMemoryResultCallback;
    const usage = {
      ...cloneUsage(),
      input_tokens: 100,
      output_tokens: 20,
      credits: 1.25,
      billable: true,
    };
    await resultCallback({
      status: 'completed',
      taskId: 'memory-task-a',
      model: 'qfmodel',
      committedMessageUuid: 'a-a-result',
      incrementalMessageCount: 2,
      writtenPaths: [
        '/tmp/project-memory/MEMORY.md',
        '/tmp/project-memory/preference.md',
      ],
      modelRequestIds: ['memory-a-1'],
      modelRequests: [
        {
          requestId: 'memory-a-1',
          model: 'qfmodel',
          ttftMs: 10,
          durationMs: 100,
          usage,
          thinkingTokens: 5,
          finishReason: 'end_turn',
        },
      ],
      modelRequestResults: [
        {
          requestId: 'memory-a-1',
          model: 'qfmodel',
          success: true,
          attemptCount: 1,
          retryCount: 0,
          finishReason: 'end_turn',
        },
      ],
      totalUsage: usage,
      credits: 1.25,
      durationMs: 120,
      writeStats: {
        successfulPaths: [
          '/tmp/project-memory/MEMORY.md',
          '/tmp/project-memory/preference.md',
        ],
        attemptCount: 2,
        successCount: 2,
        failedCount: 0,
        failures: [],
      },
    });
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'saved',
        modelRequestIds: ['memory-a-1'],
        credits: 1.25,
      }),
    );
    expect(onMemoriesSaved).toHaveBeenCalledWith([
      '/tmp/project-memory/preference.md',
    ]);
  });

  it('routes the default strategy through the existing fork', async () => {
    generationStrategyMocks.resolve.mockReturnValue({
      kind: 'fork_full_context',
    });
    const service = new AutoMemoryExtractionService(createConfig());
    await service.onTurnComplete({
      prompt: 'Remember this.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-b', 'Remember this.'),
        createAssistantMessage('a-b', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
      parentRequestId: 'request-b',
    });

    expect(runForkedAgentMock).toHaveBeenCalledTimes(1);
    expect(
      generationStrategyMocks.independentAgentSchedule,
    ).not.toHaveBeenCalled();
  });

  it('does not select a strategy when Turn Complete generation is disabled', async () => {
    autoMemoryGateMocks.turnCompleteEnabled.mockReturnValue(false);
    const service = new AutoMemoryExtractionService(createConfig());
    await service.onTurnComplete({
      prompt: 'Remember this.',
      response: 'Noted.',
      messages: [],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(generationStrategyMocks.resolve).not.toHaveBeenCalled();
    expect(runForkedAgentMock).not.toHaveBeenCalled();
  });

  it('accumulates eligible messages until the remote every-N-turn gate opens', async () => {
    autoMemoryGateMocks.extractionEveryNTurns.mockReturnValue(2);
    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });
    const firstTurn = [
      createUserMessage('u-gate-1', 'First turn.'),
      createAssistantMessage('a-gate-1', [
        { type: 'text', text: 'First response.' },
      ]),
    ];

    await service.onTurnComplete({
      prompt: 'First turn.',
      response: 'First response.',
      messages: firstTurn,
      systemPrompt: systemPromptFromText('system'),
    });

    expect(runForkedAgentMock).not.toHaveBeenCalled();
    expect(onGenerationResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'skipped',
        reason: 'turn_interval_gate',
      }),
    );

    await service.onTurnComplete({
      prompt: 'Second turn.',
      response: 'Second response.',
      messages: [
        ...firstTurn,
        createUserMessage('u-gate-2', 'Second turn.'),
        createAssistantMessage('a-gate-2', [
          { type: 'text', text: 'Second response.' },
        ]),
      ],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(runForkedAgentMock).toHaveBeenCalledTimes(1);
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('recent ~4 messages'),
      }),
    );
  });

  it('treats an SDK-approved turn as the final cadence decision', async () => {
    autoMemoryGateMocks.extractionEveryNTurns.mockReturnValue(3);
    const service = new AutoMemoryExtractionService(createConfig());

    await service.onTurnComplete({
      prompt: 'SDK approved this turn.',
      response: 'Approved.',
      messages: [
        createUserMessage('u-sdk-approved', 'SDK approved this turn.'),
        createAssistantMessage('a-sdk-approved', [
          { type: 'text', text: 'Approved.' },
        ]),
      ],
      systemPrompt: systemPromptFromText('system'),
      skipExtractionIntervalGate: true,
    });

    expect(runForkedAgentMock).toHaveBeenCalledTimes(1);
    expect(autoMemoryGateMocks.extractionEveryNTurns).not.toHaveBeenCalled();
  });

  it('uses SDK custom roots and prompt and emits a generation result', async () => {
    const onGenerationResult = vi.fn();
    const parentSystemPrompt = systemPromptFromText(
      buildMemoryPromptBody({
        displayName: 'auto memory',
        roots: [
          { scope: 'project', dir: '/tmp/project-memory', indexContent: '' },
        ],
        includeIndexContent: false,
      }),
    );
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });
    service.configureSdkGeneration({
      prompt: 'Store only durable preferences.',
      roots: [{ id: 'sdk-main', dir: '/tmp/sdk-memory', access: 'read-write' }],
    });

    await service.onTurnComplete({
      prompt: 'My editor is Vim.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-sdk', 'My editor is Vim.'),
        createAssistantMessage('a-sdk', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: parentSystemPrompt,
    });

    expect(ensureAutoMemoryDir).toHaveBeenCalledWith('/tmp/sdk-memory');
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Store only durable preferences.'),
        systemPrompt: parentSystemPrompt,
        sessionId: 'root-session-1',
        sessionScopeId: 'root-session-1',
      }),
    );
    expect(runForkedAgentMock.mock.calls[0]?.[0].prompt).toContain(
      'You are now acting as the memory extraction subagent.',
    );
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '- sdk-main: /tmp/sdk-memory (read-write)',
        ),
      }),
    );
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'no_change',
        origin: 'turn_complete',
        writtenFiles: [],
      }),
    );
  });

  it('treats an undeclared custom MEMORY.md as content', async () => {
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          {
            type: 'tool_use',
            id: 'write-memory',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/sdk-memory/MEMORY.md' },
          },
        ]),
        createToolResultMessage('fork-result', 'write-memory'),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });
    const onGenerationResult = vi.fn();
    const onMemoriesSaved = vi.fn();
    const onMemoryRefresh = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
      onMemoriesSaved,
      onMemoryRefresh,
    });
    service.configureSdkGeneration({
      prompt: 'Write a single MEMORY.md content file.',
      roots: [{ id: 'sdk-main', dir: '/tmp/sdk-memory', access: 'read-write' }],
    });

    await service.onTurnComplete({
      prompt: 'My editor is Vim.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-sdk', 'My editor is Vim.'),
        createAssistantMessage('a-sdk', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'saved',
        reason: undefined,
        indexUpdated: false,
        contentUpdated: true,
        writtenFiles: [
          { rootId: 'sdk-main', path: '/tmp/sdk-memory/MEMORY.md' },
        ],
      }),
    );
    expect(onMemoriesSaved).toHaveBeenCalledWith(['/tmp/sdk-memory/MEMORY.md']);
    expect(onMemoryRefresh).toHaveBeenCalledOnce();
  });

  it('reports custom index and content updates separately', async () => {
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          {
            type: 'tool_use',
            id: 'write-index',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/sdk-memory/MEMORY.md' },
          },
          {
            type: 'tool_use',
            id: 'write-content',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/sdk-memory/preferences.md' },
          },
        ]),
        createToolResultMessage('fork-index-result', 'write-index'),
        createToolResultMessage('fork-content-result', 'write-content'),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });
    const onGenerationResult = vi.fn();
    const onMemoriesSaved = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
      onMemoriesSaved,
    });
    service.configureSdkGeneration({
      prompt: 'Maintain an index and topic files.',
      roots: [
        {
          id: 'sdk-main',
          dir: '/tmp/sdk-memory',
          access: 'read-write',
          indexFile: 'MEMORY.md',
        },
      ],
    });

    await service.onTurnComplete({
      prompt: 'My editor is Vim.',
      response: 'Noted.',
      messages: [
        createUserMessage('u-sdk', 'My editor is Vim.'),
        createAssistantMessage('a-sdk', [{ type: 'text', text: 'Noted.' }]),
      ],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'saved',
        reason: undefined,
        indexUpdated: true,
        contentUpdated: true,
      }),
    );
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '- sdk-main: /tmp/sdk-memory (read-write; index: MEMORY.md)',
        ),
      }),
    );
    expect(onMemoriesSaved).toHaveBeenCalledWith([
      '/tmp/sdk-memory/preferences.md',
    ]);
  });

  it('inherits every cache-critical parameter from the completed parent request', async () => {
    const config = createConfig();
    const parentSystemPrompt = systemPromptFromText(
      buildMemoryPromptBody({
        displayName: 'auto memory',
        roots: [
          { scope: 'project', dir: '/tmp/project-memory', indexContent: '' },
        ],
        includeIndexContent: false,
      }),
    );
    const parentMessages: CacheSafeQuerySnapshot['forkContextMessages'] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'cached parent request' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'cached parent response' }],
      },
    ];
    const generation = { temperature: 0.2, topP: 0.8 };
    const toolSchemas: CacheSafeQuerySnapshot['toolSchemas'] = [
      {
        name: 'parent_tool',
        description: 'Parent tool schema',
        parameters: { type: 'object' },
      },
    ];
    const parentSnapshot: CacheSafeQuerySnapshot = {
      modelResolution: testModelResolution('resolved-parent-model', {
        reasoningEffort: 'max',
        contextWindow: 256_000,
      }),
      systemPrompt: parentSystemPrompt,
      forkContextMessages: parentMessages,
      model: 'resolved-parent-model',
      toolSchemas,
      maxOutputTokens: 32_000,
      thinkingBudget: 16_384,
      reasoningEffort: 'max',
      generation,
      contextWindow: 256_000,
    };
    config.getCacheSafeQuerySnapshot = vi.fn(() => parentSnapshot);
    const customContext: Readonly<Record<string, string>> = {
      identity: 'completed-parent',
    };

    const service = new AutoMemoryExtractionService(config);
    await service.onTurnComplete({
      customContext,
      prompt: 'My editor is Vim.',
      response: 'noted',
      messages: [
        createUserMessage('u-cache', 'remember this'),
        createAssistantMessage('a-cache', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(
        'reconstructed system prompt must not win',
      ),
    });

    expect(runForkedAgentMock.mock.calls[0]?.[0].parentSelection).toBe(
      parentSnapshot.modelResolution,
    );
    expect(runForkedAgentMock.mock.calls[0]?.[0].systemPrompt).toBe(
      parentSystemPrompt,
    );
    expect(runForkedAgentMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'modelResolution',
    );
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSelection: parentSnapshot.modelResolution,
        systemPrompt: parentSystemPrompt,
        forkContextMessages: parentMessages,
        maxOutputTokens: 32_000,
        thinkingBudget: 16_384,
        reasoningEffort: 'max',
        generation,
        contextWindow: 256_000,
        customContext,
      }),
    );
    expect(runForkedAgentMock.mock.calls[0]?.[0].prompt).toContain(
      '<when_to_save>When you learn any details',
    );
    expect(
      runForkedAgentMock.mock.calls[0]?.[0].toolRegistry?.getSchema(),
    ).toEqual(toolSchemas);
    expect(runForkedAgentMock.mock.calls[0]?.[0].customContext).toBe(
      customContext,
    );
  });

  it('缺省 customContext 不继承上一轮身份', async () => {
    const service = new AutoMemoryExtractionService(createConfig());
    const firstTurn: AutoMemoryTurnContext = {
      prompt: 'First task.',
      response: 'First result.',
      messages: [
        createUserMessage('u-context-first', 'First task.'),
        createAssistantMessage('a-context-first', [
          { type: 'text', text: 'First result.' },
        ]),
      ],
      systemPrompt: systemPromptFromText('system'),
      customContext: { identity: 'first' },
    };
    await service.onTurnComplete(firstTurn);

    await service.onTurnComplete({
      prompt: 'Next task without identity.',
      response: 'Next result.',
      messages: [
        ...firstTurn.messages,
        createUserMessage('u-context-next', 'Next task without identity.'),
        createAssistantMessage('a-context-next', [
          { type: 'text', text: 'Next result.' },
        ]),
      ],
      systemPrompt: systemPromptFromText('system'),
    });

    expect(runForkedAgentMock.mock.calls[0]?.[0].customContext).toBe(
      firstTurn.customContext,
    );
    expect(runForkedAgentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ customContext: undefined }),
    );
  });

  it('在途与 latest pending 抽取保持任务内容和身份绑定', async () => {
    let releaseFork!: () => void;
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    let notifyStarted!: () => void;
    const forkStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    runForkedAgentMock.mockImplementationOnce(async () => {
      notifyStarted();
      await forkGate;
      return {
        messages: [],
        totalUsage: cloneUsage(),
        textContent: 'done',
      };
    });

    const service = new AutoMemoryExtractionService(createConfig());
    const createTurn = (
      identity: string,
      previousMessages: Message[] = [],
    ): AutoMemoryTurnContext => ({
      prompt: `Task ${identity}.`,
      response: `Result ${identity}.`,
      messages: [
        ...previousMessages,
        createUserMessage(`u-binding-${identity}`, `Task ${identity}.`),
        createAssistantMessage(`a-binding-${identity}`, [
          { type: 'text', text: `Result ${identity}.` },
        ]),
      ],
      systemPrompt: systemPromptFromText(`System ${identity}.`),
      parentRequestSetId: `request-set-${identity}`,
      customContext: { identity },
    });
    const firstTurn = createTurn('first');
    const pendingTurn = createTurn('pending', firstTurn.messages);
    const latestTurn = createTurn('latest', pendingTurn.messages);
    const extraction = service.onTurnComplete(firstTurn);
    await forkStarted;

    await service.onTurnComplete(pendingTurn);
    await service.onTurnComplete(latestTurn);
    expect(runForkedAgentMock).toHaveBeenCalledOnce();

    releaseFork();
    await extraction;
    await service.drain();

    // 单槽合并只保留 latest pending；在途任务不被后续轮次身份覆盖。
    expect(
      runForkedAgentMock.mock.calls.map(([params]) => ({
        customContext: params.customContext,
        parentRequestSetId: params.parentRequestSetId,
        systemPrompt: params.systemPrompt,
      })),
    ).toEqual(
      [firstTurn, latestTurn].map((turn) => ({
        customContext: turn.customContext,
        parentRequestSetId: turn.parentRequestSetId,
        systemPrompt: turn.systemPrompt,
      })),
    );
    for (const [index, turn] of [firstTurn, latestTurn].entries()) {
      const params = runForkedAgentMock.mock.calls[index]?.[0];
      expect(params?.customContext).toBe(turn.customContext);
      expect(params?.forkContextMessages?.slice(-2)).toEqual([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: turn.prompt }),
          ]),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: turn.response }),
          ]),
        }),
      ]);
    }
  });

  it('skips background extraction while plan mode is active', async () => {
    const onExtractionStarted = vi.fn();
    const onExtractionFinished = vi.fn();
    const config = createConfig();
    vi.mocked(config.isPlanMode).mockReturnValue(true);
    const service = new AutoMemoryExtractionService(config, {
      onExtractionStarted,
      onExtractionFinished,
    });

    await service.onTurnComplete({
      prompt: 'remember this',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'remember this'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
    });

    expect(runForkedAgentMock).not.toHaveBeenCalled();
    expect(onExtractionStarted).not.toHaveBeenCalled();
    expect(onExtractionFinished).not.toHaveBeenCalled();
  });

  it('skips fork extraction when the current turn already wrote auto-memory files', async () => {
    const onExtractionStarted = vi.fn();
    const onExtractionFinished = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onExtractionStarted,
      onExtractionFinished,
    });
    const directWriteTurn = [
      createUserMessage('u1', 'remember this'),
      createAssistantMessage('a1', [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: WRITE_FILE_TOOL_NAME,
          input: { file_path: '/tmp/project-memory/user-pref.md' },
        },
      ]),
      createToolResultMessage('r1', 'tool-1'),
    ];

    await service.onTurnComplete({
      prompt: 'remember this',
      response: 'saved',
      messages: directWriteTurn,
      systemPrompt: systemPromptFromText(''),
    });

    expect(runForkedAgentMock).not.toHaveBeenCalled();
    expect(onExtractionStarted).not.toHaveBeenCalled();
    expect(onExtractionFinished).not.toHaveBeenCalled();

    const laterTurn = [
      ...directWriteTurn,
      createUserMessage('u2', 'new memory'),
      createAssistantMessage('a2', [{ type: 'text', text: 'noted' }]),
    ];

    await service.onTurnComplete({
      prompt: 'new memory',
      response: 'noted',
      messages: laterTurn,
      systemPrompt: systemPromptFromText(''),
    });

    expect(runForkedAgentMock).toHaveBeenCalledTimes(1);
    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ skipCacheWrite: true }),
    );
    expect(onExtractionStarted).toHaveBeenCalledTimes(1);
    expect(onExtractionFinished).toHaveBeenCalledTimes(1);
  });

  it('does not change fork strategy when the main session writes inactive-scope user memory', async () => {
    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });
    const directUserWriteTurn = [
      createUserMessage('u1', 'remember this globally'),
      createAssistantMessage('a1', [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: WRITE_FILE_TOOL_NAME,
          input: { file_path: '/tmp/user-memory/user-pref.md' },
        },
      ]),
      createToolResultMessage('r1', 'tool-1'),
    ];

    await service.onTurnComplete({
      prompt: 'remember this globally',
      response: 'saved',
      messages: directUserWriteTurn,
      systemPrompt: systemPromptFromText(''),
    });

    expect(runForkedAgentMock).toHaveBeenCalledTimes(1);
  });

  it('counts only memory files the fork itself wrote, excluding the MEMORY.md index', async () => {
    // Fork writes two topic files plus a mechanical MEMORY.md index touch.
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          {
            type: 'tool_use',
            id: 't1',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/project-memory/pref-a.md' },
          },
          {
            type: 'tool_use',
            id: 't2',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/project-memory/pref-b.md' },
          },
          {
            type: 'tool_use',
            id: 't3',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/project-memory/MEMORY.md' },
          },
        ]),
        createToolResultMessage('fork-r1', 't1'),
        createToolResultMessage('fork-r2', 't2'),
        createToolResultMessage('fork-r3', 't3'),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });

    const onMemoriesSaved = vi.fn();
    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onMemoriesSaved,
      onGenerationResult,
    });

    await service.onTurnComplete({
      prompt: 'just chatting',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'just chatting'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
    });

    // MEMORY.md excluded → only the two topic files are reported.
    expect(onMemoriesSaved).toHaveBeenCalledTimes(1);
    expect(onMemoriesSaved).toHaveBeenCalledWith([
      '/tmp/project-memory/pref-a.md',
      '/tmp/project-memory/pref-b.md',
    ]);
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'saved',
        indexUpdated: true,
        contentUpdated: true,
      }),
    );
  });

  it('marks successful and failed fork memory writes in the generation result', async () => {
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          {
            type: 'tool_use',
            id: 'write-ok',
            name: WRITE_FILE_TOOL_NAME,
            input: {
              file_path: '/tmp/project-memory/pref-a.md',
              content: '新内容',
            },
          },
          {
            type: 'tool_use',
            id: 'edit-ok',
            name: EDIT_TOOL_NAME,
            input: {
              file_path: '/tmp/project-memory/pref-a.md',
              old_string: '旧',
              new_string: '更新',
            },
          },
          {
            type: 'tool_use',
            id: 'write-failed',
            name: WRITE_FILE_TOOL_NAME,
            input: {
              file_path: '/tmp/project-memory/failed.md',
              content: '不应计入',
            },
          },
        ]),
        createToolResultMessage('fork-r1', 'write-ok'),
        createToolResultMessage('fork-r2', 'edit-ok'),
        createToolResultMessage('fork-r3', 'write-failed', true),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });

    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });
    await service.onTurnComplete({
      prompt: 'remember this',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'remember this'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
    });
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        writtenFiles: [
          { rootId: 'project', path: '/tmp/project-memory/pref-a.md' },
        ],
        failedFiles: [
          {
            rootId: 'project',
            path: '/tmp/project-memory/failed.md',
            error: 'tool_result_error',
          },
        ],
      }),
    );
  });

  it('does not count concurrent foreground writes the fork did not make', async () => {
    // Fork itself writes nothing. The race that the directory-diff counter hit
    // was a concurrent foreground save inflating the count; sourcing the count
    // from the fork's own result messages makes that impossible — no banner.
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          { type: 'text', text: 'nothing worth saving' },
        ]),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });

    const onMemoriesSaved = vi.fn();
    const onExtractionStarted = vi.fn();
    const onExtractionFinished = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onMemoriesSaved,
      onExtractionStarted,
      onExtractionFinished,
    });

    await service.onTurnComplete({
      prompt: 'just chatting',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'just chatting'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
    });

    expect(onMemoriesSaved).not.toHaveBeenCalled();
    expect(onExtractionStarted).toHaveBeenCalledTimes(1);
    expect(onExtractionFinished).toHaveBeenCalledTimes(1);
  });

  it('retries extraction when the main-session memory write fails', async () => {
    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });
    const directFailedWriteTurn = [
      createUserMessage('u1', 'remember this'),
      createAssistantMessage('a1', [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: WRITE_FILE_TOOL_NAME,
          input: { file_path: '/tmp/project-memory/user-pref.md' },
        },
      ]),
      createToolResultMessage('r1', 'tool-1', true, 'FILE_WRITE_FAILURE'),
    ];

    await service.onTurnComplete({
      prompt: 'remember this',
      response: 'failed',
      messages: directFailedWriteTurn,
      systemPrompt: systemPromptFromText(''),
    });

    expect(runForkedAgentMock).toHaveBeenCalledOnce();
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        writtenFiles: [],
        failedFiles: [
          {
            rootId: 'project',
            path: '/tmp/project-memory/user-pref.md',
            error: 'FILE_WRITE_FAILURE',
          },
        ],
      }),
    );
  });

  it('reports failed fork memory writes as failed generation result', async () => {
    runForkedAgentMock.mockResolvedValue({
      messages: [
        createAssistantMessage('fork-1', [
          {
            type: 'tool_use',
            id: 't1',
            name: WRITE_FILE_TOOL_NAME,
            input: { file_path: '/tmp/project-memory/pref-a.md' },
          },
        ]),
        createToolResultMessage('fork-r1', 't1', true),
      ],
      totalUsage: cloneUsage(),
      textContent: 'done',
    });

    const onGenerationResult = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onGenerationResult,
    });

    await service.onTurnComplete({
      prompt: 'just chatting',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'just chatting'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
    });
    expect(onGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        writtenFiles: [],
        failedFiles: [
          {
            rootId: 'project',
            path: '/tmp/project-memory/pref-a.md',
            error: 'tool_result_error',
          },
        ],
      }),
    );
  });

  it('does not start extraction when fork preparation fails', async () => {
    vi.mocked(ensureAutoMemoryDir).mockRejectedValueOnce(
      new Error('mkdir failed'),
    );
    const onExtractionStarted = vi.fn();
    const onExtractionFinished = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onExtractionStarted,
      onExtractionFinished,
    });

    await service.onTurnComplete({
      prompt: 'just chatting',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'just chatting'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
      parentRequestSetId: 'request-1',
    });

    expect(runForkedAgentMock).not.toHaveBeenCalled();
    expect(onExtractionStarted).not.toHaveBeenCalled();
    expect(onExtractionFinished).not.toHaveBeenCalled();
  });

  it('reports failed extraction completion when the memory fork throws', async () => {
    runForkedAgentMock.mockImplementation(async (params) => {
      const totalUsage = {
        ...cloneUsage(),
        input_tokens: 100,
        output_tokens: 20,
      };
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        requestId: 'memory-request-failed',
        modelRequestIds: ['memory-request-completed', 'memory-request-failed'],
        modelRequests: [
          {
            requestId: 'memory-request-completed',
            model: params.model ?? params.config.getModel(),
            ttftMs: 100,
            durationMs: 300,
            usage: totalUsage,
            thinkingTokens: 5,
            finishReason: 'tool_use',
          },
        ],
        modelRequestResults: [
          {
            requestId: 'memory-request-completed',
            model: params.model ?? params.config.getModel(),
            success: true,
            attemptCount: 1,
            retryCount: 0,
            finishReason: 'tool_use',
          },
          {
            requestId: 'memory-request-failed',
            model: params.model ?? params.config.getModel(),
            success: false,
            attemptCount: 2,
            retryCount: 1,
            failureReason: 'server_error',
          },
        ],
        totalUsage,
        durationMs: 500,
        success: false,
      });
      throw new Error('fork failed');
    });
    const onExtractionStarted = vi.fn();
    const onExtractionFinished = vi.fn();
    const service = new AutoMemoryExtractionService(createConfig(), {
      onExtractionStarted,
      onExtractionFinished,
    });

    await service.onTurnComplete({
      prompt: 'just chatting',
      response: 'noted',
      messages: [
        createUserMessage('u1', 'just chatting'),
        createAssistantMessage('a1', [{ type: 'text', text: 'noted' }]),
      ],
      systemPrompt: systemPromptFromText(''),
      parentRequestSetId: 'request-1',
    });

    expect(onExtractionStarted).toHaveBeenCalledTimes(1);
    expect(onExtractionFinished).toHaveBeenCalledWith({
      status: 'failed',
      error: 'fork failed',
      parentRequestSetId: 'request-1',
    });
  });
});
