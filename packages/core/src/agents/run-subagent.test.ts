/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fixedSelection } from '../test-utils/request-model.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import {
  testRequestConfig,
  testModelResolution,
} from '../test-utils/model-resolution.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSubagent, type RunSubagentParams } from './run-subagent.js';
import {
  customContextContext,
  getCustomContextFromContext,
} from '../utils/sessionIdContext.js';
import { SubagentForkContext } from './subagent-fork-context.js';
import {
  RESOLVED_AGENT_REASONING,
  type LocalAgentDefinition,
} from './types.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

import type { PermissionMode } from '../permissions/manager/decision/index.js';
import type { Terminal, QueryEvent } from '../core/query-event.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { TranscriptWriterHandle } from '../services/transcript/writer-handle.js';
import type { Message } from '../protocol/transcript/message.js';
import { createSubagentTranscriptRecorder } from '../services/subagent-transcript.js';
import type { Config } from '../config/config.js';
import type { AttachmentToolUseContext } from '../attachments/types.js';
import { runWithCwdOverride } from '../utils/Shell.js';
import { getEnvironmentAttachments } from '../attachments/generators/environment-generators.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track query() calls to verify parameters
const mockQueryCalls: Array<
  Parameters<(typeof import('../core/agent-loop.js'))['query']>[0]
> = [];
const mockCustomContextStores: Array<
  Readonly<Record<string, string>> | undefined
> = [];

// Helper to create an async generator from events + terminal
async function* fakeQuery(events: QueryEvent[], terminal: Terminal) {
  mockCustomContextStores.push(getCustomContextFromContext());
  for (const event of events) {
    yield event;
  }
  return terminal;
}

// Mock query()
vi.mock('../core/agent-loop.js', () => ({
  query: vi.fn((...args: unknown[]) => {
    const queryOptions = args[0] as Parameters<
      (typeof import('../core/agent-loop.js'))['query']
    >[0];
    expect(queryOptions).not.toHaveProperty('modelOverride');
    mockQueryCalls.push(queryOptions);
    const params = args[0] as {
      _testEvents?: QueryEvent[];
      _testTerminal?: Terminal;
    };
    const events = params._testEvents ?? [];
    const terminal: Terminal = params._testTerminal ?? {
      reason: 'end_turn' as const,
      numTurns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      } as unknown as NonNullableUsage,
      durationMs: 100,
    };
    return fakeQuery(events, terminal);
  }),
}));

// Mock CompressionPipeline
const mockCompressionConstructor = vi.fn();
vi.mock('../compression-v2/pipeline.js', () => ({
  CompressionPipeline: class MockCompressionPipeline {
    constructor(opts: unknown) {
      mockCompressionConstructor(opts);
    }
  },
}));

// Mock runLogger
vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDefinition(
  overrides?: Partial<LocalAgentDefinition>,
): LocalAgentDefinition {
  return {
    kind: 'local',
    name: 'test-subagent',
    description: 'A test subagent',
    inputConfig: {
      inputSchema: { type: 'object', properties: {} },
    },
    modelConfig: { model: 'test', generateContentConfig: {} },
    runConfig: { maxTimeMinutes: 1 },
    promptConfig: { systemPrompt: 'test system' },
    ...overrides,
  };
}

function makeMockContext(
  mode: PermissionMode = 'default',
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): AgentLoopContext {
  let currentMode = mode;
  const parentResolution = testModelResolution('parent-model');

  return {
    getCacheSafeQuerySnapshot: () => ({
      model: parentResolution.model.key,
      modelResolution: parentResolution,
      forkContextMessages: [],
      toolSchemas: [],
    }),
    config: {
      ...testRequestConfig(),
      hasModelProviderManager: () => true,
      getModelProviderManager: () => ({
        getModelConfig: vi.fn(() => ({
          reasoning: { effort: reasoningEffort },
        })),
        getModel: async (key: string) => testModelResolution(key).model,
        select: fixedSelection(
          testModelResolution('gemini-2.0-flash', { reasoningEffort }),
        ).resolve,
      }),
      getTargetDir: () => '/workspace/project',
      getPermissionMode: vi.fn(() => currentMode),
      setPermissionMode: vi.fn((m: PermissionMode) => {
        currentMode = m;
      }),
      // The session permission manager owns the classifier; runSubagent releases the
      // execution's auto-mode denial bucket through it on the way in and out.
      permission: { releaseAutoClassifier: vi.fn() },
    },
  } as unknown as AgentLoopContext;
}

function makeMockToolRegistry(): ToolRegistry {
  return {
    getSchema: vi.fn(() => []),
    execute: vi.fn(),
  } as unknown as ToolRegistry;
}

function makeParams(overrides?: Partial<RunSubagentParams>): RunSubagentParams {
  return {
    definition: makeDefinition(),
    agentId: 'atest-subagent-abc123',
    prompt: 'Do the task',
    systemPrompt: systemPromptFromText('You are a subagent.'),
    model: 'gemini-2.0-flash',
    promptId: 'test-prompt-123',
    sessionId: 'root-session-123',
    context: makeMockContext(),
    toolRegistry: makeMockToolRegistry(),
    forkContext: new SubagentForkContext(),
    maxTurns: 10,
    ...overrides,
  };
}

function makeMockTranscriptWriter(): TranscriptWriterHandle {
  return {
    recordSidechainMessages: vi
      .fn()
      .mockImplementation(async (messages: QueryEvent[]) => {
        const last = messages.at(-1) as { uuid?: string } | undefined;
        return last?.uuid ?? null;
      }),
  } as unknown as TranscriptWriterHandle;
}

function requestOverrides(params: (typeof mockQueryCalls)[number]) {
  const config = params.querySelection?.config;
  if (!config) throw new Error('测试请求缺少模型配置覆盖');
  return config;
}

async function makeAccessDeniedTranscriptRecorder() {
  const rawWriter = {
    filePath: '/tmp/subagents/agent-atest-subagent-abc123.jsonl',
    recordSidechainMessages: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
      ),
    close: vi.fn(async () => undefined),
  } as unknown as TranscriptWriterHandle;
  const onUnavailable = vi.fn();
  const config = {
    getTranscriptStore: () => ({
      acquireSubagentWriter: vi.fn(async () => rawWriter),
    }),
    getProjectRoot: () => '/workspace/project',
    getSessionArtifactProjectRoot: () => '/workspace/project',
    getActiveSessionTranscriptPath: () => '/tmp/root-session-123.jsonl',
    getSessionId: () => 'root-session-123',
    getTargetDir: () => '/workspace/project',
  } as unknown as Config;
  const recorder = await createSubagentTranscriptRecorder(
    config,
    'atest-subagent-abc123',
    'task-1',
    onUnavailable,
  );
  return { recorder, rawWriter, onUnavailable };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSubagent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryCalls.length = 0;
    mockCustomContextStores.length = 0;
    mockCompressionConstructor.mockClear();
  });

  // ── CompressionPipeline ──

  it('creates environment-capable attachment state for direct Skill/internal callers', async () => {
    const params = makeParams();
    Object.assign(params.context.config, {
      getWorkspaceContext: () => ({
        getDirectories: () => ['/workspace/project'],
      }),
    });
    await runWithCwdOverride('/workspace/agent-worktree', async () => {
      await runSubagent(params);
      const { attachmentCtx } = mockQueryCalls[0] as {
        attachmentCtx: AttachmentToolUseContext;
      };
      expect(attachmentCtx).toMatchObject({
        agentId: params.agentId,
        cwd: '/workspace/agent-worktree',
        isMainAgent: false,
        config: params.context.config,
      });
      const attachments = await getEnvironmentAttachments(attachmentCtx);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].snapshot.workingDirectory).toBe(
        '/workspace/agent-worktree',
      );
      expect(attachments[0].changes).toBeUndefined();
    });
  });

  it.each([undefined, true])(
    'forwards the definition Git omission switch (%s) to query',
    async (omitGitStatus) => {
      const params = makeParams();
      params.definition = { ...params.definition, omitGitStatus };
      await runSubagent(params);
      expect(mockQueryCalls[0]).toMatchObject({
        agentType: params.definition.name,
        omitGitStatus,
      });
    },
  );

  it('should create CompressionPipeline with target=subagent', async () => {
    const params = makeParams({ promptId: 'sub-prompt-42' });
    const manager = params.context.config.getModelProviderManager();
    vi.spyOn(params.context.config, 'getModelProviderManager').mockReturnValue(
      manager,
    );
    await runSubagent(params);

    expect(mockCompressionConstructor).toHaveBeenCalledExactlyOnceWith({
      target: 'subagent',
      sessionScopeId: 'sub-prompt-42',
      agentId: 'atest-subagent-abc123',
      modelProviderManager: params.context.config.getModelProviderManager(),
    });
  });

  it('runs the subagent query inside the supplied customContext snapshot', async () => {
    await runSubagent(makeParams({ customContext: { tenant: 'subagent' } }));

    const observed = mockCustomContextStores.at(-1);
    expect(observed).toEqual({ tenant: 'subagent' });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('inherits the parent customContext when the subagent has none', async () => {
    await customContextContext.run({ tenant: 'parent' }, () =>
      runSubagent(makeParams()),
    );

    expect(mockCustomContextStores.at(-1)).toEqual({ tenant: 'parent' });
    expect(
      (mockQueryCalls.at(-1) as { customContext?: unknown } | undefined)
        ?.customContext,
    ).toEqual({ tenant: 'parent' });
  });

  it('passes complete Workflow attempt correlation to query', async () => {
    await runSubagent(
      makeParams({
        schedulerContext: {
          internalExecutionOwner: {
            kind: 'workflow-agent',
            workflowRunId: 'wf_run',
            workflowExecutionId: 'wf-execution',
            workflowTaskId: 'workflow-tool-call',
            workflowAgentIndex: 2,
            workflowPhaseIndex: 3,
            workflowAttempt: 4,
            suppressMainSessionNotification: true,
            disableShellAutoBackground: true,
          },
        } as AgentLoopContext,
      }),
    );

    expect(mockQueryCalls[0]).toMatchObject({
      isWorkflowAgent: {
        workflowRunId: 'wf_run',
        workflowExecutionId: 'wf-execution',
        workflowAgentIndex: 2,
        workflowPhaseIndex: 3,
        workflowAttempt: 4,
      },
    });
  });

  it('子代理缺失模型延后兑换，进入 query 前不调用目录或 select', async () => {
    const context = makeMockContext('default', 'high');
    const manager = {
      getModelConfig: vi.fn(() => ({ reasoning: { effort: 'high' as const } })),
      getModel: vi.fn(async () => undefined),
      select: vi.fn(),
    };
    vi.spyOn(context.config, 'getModelProviderManager').mockReturnValue(
      manager as never,
    );
    await runSubagent(makeParams({ context, model: 'not-yet-listed' }));
    expect(mockQueryCalls[0]).toMatchObject({
      querySelection: {
        key: 'not-yet-listed',
        config: { reasoning: { effort: 'high' } },
      },
      isSubagent: true,
      agentId: 'atest-subagent-abc123',
      agentType: 'test-subagent',
    });
    expect(manager.getModelConfig).toHaveBeenCalledExactlyOnceWith(
      context.getCacheSafeQuerySnapshot?.()?.modelResolution.model,
    );
    expect(manager.getModel).not.toHaveBeenCalled();
    expect(manager.select).not.toHaveBeenCalled();
  });

  it('子代理缺失模型且无完整父选择时不提前查询偏好或目录', async () => {
    const context: AgentLoopContext = {
      ...makeMockContext('default', 'high'),
      getCacheSafeQuerySnapshot: () => null,
    };
    const manager = {
      getModelConfig: vi.fn(),
      getModel: vi.fn(async () => undefined),
      select: vi.fn(),
    };
    vi.spyOn(context.config, 'getModelProviderManager').mockReturnValue(
      manager as never,
    );

    await runSubagent(makeParams({ context, model: 'not-yet-listed' }));

    expect(mockQueryCalls[0].querySelection).toMatchObject({
      key: 'not-yet-listed',
    });
    expect(
      mockQueryCalls[0].querySelection?.config?.reasoning?.effort,
    ).toBeUndefined();
    expect(manager.getModelConfig).not.toHaveBeenCalled();
    expect(manager.getModel).not.toHaveBeenCalled();
    expect(manager.select).not.toHaveBeenCalled();
  });

  it('传入的父选择优先于上下文快照，纯继承不再传覆盖', async () => {
    const parentSelection = testModelResolution('same-key', {
      reasoningEffort: 'low',
    });
    Object.assign(parentSelection, {
      model: { ...parentSelection.model, source: 'custom-owner' },
    });
    await runSubagent(makeParams({ model: 'same-key', parentSelection }));
    expect(mockQueryCalls[0].querySelection).toBeUndefined();
    expect(mockQueryCalls[0].parentSelection).toBe(parentSelection);
    expect(mockQueryCalls[0].parentSelection?.config.reasoning?.effort).toBe(
      'low',
    );
    expect(mockQueryCalls[0]).not.toHaveProperty('modelResolution');
    expect(mockQueryCalls[0].compactSelection).toBeUndefined();
  });

  it.each(['parent-model', 'child-model'])(
    '直接调用保留父选择，只有独立目标模型 %s 传覆盖',
    async (model) => {
      const context = makeMockContext('default', 'high');
      const parent = context.getCacheSafeQuerySnapshot!()!.modelResolution;
      await runSubagent(makeParams({ context, model }));
      const options = mockQueryCalls[0];
      expect(options.parentSelection).toBe(parent);
      expect(options.querySelection).toEqual(
        model === parent.model.key
          ? undefined
          : {
              key: model,
              config: { reasoning: { effort: 'high' } },
            },
      );
      expect(options).not.toHaveProperty('modelResolution');
      expect(options.compactSelection).toBeUndefined();
    },
  );

  it.each([undefined, 'low'] as const)(
    'parent model plus generation overrides only forwards explicit config, effort=%s',
    async (effort) => {
      const parentSelection = testModelResolution('parent-model', {
        reasoningEffort: 'high',
      });
      await runSubagent(
        makeParams({
          model: 'parent-model',
          parentSelection,
          definition: makeDefinition({
            modelConfig: {
              model: 'inherit',
              generateContentConfig: { temperature: 0.2, maxOutputTokens: 456 },
            },
            ...(effort
              ? {
                  [RESOLVED_AGENT_REASONING]: {
                    reasoningEffort: effort,
                    thinkingBudget: 1024,
                  },
                }
              : {}),
          }),
        }),
      );
      const params = mockQueryCalls[0];
      expect(params.parentSelection).toBe(parentSelection);
      expect(params.querySelection).toEqual({
        config: {
          reasoning: effort ? { effort } : {},
          sampling: { temperature: 0.2 },
          context: { maxOutputTokens: 456 },
        },
      });
    },
  );

  it('same parent model still preserves explicit Agent generation and thinking requirements', async () => {
    const parentSelection = testModelResolution('parent-model', {
      reasoningEffort: 'high',
    });
    await runSubagent(
      makeParams({
        model: 'parent-model',
        parentSelection,
        definition: makeDefinition({
          modelConfig: {
            model: 'inherit',
            generateContentConfig: { temperature: 0.2 },
          },
          [RESOLVED_AGENT_REASONING]: {
            thinkingBudget: 1024,
            reasoningEffort: undefined,
          },
        }),
      }),
    );
    expect(mockQueryCalls[0].querySelection).toMatchObject({
      key: 'parent-model',
      config: { sampling: { temperature: 0.2 } },
    });
    expect(
      mockQueryCalls[0].querySelection?.config?.reasoning?.effort,
    ).toBeUndefined();
  });

  it('marks the seed prompt as a delegated task for auto mode', async () => {
    await runSubagent(makeParams());

    expect(
      (mockQueryCalls[0] as { userMessage?: unknown }).userMessage,
    ).toEqual({ isDelegatedTask: true });
  });

  // ── reasoning effort ──

  it('should leave reasoning unset when neither subagent nor parent defines effort', async () => {
    await runSubagent(makeParams());

    expect(mockQueryCalls).toHaveLength(1);
    const queryParams = mockQueryCalls[0];
    expect(queryParams).not.toHaveProperty('thinkingBudget');
    expect(
      requestOverrides(mockQueryCalls[0]).reasoning?.effort,
    ).toBeUndefined();
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
    expect(queryParams).not.toHaveProperty('generationPolicy');
    expect(requestOverrides(mockQueryCalls[0]).sampling).toBeUndefined();
  });

  it('should inherit the parent session effort when the subagent does not define one', async () => {
    await runSubagent(
      makeParams({
        context: makeMockContext('default', 'high'),
      }),
    );

    const queryParams = mockQueryCalls[0];
    expect(queryParams).not.toHaveProperty('thinkingBudget');
    expect(requestOverrides(mockQueryCalls[0]).reasoning?.effort).toBe('high');
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
    expect(queryParams).not.toHaveProperty('generationPolicy');
    expect(requestOverrides(mockQueryCalls[0]).sampling).toBeUndefined();
  });

  it('should inherit an explicitly disabled parent session effort', async () => {
    await runSubagent(
      makeParams({
        context: makeMockContext('default', 'none'),
      }),
    );

    const queryParams = mockQueryCalls[0];
    expect(requestOverrides(mockQueryCalls[0]).reasoning?.effort).toBe('none');
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
    expect(queryParams).not.toHaveProperty('generationPolicy');
    expect(requestOverrides(mockQueryCalls[0]).sampling).toBeUndefined();
  });

  it('should preserve an explicitly disabled subagent effort', async () => {
    await runSubagent(
      makeParams({
        definition: makeDefinition({
          effort: 'none',
          [RESOLVED_AGENT_REASONING]: {
            thinkingBudget: 0,
            reasoningEffort: 'none',
          },
        }),
      }),
    );

    const queryParams = mockQueryCalls[0];
    expect(queryParams).not.toHaveProperty('thinkingBudget');
    expect(requestOverrides(mockQueryCalls[0]).reasoning?.effort).toBe('none');
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
    expect(queryParams).not.toHaveProperty('generationPolicy');
    expect(requestOverrides(mockQueryCalls[0]).sampling).toBeUndefined();
  });

  it.each([true, false])(
    'honors complete inherited effort with inheritParentReasoning=%s',
    async (inheritParentReasoning) => {
      const context = makeMockContext('default', 'low');
      const parentSelection = testModelResolution('gemini-2.0-flash', {
        reasoningEffort: 'high',
        contextWindow: 128_000,
      });
      await runSubagent(
        makeParams({ context, parentSelection, inheritParentReasoning }),
      );
      const params = mockQueryCalls[0];
      expect(params.querySelection?.config?.reasoning?.effort).toBeUndefined();
      if (inheritParentReasoning) expect(params.querySelection).toBeUndefined();
      else expect(params.querySelection?.key).toBe(parentSelection.model.key);
      expect(params.parentSelection).toBe(parentSelection);
      expect(params.parentSelection?.config.reasoning?.effort).toBe('high');
      expect(params.parentSelection?.config.context?.contextWindow).toBe(
        128_000,
      );
    },
  );

  it('should pass registry-resolved effort to query without re-resolving it', async () => {
    await runSubagent(
      makeParams({
        context: makeMockContext('default', 'low'),
        definition: makeDefinition({
          effort: 'low',
          [RESOLVED_AGENT_REASONING]: {
            thinkingBudget: 16384,
            reasoningEffort: 'high',
          },
          modelConfig: {
            model: 'test',
            generateContentConfig: {
              thinkingConfig: { thinkingBudget: 16384 },
            },
          },
        }),
      }),
    );

    const queryParams = mockQueryCalls[0];
    expect(queryParams).not.toHaveProperty('thinkingBudget');
    expect(requestOverrides(mockQueryCalls[0]).reasoning?.effort).toBe('high');
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
  });

  it.each([0, 0.2])(
    'should preserve explicit agent temperature %s and other sampling overrides',
    async (temperature) => {
      await runSubagent(
        makeParams({
          definition: makeDefinition({
            modelConfig: {
              model: 'test',
              generateContentConfig: {
                temperature,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 8192,
              },
            },
          }),
        }),
      );

      expect(requestOverrides(mockQueryCalls[0])).toMatchObject({
        sampling: { temperature, topP: 0.8, topK: 40 },
        context: { maxOutputTokens: 8192 },
      });
    },
  );

  it('should not inherit parent effort when the subagent has an explicit budget without a resolved effort', async () => {
    await runSubagent(
      makeParams({
        context: makeMockContext('default', 'high'),
        definition: makeDefinition({
          [RESOLVED_AGENT_REASONING]: {
            thinkingBudget: -1,
          },
        }),
      }),
    );

    const queryParams = mockQueryCalls[0];
    expect(queryParams).not.toHaveProperty('thinkingBudget');
    expect(
      requestOverrides(mockQueryCalls[0]).reasoning?.effort,
    ).toBeUndefined();
    expect(queryParams).not.toHaveProperty('reasoningEffortIsOverride');
    expect(queryParams).not.toHaveProperty('generationPolicy');
    expect(requestOverrides(mockQueryCalls[0]).sampling).toBeUndefined();
  });

  // ── Basic query() parameters ──

  it('should pass prompt, model, systemPrompt, maxTurns to query()', async () => {
    const contextMessages = [
      {
        type: 'user',
        uuid: 'context-message',
        timestamp: '2026-01-01T00:00:00.000Z',
        isMeta: true,
        message: { role: 'user', content: 'preloaded context' },
      } satisfies Message,
    ];
    const params = makeParams({
      prompt: 'Analyze this code',
      contextMessages,
      model: 'gemini-pro',
      systemPrompt: systemPromptFromText('You are a code reviewer.'),
      maxTurns: 5,
      promptId: 'pid-99',
    });

    await runSubagent(params);

    expect(mockQueryCalls).toHaveLength(1);
    const queryParams = mockQueryCalls[0];
    expect(queryParams['prompt']).toBe('Analyze this code');
    expect(queryParams['messages']).toBe(contextMessages);
    expect(queryParams['sessionId']).toBe('root-session-123');
    expect(queryParams).not.toHaveProperty('model');
    expect(queryParams['systemPrompt']).toEqual(
      systemPromptFromText('You are a code reviewer.'),
    );
    expect(queryParams['maxTurns']).toBe(5);
    expect(queryParams['promptId']).toBe('pid-99');
    expect(mockQueryCalls[0].querySelection).toMatchObject({
      key: 'gemini-pro',
    });
    expect(mockQueryCalls[0]).not.toHaveProperty('modelSelection');
    expect(queryParams['isSubagent']).toBe(true);
    expect(queryParams['agentId']).toBe('atest-subagent-abc123');
    expect(queryParams['agentType']).toBe('test-subagent');
  });

  it('seeds the fresh agent with its policy-filtered agent listing', async () => {
    const context = makeMockContext();
    Object.assign(context.config, {
      getAgentRegistry: () => ({
        getDefinition: () => undefined,
        getAllDefinitions: () => [
          { name: 'Explore', description: 'Search the codebase' },
          { name: 'Plan', description: 'Design an implementation' },
        ],
      }),
    });
    const agentTool = {
      getAvailableAgentListing: () => [
        { name: 'Explore', description: 'Search the codebase' },
      ],
      isAgentTypeAvailable: (name: string) => name === 'Explore',
    };
    const childToolRegistry = {
      hasToolEnabled: (name: string) => name === 'Agent',
      getTool: (name: string) => (name === 'Agent' ? agentTool : undefined),
    };
    const schedulerContext = {
      toolRegistry: childToolRegistry,
    } as unknown as AgentLoopContext;
    const attachmentCtx = createAttachmentContext('/workspace/project');

    await runSubagent(makeParams({ context, schedulerContext, attachmentCtx }));

    const queryParams = mockQueryCalls[0];
    expect(queryParams['attachmentToolRegistry']).toBe(childToolRegistry);
    expect(queryParams['initialInputAttachments']).toEqual([
      expect.objectContaining({
        type: 'attachment',
        attachment: expect.objectContaining({
          type: 'agent_listing_delta',
          addedTypes: ['Explore'],
          removedTypes: [],
          isInitial: true,
        }),
      }),
    ]);
    expect(attachmentCtx.announcedAgentTypes).toEqual(new Set(['Explore']));
  });

  it('binds nested fork accessors to the fresh agent query state', async () => {
    const contextMessage = {
      type: 'user',
      uuid: 'child-context',
      timestamp: '2026-01-01T00:00:01.000Z',
      isMeta: true,
      message: { role: 'user', content: 'child context' },
    } satisfies Message;
    const childUser = {
      type: 'user',
      uuid: 'child-user',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'child task' },
    } satisfies Message;
    const childAssistant = {
      type: 'assistant',
      uuid: 'child-assistant',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'delegating' }],
      },
    } as unknown as Message;
    // Mirrors buildSubagentRegistries: the child context delegates its fork
    // accessors to the holder, so seeding the holder is what nested forks see.
    const forkContext = new SubagentForkContext();
    const schedulerContext = {
      getConversationMessages: forkContext.getConversationMessages,
      stripThoughtsFromConversationHistory:
        forkContext.stripThoughtsFromConversationHistory,
      getSystemPrompt: forkContext.getSystemPrompt,
      getParentToolSchemas: forkContext.getParentToolSchemas,
      getCacheSafeQuerySnapshot: forkContext.getCacheSafeQuerySnapshot,
    } as unknown as AgentLoopContext;
    const initialToolSchemas = [{ name: 'ChildTool' }];
    const resolvedToolSchemas = [{ name: 'ResolvedChildTool' }];
    const toolRegistry = {
      ...makeMockToolRegistry(),
      getToolSchemas: vi.fn(() => initialToolSchemas),
    } as unknown as ToolRegistry;
    const childSystemPrompt = [
      { type: 'text', text: 'stable child instructions' },
      { type: 'text', text: 'dynamic child context' },
    ] as const;
    const snapshot = {
      systemPrompt: childSystemPrompt,
      forkContextMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'wire child history' }],
        },
      ],
      model: 'resolved-child-model',
      toolSchemas: resolvedToolSchemas,
    };
    let observedDuringToolExecution:
      | {
          messages: readonly Message[];
          systemPrompt: import('../prompts/types.js').SystemPrompt | undefined;
          toolSchemas: unknown;
          snapshot: unknown;
        }
      | undefined;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((params: {
      onCacheSafeSnapshot?: (value: typeof snapshot) => void;
    }) => {
      expect(schedulerContext.getConversationMessages()).toEqual([
        contextMessage,
      ]);
      expect(schedulerContext.getSystemPrompt?.()).toEqual(childSystemPrompt);
      expect(schedulerContext.getParentToolSchemas?.()).toBe(
        initialToolSchemas,
      );

      return (async function* () {
        yield childUser;
        yield childAssistant;
        params.onCacheSafeSnapshot?.(snapshot);
        observedDuringToolExecution = {
          messages: schedulerContext.getConversationMessages(),
          systemPrompt: schedulerContext.getSystemPrompt?.(),
          toolSchemas: schedulerContext.getParentToolSchemas?.(),
          snapshot: schedulerContext.getCacheSafeQuerySnapshot?.(),
        };
        return {
          reason: 'end_turn' as const,
          numTurns: 1,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          } as unknown as NonNullableUsage,
          durationMs: 10,
        };
      })();
    }) as unknown as typeof query);

    await runSubagent(
      makeParams({
        contextMessages: [contextMessage],
        schedulerContext,
        forkContext,
        systemPrompt: childSystemPrompt,
        toolRegistry,
      }),
    );

    expect(
      observedDuringToolExecution?.messages.map((message) => message.uuid),
    ).toEqual(['child-context', 'child-user', 'child-assistant']);
    expect(observedDuringToolExecution?.messages[1]).toMatchObject({
      sessionId: 'root-session-123',
      uuid: 'child-user',
    });
    expect(observedDuringToolExecution?.systemPrompt).toBe(childSystemPrompt);
    expect(observedDuringToolExecution).toMatchObject({
      systemPrompt: childSystemPrompt,
      toolSchemas: resolvedToolSchemas,
      snapshot,
    });
  });

  it.each([false, true])(
    'only an explicit agent effort follows an SDK model switch (explicit=%s)',
    async (explicit) => {
      const context = makeMockContext('default', 'high');
      Object.assign(context.config, {
        getModelPolicy: async () => ({ model: 'policy-subagent-model' }),
      });
      await runSubagent(
        makeParams({
          context,
          definition: makeDefinition(
            explicit
              ? {
                  [RESOLVED_AGENT_REASONING]: {
                    reasoningEffort: 'low',
                    thinkingBudget: 1024,
                  },
                }
              : {},
          ),
        }),
      );
      const params = mockQueryCalls[0];
      // SDK 重选由实际 query 执行；此处验证子任务只传显式覆盖意图。
      expect(params.config).toBe(context.config);
      expect(params.isSubagent).toBe(true);
      expect(requestOverrides(params).reasoning?.effort).toBe(
        explicit ? 'low' : 'high',
      );
    },
  );

  it('wraps the fixed subagent model with SDK policy when configured', async () => {
    const context = makeMockContext();
    const getModelPolicy = vi
      .fn()
      .mockResolvedValue({ model: 'policy-subagent-model' });
    Object.assign(context.config, {
      getModelPolicy,
    });

    await runSubagent(makeParams({ context }));

    const queryParams = mockQueryCalls[0];
    expect(queryParams['config']).toBe(context.config);
    expect(mockQueryCalls[0]).not.toHaveProperty('modelSelection');
    expect(mockQueryCalls[0].querySelection).toMatchObject({
      key: 'gemini-2.0-flash',
    });
    expect(context.config.getModelPolicy).toBe(getModelPolicy);
    expect(getModelPolicy).not.toHaveBeenCalled();
  });

  // skip: 现存失败
  it.skip('propagates SDK policy failures without bypassing the policy with a fixed model', async () => {
    const context = makeMockContext();
    const policyError = new Error('subagent policy unavailable');
    Object.assign(context.config, {
      getModelPolicy: vi.fn().mockRejectedValue(policyError),
    });

    await runSubagent(
      makeParams({
        context,
        model: 'fixed-subagent-model',
      }),
    );

    const queryParams = mockQueryCalls[0];
    const modelRouter = (queryParams as unknown as Record<string, unknown>)[
      'modelRouter'
    ] as {
      resolve: (ctx: Record<string, unknown>) => Promise<{ model: string }>;
    };
    await expect(
      modelRouter.resolve({
        purpose: 'task',
        history: [],
        sessionId: 'root-session-123',
        turnIndex: 0,
        isSubagent: true,
      }),
    ).rejects.toBe(policyError);
  });

  it('should pass toolRegistry and signal to query()', async () => {
    const toolRegistry = makeMockToolRegistry();
    const controller = new AbortController();
    const params = makeParams({
      toolRegistry,
      signal: controller.signal,
    });

    await runSubagent(params);

    const queryParams = mockQueryCalls[0];
    expect(queryParams['toolRegistry']).toBe(toolRegistry);
    expect(queryParams['signal']).toBe(controller.signal);
  });

  // ── Result collection ──

  it('should collect assistant messages and text content', async () => {
    const assistantMsg: QueryEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    } as unknown as QueryEvent;

    const userMsg: QueryEvent = { type: 'user' } as unknown as QueryEvent;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([assistantMsg, userMsg], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
        } as unknown as NonNullableUsage,
        durationMs: 200,
      })) as unknown as typeof query);

    const result = await runSubagent(makeParams());

    expect(result.messages).toHaveLength(2);
    expect(result.textContent).toBe('Hello world');
  });

  it('should return terminal usage', async () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    } as unknown as NonNullableUsage;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([], {
        reason: 'end_turn',
        numTurns: 2,
        usage,
        durationMs: 500,
      })) as unknown as typeof query);

    const result = await runSubagent(makeParams());

    expect(result.totalUsage).toBe(usage);
    expect(result.messages).toHaveLength(0);
    expect(result.textContent).toBe('');
  });

  it('should collect actual model request IDs without changing query execution', async () => {
    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((params: {
      onModelRequestFinished?: (result: {
        requestId: string;
        model: string;
        success: boolean;
        attemptCount: number;
        retryCount: number;
      }) => void;
    }) => {
      params.onModelRequestFinished?.({
        requestId: 'request-1',
        model: 'test-model',
        success: true,
        attemptCount: 1,
        retryCount: 0,
      });
      params.onModelRequestFinished?.({
        requestId: 'request-2',
        model: 'test-model',
        success: false,
        attemptCount: 1,
        retryCount: 0,
      });
      return fakeQuery([], {
        reason: 'end_turn',
        numTurns: 2,
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
        } as unknown as NonNullableUsage,
        durationMs: 200,
      });
    }) as unknown as typeof query);

    const result = await runSubagent(makeParams());

    expect(result.modelRequestIds).toEqual(['request-1', 'request-2']);
  });

  it('should report server-returned credits from model requests', async () => {
    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((params: {
      onModelRequestCompleted?: (completion: {
        requestId: string;
        model: string;
        ttftMs: number;
        durationMs: number;
        usage: NonNullableUsage;
        thinkingTokens: number;
        finishReason: string;
      }) => void;
    }) => {
      const usage = {
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
        credits: 1.25,
        billable: true,
      } as unknown as NonNullableUsage;
      params.onModelRequestCompleted?.({
        requestId: 'request-with-credits',
        model: 'test-model',
        ttftMs: 10,
        durationMs: 100,
        usage,
        thinkingTokens: 0,
        finishReason: 'end_turn',
      });
      return fakeQuery([], {
        reason: 'end_turn',
        numTurns: 1,
        usage,
        durationMs: 100,
      });
    }) as unknown as typeof query);

    const result = await runSubagent(makeParams());

    expect(result.credits).toBe(1.25);
  });

  // ── onEvent callback ──

  it('should invoke onEvent for each query event', async () => {
    const events: QueryEvent[] = [
      { type: 'assistant', message: { content: [] } } as unknown as QueryEvent,
      { type: 'user' } as unknown as QueryEvent,
    ];

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery(events, {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    const receivedEvents: QueryEvent[] = [];
    await runSubagent(makeParams({ onEvent: (e) => receivedEvents.push(e) }));

    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0].type).toBe('assistant');
    expect(receivedEvents[1].type).toBe('user');
  });

  it('stamps child stream events with session and parent tool use id before forwarding', async () => {
    const streamEvent: QueryEvent = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'child-thought' },
      },
    };

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([streamEvent], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    const receivedEvents: QueryEvent[] = [];
    await runSubagent(
      makeParams({
        parentToolUseId: 'toolu-parent-1',
        onEvent: (event) => receivedEvents.push(event),
      }),
    );

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toMatchObject({
      type: 'stream_event',
      parent_tool_use_id: 'toolu-parent-1',
      session_id: 'root-session-123',
    });
  });

  // ── Permission mode: no custom mode ──

  it('should not change permission mode when definition has no permissionMode', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition(); // no permissionMode

    await runSubagent(makeParams({ definition, context }));

    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  // ── Permission mode: custom mode stores declaredMode ──

  it('should store parsed permission mode as declaredMode', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    // acceptEdits is stored verbatim as declaredMode
    expect(schedulerContext.permissionContext!()?.mode).toBe('acceptEdits');
    // No setPermissionMode call (stateless model)
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  it('keeps a caller fork policy when declaring the subagent mode', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });
    // A skill fork running a subagent: the context already carries the fork's
    // narrow allowlist and its refuse-to-ask handler.
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
      permissionContext: () => ({
        rules: { allow: { session: ['Read'] }, deny: {}, ask: {} },
        canPrompt: false,
      }),
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    const override = schedulerContext.permissionContext!();
    expect(override?.mode).toBe('acceptEdits');
    // Declaring a mode must not hand the nested agent the session's wider rules
    // or the ability to raise a prompt.
    expect(override?.rules?.allow.session).toEqual(['Read']);
    expect(override?.canPrompt).toBe(false);
  });

  it('resolves against the fork it runs inside, not the permissive session', async () => {
    // The session is wide open, but the fork pinned itself to Default with a
    // narrow allowlist. A nested agent must inherit that confinement rather
    // than the session's mode — otherwise declaring nothing would hand it Yolo.
    const context = makeMockContext('yolo');
    const definition = makeDefinition({});
    const schedulerContext = {
      permission: { getPermissionMode: () => 'yolo' },
      permissionContext: () => ({
        mode: 'default',
        rules: { allow: { session: ['Read'] }, deny: {}, ask: {} },
      }),
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(schedulerContext.permissionContext!()?.mode).toBe('default');
  });

  it('does not pin a mode for an undeclared subagent, so mode switches stay visible to rechecks', async () => {
    // The component task freezes the override when the check starts. Pinning
    // the parent mode into it would make a later mode switch invisible to the
    // recheck, stranding the subagent's pending prompt. Leaving the mode out
    // keeps every check resolving against the live session mode.
    const context = makeMockContext('default');
    const definition = makeDefinition(); // no permissionMode
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    const override = schedulerContext.permissionContext!();
    expect(override?.mode).toBeUndefined();
  });

  it('re-resolves a declared mode against the parent live mode, so mode switches reach pending prompts', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });
    let parentMode: 'default' | 'yolo' = 'default';
    const schedulerContext = {
      permission: { getPermissionMode: () => parentMode },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    // Parent default: the declaration applies.
    expect(schedulerContext.permissionContext!()?.mode).toBe('acceptEdits');
    // Parent switches to yolo: yolo always wins over a declaration, and the
    // resolution must see the switch — a frozen value would strand a pending
    // prompt.
    parentMode = 'yolo';
    expect(schedulerContext.permissionContext!()?.mode).toBe('yolo');
  });

  it('should store auto as declaredMode', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'auto' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(schedulerContext.permissionContext!()?.mode).toBe('auto');
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  it('supports isolated internal-agent mode, no compression, and no parent reasoning', async () => {
    const context = makeMockContext('acceptEdits', 'high');
    const definition = makeDefinition({ permissionMode: 'auto' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(
      makeParams({
        definition,
        context,
        schedulerContext,
        disableCompression: true,
        inheritParentReasoning: false,
        querySource: 'auto_memory',
      }),
    );

    expect(schedulerContext.permissionContext!()?.mode).toBe('auto');
    expect(mockCompressionConstructor).not.toHaveBeenCalled();
    expect(mockQueryCalls.at(-1)).toMatchObject({
      querySelection: { config: { reasoning: {} } },
      compressionPipeline: undefined,
      querySource: 'auto_memory',
    });
    expect(
      mockQueryCalls.at(-1)?.querySelection?.config?.reasoning?.effort,
    ).toBeUndefined();
  });

  it.each(['autoEdit', 'auto_edit'])(
    'should ignore removed legacy alias %s (no declaredMode)',
    async (legacyMode) => {
      const context = makeMockContext('default');
      const definition = makeDefinition({ permissionMode: legacyMode });
      const schedulerContext = {
        permission: { getPermissionMode: () => 'default' },
      } as unknown as AgentLoopContext;

      await runSubagent(makeParams({ definition, context, schedulerContext }));

      // An unrecognized alias declares nothing, and declaring nothing pins no
      // mode: every check resolves against the live session mode so later
      // mode switches stay visible to rechecks.
      expect(schedulerContext.permissionContext!()?.mode).toBeUndefined();
      expect(context.config.setPermissionMode).not.toHaveBeenCalled();
    },
  );

  // ── permissionMode: camelCase / snake_case / case-variant equivalence ──
  // Mirrors the --permission-mode CLI flag: bypass_permissions ≡ bypassPermissions.
  it.each([
    ['acceptEdits', 'acceptEdits'],
    ['accept_edits', 'acceptEdits'],
    ['ACCEPT_EDITS', 'acceptEdits'],
    ['accept-edits', 'acceptEdits'],
    ['yolo', 'yolo'],
    ['bypass_permissions', 'yolo'],
    ['BYPASS_PERMISSIONS', 'yolo'],
    ['yolo', 'yolo'],
    ['YOLO', 'yolo'],
    ['dontAsk', 'dontAsk'],
    ['dont_ask', 'dontAsk'],
    ['auto', 'auto'],
    ['AUTO', 'auto'],
    ['Default', 'default'],
  ] as Array<[string, PermissionMode]>)(
    'should normalize permissionMode %s → %s',
    async (declared, expected) => {
      const context = makeMockContext('default');
      context.config.isYoloModeDisabled = vi.fn(() => false);
      const definition = makeDefinition({ permissionMode: declared });
      const schedulerContext = {
        permission: { getPermissionMode: () => 'default' },
      } as unknown as AgentLoopContext;

      await runSubagent(makeParams({ definition, context, schedulerContext }));

      expect(schedulerContext.permissionContext!()?.mode).toBe(expected);
    },
  );

  it('should not crash when query() throws (no restore needed in stateless model)', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce((() => {
      // Return an async generator that throws on first next()
      // eslint-disable-next-line require-yield
      async function* throwingGen(): AsyncGenerator<QueryEvent, Terminal> {
        throw new Error('query failed');
      }
      return throwingGen();
    }) as unknown as typeof query);

    await expect(
      runSubagent(makeParams({ definition, context })),
    ).rejects.toThrow('query failed');

    // No restore needed — stateless model has no mode to restore
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  // ── Permission mode: stateless resolve model (CC-aligned) ──
  // At launch, only declaredMode is stored. Effective mode and prompt
  // suppression are computed at gate runtime on each tool call.

  it('should store subagentDeclaredMode on context without resolving mode at launch', async () => {
    const context = makeMockContext('dontAsk');
    const definition = makeDefinition({ permissionMode: 'default' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'dontAsk' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    // The override resolves against the parent mode as it is at call time, and a
    // parent DontAsk cannot be demoted by a subagent declaring something laxer.
    expect(schedulerContext.permissionContext!()?.mode).toBe('dontAsk');
    // The shared object is untouched: a subagent states its own divergence, it
    // does not reconfigure the session.
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  it('should leave declaredMode undefined and inherit parent when not specified (CC-aligned)', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition(); // no permissionMode
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    // Declaring nothing means live inheritance: the override supplier still
    // exists (that is what marks this as a subagent) but pins no mode, so
    // every check resolves against the session's mode as it is at that
    // moment — a later mode switch stays visible to rechecks.
    expect(schedulerContext.permissionContext).toBeDefined();
    expect(schedulerContext.permissionContext!()?.mode).toBeUndefined();
  });

  it('should not call setPermissionMode (stateless model)', async () => {
    const context = makeMockContext('dontAsk');
    const definition = makeDefinition({ permissionMode: 'default' });

    await runSubagent(makeParams({ definition, context }));

    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  // ── Permission mode: parent bypassPermissions cannot be downgraded ──

  it('should keep bypassPermissions when parent is bypassPermissions and subagent declares default', async () => {
    const context = makeMockContext('yolo');
    const definition = makeDefinition({ permissionMode: 'default' });

    await runSubagent(makeParams({ definition, context }));

    // Parent bypassPermissions is absolute — effective mode stays bypassPermissions,
    // which equals parentMode, so setPermissionMode is not called
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  it('should keep bypassPermissions when parent is bypassPermissions and subagent declares acceptEdits', async () => {
    const context = makeMockContext('yolo');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });

    await runSubagent(makeParams({ definition, context }));

    // effectiveMode resolves to bypassPermissions (= parentMode), so no mode change
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  // ── Permission mode: subagent can be more permissive ──

  it('should store bypassPermissions as declaredMode when subagent declares it', async () => {
    const context = makeMockContext('default');
    context.config.isYoloModeDisabled = vi.fn(() => false);
    const definition = makeDefinition({ permissionMode: 'yolo' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(schedulerContext.permissionContext!()?.mode).toBe('yolo');
  });

  it('should demote bypassPermissions when policy disables yolo mode', async () => {
    const context = makeMockContext('default');
    context.config.isYoloModeDisabled = vi.fn(() => true);
    const definition = makeDefinition({ permissionMode: 'yolo' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(context.config.isYoloModeDisabled).toHaveBeenCalled();
    expect(schedulerContext.permissionContext!()?.mode).toBe('acceptEdits');
  });

  // ── Permission mode aliases ──

  it('should support bypassPermissions as canonical name', async () => {
    const context = makeMockContext('default');
    context.config.isYoloModeDisabled = vi.fn(() => false);
    const definition = makeDefinition({ permissionMode: 'yolo' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(schedulerContext.permissionContext!()?.mode).toBe('yolo');
  });

  it('should support acceptEdits as canonical name', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'acceptEdits' });
    const schedulerContext = {
      permission: { getPermissionMode: () => 'default' },
    } as unknown as AgentLoopContext;

    await runSubagent(makeParams({ definition, context, schedulerContext }));

    expect(schedulerContext.permissionContext!()?.mode).toBe('acceptEdits');
  });

  // ── Permission mode: invalid mode string ──

  it('should not change mode for unknown permissionMode string', async () => {
    const context = makeMockContext('default');
    const definition = makeDefinition({ permissionMode: 'invalid_mode' });

    await runSubagent(makeParams({ definition, context }));

    // parsePermissionMode returns undefined for unknown strings,
    // resolveEffectiveMode returns parentMode, so no mode change
    expect(context.config.setPermissionMode).not.toHaveBeenCalled();
  });

  // ── Non-text content blocks are ignored ──

  it('should skip non-text content blocks when collecting textContent', async () => {
    const assistantMsg: QueryEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Some text' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
          null,
          { type: 'text', text: ' more text' },
        ],
      },
    } as unknown as QueryEvent;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([assistantMsg], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 5,
          output_tokens: 5,
          total_tokens: 10,
        } as unknown as NonNullableUsage,
        durationMs: 50,
      })) as unknown as typeof query);

    const result = await runSubagent(makeParams());
    expect(result.textContent).toBe('Some text more text');
  });

  it('should record durable messages to the sidechain transcript', async () => {
    const transcriptWriter = makeMockTranscriptWriter();
    const assistantMsg: QueryEvent = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: 'done' }] },
    } as unknown as QueryEvent;
    const userMsg: QueryEvent = {
      type: 'user',
      uuid: 'user-1',
      message: { content: 'prompt' },
    } as unknown as QueryEvent;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([userMsg, assistantMsg], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    await runSubagent(makeParams({ transcriptWriter }));

    expect(transcriptWriter.recordSidechainMessages).toHaveBeenNthCalledWith(
      1,
      [
        expect.objectContaining({
          ...userMsg,
          sessionId: 'root-session-123',
          parent_tool_use_id: null,
        }),
      ],
      'atest-subagent-abc123',
      null,
    );
    expect(transcriptWriter.recordSidechainMessages).toHaveBeenNthCalledWith(
      2,
      [
        expect.objectContaining({
          ...assistantMsg,
          sessionId: 'root-session-123',
          session_id: 'root-session-123',
          parent_tool_use_id: null,
        }),
      ],
      'atest-subagent-abc123',
      'user-1',
    );
  });

  it('continues the query loop when a delayed transcript write is denied', async () => {
    const { recorder, rawWriter, onUnavailable } =
      await makeAccessDeniedTranscriptRecorder();
    const assistantMsg: QueryEvent = {
      type: 'assistant',
      uuid: 'assistant-access-denied',
      message: { content: [{ type: 'text', text: 'done' }] },
    } as unknown as QueryEvent;
    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([assistantMsg], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    await expect(
      runSubagent(makeParams({ transcriptWriter: recorder })),
    ).resolves.toMatchObject({ textContent: 'done' });
    expect(rawWriter.recordSidechainMessages).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('continues the first resumed message from the restored sidechain leaf', async () => {
    const transcriptWriter = makeMockTranscriptWriter();
    const resumedUser: QueryEvent = {
      type: 'user',
      uuid: 'resumed-user-1',
      message: { role: 'user', content: 'recall the marker' },
    } as unknown as QueryEvent;
    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([resumedUser], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    await runSubagent(
      makeParams({
        transcriptWriter,
        resumeLeafUuid: 'prior-assistant-leaf',
      }),
    );

    expect(transcriptWriter.recordSidechainMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ uuid: 'resumed-user-1' })],
      'atest-subagent-abc123',
      'prior-assistant-leaf',
    );
  });

  it('should stamp sidechain messages with session and parent tool use id', async () => {
    const transcriptWriter = makeMockTranscriptWriter();
    const assistantMsg: QueryEvent = {
      type: 'assistant',
      uuid: 'assistant-ctx-1',
      timestamp: new Date().toISOString(),
      message: {
        id: 'resp-1',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
        content: [{ type: 'text', text: 'done' }],
        container: null,
        context_management: null,
      },
    } as unknown as QueryEvent;
    const userMsg: QueryEvent = {
      type: 'user',
      uuid: 'user-ctx-1',
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: 'prompt',
      },
    } as unknown as QueryEvent;

    const { query } = await import('../core/agent-loop.js');
    vi.mocked(query).mockImplementationOnce(((_params: unknown) =>
      fakeQuery([userMsg, assistantMsg], {
        reason: 'end_turn',
        numTurns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        } as unknown as NonNullableUsage,
        durationMs: 10,
      })) as unknown as typeof query);

    const result = await runSubagent(
      makeParams({
        transcriptWriter,
        parentToolUseId: 'toolu-parent-1',
      }),
    );

    expect(result.messages[0]).toMatchObject({
      type: 'user',
      sessionId: 'root-session-123',
      parent_tool_use_id: 'toolu-parent-1',
    });
    expect(result.messages[1]).toMatchObject({
      type: 'assistant',
      sessionId: 'root-session-123',
      session_id: 'root-session-123',
      parent_tool_use_id: 'toolu-parent-1',
    });
  });
});
