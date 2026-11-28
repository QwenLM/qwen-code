/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selectedSkills` 从 `SessionSubmitOptions` 到 core `executeUserInput` 的透传。
 *
 * 断言点刻意选在「命令交给 core 的那一刻」：`executeUserInput` 被替换成捕获替身，
 * 直接看它收到的合成命令。这样链路上任何一环把字段丢掉（选项类型删字段、合成命令
 * 漏拷贝）都会红，而不是只在最终激活结果上间接观察。
 *
 * core 模块全部走 beforeAll 里的动态 import，原因与 queryProjectionParity.test.ts
 * 文件头相同：cli 的 test-setup 会在 vi.mock 注册前静态求值整张 core 图，只有
 * resetModules + 动态 import 才能让被测的 sessionQueryRunner 绑到带 mock 的那份。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ToolRegistryFactory } from '@qwen-code/core';
import type { HookCoordinatorAdapter } from '../../../../../core/src/core/hook-coordinator-types.js';
import type { SessionStateKeyProvider } from '../../../../../core/src/services/session-state-crypto.js';
import type {
  SessionQueryRunner,
  SessionQueryRunnerConfig,
} from './sessionQueryRunner.js';

// ===========================================================================
// executeUserInput 捕获替身
// ===========================================================================

interface CapturedCommand {
  prompt: unknown;
  selectedSkills?: ReadonlyArray<{ name: string; arguments?: string }>;
}

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ commands: unknown[] }>,
  businesses: [] as Array<string | undefined>,
  requestSets: [] as string[],
  observeInput: undefined as undefined
    | ((context: Record<string, unknown>) => void),
}));

vi.mock(
  '../../../../../core/src/input/executor.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    executeUserInput: async (
      commands: unknown[],
      context: { taskId: string },
    ) => {
      harness.calls.push({ commands });
      harness.observeInput?.(context);
      const { getBusinessInfoFromContext } = await import(
        '../../../../../core/src/utils/sessionIdContext.js'
      );
      harness.businesses.push(getBusinessInfoFromContext()?.id);
      harness.requestSets.push(context.taskId);
      // shouldQuery:false → 跳过 agent loop，本轮不需要脚本化的 query()。
      return { messages: [], shouldQuery: false };
    },
  }),
);

// ===========================================================================
// core 运行时值：resetModules 之后动态装载
// ===========================================================================

let SessionQueryRunnerCtor!: typeof SessionQueryRunner;
let testRequestConfig!: typeof import('../../../../../core/src/test-utils/model-resolution.js').testRequestConfig;
let SessionStateStoreCtor!: typeof import('@qwen-code/core').SessionStateStore;

beforeAll(async () => {
  vi.resetModules();
  const [pkg, modelResolution, runner] = await Promise.all([
    import('@qwen-code/core'),
    import('../../../../../core/src/test-utils/model-resolution.js'),
    // 与 core 同一批动态 import，静态 import 会绑回 test-setup 那份旧 core 图。
    import('./sessionQueryRunner.js'),
  ]);
  SessionQueryRunnerCtor = runner.SessionQueryRunner;
  SessionStateStoreCtor = pkg.SessionStateStore;
  testRequestConfig = modelResolution.testRequestConfig;
});

// ===========================================================================
// 协作者装配（对齐 queryProjectionParity 的最小 fake，够跑到 executeUserInput 即可）
// ===========================================================================

const MODEL_KEY = 'test-model';
const STATE_CONFIG_HOME = path.join(
  os.tmpdir(),
  `qwen-selected-skills-${process.pid}`,
);

class StaticSessionStateKeyProvider implements SessionStateKeyProvider {
  async getMasterKey(): Promise<Buffer> {
    return Buffer.alloc(32, 7);
  }
}

function createFakeProcessorConfig(): SessionQueryRunnerConfig['config'] {
  return {
    storage: {
      getProjectTempDir: () => os.tmpdir(),
      getPlansDir: () => os.tmpdir(),
    },
    getPermissionMode: () => 'acceptEdits',
    getModel: () => MODEL_KEY,
    getBusinessType: () => undefined,
    getBusinessModelKey: () => undefined,
    getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    getToolRegistry: () => ({ hasToolEnabled: () => false }),
    ...testRequestConfig(),
    getSkillListingMaxDescChars: () => 80,
    getSkillListingBudgetFraction: () => 0.1,
    getSkillVisibilityOverrides: () => undefined,
    getMemoryContextManager: () => undefined,
    getGoalManager: () => undefined,
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
    planStateManager: undefined,
  } as unknown as SessionQueryRunnerConfig['config'];
}

function createRunnerConfig(sessionId: string): SessionQueryRunnerConfig {

  const hookCoordinator: HookCoordinatorAdapter = {
    fireBefore: vi.fn().mockResolvedValue(null),
    fireAfter: vi.fn().mockResolvedValue(null),
    drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
    fireStopFailure: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };

  const toolRegistryFactory: ToolRegistryFactory = {
    create: vi.fn().mockReturnValue({
      getSchema: () => [],
      execute: vi.fn().mockResolvedValue({ toolResults: [], allMessages: [] }),
    }),
  };

  return {
    sessionId,
    promptSurface: 'sdk' as const,
    customSystemPrompt: 'selected-skills harness system prompt',
    defaultModel: MODEL_KEY,
    maxTurns: 1,
    includePartialMessages: false,
    config: createFakeProcessorConfig(),
    hookCoordinator,
    toolRegistryFactory,
    permissionMode: 'acceptEdits',
    sessionStateStoreFactory: (sid: string, { persist }: { persist: boolean }) =>
      new SessionStateStoreCtor({
        projectRoot: os.tmpdir(),
        sessionId: sid,
        configHomeDir: STATE_CONFIG_HOME,
        keyProvider: new StaticSessionStateKeyProvider(),
        persist,
      }),
  };
}

async function submitAndCapture(
  options: Parameters<SessionQueryRunner['submitMessage']>[1],
): Promise<CapturedCommand> {
  const runner = new SessionQueryRunnerCtor(
    createRunnerConfig('selected-skills-session'),
  );
  try {
    for await (const _message of runner.submitMessage('harness prompt', {
      promptSuggestions: false,
      ...options,
    })) {
      // 只关心交给 core 的命令，产出帧不是本文件的断言对象。
    }
  } finally {
    runner.dispose();
  }
  expect(harness.calls).toHaveLength(1);
  const commands = harness.calls[0]!.commands as CapturedCommand[];
  expect(commands).toHaveLength(1);
  return commands[0]!;
}

describe('SessionQueryRunner submitMessage 的 selectedSkills 透传', () => {
  beforeEach(() => {
    harness.calls.length = 0;
  });

  it('提交选项里的选中 Skill 原样出现在交给 core executeUserInput 的合成命令上', async () => {
    const selectedSkills = [
      { name: 'skill-a', arguments: '--verbose' },
      { name: 'skill-b' },
    ];

    const command = await submitAndCapture({ selectedSkills });

    expect(command.selectedSkills).toEqual(selectedSkills);
  });

  it('未选择 Skill 时合成命令不携带 selectedSkills', async () => {
    const command = await submitAndCapture({});
    expect(command.selectedSkills).toBeUndefined();
  });
});

describe(
  'background wake businessId',
  () => {
    it(
      'uses B1 for a wake and generates independent request sets without leaking into later turns or sessions',
      async () => {
        const runner = new SessionQueryRunnerCtor(
          createRunnerConfig('wake-session'),
        );
        const other = new SessionQueryRunnerCtor(
          createRunnerConfig('other-session'),
        );
        harness.businesses.length = 0;
        harness.requestSets.length = 0;
        try {
          for (const [owner, options] of [
            [runner, {}],
            [runner, { backgroundWakeBusinessId: 'B1' }],
            [runner, {}],
            [other, {}],
          ] as const) {
            for await (const _message of owner.submitMessage(
              'hello',
              {
                ...options,
                promptSuggestions: false,
              }
            )) {
          // Observe the request set and business at input processing time.
        }
          }
          expect(harness.businesses[1]).toBe('B1');
          expect(harness.businesses[0]).not.toBe('B1');
          expect(harness.businesses[2]).not.toBe('B1');
          expect(harness.businesses[3]).not.toBe('B1');
          expect(harness.requestSets).toHaveLength(4);
          expect(new Set(harness.requestSets).size).toBe(4);
          expect(harness.requestSets).not.toContain('B1');
        } finally {
          runner.dispose();
          other.dispose();
        }
      }
    );
  }
);

describe(
  'SessionQueryRunner metrics timing',
  () => {
    it.each([false, true])(
      'retains entry timing and business through blocked or throwing preparation (%s)',
      async (throws) => {
        const config = createRunnerConfig(`timing-${throws}`);
        const fireQueryEndEvent = vi.fn();
        Object.assign(
          config.config,
          {
            getHookSystem: () => ({
              fireQueryEndEvent,
              updateFileWatcherCwd: vi.fn(),
              dispose: vi.fn()
            })
          }
        );
        let clock = 100;
        const clockSpy = vi
          .spyOn(
            performance,
            'now'
          )
          .mockImplementation(() => clock);
        let observed: Record<string, unknown> | undefined;
        harness.observeInput = context => {
          observed = context;
          clock = 125;
          if (throws) throw Error('input rejected');
        };
        const runner = new SessionQueryRunnerCtor(config);
        try {
          for await (const _message of runner.submitMessage(
            'hello',
            {
              backgroundWakeBusinessId: 'original',
              promptSuggestions: false
            }
          )) {
          }
          expect(observed?.['businessId']).toBe('original');
          expect(observed?.['requestPreparationTiming']).toBeDefined();
          if (!throws) {
            expect(fireQueryEndEvent).not.toHaveBeenCalled();
            return;
          }
          expect(fireQueryEndEvent).toHaveBeenCalledOnce();
          expect(fireQueryEndEvent.mock.calls[0][1]).toBe('original');
          expect(fireQueryEndEvent.mock.calls[0][4]).toMatchObject({
            businessId: 'original',
            turnTiming: { submittedAtMs: 100, durationMs: 25 }
          });
        } finally {
          harness.observeInput = undefined;
          clockSpy.mockRestore();
          runner.dispose();
        }
      }
    );
  }
);
