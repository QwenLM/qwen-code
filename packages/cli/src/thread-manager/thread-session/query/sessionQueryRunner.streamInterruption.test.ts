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
} from './sessionQueryRunner.js';

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
      getReasoningEffort: () => undefined,
      getCliReasoningEffort: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
      getToolRegistry: () => ({ hasToolEnabled: () => false }),
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
): Promise<SDKMessage[]> {
  const runner = new SessionQueryRunnerCtor(config);
  const events: SDKMessage[] = [];
  try {
    for await (const event of runner.submitMessage('Hi', {
      promptSuggestions: false,
    })) {
      events.push(event);
    }
  } finally {
    runner.dispose();
  }
  expect(mockQuery).toHaveBeenCalledOnce();
  return events;
}

describe('SessionQueryRunner stream interruption', () => {
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

  it('still emits the interrupted text block after an earlier block was streamed', async () => {
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
      yield makeAssistant('continued', 'done');
      return makeTerminal();
    });

    const events = await collectEvents(
      createRunnerConfig({ includePartialMessages: true }),
    );
    const texts = events.flatMap((event) =>
      event.type === 'assistant'
        ? event.message.content.flatMap((block) =>
            block.type === 'text' ? [block.text] : [],
          )
        : [],
    );
    expect(texts).toEqual(['partial answer', 'done']);
    expect(
      events.filter(
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
