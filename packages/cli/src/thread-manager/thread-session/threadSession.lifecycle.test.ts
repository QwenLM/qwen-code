/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';import { createTestPermissionManager } from '../../test-utils/permissionManager.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginResumeRead,
  TranscriptRepository,
  GoalStatus,
  ModelTransportManager,
  Storage,
  CustomProviderManager,
  ResourceService,
  disposeSessionEventQueue,
  enqueueSubagentSdkEvent,
  type QueryEvent,
} from '@qwen-code/core';
import * as core from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { ThreadSession, type ThreadSessionParams } from './threadSession.js';

vi.mock('../../config/config.js', () => ({ loadCliConfig: vi.fn() }));
import { loadCliConfig } from '../../config/config.js';
import * as startupModePolicy from '../../startup/startupModePolicy.js';
import type { ThreadEvent } from './contract/hostContext.js';

afterEach(() => vi.restoreAllMocks());

function params(): ThreadSessionParams {
  return {
    sessionId: 'startup-cleanup',
    cwd: '/project',
    cliArgs: {} as ThreadSessionParams['cliArgs'],
    host: {
      events: { emit: vi.fn() },
      requests: {},
    } as unknown as ThreadSessionParams['host'],
    permissionManager: createTestPermissionManager(),
    resourceService: new ResourceService(),
    settingsService: new SettingsService(),
    modelTransportManager: new ModelTransportManager([]),
  };
}

// 只控制故障点，不运行 start 的网络、认证和配置加载。
const lifecycle = ThreadSession.prototype as unknown as {
  start(): Promise<void>;
  interruptTurn(): Promise<void>;
  closeChannel(): Promise<{ transcriptFlushed: Promise<void> }>;
  retire(): Promise<void>;
};

it('configures an injected service before resolving a directly created session', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'thread-settings-'));
  const storage = vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
  const options = { ...params(), cwd: root };
  const session = new ThreadSession(options);
  const stop = new Error('stop after settings resolution');
  const load = vi.mocked(loadCliConfig).mockRejectedValueOnce(stop);
  try {
    await expect(lifecycle.start.call(session)).rejects.toBe(stop);
    expect(options.settingsService.getDefinition()).toBeDefined();
    const [settings, , , configOptions] = load.mock.lastCall!;
    expect(settings.getSettingsService()).toBe(options.settingsService);
    expect(configOptions.settingsService).toBe(options.settingsService);
  } finally {
    load.mockReset();
    storage.mockRestore();
    await options.settingsService.dispose();
    await options.resourceService.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('ThreadSession fork 收尾', () => {
  it('fork 会话把源计划状态复制到本会话；失败只告警不抛出', async () => {
    const resumeData = {
      resumeState: {} as never,
      messages: [{ uuid: 'm-1' } as never],
      fileHistorySnapshots: [],
      sourceSessionId: 'source-1',
    };
    const options: ThreadSessionParams = {
      ...params(),
      forked: true,
      resumeData,
    };
    const session = new ThreadSession(options);
    const copyPlanForResume = vi
      .fn()
      .mockRejectedValueOnce(new Error('plan copy failed'));
    const config = {
      planStateManager: { copyPlanForResume },
      storage: { getPlansDir: () => '/plans' },
    };
    const internals = session as unknown as {
      copyForkPlanState(config: unknown): Promise<void>;
    };

    await expect(internals.copyForkPlanState(config)).resolves.toBeUndefined();
    expect(copyPlanForResume).toHaveBeenCalledWith(
      resumeData.messages,
      'source-1',
      'startup-cleanup',
      '/plans',
    );
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('非 fork 会话不复制计划状态', async () => {
    const options: ThreadSessionParams = {
      ...params(),
      resumeData: {
        resumeState: {} as never,
        messages: [],
        fileHistorySnapshots: [],
        sourceSessionId: 'source-1',
      },
    };
    const session = new ThreadSession(options);
    const copyPlanForResume = vi.fn(async () => {});
    const config = {
      planStateManager: { copyPlanForResume },
      storage: { getPlansDir: () => '/plans' },
    };

    await (
      session as unknown as {
        copyForkPlanState(config: unknown): Promise<void>;
      }
    ).copyForkPlanState(config);

    expect(copyPlanForResume).not.toHaveBeenCalled();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});

describe('ThreadSession 恢复准入生命周期', () => {
  it.each(['startup-failure', 'close-before-runner'] as const)(
    '真实读取候选在 %s 出口释放，同进程下一次恢复可以前进',
    async (kind) => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'resume-lifecycle-'));
      const filePath = path.join(root, 'session.jsonl');
      const attempt = await beginResumeRead({});
      const options = params();
      try {
        await fs.writeFile(
          filePath,
          `${JSON.stringify({ type: 'active-leaf', sessionId: options.sessionId, leafUuid: null, explicit: true, timestamp: '2026-10-27T00:00:00.000Z' })}\n`,
        );
        const candidate = await new TranscriptRepository().readForResume(
          filePath,
          { sessionId: options.sessionId, attempt },
        );
        const resumeOptions = {
          ...options,
          resumeTranscriptPath: filePath,
          resumeCandidate: candidate!,
        };
        if (kind === 'startup-failure') {
          const failure = new Error('configuration failed');
          vi.spyOn(lifecycle, 'start').mockRejectedValueOnce(failure);
          await expect(ThreadSession.create(resumeOptions)).rejects.toBe(
            failure,
          );
        } else {
          await new ThreadSession(resumeOptions).close();
        }
        expect(() => attempt.check()).toThrow();
        const next = await beginResumeRead({});
        next.finish();
      } finally {
        attempt.finish();
        await options.resourceService.dispose();
        await options.settingsService.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('ThreadSession 资源回收', () => {
  it('装配失败会关闭半成品，前序收尾报错也释放 Config，并保留原始装配错误', async () => {
    const dispose = vi.fn(async () => {});
    const startupError = new Error('startup failed');
    vi.spyOn(lifecycle, 'start').mockImplementation(async function (
      this: ThreadSession,
    ) {
      Object.assign(this, {
        config: {
          dispose,
        },
      });
      throw startupError;
    });
    const closeChannel = vi
      .spyOn(lifecycle, 'closeChannel')
      .mockRejectedValue(new Error('pipeline cleanup failed'));
    const options = params();

    await expect(ThreadSession.create(options)).rejects.toBe(startupError);

    expect(closeChannel).toHaveBeenCalledOnce();
    // 信道关闭抛错也要继续退休收尾：Config 仍被释放，原始装配错误原样上抛。
    expect(dispose).toHaveBeenCalledOnce();
    // 会话只释放自己的 Config，不销毁 Manager 持有的 ResourceService。
    expect(() =>
      options.resourceService.getUserResource({
        homeDir: '/home',
      }),
    ).not.toThrow();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('正常 close 只释放一次 Config，并发 close 共享同一 Promise', async () => {
    const options = params();
    const session = new ThreadSession(options);
    const dispose = vi.fn(async () => {});
    const getModelProviderManager = vi.fn();
    Object.assign(session, {
      config: { dispose, getModelProviderManager },
    });
    vi.spyOn(lifecycle, 'interruptTurn').mockResolvedValue();

    const first = session.close();
    expect(session.close()).toBe(first);
    await first;
    await session.close();

    expect(dispose).toHaveBeenCalledOnce();
    expect(getModelProviderManager).not.toHaveBeenCalled();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it.each([
    'background', 'cancel', 'pipelines', 'broadcast', 'sessionEnd',
    'toolUnsubscribe', 'hookUnsubscribe', 'runner', 'transcript', 'config',
  ])('%s 失败仍执行其余释放；信道阶段失败不抛，退休阶段失败由 close 报告', async (failure) => {
    const options = params();
    const session = new ThreadSession(options);
    const calls: string[] = [];
    const error = new Error(`${failure} failed`);
    const step = (name: string) => vi.fn(() => {
      calls.push(name);
      if (failure === name) throw error;
    });
    const internals = session as unknown as {
      drainBackgroundWork(): Promise<void>;
      drainSessionPipelines(): Promise<void>;
    };
    vi.spyOn(lifecycle, 'interruptTurn').mockImplementation(async () => {
      step('interrupt')();
    });
    vi.spyOn(internals, 'drainBackgroundWork').mockImplementation(async () => {
      step('background')();
    });
    options.host.requests.memory = {
      prepare: vi.fn(),
      refreshMemory: vi.fn(),
      flushMemory: vi.fn(),
      flushSkillEvolution: vi.fn(),
      drain: async () => { step('pipelines')(); },
    };
    Object.assign(session, {
      config: {
        dispose: step('config'),
      },
      commands: {
        cancelAndDrain: vi.fn(),
        discardQueuedAndReport: step('discard'),
        dispose: step('commands'),
        clear: step('clear'),
      },
      transcriptUnsubscribe: step('transcriptUnsubscribe'),
      scheduler: { cancelAll: step('cancel'), dispose: step('scheduler') },
      cleanupTaskRegistryBridge: step('taskBridge'),
      broadcast: { dispose: step('broadcast') },
      sessionEndCloseout: { run: step('sessionEnd') },
      unsubscribeToolProgress: step('toolUnsubscribe'),
      unsubscribeHookEvents: step('hookUnsubscribe'),
      mcpControlRef: { dispose: step('mcp') },
      runner: { dispose: step('runner') },
      transcriptWriter: { close: step('transcript'), flush: step('flush') },
    });

    const first = session.close();
    expect(session.close()).toBe(first);
    const channelStage = ['sessionEnd', 'interrupt', 'discard', 'flush'].includes(
      failure,
    );
    if (channelStage) {
      await expect(first).resolves.toBeUndefined();
    } else {
      await expect(first).rejects.toBe(error);
      await expect(session.close()).rejects.toBe(error);
    }

    // 信道阶段在前（interrupt → discard → SessionEnd → flush），退休阶段随后；
    // 任一阶段失败都不跳过其余释放。
    expect(calls).toEqual([
      'interrupt', 'discard', 'sessionEnd', 'flush',
      'background', 'commands', 'transcriptUnsubscribe', 'cancel', 'scheduler',
      'taskBridge', 'pipelines', 'broadcast',
      'toolUnsubscribe', 'hookUnsubscribe', 'mcp', 'runner', 'transcript', 'config', 'clear',
    ]);
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('汇总多个退休错误，Config 释放失败也不跳过最后的命令清理', async () => {
    const options = params();
    const session = new ThreadSession(options);
    const runtimeError = new Error('runtime failed');
    const configError = new Error('config failed');
    const internals = session as unknown as {
      drainBackgroundWork(): Promise<void>;
    };
    vi.spyOn(lifecycle, 'interruptTurn').mockResolvedValue();
    vi.spyOn(internals, 'drainBackgroundWork').mockRejectedValue(runtimeError);
    const clear = vi.fn();
    const drainPipelines = vi
      .spyOn(
        session as unknown as { drainSessionPipelines(): Promise<void> },
        'drainSessionPipelines',
      )
      .mockResolvedValue();
    Object.assign(session, {
      config: {
        dispose: vi.fn().mockRejectedValue(configError),
      },
      commands: {
        discardQueuedAndReport: vi.fn(),
        dispose: vi.fn(),
        clear,
      },
      sessionEndCloseout: { run: vi.fn() },
    });
    const agg = await session.close().catch((failure: unknown) => failure);
    expect(drainPipelines).toHaveBeenCalled();
    expect(agg).toMatchObject({
      errors: [runtimeError, configError],
    });
    expect(clear).toHaveBeenCalledOnce();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('宿主记忆管线失败后仍等 AutoDream 结束，之后才释放 Config', async () => {
    const options = params();
    const session = new ThreadSession(options);
    const error = new Error('memory failed');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const drainDream = vi
      .spyOn(core, 'drainAutoDream')
      .mockImplementation(() => pending);
    options.host.requests.memory = {
      prepare: vi.fn(),
      refreshMemory: vi.fn(),
      flushMemory: vi.fn(),
      flushSkillEvolution: vi.fn(),
      drain: vi.fn().mockRejectedValue(error),
    };
    const dispose = vi.fn();
    const internals = session as unknown as {
      drainBackgroundWork(): Promise<void>;
    };
    vi.spyOn(lifecycle, 'interruptTurn').mockResolvedValue();
    vi.spyOn(internals, 'drainBackgroundWork').mockResolvedValue();
    Object.assign(session, {
      config: {
        dispose,
      },
      commands: {
        discardQueuedAndReport: vi.fn(),
        dispose: vi.fn(),
        clear: vi.fn(),
      },
      sessionEndCloseout: { run: vi.fn() },
    });
    const closed = session.close();
    const rejected = closed.catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(drainDream).toHaveBeenCalledOnce());
    expect(dispose).not.toHaveBeenCalled();
    finish();
    expect(await rejected).toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('当前 turn 结算后才关闭 transcript writer', async () => {
    const options = params();
    const session = new ThreadSession(options);
    let finishTurn!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const calls: string[] = [];
    const internals = session as unknown as {
      drainBackgroundWork(): Promise<void>;
      drainSessionPipelines(): Promise<void>;
    };
    vi.spyOn(internals, 'drainBackgroundWork').mockResolvedValue();
    vi.spyOn(internals, 'drainSessionPipelines').mockResolvedValue();
    Object.assign(session, {
      config: { dispose: vi.fn() },
      commands: {
        cancelAndDrain: vi.fn(async () => {
          calls.push('waitTurn');
          await turnFinished;
          calls.push('turnFinished');
        }),
        interruptTurn: vi.fn(),
        discardQueuedAndReport: vi.fn(),
        dispose: vi.fn(),
        clear: vi.fn(),
      },
      sessionEndCloseout: { run: vi.fn(async () => {}) },
      transcriptWriter: {
        flush: vi.fn(async () => {}),
        close: vi.fn(() => {
          calls.push('transcriptClosed');
        }),
      },
    });

    const closed = session.close();
    await vi.waitFor(() => expect(calls).toContain('waitTurn'));
    expect(calls).not.toContain('transcriptClosed');

    finishTurn();
    await closed;
    expect(calls).toEqual(['waitTurn', 'turnFinished', 'transcriptClosed']);
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});

describe('ThreadSession refreshMemory', () => {
  it('刷新记忆后失效请求快照', async () => {
    const options = params();
    const session = new ThreadSession(options);
    const refresh = vi.fn(async () => {});
    const refreshRuntimeContext = vi.fn();
    const internals = session as unknown as {
      memoryEnabled: boolean;
      runner: { refreshRuntimeContext: typeof refreshRuntimeContext } | null;
    };
    internals.memoryEnabled = true;
    options.host.requests.memory = {
      prepare: vi.fn(),
      refreshMemory: refresh,
      flushMemory: vi.fn(),
      flushSkillEvolution: vi.fn(),
      drain: vi.fn(),
    };
    internals.runner = { refreshRuntimeContext };

    await session.refreshMemory({} as never);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
      refreshRuntimeContext.mock.invocationCallOrder[0],
    );
    expect(refreshRuntimeContext).toHaveBeenCalledWith({
      invalidateRequestSnapshot: true,
    });
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});

describe('ThreadSession flush 有界等待', () => {
  afterEach(() => vi.useRealTimers());

  function setupFlush(flag: 'memoryEnabled' | 'skillEvolutionEnabled') {
    vi.useFakeTimers();
    const options = params();
    const session = new ThreadSession(options);
    const pending = new Promise<void>(() => {});
    const internals = session as unknown as Record<string, unknown>;
    internals[flag] = true;
    const flushMemory = vi.fn(() => pending);
    const flushSkillEvolution = vi.fn(() => pending);
    options.host.requests.memory = {
      prepare: vi.fn(),
      refreshMemory: vi.fn(),
      flushMemory,
      flushSkillEvolution,
      drain: vi.fn(),
    } as never;
    return { options, session, flushMemory, flushSkillEvolution };
  }

  it('后台记忆管线卡住时，flush_memory 到点回执', async () => {
    const { options, session, flushMemory } = setupFlush('memoryEnabled');
    let settled = false;
    const flushing = session.flushMemory({} as never).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushing;
    expect(settled).toBe(true);
    expect(flushMemory).toHaveBeenCalledTimes(1);
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it('后台技能进化管线卡住时，flush_skill_evolution 到点回执', async () => {
    const { options, session, flushSkillEvolution } = setupFlush(
      'skillEvolutionEnabled',
    );
    let settled = false;
    const flushing = session.flushSkillEvolution({} as never).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushing;
    expect(settled).toBe(true);
    expect(flushSkillEvolution).toHaveBeenCalledTimes(1);
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});

describe('ThreadSession goal kickoff 收尾窗口', () => {
  it('result 已出时登记 pending，settle 后恰好补启动一次', async () => {
    const options = params();
    const session = new ThreadSession(options);
    const kickoff = vi.fn(async (_msg: unknown) => {});
    const state = { finishing: true, running: true, queued: [] as string[] };
    const internals = session as unknown as {
      config: unknown;
      commands: {
        isTurnFinishing(): boolean;
        isTurnRunning(): boolean;
        queuedUuids(): readonly string[];
      };
      runInlineTurn(msg: unknown): Promise<void>;
      flushPendingGoalKickoff(): void;
    };
    internals.config = {
      getGoalManager: () => ({
        getGoal: () => ({
          id: 'g-1',
          status: GoalStatus.Active,
          objective: 'o',
          turnsUsed: 0,
          timeUsedSeconds: 0,
          creditsUsed: 0,
          createdAt: 0,
          updatedAt: 0,
          customContext: { tenant: 'alpha' },
        }),
      }),
    };
    internals.runInlineTurn = kickoff;
    internals.commands = {
      isTurnFinishing: () => state.finishing,
      isTurnRunning: () => state.running,
      queuedUuids: () => state.queued,
    };

    session.continueGoalIfIdle();
    expect(kickoff).not.toHaveBeenCalled();

    state.finishing = false;
    state.running = false;
    internals.flushPendingGoalKickoff();
    await Promise.resolve();

    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]?.[0]).toMatchObject({
      isSynthetic: true,
      isMeta: true,
      commandMode: 'prompt',
      custom_context: { tenant: 'alpha' },
    });

    internals.flushPendingGoalKickoff();
    await Promise.resolve();
    expect(kickoff).toHaveBeenCalledTimes(1);

    await options.resourceService.dispose();
  });
});

describe('ThreadSession fork transcript mirror', () => {
  it('without sessionMirror drops supplied creation entries immediately', async () => {
    const options = params();
    const session = new ThreadSession({
      ...options,
      forked: true,
      resumeData: {
        forkTranscriptEntries: [
          { type: 'custom-title', customTitle: 'inherited' },
        ] as never,
        resumeState: {} as never,
        messages: [],
        fileHistorySnapshots: [],
        sourceSessionId: 'source',
      },
    });
    const retained = session as unknown as {
      params: ThreadSessionParams;
      forkTranscriptEntries?: unknown;
      pendingForkResumeData?: { forkTranscriptEntries?: unknown };
    };
    expect(retained.params.resumeData).toBeUndefined();
    expect(retained.forkTranscriptEntries).toBeUndefined();
    expect(
      retained.pendingForkResumeData?.forkTranscriptEntries,
    ).toBeUndefined();
    await session.close();
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });

  it.each(['success', 'replay-failure'] as const)(
    'actual startup orders observer, replay and initialization, and releases entries: %s',
    async (outcome) => {
      const base = params();
      const options: ThreadSessionParams = {
        ...base,
        customProviderManager: new CustomProviderManager(base.settingsService),
      };
      const order: string[] = [];
      const entries = [
        { type: 'custom-title', customTitle: 'inherited' },
      ] as never;
      const failure = new Error(outcome);
      let observer: ((path: string, entries: never) => void) | undefined;
      const unsubscribe = vi.fn(() => {
        observer = undefined;
      });
      const manager = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      const config = {
        getSessionId: () => 'startup-cleanup',
        setBusinessType: vi.fn(),
        toolCallSnapshots: new core.InMemoryToolCallSnapshotStore(),
        getHookSystem: () => undefined,
        getTranscriptStore: () => ({
          addCommitObserver(callback: typeof observer) {
            order.push('observer');
            observer = callback;
            return unsubscribe;
          },
        }),
        getModelProviderManager: () => manager,
        initialize: vi.fn(async () => {
          await manager.start();
          order.push('initialize');
          observer?.('/tmp/fork.jsonl', [
            { type: 'custom-title', customTitle: 'initialized' },
          ] as never);
        }),
        dispose: vi.fn(async () => {
          await manager.stop();
        }),
      };
      vi.mocked(loadCliConfig).mockResolvedValue(config as never);
      vi.spyOn(options.settingsService, 'resolve').mockReturnValue({} as never);
      const emit = vi.fn((event: { entries?: unknown }) => {
        expect(observer).toBeDefined();
        if (
          event.entries === entries ||
          JSON.stringify(event.entries) === JSON.stringify(entries)
        ) {
          order.push('replay');
          if (outcome === 'replay-failure') throw failure;
        } else order.push('commit');
      });
      // Keep real start/create/close lifecycle; isolate unrelated model, auth and bridge phases.
      const phaseLog = {
        phase: async (name: string, _detail: string, run: () => unknown) =>
          ['构造会话 Config', 'Config 初始化'].includes(name)
            ? run()
            : undefined,
        phaseSync: (name: string, _detail: string, run: () => unknown) =>
          name === '读取会话设置' ? run() : undefined,
      } as unknown as ThreadSessionParams['phaseLog'];
      let session: ThreadSession | undefined;
      const start = lifecycle.start;
      vi.spyOn(lifecycle, 'start').mockImplementation(function (
        this: ThreadSession,
      ) {
        // oxlint-disable-next-line typescript/no-this-alias -- 捕获 spy 的接收者，用于后续断言会话内部状态。
        session = this;
        return start.call(this);
      });
      try {
        const created = ThreadSession.create({
          ...options,
          phaseLog,
          host: {
            events: { emit },
            requests: {},
          } as unknown as ThreadSessionParams['host'],
          forked: true,
          cliArgs: { sessionMirror: true } as ThreadSessionParams['cliArgs'],
          resumeTranscriptPath: '/tmp/fork.jsonl',
          resumeData: {
            forkTranscriptEntries: entries,
            resumeState: {} as never,
            messages: [],
            fileHistorySnapshots: [],
            sourceSessionId: 'source',
          },
        });
        if (outcome === 'success') await created;
        else await expect(created).rejects.toBe(failure);
        expect(vi.mocked(loadCliConfig).mock.lastCall?.[3]?.customProviderManager).toBe(options.customProviderManager);
        expect(order).toEqual(
          outcome === 'replay-failure'
            ? ['observer', 'replay']
            : ['observer', 'replay', 'initialize', 'commit'],
        );
        expect(
          (session as unknown as { forkTranscriptEntries?: unknown })
            .forkTranscriptEntries,
        ).toBeUndefined();
        if (outcome !== 'success') {
          expect(
            (session as unknown as { pendingForkResumeData?: unknown })
              .pendingForkResumeData,
          ).toBeUndefined();
        }
        await session?.close();
        expect(config.initialize).toHaveBeenCalledTimes(
          outcome === 'success' ? 1 : 0,
        );
        expect(manager.start).toHaveBeenCalledTimes(
          outcome === 'success' ? 1 : 0,
        );
        expect(config.dispose).toHaveBeenCalledOnce();
        expect(manager.stop).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      } finally {
        await session?.close();
        await options.resourceService.dispose();
        await options.settingsService.dispose();
      }
    },
  );

  it('fork + sessionMirror 补发初始 transcript_mirror', async () => {
    const entries = [
      { type: 'user', uuid: 'entry-1' },
      { type: 'custom-title', customTitle: 'Fork title' },
    ] as never;
    const options: ThreadSessionParams = {
      ...params(),
      forked: true,
      cliArgs: {
        forkSession: true,
        sessionMirror: true,
      } as ThreadSessionParams['cliArgs'],
      resumeTranscriptPath: '/tmp/fork.jsonl',
      resumeData: {
        forkTranscriptEntries: entries,
        resumeState: {} as never,
        messages: [],
        fileHistorySnapshots: [],
        sourceSessionId: 'source',
      },
    };
    const session = new ThreadSession(options);
    const emit = vi.fn();
    const internals = session as unknown as {
      host: ThreadSessionParams['host'];
      emitForkTranscriptMirror(): Promise<void>;
    };
    internals.host = {
      events: { emit },
      requests: {},
    } as unknown as ThreadSessionParams['host'];

    expect(
      (session as unknown as { params: ThreadSessionParams }).params.resumeData,
    ).toBeUndefined();
    await internals.emitForkTranscriptMirror();
    expect(
      (session as unknown as { forkTranscriptEntries?: unknown })
        .forkTranscriptEntries,
    ).toBeUndefined();

    expect(emit).toHaveBeenCalledWith({
      kind: 'transcriptMirror',
      filePath: '/tmp/fork.jsonl',
      entries,
    });
    await options.resourceService.dispose();
  });
});

describe('ThreadSession 后台子 Agent 事件泵', () => {
  it('后台任务注册后把 progress 与正文增量投给宿主', () => {
    const options = params();
    const session = new ThreadSession(options);
    const emit = vi.fn();
    const progressEvent = {
      type: 'system',
      subtype: 'task_progress',
      content: '',
      level: 'info',
      task_id: 'agent-task-1',
      tool_use_id: 'toolu-parent',
      uuid: 'progress-1',
    } as unknown as QueryEvent;
    enqueueSubagentSdkEvent(options.sessionId, progressEvent);

    const internals = session as unknown as {
      host: ThreadSessionParams['host'];
      runner: {
        projectSubagentEvent(event: QueryEvent): Generator<unknown>;
      } | null;
      taskRegistryRef: { all(): unknown[] } | undefined;
      pumpBackgroundSubagentEvents(): void;
      stopBackgroundSubagentPump(): void;
    };
    internals.host = {
      events: { emit },
      requests: {},
    } as unknown as ThreadSessionParams['host'];
    internals.runner = {
      *projectSubagentEvent(event) {
        yield {
          type: 'system',
          subtype: 'task_progress',
          uuid: (event as unknown as { uuid?: string }).uuid,
        };
      },
    };
    internals.taskRegistryRef = {
      all: () => [
        {
          id: 'a-agent-1',
          publicId: 'agent-task-1',
          taskId: 'agent-task-1',
          type: 'local_agent',
          status: 'running',
          isBackgrounded: true,
          toolUseId: 'toolu-parent',
        },
      ],
    };

    internals.pumpBackgroundSubagentEvents();

    expect(emit).toHaveBeenCalledWith({
      kind: 'threadMessage',
      message: {
        type: 'system',
        subtype: 'task_progress',
        uuid: 'progress-1',
      },
    });
    internals.stopBackgroundSubagentPump();
    disposeSessionEventQueue(options.sessionId);
  });
});

describe('acknowledged session checkpoint', () => {
  it.each([{ messages: [] }, { messages: [{ uuid: 'existing-message' }] }])(
    'durably records the current leaf without discarding existing history: %j',
    async ({ messages }) => {
      const options = params();
      const session = new ThreadSession(options);
      const recordActiveLeaf = vi.fn(async () => {});
      Object.assign(session, { transcriptWriter: { recordActiveLeaf } });
      vi.spyOn(session, 'getQueryRunner').mockResolvedValue({
        getMessages: () => messages,
      } as never);
      await session.persistSessionCheckpoint();
      expect(recordActiveLeaf).toHaveBeenCalledWith(
        messages.at(-1)?.uuid ?? null,
        { explicit: true, durable: true },
      );
      await options.resourceService.dispose();
      await options.settingsService.dispose();
    },
  );

  it('does not acknowledge success when persistence fails', async () => {
    const options = params();
    const session = new ThreadSession(options);
    Object.assign(session, {
      transcriptWriter: {
        recordActiveLeaf: vi.fn().mockRejectedValue(new Error('disk full')),
      },
    });
    vi.spyOn(session, 'getQueryRunner').mockResolvedValue({
      getMessages: () => [],
    } as never);
    await expect(session.persistSessionCheckpoint()).rejects.toThrow(
      'disk full',
    );
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});


describe('startup hook interrupt wiring', () => {
  it.each(['interrupt', 'interruptTurn'] as const)('%s cancels startup before waiting for the turn', async (method) => {
    const options = params();
    const session = new ThreadSession(options);
    const calls: string[] = [];
    Object.assign(session, {
      hooks: { cancelStart: () => calls.push('startup') },
      commands: {
        interrupt: () => { calls.push('turn'); return Promise.resolve({}); },
        interruptTurn: () => calls.push('turn'),
      },
    });
    if (method === 'interrupt') await session.interrupt({} as never);
    else session.interruptTurn();
    expect(calls).toEqual(['startup', 'turn']);
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});

describe('ThreadSession 后台收尾策略', () => {
  it.each([
    ['未注入时用 core 缺省策略', undefined, 600_000, 10_000],
    [
      '宿主注入的策略原样生效',
      { waitCeilingMs: 3_000 },
      3_000,
      undefined,
    ],
  ] as const)('%s', async (_label, policy, waitCeilingMs, boundMs) => {
    const options: ThreadSessionParams = {
      ...params(),
      backgroundWindDownPolicy: policy,
    };
    const session = new ThreadSession(options);
    Object.assign(session, {
      taskRegistryRef: { all: () => [] },
      commands: {
        hasOwnContinuation: () => false,
        drainContinuations: async () => 0,
      },
    });
    const log = vi.spyOn(core.runLogger, 'log');

    await (
      session as unknown as { drainBackgroundWork(): Promise<void> }
    ).drainBackgroundWork();

    expect(log).toHaveBeenCalledWith(
      '[thread-session] background wind-down entered',
      { sessionId: options.sessionId, waitCeilingMs, boundMs },
    );
    await options.resourceService.dispose();
    await options.settingsService.dispose();
  });
});


describe('ThreadSession managed mode admission', () => {
  it.each(['auto', 'yolo'] as const)(
    'checks the latest %s policy after preparation and when queued input executes',
    async (mode) => {
      const options = { ...params(), sessionId: `managed-admission-${mode}` };
      const session = new ThreadSession(options);
      let selectedMode: core.PermissionMode = mode;
      let restricted = false;
      const reason = `企业管理员已禁用${mode}模式，如需开启，请联系您所在企业的管理员`;
      let finishPreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      const ensureStart = vi.fn(() => preparation);
      Object.assign(session, {
        config: {
          getPermissionMode: () => selectedMode,
          getPermissionModeRestriction: (value: core.PermissionMode) =>
            restricted && value === mode
              ? reason
              : undefined,
        },
        hooks: { ensureStart, cancelStart: vi.fn() },
      });
      vi.spyOn(
        startupModePolicy,
        'waitForNonInteractiveRequestReady',
      ).mockResolvedValue(undefined);
      vi.spyOn(session, 'getQueryRunner').mockResolvedValue({} as never);
      // Stop ordinary input just after admission, without calling a real model.
      const admitted = new Error('model admission reached');
      const emitInit = vi
        .spyOn(
          session as unknown as { emitInitMessage(): Promise<void> },
          'emitInitMessage',
        )
        .mockRejectedValue(admitted);
      const emit = vi.mocked(options.host.events.emit);
      const failures = () =>
        emit.mock.calls
          .map(([event]) => event)
          .filter(
            (event): event is Extract<ThreadEvent, { kind: 'turnFailed' }> =>
              event.kind === 'turnFailed',
          );
      const message = (uuid: string) => ({
        type: 'user' as const,
        uuid,
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'hello' }],
        },
      });
      const commands = (
        session as unknown as {
          commands: {
            cancelAndDrain(): Promise<void>;
            clear(): void;
            dispose(): void;
          };
        }
      ).commands;
      try {
        await expect(
          session.submitMessage({} as never, message(`${mode}-first`)),
        ).resolves.toMatchObject({ disposition: 'queued' });
        await vi.waitFor(() => expect(ensureStart).toHaveBeenCalledOnce());
        await session.submitMessage({} as never, message(`${mode}-queued`));
        restricted = true;
        for (const priority of ['next', 'now'] as const) {
          await session.submitMessage({} as never, {
            ...message(`${mode}-insert-${priority}`),
            priority,
          });
        }
        expect(failures()).toHaveLength(2);
        expect(session.isTurnRunning()).toBe(true);
        expect(session.queuedCommandUuids()).toEqual([`${mode}-queued`]);
        finishPreparation();
        await vi.waitFor(() => expect(failures()).toHaveLength(4));
        expect(failures().map((event) => event.error)).toEqual([
          expect.any(core.PermissionModeUnavailableError),
          expect.any(core.PermissionModeUnavailableError),
          expect.any(core.PermissionModeUnavailableError),
          expect.any(core.PermissionModeUnavailableError),
        ]);
        expect(emitInit).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
        expect(session.queuedCommandUuids()).toEqual([]);

        selectedMode = 'default';
        await session.submitMessage({} as never, message(`${mode}-ordinary`));
        await vi.waitFor(() => expect(failures()).toHaveLength(5));
        expect(failures()[4].error).toBe(admitted);
        expect(emitInit).toHaveBeenCalledOnce();
      } finally {
        finishPreparation();
        await commands.cancelAndDrain();
        commands.clear();
        commands.dispose();
        await options.resourceService.dispose();
        await options.settingsService.dispose();
      }
    },
  );
});

describe('ThreadSession 诊断 segment 目录', () => {
  it('启动时把会话声明的目录绑定到 sessionLogger', async () => {
    const options = params();
    const bind = vi.spyOn(core.sessionLogger, 'bindSessionProject');
    vi.mocked(loadCliConfig).mockRejectedValue(new Error('config failed'));
    try {
      const session = new ThreadSession(options);
      await expect(
        (session as unknown as { start(): Promise<void> }).start(),
      ).rejects.toThrow();
      expect(bind).toHaveBeenCalledWith('startup-cleanup', '/project');
    } finally {
      await options.resourceService.dispose();
      await options.settingsService.dispose();
    }
  });

  it('退休时解除目录绑定', async () => {
    const options = params();
    const clear = vi.spyOn(core.sessionLogger, 'clearSessionProject');
    try {
      const session = new ThreadSession(options);
      await (session as unknown as { retire(): Promise<void> }).retire();
      expect(clear).toHaveBeenCalledWith('startup-cleanup');
    } finally {
      await options.resourceService.dispose();
      await options.settingsService.dispose();
    }
  });
});
