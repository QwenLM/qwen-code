/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  testModelResolution,
  testRequestConfig,
} from '../test-utils/model-resolution.js';
import {
  fixedSelection,
  withTestSelection,
} from '../test-utils/request-model.js';

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  runForkedAgent,
  type ForkedAgentParams,
  type SingleRequestForkParams,
} from './forkedAgent.js';
import { query, type QueryParams } from './agent-loop.js';
import { collectQueryResults } from './query-result-collector.js';
import {
  customContextContext,
  getCustomContextFromContext,
} from '../utils/sessionIdContext.js';
import {
  emitForkAgentCompleted,
  emitForkAgentStarted,
} from '../utils/diagnosticInterceptors.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { AttachmentToolUseContext } from '../attachments/types.js';
import { createSubagentTranscriptRecorder } from '../services/subagent-transcript.js';
import type { Config } from '../config/config.js';
import type { TranscriptWriterHandle } from '../services/transcript/writer-handle.js';
import { EnvironmentAttachment } from '../attachments/models/environment-attachment.js';
import { SessionContextAttachment } from '../attachments/models/session-context-attachment.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { buildForkContextMessages } from '../utils/forkContextUtils.js';

vi.mock('./agent-loop.js', () => ({
  query: vi.fn(),
}));

vi.mock('./query-result-collector.js', () => ({
  collectQueryResults: vi.fn(),
}));

vi.mock('../utils/diagnosticInterceptors.js', () => ({
  emitForkAgentStarted: vi.fn(),
  emitForkAgentCompleted: vi.fn(),
}));

function forkConfig(): Config {
  return withTestSelection({
    config: testRequestConfig() as Config,
    model: 'test-model',
    selectModel: fixedSelection('test-model').resolve,
  }).config;
}

describe('runForkedAgent', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockReturnValue({} as never);
    vi.mocked(collectQueryResults).mockReset();
    vi.mocked(emitForkAgentStarted).mockReset();
    vi.mocked(emitForkAgentCompleted).mockReset();
  });

  it.each(['parent-model', 'gateway/parent-model'])(
    'uses parentSelection %s as the final query result without selecting again after the session changes',
    async (key) => {
      const config = forkConfig();
      const select = vi.spyOn(config.getModelProviderManager(), 'select');
      select.mockRejectedValue(new Error('must reuse parent selection'));
      const parentSelection = testModelResolution(
        {
          ...testModelResolution(key).model,
          source: key.startsWith('gateway/') ? 'gateway' : 'qwen-provider',
        },
        {
          config: {
            reasoning: {
              effort: 'high',
              thinking: { type: 'enabled', budgetTokens: 4096 },
            },
            context: { contextWindow: 200_000, maxOutputTokens: 8192 },
            sampling: { temperature: 0.2 },
          },
        },
      );
      vi.mocked(collectQueryResults).mockResolvedValueOnce({
        messages: [],
        totalUsage: cloneUsage(),
        textContent: 'done',
        terminal: {
          reason: 'end_turn',
          numTurns: 1,
          usage: cloneUsage(),
          durationMs: 1,
        },
      });
      await runForkedAgent({
        config,
        parentSelection,
        model: key,
        prompt: 'fork question',
        sessionId: 'test-session',
        promptId: 'parent-fork',
        forkLabel: 'agent-fork',
      });
      const options = vi.mocked(query).mock.calls[0]![0];
      expect(config.getModel()).not.toBe(key);
      expect(options.parentSelection).toBe(parentSelection);
      expect(options.compactSelection).toBeUndefined();
      expect(options).not.toHaveProperty('modelOverride');
      expect(options.modelPurpose).toBe('fork');
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'forwards an existing result or model requirement without preselecting (preselected=%s)',
    async (preselected) => {
      const config = forkConfig();
      const select = vi.spyOn(config.getModelProviderManager(), 'select');
      const resolution = preselected
        ? testModelResolution('test-model')
        : undefined;
      vi.mocked(collectQueryResults).mockResolvedValueOnce({
        messages: [],
        totalUsage: cloneUsage(),
        textContent: 'done',
        terminal: {
          reason: 'end_turn',
          numTurns: 1,
          usage: cloneUsage(),
          durationMs: 1,
        },
      });
      await runForkedAgent({
        config,
        compactSelection: resolution,
        model: 'test-model',
        prompt: 'summarize',
        sessionId: 'test-session',
        promptId: 'compat-fork',
        forkLabel: 'compact',
      });
      const options = vi.mocked(query).mock.calls[0]![0];
      expect(options.parentSelection).toBeUndefined();
      expect(options.compactSelection).toBe(resolution);
      expect(options).not.toHaveProperty('modelResolution');
      expect(options.modelPurpose).toBe(preselected ? 'compact' : 'fork');
      if (preselected) {
        expect(options.querySelection).toBeUndefined();
      } else {
        expect(options.querySelection).toMatchObject({ key: 'test-model' });
        expect(options).not.toHaveProperty('modelOverride');
      }
      expect(select).not.toHaveBeenCalled();
    },
  );

  it('requires a completed parent and excludes loop controls for single-request forks', () => {
    type RequiredInputs = Pick<
      SingleRequestForkParams,
      'parent' | 'selection' | 'isCurrent'
    >;
    type Turn = SingleRequestForkParams['parent']['completedTurn'];
    type ParentIdentity = Pick<
      Turn,
      'sessionId' | 'requestSetId' | 'businessInfo'
    >;
    expectTypeOf<QueryParams>().not.toHaveProperty('prediction');
    expectTypeOf<ForkedAgentParams>().not.toHaveProperty('prediction');
    expectTypeOf<RequiredInputs>().toEqualTypeOf<Required<RequiredInputs>>();
    expectTypeOf<ParentIdentity>().toEqualTypeOf<Required<ParentIdentity>>();
    expectTypeOf<SingleRequestForkParams>().not.toHaveProperty('maxTurns');
    expectTypeOf<SingleRequestForkParams>().not.toHaveProperty('toolRegistry');
    expectTypeOf<SingleRequestForkParams>().not.toHaveProperty('toolExecutor');
  });

  it('rejects when the drained query terminal reports an error', async () => {
    const usage = cloneUsage();
    const terminalError = Object.assign(new Error('content rejected'), {
      status: 416,
      code: '406',
    });
    vi.mocked(collectQueryResults).mockResolvedValueOnce({
      messages: [],
      totalUsage: usage,
      textContent: '',
      terminal: {
        reason: 'error',
        error: terminalError,
        requestId: 'request-1',
        numTurns: 1,
        usage,
        durationMs: 10,
      },
    });

    const onCompleted = vi.fn();
    const onObservation = vi.fn();

    await expect(
      runForkedAgent({
        config: forkConfig(),
        prompt: 'summarize',
        sessionId: 'root-session-1',
        model: 'test-model',
        promptId: 'compact-1',
        forkLabel: 'compact',
        parentRequestSetId: 'parent-request-set-1',
        customContext: { tenant: 'pds' },
        toolChoice: 'none',
        onCompleted,
        onObservation,
      }),
    ).rejects.toBe(terminalError);

    expect(vi.mocked(query).mock.calls[0]?.[0]).not.toHaveProperty(
      'attachmentCtx',
    );
    expect(vi.mocked(query).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        customContext: { tenant: 'pds' },
        toolChoice: 'none',
        onModelRequestObservation: onObservation,
      }),
    );

    expect(emitForkAgentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        success: false,
      }),
    );
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        requestId: 'request-1',
        modelRequestIds: ['request-1'],
        success: false,
        totalUsage: usage,
      }),
    );
  });

  it('runs fork collection inside the supplied customContext snapshot', async () => {
    const usage = cloneUsage();
    let observed: Readonly<Record<string, string>> | undefined;
    vi.mocked(collectQueryResults).mockImplementationOnce(async () => {
      observed = getCustomContextFromContext();
      return {
        messages: [],
        totalUsage: usage,
        textContent: 'done',
        terminal: {
          reason: 'end_turn',
          requestId: 'request-context',
          numTurns: 1,
          usage,
          durationMs: 10,
        },
      };
    });

    const customContext = { tenant: 'fork' };
    const pending = runForkedAgent({
      config: forkConfig(),
      prompt: 'summarize',
      sessionId: 'root-session-1',
      model: 'test-model',
      promptId: 'context-1',
      forkLabel: 'context',
      customContext,
    });
    customContext.tenant = 'changed-after-call';
    await pending;

    expect(observed).toEqual({ tenant: 'fork' });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('inherits the parent customContext when the fork has none', async () => {
    const usage = cloneUsage();
    let observed: Readonly<Record<string, string>> | undefined;
    vi.mocked(collectQueryResults).mockImplementationOnce(async () => {
      observed = getCustomContextFromContext();
      return {
        messages: [],
        totalUsage: usage,
        textContent: 'done',
        terminal: {
          reason: 'end_turn',
          requestId: 'request-parent-context',
          numTurns: 1,
          usage,
          durationMs: 10,
        },
      };
    });

    await customContextContext.run({ tenant: 'parent' }, () =>
      runForkedAgent({
        config: forkConfig(),
        prompt: 'summarize',
        sessionId: 'root-session-1',
        model: 'test-model',
        promptId: 'context-2',
        forkLabel: 'context',
      }),
    );

    expect(observed).toEqual({ tenant: 'parent' });
    expect(
      (
        vi.mocked(query).mock.calls.at(-1)?.[0] as
          | { customContext?: unknown }
          | undefined
      )?.customContext,
    ).toEqual({ tenant: 'parent' });
  });

  it('does not let a completion observer change the fork result', async () => {
    const usage = cloneUsage();
    vi.mocked(collectQueryResults).mockResolvedValueOnce({
      messages: [],
      totalUsage: usage,
      textContent: 'done',
      terminal: {
        reason: 'end_turn',
        requestId: 'request-observer',
        numTurns: 1,
        usage,
        durationMs: 10,
      },
    });

    await expect(
      runForkedAgent({
        config: forkConfig(),
        prompt: 'summarize',
        sessionId: 'root-session-1',
        model: 'test-model',
        promptId: 'compact-observer',
        forkLabel: 'compact',
        onCompleted: () => {
          throw new Error('observer failed');
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        textContent: 'done',
        totalUsage: usage,
      }),
    );
  });

  it('forwards attachment state to tool-enabled fork queries', async () => {
    const usage = cloneUsage();
    const attachmentCtx = {
      agentId: 'fork-agent-1',
      pendingHookOutputs: [],
      pendingHookAttachments: [],
    } as unknown as AttachmentToolUseContext;
    const contextAttachmentMessages = [
      createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { gitStatus: 'parent Git snapshot' },
          changed: true,
          reason: 'compaction',
        }),
      ),
      createAttachmentMessage(
        new EnvironmentAttachment({
          type: 'environment',
          snapshot: {
            workingDirectory: '/parent',
            additionalWorkingDirectories: [],
            isWorktree: false,
            isGitRepo: true,
            platform: 'darwin',
            shell: '/bin/zsh',
            osVersion: '24.0.0',
            architecture: 'arm64',
            nodeVersion: 'v22.0.0',
          },
        }),
      ),
    ];

    const forkContextMessages = buildForkContextMessages(
      contextAttachmentMessages,
    );
    vi.mocked(collectQueryResults).mockResolvedValueOnce({
      messages: [],
      totalUsage: usage,
      textContent: 'done',
      terminal: {
        reason: 'end_turn',
        requestId: 'request-2',
        numTurns: 1,
        usage,
        durationMs: 10,
      },
    });

    await runForkedAgent({
      config: forkConfig(),
      prompt: 'inspect',
      sessionId: 'root-session-1',
      model: 'test-model',
      promptId: 'fork-1',
      forkLabel: 'agent-fork',
      agentType: 'Explore',
      toolRegistry: {} as never,
      attachmentCtx,
      forkContextMessages,
      contextAttachmentMessages,
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCtx,
        sessionId: 'root-session-1',
        isSubagent: true,
        agentId: 'fork-agent-1',
        agentType: 'Explore',
        preProjectedMessages: forkContextMessages,
        messages: contextAttachmentMessages,
      }),
    );
    expect(vi.mocked(query).mock.calls[0][0].messages).not.toBe(
      contextAttachmentMessages,
    );
    expect(vi.mocked(query).mock.calls[0][0].preProjectedMessages).toBe(
      forkContextMessages,
    );
  });

  it('uses the fork label as the type for internal tool-enabled subagents', async () => {
    vi.mocked(collectQueryResults).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: 'done',
      terminal: {
        reason: 'end_turn',
        requestId: 'request-memory-fork',
        numTurns: 1,
        usage: cloneUsage(),
        durationMs: 10,
      },
    });

    await runForkedAgent({
      config: forkConfig(),
      prompt: 'extract memory',
      sessionId: 'root-session-1',
      model: 'test-model',
      promptId: 'memory-fork-1',
      forkLabel: 'memory-fork',
      toolRegistry: {} as never,
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        isSubagent: true,
        agentType: 'memory-fork',
      }),
    );
    expect(vi.mocked(query).mock.calls[0][0]).not.toHaveProperty(
      'providerPurpose',
    );
  });

  it('forwards system prompt blocks without flattening the parent payload', async () => {
    const systemPrompt = [
      { type: 'text' as const, text: 'stable' },
      { type: 'text' as const, text: 'dynamic' },
    ];
    vi.mocked(collectQueryResults).mockResolvedValueOnce({
      messages: [],
      totalUsage: cloneUsage(),
      textContent: 'done',
      terminal: {
        reason: 'end_turn',
        requestId: 'request-blocks',
        numTurns: 1,
        usage: cloneUsage(),
        durationMs: 10,
      },
    });

    await runForkedAgent({
      config: forkConfig(),
      prompt: 'inspect',
      sessionId: 'root-session-1',
      model: 'test-model',
      promptId: 'fork-blocks',
      forkLabel: 'agent-fork',
      systemPrompt,
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt }),
    );
  });

  it('continues a fork when a delayed transcript write is denied', async () => {
    const usage = cloneUsage();
    const rawWriter = {
      filePath: '/tmp/subagents/agent-fork-agent-1.jsonl',
      recordSidechainMessages: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('read-only file system'), { code: 'EROFS' }),
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
      getActiveSessionTranscriptPath: () => '/tmp/session-1.jsonl',
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace/project',
    } as unknown as Config;
    const recorder = await createSubagentTranscriptRecorder(
      config,
      'fork-agent-1',
      'task-1',
      onUnavailable,
    );
    vi.mocked(collectQueryResults).mockImplementationOnce((async (
      _generator: unknown,
      _onEvent: unknown,
      onMessage?: (message: never) => Promise<void>,
    ) => {
      await onMessage?.({
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: 'done' }] },
      } as never);
      return {
        messages: [],
        totalUsage: usage,
        textContent: 'done',
        terminal: {
          reason: 'end_turn',
          requestId: 'request-transcript-denied',
          numTurns: 1,
          usage,
          durationMs: 10,
        },
      };
    }) as never);

    await expect(
      runForkedAgent({
        config: forkConfig(),
        prompt: 'inspect',
        sessionId: 'root-session-1',
        model: 'test-model',
        promptId: 'fork-transcript-denied',
        forkLabel: 'agent-fork',
        toolRegistry: {} as never,
        transcriptWriter: recorder,
        transcriptAgentId: 'fork-agent-1',
      }),
    ).resolves.toMatchObject({ textContent: 'done' });
    expect(rawWriter.recordSidechainMessages).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});
