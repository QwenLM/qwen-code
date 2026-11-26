/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  ModelContentBlock,
  ModelMessage,
  QueryEvent,
  SDKMessage,
  Terminal,
} from '@qwen-code/core';
import type {
  SessionQueryRunner,
  SessionQueryRunnerConfig,
  SessionSubmitOptions,
} from './sessionQueryRunner.js';
import type { ThreadEvent } from '../contract/hostContext.js';
import type { SessionCommandManager } from '../command/sessionCommandManager.js';
import type { ThreadSessionParams } from '../threadSession.js';
import { createCompactBoundaryMessage } from '../../../../../core/src/compression-v2/boundary.js';

const mockQuery = vi.hoisted(() =>
  vi.fn<() => AsyncGenerator<QueryEvent, Terminal>>(),
);
const mockExecuteUserInput = vi.hoisted(() => vi.fn());

vi.mock(
  '../../../../../core/src/core/agent-loop.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    query: mockQuery,
  }),
);

// 本套件只关心 agent loop → SDK 投影这一段，输入链（slash / attachment / hook）
// 不参与断言；直接放行到 query()，免得把整条 processor 依赖搬进配置替身。
vi.mock(
  '../../../../../core/src/input/executor.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    executeUserInput: mockExecuteUserInput,
  }),
);

let core: typeof import('@qwen-code/core');
let conversions: typeof import('../../../../../core/src/protocol/transcript/conversions.js');
let cloneUsage: typeof import('../../../../../core/src/protocol/provider/empty-usage.js').cloneUsage;
let modelResolution: typeof import('../../../../../core/src/test-utils/model-resolution.js');
let SessionQueryRunnerCtor: typeof SessionQueryRunner;

beforeAll(async () => {
  // test-setup 已经加载 core；重载后 runner 才会绑定到脚本化的 query。
  vi.resetModules();
  const [pkg, messages, usage, resolution, runner] = await Promise.all([
    import('@qwen-code/core'),
    import('../../../../../core/src/protocol/transcript/conversions.js'),
    import('../../../../../core/src/protocol/provider/empty-usage.js'),
    import('../../../../../core/src/test-utils/model-resolution.js'),
    import('./sessionQueryRunner.js'),
  ]);
  core = pkg;
  conversions = messages;
  cloneUsage = usage.cloneUsage;
  modelResolution = resolution;
  SessionQueryRunnerCtor = runner.SessionQueryRunner;
});

beforeEach(() => {
  mockQuery.mockReset();
  mockExecuteUserInput
    .mockReset()
    .mockResolvedValue({ messages: [], shouldQuery: true });
});

const MODEL_KEY = 'test-model';

function createRunnerConfig(
  overrides: Partial<SessionQueryRunnerConfig> = {},
): SessionQueryRunnerConfig {
  return {
    sessionId: 'stream-interruption-session',
    promptSurface: 'sdk',
    customSystemPrompt: 'stream interruption test',
    defaultModel: MODEL_KEY,
    permissionMode: 'acceptEdits',
    config: {
      storage: {
        getProjectTempDir: () => os.tmpdir(),
        getPlansDir: () => os.tmpdir(),
      },
      getPermissionMode: () => 'acceptEdits',
      getModel: () => MODEL_KEY,
      getBusinessType: () => undefined,
      getBusinessModelKey: () => undefined,
      getReasoningEffort: () => undefined,
      getCliReasoningEffort: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
      getToolRegistry: () => ({ hasToolEnabled: () => false }),
      getToolExecutor: () => undefined,
      ...modelResolution.testRequestConfig(),
      getSkillListingMaxDescChars: () => 80,
      getSkillListingBudgetFraction: () => 0.1,
      getSkillVisibilityOverrides: () => undefined,
      getMemoryContextManager: () => undefined,
      getFileHistoryManager: () => undefined,
      isWorkflowsEnabled: () => false,
      getWorkflowKeywordTriggerEnabled: () => false,
      isUltracodeActive: () => false,
      isTasksEnabled: () => false,
      getSessionPersistence: () => false,
      getProjectRoot: () => os.tmpdir(),
      getTargetDir: () => os.tmpdir(),
      getWorkingDir: () => os.tmpdir(),
      onSkillChange: vi.fn().mockReturnValue(() => undefined),
      registerForkContextAccessors: vi.fn(),
      registerSessionRuntimeBinding: vi.fn(),
    } as unknown as SessionQueryRunnerConfig['config'],
    hookCoordinator: {
      fireBefore: vi.fn().mockResolvedValue(null),
      fireAfter: vi.fn().mockResolvedValue(null),
      drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
      fireStopFailure: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
    toolRegistryFactory: {
      create: vi.fn().mockReturnValue({
        getSchema: () => [],
        execute: vi
          .fn()
          .mockResolvedValue({ toolResults: [], allMessages: [] }),
      }),
    },
    sessionStateStoreFactory: (sessionId, { persist }) =>
      new core.SessionStateStore({
        projectRoot: os.tmpdir(),
        sessionId,
        configHomeDir: path.join(
          os.tmpdir(),
          `qwen-stream-interruption-${process.pid}`,
        ),
        keyProvider: { getMasterKey: async () => Buffer.alloc(32, 7) },
        persist,
      }),
    ...overrides,
  };
}

function makeModelMessage(
  id: string,
  blocks: readonly ModelContentBlock[],
): ModelMessage {
  return { messageId: id, model: MODEL_KEY, blocks };
}

function makeAssistant(id: string, text: string): AssistantMessage {
  return conversions.createAssistantMessage(
    makeModelMessage(id, [{ type: 'text', text }]),
  );
}

function makeTerminal(): Terminal {
  return {
    reason: 'end_turn',
    numTurns: 2,
    usage: cloneUsage(),
    durationMs: 1,
  };
}

async function collectEvents(
  config: SessionQueryRunnerConfig,
  options: SessionSubmitOptions = {},
): Promise<SDKMessage[]> {
  const runner = new SessionQueryRunnerCtor(config);
  const events: SDKMessage[] = [];
  try {
    for await (const event of runner.submitMessage('Hi', {
      promptSuggestions: false,
      ...options,
    })) {
      events.push(event);
    }
  } finally {
    runner.dispose();
  }
  return events;
}

describe('SessionQueryRunner input persistence receipt', () => {
  it('does not report a dispatched peer input as an unpersisted host input when cancelled', async () => {
    const [
      { ThreadSession },
      { SettingsService },
      { createTestPermissionManager },
    ] = await Promise.all([
      import('../threadSession.js'),
      import('@qwen-code/resource'),
      import('../../../test-utils/permissionManager.js'),
    ]);
    const config = createRunnerConfig();
    const runner = new SessionQueryRunnerCtor(config);
    const resourceService = new core.ResourceService();
    const settingsService = new SettingsService();
    const events: ThreadEvent[] = [];
    const session = new ThreadSession({
      sessionId: config.sessionId,
      cwd: path.join(os.tmpdir(), 'peer-input-receipt'),
      cliArgs: {} as ThreadSessionParams['cliArgs'],
      host: {
        events: { emit: (event) => events.push(event) },
        requests: {} as ThreadSessionParams['host']['requests'],
      },
      permissionManager: createTestPermissionManager(),
      resourceService,
      settingsService,
      modelTransportManager: new core.ModelTransportManager([]),
    });
    // 隔离启动并让输入准备等待取消；派发、runTurn 参数传递和回执均执行真实实现。
    const internals = session as unknown as {
      commands: SessionCommandManager;
      hooks: { ensureStart(): Promise<void> };
      emitInitMessage(): Promise<void>;
      requireConfig(): unknown;
    };
    vi.spyOn(session, 'getQueryRunner').mockResolvedValue(runner);
    vi.spyOn(internals.hooks, 'ensureStart').mockResolvedValue(undefined);
    vi.spyOn(internals, 'emitInitMessage').mockResolvedValue(undefined);
    vi.spyOn(internals, 'requireConfig').mockReturnValue({
      waitForStartupGate: async () => undefined,
      getProcessPermissionManager: () => undefined,
      getPermissionModeRestriction: () => undefined,
      getPermissionMode: () => 'default',
    });
    mockExecuteUserInput.mockImplementation(
      (_commands, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('input cancelled'), {
                  name: 'AbortError',
                }),
              ),
            { once: true },
          );
        }),
    );
    core._resetQueueForTest();
    internals.commands.attach();
    try {
      core.enqueue({
        prompt: 'Peer review update',
        commandMode: 'prompt',
        priority: 'next',
        sessionId: config.sessionId,
        origin: { kind: 'peer', from: 'reviewer' },
      });
      await vi.waitFor(() => expect(mockExecuteUserInput).toHaveBeenCalled());
      session.interruptTurn();
      await internals.commands.cancelAndDrain();

      const result = events.find(
        (event) =>
          event.kind === 'threadMessage' && event.message.type === 'result',
      );
      expect(result).toMatchObject({
        kind: 'threadMessage',
        message: {
          type: 'result',
          is_error: true,
          terminal_reason: 'aborted_streaming',
          origin: { kind: 'peer', from: 'reviewer' },
        },
      });
      if (result?.kind !== 'threadMessage')
        throw new Error('Missing peer result');
      expect(result.message).not.toHaveProperty('error_code');
      expect(events.some((event) => event.kind === 'turnFailed')).toBe(false);
    } finally {
      await internals.commands.cancelAndDrain();
      internals.commands.dispose();
      runner.dispose();
      core._resetQueueForTest();
      vi.restoreAllMocks();
      await settingsService.dispose();
      await resourceService.dispose();
    }
  });

  it.each<[string, SessionSubmitOptions, boolean]>([
    ['host input', {}, true],
    ['synthetic input', { isSynthetic: true }, false],
    ['continuation', { continuationId: 'continuation-1' }, false],
    ['task notification', { commandMode: 'task-notification' }, false],
  ])(
    'reports cancellation before writing only for %s',
    async (_, options, expected) => {
      mockExecuteUserInput.mockRejectedValue(
        Object.assign(new Error('cancelled during input preparation'), {
          name: 'AbortError',
        }),
      );
      const events = await collectEvents(createRunnerConfig(), options);
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        is_error: true,
        terminal_reason: 'aborted_streaming',
      });
      if (expected) {
        expect(events.at(-1)).toHaveProperty(
          'error_code',
          core.RESULT_ERROR_CODES.userInputNotPersisted,
        );
      } else {
        expect(events.at(-1)).not.toHaveProperty('error_code');
      }
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it.each(['during write', 'after write'])(
    'does not claim input is absent when cancelled %s',
    async (stage) => {
      const controller = new AbortController();
      const failure = new Error('writer metadata failed');
      const writtenMessages: unknown[] = [];
      mockExecuteUserInput.mockResolvedValue({
        messages: [conversions.createUserMessage('Hi')],
        shouldQuery: true,
      });
      const transcriptWriter = {
        recordMessages: async (messages: unknown[]) => {
          writtenMessages.push(...messages);
          if (stage === 'during write') {
            controller.abort();
            throw failure;
          }
          return 'written-user';
        },
      };
      mockQuery.mockImplementation(async function* () {
        yield* [];
        controller.abort();
        throw new Error('cancelled after persistence');
      });
      const events = await collectEvents(
        createRunnerConfig({
          transcriptWriter:
            transcriptWriter as SessionQueryRunnerConfig['transcriptWriter'],
        }),
        { signal: controller.signal },
      );
      expect(writtenMessages).not.toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        terminal_reason: 'aborted_streaming',
      });
      expect(events.at(-1)).not.toHaveProperty('error_code');
    },
  );

  it('preserves the original error code for non-cancellation preparation failures', async () => {
    mockExecuteUserInput.mockRejectedValue(
      new core.ModelInferenceError('provider unavailable', {
        code: '112',
        kind: 'server',
        status: 503,
        phase: 'before_output',
      }),
    );
    const events = await collectEvents(createRunnerConfig());
    expect(events.at(-1)).toMatchObject({ type: 'result', error_code: '112' });
  });

  it('keeps hook rejection separate from cancellation before persistence', async () => {
    mockExecuteUserInput.mockResolvedValue({
      messages: [],
      shouldQuery: false,
      resultIsError: true,
      resultText: 'Hook rejected the input',
      terminalReason: 'hook_blocked',
      errorCode: core.RESULT_ERROR_CODES.hookBlocked,
    });
    const events = await collectEvents(createRunnerConfig());
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      error_code: core.RESULT_ERROR_CODES.hookBlocked,
    });
  });
});

describe('SessionQueryRunner stream interruption', () => {
  it.each([false, true])(
    'keeps complete output and durable history when compaction replay is ignored (partials=%s)',
    async (includePartialMessages) => {
      const blocks: ModelContentBlock[] = [
        { type: 'thinking', thinking: 'Inspecting', signature: '' },
        { type: 'text', text: 'Previous answer' },
        { type: 'tool_use', id: 'read-call', name: 'Read', input: {} },
      ];
      const kept = conversions.createAssistantMessage(makeModelMessage('kept', blocks));
      const toolResult = conversions.createToolResultMessage(
        [{ type: 'tool_result', tool_use_id: 'read-call', content: 'Read output', is_error: false }],
        kept.uuid,
      );
      const user = conversions.createUserMessage('Next task');
      const boundary = {
        type: 'system' as const,
        subtype: 'compact_boundary' as const,
        uuid: 'boundary',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'Conversation compacted',
        level: 'info' as const,
        compactMetadata: {
          trigger: 'auto' as const,
          preTokens: 10000,
          preservedSegment: {
            headUuid: kept.uuid,
            anchorUuid: 'summary',
            tailUuid: user.uuid,
            messageUuids: [kept.uuid, toolResult.uuid, user.uuid],
          },
        },
      };
      const history = [boundary, kept, toolResult, user];
      mockQuery.mockImplementation(async function* () {
        for (const [index, block] of blocks.entries()) {
          yield { type: 'assistant_block', index, message: makeModelMessage('kept', [block]) };
        }
        yield kept;
        yield toolResult;
        yield user;
        yield* core.getCompactionReplayMessages(history);
        yield makeAssistant('fresh', 'New answer');
        return makeTerminal();
      });
      const transcriptWriter = { recordMessages: vi.fn().mockResolvedValue(undefined) };
      const runner = new SessionQueryRunnerCtor(createRunnerConfig({
        includePartialMessages,
        transcriptWriter: transcriptWriter as unknown as SessionQueryRunnerConfig['transcriptWriter'],
      }));
      try {
        const events: SDKMessage[] = [];
        for await (const event of runner.submitMessage('Hi', { promptSuggestions: false })) events.push(event);
        expect(events.filter((event) => event.type === 'result' && event.is_error)).toEqual([]);
        const originals = events.filter((event) => event.type === 'assistant' &&
          event.message.id === 'kept' && event.isVisibleInTranscriptOnly !== true);
        expect(originals.flatMap((event) => event.type === 'assistant' ? event.message.content : []))
          .toMatchObject(blocks);
        const replays = events.filter((event) => event.type === 'assistant' && event.isVisibleInTranscriptOnly === true);
        expect(replays.flatMap((event) => event.type === 'assistant' ? event.message.content : []))
          .toMatchObject(blocks);
        expect(runner.getMessages().filter((message) => message.uuid === kept.uuid)).toEqual([kept]);
        expect(runner.getMessages().filter((message) => message.uuid === toolResult.uuid)).toEqual([toolResult]);
        expect(runner.getMessages().filter((message) => message.uuid === user.uuid)).toEqual([user]);
        for (const message of runner.getMessages()) {
          if (message.type === 'assistant') expect(message).not.toHaveProperty('isVisibleInTranscriptOnly');
        }
        for (const [messages] of transcriptWriter.recordMessages.mock.calls) {
          for (const message of messages) {
            if (message.type === 'assistant') expect(message).not.toHaveProperty('isVisibleInTranscriptOnly');
          }
        }
        expect(events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
      } finally {
        runner.dispose();
      }
    },
  );

  it.each(['112', undefined])(
    'forwards Provider exception %s without selecting display text',
    async (code) => {
      const failure = new core.ModelInferenceError(
        'Raw Provider failure: HTTP 503',
        {
          code,
          kind: 'server',
          status: 503,
          phase: 'before_output',
        },
      );
      mockQuery.mockImplementation(async function* () {
        yield* [];
        throw failure;
      });
      const onQueryError = vi.fn();
      const events = await collectEvents(createRunnerConfig({ onQueryError }));
      expect(onQueryError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        is_error: true,
        errors: [failure.message],
      });
      if (code === undefined)
        expect(events.at(-1)).not.toHaveProperty('error_code');
      else expect(events.at(-1)).toHaveProperty('error_code', code);
    },
  );

  it.each([false, true])(
    'keeps the recovery placeholder paired with its tool result (partials=%s)',
    async (includePartialMessages) => {
      const text = makeAssistant('interrupted', 'partial answer');
      text.partialStreamIndex = 0;
      const placeholder = makeAssistant('interrupted_recovery', 'unused');
      placeholder.message.stop_reason = 'tool_use';
      placeholder.message.usage = undefined;
      placeholder.message.content = [
        { type: 'tool_use', id: 'unfinished', name: 'Write', input: {} },
      ];
      const paired = conversions.createToolResultMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'unfinished',
            content: 'arguments incomplete',
            is_error: true,
          },
        ],
        placeholder.uuid,
      );
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant_block',
          index: 0,
          message: makeModelMessage('interrupted', [
            { type: 'text', text: 'partial answer' },
          ]),
        };
        yield text;
        yield placeholder;
        yield paired;
        yield makeAssistant('continued', 'done');
        return makeTerminal();
      });

      const events = await collectEvents(
        createRunnerConfig({ includePartialMessages }),
      );
      const toolUses = events.flatMap((event) =>
        event.type === 'assistant'
          ? event.message.content.filter((block) => block.type === 'tool_use')
          : [],
      );
      expect(toolUses).toEqual([expect.objectContaining({ id: 'unfinished' })]);
      expect(
        events.find(
          (event) =>
            event.type === 'assistant' &&
            event.message.id === placeholder.message.id,
        ),
      ).toMatchObject({ message: { stop_reason: 'tool_use' } });
      expect(
        events.filter(
          (event) =>
            event.type === 'user' &&
            Array.isArray(event.message.content) &&
            event.message.content.some(
              (block) =>
                block.type === 'tool_result' &&
                block.tool_use_id === 'unfinished',
            ),
        ),
      ).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        subtype: 'success',
        is_error: false,
      });
    },
  );

  it.each([false, true])('keeps interrupted thinking and text complete when compaction replay is ignored (partials=%s)', async (includePartialMessages) => {
    const thinking = makeAssistant('interrupted', 'thinking');
    thinking.message.content = [
      { type: 'thinking', thinking: 'let me see', signature: '' },
    ];
    thinking.partialStreamIndex = 0;
    const text = makeAssistant('interrupted', 'partial answer');
    text.partialStreamIndex = 1;
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant_block',
        index: 0,
        message: makeModelMessage('interrupted', [
          { type: 'thinking', thinking: 'let me see', signature: '' },
        ]),
      };
      yield thinking;
      yield text;
      const boundary = createCompactBoundaryMessage({
        trigger: 'auto',
        preTokens: 10000,
        preservedSegment: {
          headUuid: thinking.uuid,
          anchorUuid: 'summary',
          tailUuid: text.uuid,
          messageUuids: [thinking.uuid, text.uuid],
        },
      });
      yield* core.getCompactionReplayMessages([boundary, thinking, text]);
      yield makeAssistant('continued', 'done');
      return makeTerminal();
    });

    const events = await collectEvents(
      createRunnerConfig({ includePartialMessages }),
    );
    expect(events.filter((event) => event.type === 'result' && event.is_error)).toEqual([]);
    const visible = events.filter((event) => event.type !== 'assistant' || event.isVisibleInTranscriptOnly !== true);
    const texts = visible.flatMap((event) =>
      event.type === 'assistant'
        ? event.message.content.flatMap((block) =>
            block.type === 'text' ? [block.text] : [],
          )
        : [],
    );
    expect(texts).toEqual(['partial answer', 'done']);
    const replays = events.flatMap((event) => event.type === 'assistant' && event.isVisibleInTranscriptOnly === true ? event.message.content : []);
    expect(replays).toMatchObject([...thinking.message.content, ...text.message.content]);
    expect(
      visible.filter(
        (event) =>
          event.type === 'assistant' &&
          event.message.content.some((block) => block.type === 'thinking'),
      ),
    ).toHaveLength(1);
  });

  it('stops the agent loop before continuation when transcript writing fails', async () => {
    const continued = vi.fn();
    mockQuery.mockImplementation(async function* () {
      yield core.createAttachmentMessage(
        new core.StreamInterruptionAttachment({
          type: 'stream_interruption',
          cause: 'the upstream connection was closed',
        }),
      );
      continued();
      yield makeAssistant('continued', 'must not run');
      return makeTerminal();
    });
    const transcriptWriter = {
      recordMessages: vi.fn().mockRejectedValue(new Error('disk full')),
    };

    const events = await collectEvents(
      createRunnerConfig({
        transcriptWriter:
          transcriptWriter as unknown as SessionQueryRunnerConfig['transcriptWriter'],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
    });
    expect(continued).not.toHaveBeenCalled();
    expect(transcriptWriter.recordMessages).toHaveBeenCalledOnce();
  });

  it('rolls back appended messages when the immediate transcript write fails', async () => {
    mockExecuteUserInput.mockResolvedValue({
      messages: [conversions.createUserMessage('Hi')],
      shouldQuery: true,
    });
    const transcriptWriter = {
      recordMessages: vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error(
              "EPERM: operation not permitted, open 'C:\\tmp\\session.jsonl'",
            ),
            { code: 'EPERM' },
          ),
        ),
    };
    const runner = new SessionQueryRunnerCtor(
      createRunnerConfig({
        transcriptWriter:
          transcriptWriter as unknown as SessionQueryRunnerConfig['transcriptWriter'],
      }),
    );

    try {
      const events: SDKMessage[] = [];
      for await (const event of runner.submitMessage('Hi', {
        promptSuggestions: false,
      })) {
        events.push(event);
      }
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
      });
      expect(transcriptWriter.recordMessages).toHaveBeenCalledTimes(1);
      // transcript 里没有这一轮，上下文里也不能留下它，否则下一轮会重放。
      expect(runner.getMessages()).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      runner.dispose();
    }
  });
});
