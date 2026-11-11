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
  QueryEvent,
  QueryParams,
  SDKMessage,
  Terminal,
} from '@qwen-code/core';
import type {
  SessionQueryRunner,
  SessionQueryRunnerConfig,
} from './sessionQueryRunner.js';

const mockQuery = vi.hoisted(() =>
  vi.fn<(params: QueryParams) => AsyncGenerator<QueryEvent, Terminal>>(),
);
const mockExecuteUserInput = vi.hoisted(() => vi.fn());

vi.mock(
  '../../../../../core/src/core/agent-loop.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    query: mockQuery,
  }),
);

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
    sessionId: 'turn-timing-session',
    promptSurface: 'sdk',
    customSystemPrompt: 'turn timing test',
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
          `qwen-turn-timing-${process.pid}`,
        ),
        keyProvider: { getMasterKey: async () => Buffer.alloc(32, 7) },
        persist,
      }),
    ...overrides,
  };
}

function makeTerminal(): Terminal {
  return {
    reason: 'end_turn',
    numTurns: 1,
    usage: cloneUsage(),
    durationMs: 1,
  };
}

async function runTurn(
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
  return events;
}

describe('SessionQueryRunner turn timing', () => {
  it('passes the submission timestamp to query() for a user prompt', async () => {
    mockExecuteUserInput.mockImplementation(
      async (inputs: Array<{ uuid: string }>) => ({
        messages: [
          conversions.createUserMessage('Hi', {
            uuid: inputs[0]!.uuid,
            origin: { kind: 'human' },
            humanInput: { text: 'Hi', mode: 'prompt' },
          }),
        ],
        shouldQuery: true,
      }),
    );
    mockQuery.mockImplementation(async function* () {
      yield* [];
      return makeTerminal();
    });

    await runTurn(createRunnerConfig());

    expect(mockQuery).toHaveBeenCalledOnce();
    const params = mockQuery.mock.calls[0]![0];
    expect(params.userMessageSubmittedAtMs).toEqual(expect.any(Number));
  });

  it('keeps continuations off the submission-timestamp path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield* [];
      return makeTerminal();
    });

    await runTurn(createRunnerConfig());

    expect(mockQuery).toHaveBeenCalledOnce();
    const params = mockQuery.mock.calls[0]![0];
    expect(params.userMessageSubmittedAtMs).toBeUndefined();
  });

  it('surfaces a cancelled turn as an error result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield* [];
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const events = await runTurn(createRunnerConfig());

    expect(events.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });
});
