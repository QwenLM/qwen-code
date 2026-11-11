/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话关闭前收尾要锁的不变量，按「破了就能被 SDK 侧看见」排：
 *
 * 1. **到点必须真的收尾，而且只按 executionId 逐个杀。** 进程内会话没有 worker 那道
 *    SIGTERM 兜底：漏杀就是没有归属的孤儿执行，漏发 `task_notification{status:'stopped'}`
 *    就让 SDK 侧那个任务永远停在 running。`terminateAll()` 背后是进程级 static 登记表，
 *    调它会杀掉**所有**会话的后台任务，所以「绝不调用它」跟着逐个杀一起锁。
 * 2. **硬界（policy.boundMs）在没有运行中任务时也要触发。** 等待上限只在还有运行中
 *    任务时才收尾，管不到「只剩一个永远不来的终态通知」那个状态；不自己掐表就要等满
 *    240s 的 expired 才走得掉，daemon 控制面被钉死。这是 thread 独有的一条，单独锁。
 * 3. **不该收的不收。** 进程内队友与通知支撑型任务（shell / agent / workflow）自己会把
 *    结果送出来，为它们启动 5s 宽限收尾等于把正常完成的任务报成 stopped。
 * 4. **终态通知优先让路 240s**，到点标 expired、warn 一行、之后不再为它阻塞退出；
 *    `waits` 必须跨轮持有，每轮重建就等于永远等不到那个上限。
 * 5. **等待上限 = min(waitCeilingMs, boundMs)**，`waitCeilingMs` 为 `0`（无限等）时
 *    等待上限不生效，只剩硬界能收尾——无限等在 daemon 形态下是不可接受的。
 * 6. **上限触发时走 runLogger.warn 而不是 stderr**：daemon 的 stderr 是进程级共享的，
 *    多个会话往同一条流写会互相插话。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRAND_FIXED_ENV_PREFIX,
  DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
  ExecutionLifecycleService,
  runLogger,
  type AgentUnifiedTask,
  type BackgroundWindDownPolicy,
  type BashUnifiedTask,
  type InternalAgentUnifiedTask,
  type TaskRegistry,
  type UnifiedTask,
  type VideoGenUnifiedTask,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import {
  drainBackgroundWorkBeforeClose,
  getTaskNotificationId,
  hasPendingTerminalTaskNotifications,
  isNotificationBackedBackgroundTask,
  isPendingTerminalTaskNotification,
  isRunningBackgroundTask,
  type BackgroundWindDownParams,
} from './backgroundWindDown.js';
import { readPrintBackgroundWindDownPolicy } from '../../../headless/backgroundWindDownPolicy.js';

const TASK_BASE = {
  startTime: 0,
  notified: false,
  completionBehavior: 'notify',
} as const;

function bashTask(overrides: Partial<BashUnifiedTask> = {}): BashUnifiedTask {
  return {
    ...TASK_BASE,
    id: 'b-1',
    type: 'local_bash',
    status: 'running',
    description: 'background shell',
    executionId: 9001,
    command: 'sleep 30',
    isBackgrounded: true,
    output: '',
    ...overrides,
  };
}

function agentTask(
  overrides: Partial<AgentUnifiedTask> = {},
): AgentUnifiedTask {
  return {
    ...TASK_BASE,
    id: 'a-1',
    type: 'local_agent',
    status: 'running',
    description: 'background agent',
    executionId: 9002,
    agentId: 'agent-1',
    agentName: 'explore',
    agentType: 'general-purpose',
    prompt: 'explore the repo',
    isBackgrounded: true,
    taskId: 'agent-task-1',
    ...overrides,
  };
}

function teammateTask(
  overrides: Partial<AgentUnifiedTask> = {},
): AgentUnifiedTask {
  return agentTask({
    id: 't-1',
    type: 'in_process_teammate',
    description: 'teammate',
    executionId: 9006,
    ...overrides,
  });
}

function workflowTask(
  overrides: Partial<WorkflowUnifiedTask> = {},
): WorkflowUnifiedTask {
  return {
    ...TASK_BASE,
    id: 'wf-1',
    type: 'local_workflow',
    status: 'running',
    description: 'background workflow',
    executionId: 9003,
    workflowRunId: 'run-1',
    workflowName: 'wf',
    scriptPath: '/tmp/wf.js',
    transcriptDir: '/tmp/transcripts',
    progress: [],
    logs: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    ...overrides,
  };
}

function videoGenTask(
  overrides: Partial<VideoGenUnifiedTask> = {},
): VideoGenUnifiedTask {
  return {
    ...TASK_BASE,
    id: 'v-1',
    type: 'local_video_gen',
    status: 'running',
    description: 'background video',
    executionId: 9004,
    videoId: 'video_1',
    prompt: 'a video',
    isBackgrounded: true,
    ...overrides,
  };
}

function internalAgentTask(
  overrides: Partial<InternalAgentUnifiedTask> = {},
): InternalAgentUnifiedTask {
  return {
    ...TASK_BASE,
    id: 'i-1',
    type: 'internal_agent',
    status: 'running',
    description: 'internal memory agent',
    executionId: 9005,
    agentName: 'memory',
    agentType: 'memory',
    prompt: 'extract memories',
    isBackgrounded: true,
    killable: true,
    ...overrides,
  };
}

function setup(
  options: { tasks?: UnifiedTask[]; policy?: BackgroundWindDownPolicy } = {},
) {
  const tasks = options.tasks ?? [];
  const order: string[] = [];
  const killExecution = vi
    .spyOn(ExecutionLifecycleService, 'kill')
    .mockResolvedValue(undefined);
  const terminateAll = vi
    .spyOn(ExecutionLifecycleService, 'terminateAll')
    .mockResolvedValue(undefined);
  const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  const stderrWrite = vi
    .spyOn(process.stderr, 'write')
    .mockReturnValue(true as never);
  const registryKill = vi.fn();
  const notifyStopped = vi.fn();
  const hasQueuedContinuation = vi.fn(() => false);
  const drainContinuations = vi.fn(async () => {
    order.push('drain');
    return 0;
  });
  const abort = new AbortController();

  const params: BackgroundWindDownParams = {
    sessionId: 's-1',
    taskRegistry: {
      all: () => [...tasks],
      kill: registryKill,
    } as unknown as TaskRegistry,
    notifyStopped: (notification) => {
      order.push('notify');
      notifyStopped(notification);
    },
    signal: abort.signal,
    policy: options.policy ?? { waitCeilingMs: 600_000 },
    hasQueuedContinuation,
    drainContinuations,
  };

  const notifications = () =>
    notifyStopped.mock.calls.map(
      (call) => call[0] as { taskId: string; summary: string },
    );
  const warnings = () => warn.mock.calls.map((call) => String(call[0]));

  return {
    tasks,
    order,
    params,
    abort,
    notifyStopped,
    warn,
    stderrWrite,
    killExecution,
    terminateAll,
    registryKill,
    hasQueuedContinuation,
    drainContinuations,
    notifications,
    warnings,
  };
}

const runningCases: Array<[string, UnifiedTask, boolean]> = [
  ['在跑的后台 shell 算', bashTask(), true],
  ['排队中的后台 shell 算', bashTask({ status: 'pending' }), true],
  [
    '前台 shell（isBackgrounded=false）不算',
    bashTask({ isBackgrounded: false }),
    false,
  ],
  ['已完成的 shell 不算', bashTask({ status: 'completed' }), false],
  ['internal_agent 永远不算', internalAgentTask(), false],
  ['在跑的进程内队友算', teammateTask(), true],
  [
    '空闲的进程内队友不算——它只是挂着等下一条消息',
    teammateTask({ isIdle: true }),
    false,
  ],
  ['在跑的视频生成任务算', videoGenTask(), true],
];

const notificationBackedCases: Array<[string, UnifiedTask, boolean]> = [
  ['local_bash 是通知支撑型', bashTask(), true],
  ['local_agent 是通知支撑型', agentTask(), true],
  ['local_workflow 是通知支撑型', workflowTask(), true],
  ['in_process_teammate 不是通知支撑型', teammateTask(), false],
  ['local_video_gen 不是通知支撑型', videoGenTask(), false],
  ['internal_agent 不是通知支撑型', internalAgentTask(), false],
];

const pendingTerminalCases: Array<[string, UnifiedTask, boolean]> = [
  ['终态且未通知的后台 shell 待发', bashTask({ status: 'completed' }), true],
  ['终态且未通知的后台 agent 待发', agentTask({ status: 'failed' }), true],
  ['终态且未通知的 workflow 待发', workflowTask({ status: 'killed' }), true],
  [
    '已通知过的终态 shell 不再待发',
    bashTask({ status: 'completed', notified: true }),
    false,
  ],
  ['仍在跑的 shell 还没到终态', bashTask(), false],
  [
    '前台 shell 即使终态未通知也不待发',
    bashTask({ status: 'completed', isBackgrounded: false }),
    false,
  ],
  [
    '终态的进程内队友不发这类通知',
    teammateTask({ status: 'completed' }),
    false,
  ],
  [
    '终态的视频生成任务不发这类通知',
    videoGenTask({ status: 'completed' }),
    false,
  ],
];

describe('backgroundWindDown: 任务判定', () => {
  it.each(runningCases)('在跑判定：%s', (_label, task, expected) => {
    expect(isRunningBackgroundTask(task)).toBe(expected);
  });

  it.each(notificationBackedCases)(
    '通知支撑型判定：%s',
    (_label, task, expected) => {
      expect(isNotificationBackedBackgroundTask(task)).toBe(expected);
    },
  );

  it.each(pendingTerminalCases)(
    '待发终态通知判定：%s',
    (_label, task, expected) => {
      expect(isPendingTerminalTaskNotification(task)).toBe(expected);
    },
  );

  it('通知 id：local_agent 用 taskId，其余用 publicId，缺 publicId 才回落 id', () => {
    expect(
      getTaskNotificationId(
        agentTask({ taskId: 'agent-task-9', publicId: 'pub-9' }),
      ),
    ).toBe('agent-task-9');
    expect(getTaskNotificationId(bashTask({ publicId: 'pub-1' }))).toBe(
      'pub-1',
    );
    expect(getTaskNotificationId(bashTask({ publicId: undefined }))).toBe(
      'b-1',
    );
  });
});

describe('backgroundWindDown: 终态通知让路计时', () => {
  type TerminalWaits = Map<string, { firstSeenAt: number; expired: boolean }>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits 跨轮持有：同一任务的 240s 计时连续，expired 后不再重复 warn', () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const waits: TerminalWaits = new Map();
    const tasks = [bashTask({ status: 'completed', notified: false })];

    expect(hasPendingTerminalTaskNotifications(waits, tasks, 0, 's-1')).toBe(
      true,
    );
    expect(
      hasPendingTerminalTaskNotifications(waits, tasks, 239_999, 's-1'),
    ).toBe(true);
    expect(
      hasPendingTerminalTaskNotifications(waits, tasks, 240_000, 's-1'),
    ).toBe(false);
    expect(warn.mock.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      'was not queued within 240000ms',
    );
    expect(warn.mock.calls[0]![1]).toEqual({ sessionId: 's-1' });

    expect(
      hasPendingTerminalTaskNotifications(waits, tasks, 300_000, 's-1'),
    ).toBe(false);
    expect(warn.mock.calls).toHaveLength(1);
  });

  it('任务从 registry 消失后清掉对应 waits 条目，避免 Map 无界增长', () => {
    const waits: TerminalWaits = new Map();
    const gone = bashTask({ id: 'b-gone', status: 'completed' });
    hasPendingTerminalTaskNotifications(waits, [gone], 0, 's-1');
    expect(waits.size).toBe(1);

    hasPendingTerminalTaskNotifications(waits, [], 100, 's-1');
    expect(waits.size).toBe(0);
  });
});

describe('backgroundWindDown: 退出条件与让路规则', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('没有排队续跑、没有在跑任务、没有待发终态通知时立刻返回，不再轮询', async () => {
    const harness = setup({
      tasks: [bashTask({ status: 'completed', notified: true })],
    });

    await drainBackgroundWorkBeforeClose(harness.params);

    expect(harness.drainContinuations).toHaveBeenCalledTimes(1);
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.registryKill).not.toHaveBeenCalled();
  });

  it('会话信号已中止时一轮都不进，连排干续跑都不做', async () => {
    const harness = setup({ tasks: [bashTask()] });
    harness.abort.abort();

    await drainBackgroundWorkBeforeClose(harness.params);

    expect(harness.drainContinuations).not.toHaveBeenCalled();
    expect(harness.notifications()).toHaveLength(0);
  });

  it('排队续跑没排完时不启动收尾，超过 5s 宽限也不上报 stopped', async () => {
    vi.useFakeTimers();
    const harness = setup({ tasks: [videoGenTask()] });
    harness.hasQueuedContinuation.mockReturnValue(true);
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.notifications()).toHaveLength(0);

    harness.hasQueuedContinuation.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5_200);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(1);
  });

  it('在跑的进程内队友挡住收尾，转成 idle 后立刻返回', async () => {
    vi.useFakeTimers();
    const teammate = teammateTask();
    const harness = setup({ tasks: [teammate] });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.killExecution).not.toHaveBeenCalled();

    teammate.isIdle = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(0);
  });

  it('通知支撑型任务在跑时不启动收尾，等它自己把结果送出来', async () => {
    vi.useFakeTimers();
    const shell = bashTask();
    const harness = setup({ tasks: [shell] });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.killExecution).not.toHaveBeenCalled();

    shell.status = 'completed';
    shell.notified = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(0);
  });

  it('非通知支撑型任务给满 5s 宽限，到点只上报 stopped、不按 executionId 杀', async () => {
    vi.useFakeTimers();
    const harness = setup({ tasks: [videoGenTask({ executionId: 9100 })] });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(4_900);
    expect(harness.notifications()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.killExecution).not.toHaveBeenCalled();
    expect(harness.registryKill).not.toHaveBeenCalled();
    expect(harness.notifications()).toEqual([
      { taskId: 'v-1', summary: 'background video' },
    ]);
  });

  it('终态通知优先让路 240s，到点标 expired、warn 一行后不再阻塞退出', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask({ status: 'completed', notified: false })],
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);
    let settled = false;
    void draining.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(239_900);
    expect(settled).toBe(false);
    expect(harness.notifications()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.warnings()).toEqual([
      expect.stringContaining('was not queued within 240000ms'),
    ]);
    expect(harness.warn.mock.calls[0]![1]).toEqual({ sessionId: 's-1' });
    expect(harness.notifications()).toHaveLength(0);
  });
});

describe('backgroundWindDown: 等待上限与硬界', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('core 缺省策略：600s 等待、10s 硬界', () => {
    expect(DEFAULT_BACKGROUND_WIND_DOWN_POLICY).toEqual({
      waitCeilingMs: 600_000,
      boundMs: 10_000,
    });
  });

  it('等待上限取 waitCeilingMs 与 boundMs 的较小值，触发时不给 5s 宽限', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask()],
      policy: { waitCeilingMs: 1_000, boundMs: 60_000 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.killExecution).toHaveBeenCalledWith(9001);
    expect(harness.warnings()).toEqual([
      expect.stringContaining('still running after 1s'),
    ]);
  });

  it('没有 boundMs 时只受 waitCeilingMs 约束', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask()],
      policy: { waitCeilingMs: 1_000 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.killExecution).toHaveBeenCalledWith(9001);
  });

  it('显式配置的 print 等待超过 10s 后仍等待后台 Agent，直到配置上限', async () => {
    vi.useFakeTimers();
    const envName = `${BRAND_FIXED_ENV_PREFIX.replace(/_$/, '')}CLI_PRINT_BG_WAIT_CEILING_MS`;
    const harness = setup({
      tasks: [agentTask()],
      policy: readPrintBackgroundWindDownPolicy({ [envName]: '30000' }),
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);
    let settled = false;
    void draining.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10_100);
    expect(settled).toBe(false);
    expect(harness.notifications()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(1);
    expect(harness.warnings()).toEqual([
      expect.stringContaining('still running after 30s'),
    ]);
  });

  it('显式配置为 0 时超过默认 600s 仍等待，后台 Agent 完成后正常退出', async () => {
    vi.useFakeTimers();
    const envName = `${BRAND_FIXED_ENV_PREFIX.replace(/_$/, '')}CLI_PRINT_BG_WAIT_CEILING_MS`;
    const harness = setup({
      tasks: [agentTask()],
      policy: readPrintBackgroundWindDownPolicy({ [envName]: '0' }),
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);
    let settled = false;
    void draining.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(600_100);
    expect(settled).toBe(false);
    expect(harness.notifications()).toHaveLength(0);

    harness.tasks[0]!.status = 'completed';
    harness.tasks[0]!.notified = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.warnings()).toHaveLength(0);
  });

  it('上限触发时 warn 带 sessionId，不写进程级 stderr', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [workflowTask()],
      policy: { waitCeilingMs: 1_000 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.stderrWrite).not.toHaveBeenCalled();
    expect(harness.warn.mock.calls[0]![1]).toEqual({ sessionId: 's-1' });
    expect(harness.warnings()).toEqual([
      expect.stringContaining('still running after 1s'),
    ]);
    expect(harness.registryKill).toHaveBeenCalledWith(
      'wf-1',
      'headless_wait_ceiling',
    );
  });

  it('waitCeilingMs 为 0（无限等）时等待上限不生效，只剩硬界能收尾', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask()],
      policy: { waitCeilingMs: 0, boundMs: 3_000 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(2_900);
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.killExecution).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.killExecution).toHaveBeenCalledWith(9001);
    expect(harness.warnings()).toEqual([
      expect.stringContaining('Giving up on background work after 3000ms'),
    ]);
  });

  it('硬界在「没有运行中任务、只剩待发终态通知」时也触发，不必等满 240s', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask({ status: 'completed', notified: false })],
      policy: { waitCeilingMs: 600_000, boundMs: 10_000 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);
    let settled = false;
    void draining.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(9_900);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();
    expect(harness.warnings()).toEqual([
      expect.stringContaining('Giving up on background work after 10000ms'),
    ]);
    expect(harness.notifications()).toHaveLength(0);
    expect(harness.killExecution).not.toHaveBeenCalled();
  });

  it('硬界触发时 workflow 无条件带 headless_wait_ceiling 理由，不看等待上限是否也到了', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [workflowTask()],
      policy: { waitCeilingMs: 600_000, boundMs: 10_000 },
    });
    // 第一轮排到一条续跑，等待计时被清零重来；于是硬界到点时按重置后的起点算，
    // 等待上限还差 100ms 才到，收到的理由仍然必须是 headless_wait_ceiling。
    harness.hasQueuedContinuation.mockReturnValueOnce(true);
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(10_100);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.registryKill).toHaveBeenCalledWith(
      'wf-1',
      'headless_wait_ceiling',
    );
    expect(harness.warnings()).toEqual([
      expect.stringContaining('Giving up on background work after 10000ms'),
    ]);
  });
});

describe('backgroundWindDown: 收尾动作', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('每个在跑的任务各发一帧 stopped，shell 按 executionId 逐个杀且不碰 terminateAll', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [
        bashTask({ id: 'b-1', executionId: 9001, publicId: 'pub-b1' }),
        bashTask({
          id: 'b-2',
          executionId: 9002,
          description: 'second shell',
        }),
        agentTask({ id: 'a-1', taskId: 'agent-task-1' }),
      ],
      policy: { waitCeilingMs: 1 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.killExecution.mock.calls).toEqual([[9001], [9002]]);
    expect(harness.terminateAll).not.toHaveBeenCalled();
    expect(harness.registryKill).not.toHaveBeenCalled();
    expect(harness.notifications().map((n) => n.taskId)).toEqual([
      'pub-b1',
      'b-2',
      'agent-task-1',
    ]);
  });

  it('收尾路径在上报完 stopped 后再排一次续跑', async () => {
    vi.useFakeTimers();
    const harness = setup({
      tasks: [bashTask()],
      policy: { waitCeilingMs: 1 },
    });
    const draining = drainBackgroundWorkBeforeClose(harness.params);

    await vi.advanceTimersByTimeAsync(200);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.order.slice(-2)).toEqual(['notify', 'drain']);
  });
});

describe('backgroundWindDown: 排干续跑失败', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // close() 没有 worker 那个 finally（headlessSession.ts:7017），排干一抛就会让会话
  // 在半路中断，留下正好是本模块要防的孤儿执行。所以这里必须既不上抛、也照样收尾。
  it('续跑排干抛错时不上抛，仍然收掉在跑的任务并发出 stopped 帧', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(runLogger, 'error').mockImplementation(() => {});
    const harness = setup({ tasks: [videoGenTask({ executionId: 9100 })] });
    harness.drainContinuations.mockRejectedValue(
      new Error('lost the wire frame for queued command'),
    );

    const draining = drainBackgroundWorkBeforeClose(harness.params);
    await vi.advanceTimersByTimeAsync(5_100);

    await expect(draining).resolves.toBeUndefined();
    expect(harness.notifications()).toHaveLength(1);
    expect(harness.notifications()[0]).toMatchObject({ taskId: 'v-1' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('draining queued continuations failed'),
      { sessionId: 's-1', error: expect.any(Error) },
    );
  });

  it('排干失败后不再重试：失败那条已出队，每轮 100ms 重抛同一个错没有意义', async () => {
    vi.useFakeTimers();
    vi.spyOn(runLogger, 'error').mockImplementation(() => {});
    const harness = setup({ tasks: [videoGenTask()] });
    harness.drainContinuations.mockRejectedValue(new Error('boom'));

    const draining = drainBackgroundWorkBeforeClose(harness.params);
    // 5s 宽限期里循环跑约 50 轮，重试的话调用次数会是几十次。
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(draining).resolves.toBeUndefined();

    expect(harness.drainContinuations).toHaveBeenCalledTimes(1);
  });
});
