/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话结束前的后台任务收尾：退出前排干排队的主线续跑，等待或强收仍在跑的后台任务，
 * 并逐个上报「已停止」事实；等待上限与硬界由宿主注入的 policy 决定。
 *
 * 到点必须真收：`close()` 返回后 daemon 还在跑，未收掉的任务会变成没有归属的孤儿执行。
 */

import {
  ExecutionLifecycleService,
  isInternalAgentTask,
  isTerminalStatus,
  runLogger,
  type BackgroundWindDownPolicy,
  type TaskRegistry,
  type UnifiedTask,
} from '@qwen-code/core';

/** 收尾轮询间隔、强收前的宽限期、终态通知等待上限。 */
const BACKGROUND_TASK_POLL_MS = 100;
const BACKGROUND_TASK_WIND_DOWN_GRACE_MS = 5_000;
const TERMINAL_NOTIFICATION_WAIT_MS = 240_000;

interface TerminalNotificationWait {
  firstSeenAt: number;
  expired: boolean;
}

/** 生效上限 = `min(waitCeilingMs, boundMs)`；`waitCeilingMs` 为 `0` 表示无限等，此时只有硬界生效。 */
function effectiveWaitCeilingMs(
  policy: BackgroundWindDownPolicy,
): number {
  const { waitCeilingMs, boundMs } = policy;
  if (boundMs === undefined) return waitCeilingMs;
  return waitCeilingMs > 0 ? Math.min(waitCeilingMs, boundMs) : boundMs;
}

/** running/pending 且未转后台的任务才算在跑；内部 agent 与空闲的进程内队友不算。 */
export function isRunningBackgroundTask(task: UnifiedTask): boolean {
  if (
    (task.status !== 'running' && task.status !== 'pending') ||
    isInternalAgentTask(task)
  ) {
    return false;
  }
  // 空闲的进程内队友不算「还在跑」：它只是挂着等下一条消息，为它阻塞退出没有意义。
  if (task.type === 'in_process_teammate' && task.isIdle) {
    return false;
  }
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false;
  }
  return true;
}

/** 会自己把结果以通知形式送出的后台任务类型。 */
export function isNotificationBackedBackgroundTask(task: UnifiedTask): boolean {
  return (
    task.type === 'local_bash' ||
    task.type === 'local_agent' ||
    task.type === 'local_workflow'
  );
}

/** 已到终态、完成通知却还没入队。 */
export function isPendingTerminalTaskNotification(task: UnifiedTask): boolean {
  if (!isNotificationBackedBackgroundTask(task)) {
    return false;
  }
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false;
  }
  return isTerminalStatus(task.status) && !task.notified;
}

/** 通知里的任务 ID：local_agent 用 `taskId`，其余用 `publicId` 兜底 `id`。 */
export function getTaskNotificationId(task: UnifiedTask): string {
  if (task.type === 'local_agent') return task.taskId;
  return task.publicId ?? task.id;
}

/**
 * 只要还有未发出的终态通知就返回 true；超时未到的通知标记 expired 并不再阻塞退出。
 * `waits` 由调用方跨轮持有：计时要连续，每轮新建就等于永远等不到 240s 上限。
 */
export function hasPendingTerminalTaskNotifications(
  waits: Map<string, TerminalNotificationWait>,
  tasks: UnifiedTask[],
  now: number,
  sessionId: string,
): boolean {
  let pending = false;
  const currentTaskIds = new Set<string>();

  for (const task of tasks) {
    if (!isPendingTerminalTaskNotification(task)) continue;

    currentTaskIds.add(task.id);
    let wait = waits.get(task.id);
    if (!wait) {
      wait = { firstSeenAt: now, expired: false };
      waits.set(task.id, wait);
    }
    if (wait.expired) continue;

    if (now - wait.firstSeenAt >= TERMINAL_NOTIFICATION_WAIT_MS) {
      wait.expired = true;
      runLogger.warn(
        `[thread-session] Task ${task.id} became terminal but its completion notification was not queued within ${TERMINAL_NOTIFICATION_WAIT_MS}ms; exiting without it.`,
        { sessionId },
      );
      continue;
    }

    pending = true;
  }

  for (const taskId of waits.keys()) {
    if (!currentTaskIds.has(taskId)) {
      waits.delete(taskId);
    }
  }

  return pending;
}

export interface BackgroundWindDownParams {
  readonly sessionId: string;
  readonly taskRegistry: TaskRegistry;
  /**
   * 报告一个后台任务被强制收尾。中立回调——本模块不构造帧，帧形态由上游适配层决定。
   */
  readonly notifyStopped: (notification: {
    taskId: string;
    summary: string;
  }) => void;
  /** 会话级中止信号；会话已经在关就别再等。 */
  readonly signal: AbortSignal;
  /**
   * 会话关闭时的等待策略，由宿主在 open 时注入；`boundMs` 缺省表示不设硬界。
   */
  readonly policy: BackgroundWindDownPolicy;
  readonly hasQueuedContinuation: () => boolean;
  /** 排干排队的主线续跑，返回本轮排干条数（0 表示没有可排的）。 */
  readonly drainContinuations: () => Promise<number>;
}

/**
 * 强收仍在跑的后台任务，逐个上报停止事实。`workflowTerminationReason` 只在等待上限或
 * 硬界触发时给；宽限期到点的正常收尾不带理由。
 */
function windDownBackgroundTasks(
  params: BackgroundWindDownParams,
  tasks: UnifiedTask[],
  workflowTerminationReason?: 'headless_wait_ceiling',
): void {
  const { sessionId, taskRegistry, notifyStopped } = params;
  for (const task of tasks) {
    if (task.type === 'local_bash') {
      // 强杀后台任务是收尾链的关键节点，必须默认级别可见（runLogger 默认丢弃 debug）。
      runLogger.log(
        `[thread-session] Killing background shell ${task.id} after ${BACKGROUND_TASK_WIND_DOWN_GRACE_MS}ms wind-down grace.`,
        { sessionId },
      );
      // 按 executionId 单个杀。绝不能用 ExecutionLifecycleService.terminateAll()：
      // 那是进程级 static 登记表，会杀掉所有会话的后台任务。
      void ExecutionLifecycleService.kill(task.executionId);
    } else if (task.type === 'local_workflow' && workflowTerminationReason) {
      taskRegistry.kill(task.id, workflowTerminationReason);
      runLogger.log(
        `[thread-session] Stopping Workflow ${task.id} after reaching the background wait ceiling.`,
        { sessionId },
      );
    } else {
      runLogger.log(
        `[thread-session] No longer waiting for background ${task.type} task ${task.id}.`,
        { sessionId },
      );
    }

    notifyStopped({
      taskId: getTaskNotificationId(task),
      summary: task.description,
    });
  }
}

/**
 * 会话关闭前排干后台工作：直到没有排队续跑、没有运行中任务、没有待发终态通知，
 * 或撞上等待上限与硬界。
 */
export async function drainBackgroundWorkBeforeClose(
  params: BackgroundWindDownParams,
): Promise<void> {
  const {
    sessionId,
    taskRegistry,
    signal,
    policy,
    hasQueuedContinuation,
    drainContinuations,
  } = params;

  const terminalNotificationWaits = new Map<string, TerminalNotificationWait>();
  const startedAt = Date.now();
  let backgroundWaitStartedAt: number | null = null;
  let windDownDeadline: number | null = null;

  runLogger.log('[thread-session] background wind-down entered', {
    sessionId,
    waitCeilingMs: policy.waitCeilingMs,
    boundMs: policy.boundMs,
  });

  // 排干续跑失败不能让收尾跳过，否则正好造出本模块要防的孤儿执行：
  // 记 error、不再重试（失败那条已出队），循环继续走到收尾。
  let drainFailed = false;
  const drainSafely = async (): Promise<number> => {
    if (drainFailed) return 0;
    try {
      return await drainContinuations();
    } catch (error) {
      drainFailed = true;
      runLogger.error(
        '[thread-session] draining queued continuations failed during background wind-down; collecting running tasks instead',
        { sessionId, error },
      );
      return 0;
    }
  };

  while (!signal.aborted) {
    const drainedCount = await drainSafely();
    const tasks = taskRegistry.all();
    const runningBackgroundTasks = tasks.filter(isRunningBackgroundTask);
    const hasQueued = hasQueuedContinuation();
    const now = Date.now();
    const hasPendingTerminalNotification = hasPendingTerminalTaskNotifications(
      terminalNotificationWaits,
      tasks,
      now,
      sessionId,
    );

    if (
      !hasQueued &&
      runningBackgroundTasks.length === 0 &&
      !hasPendingTerminalNotification
    ) {
      runLogger.log('[thread-session] background wind-down settled', {
        sessionId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // 没有续跑可排才开始计等待时间；一旦有活可干就把计时清零重来。
    if (!hasQueued && drainedCount === 0) {
      backgroundWaitStartedAt ??= now;
    } else {
      backgroundWaitStartedAt = null;
    }

    const waitCeiling = effectiveWaitCeilingMs(policy);
    const ceilingExceeded =
      waitCeiling > 0 &&
      backgroundWaitStartedAt !== null &&
      now - backgroundWaitStartedAt >= waitCeiling;

    // 硬界与等待上限分开判：`shouldStartWindDown` 要求还有运行中任务，管不到
    // 「没有运行中任务、只剩一个永远不来的终态通知」；那种状态只能等 240s 的 expired。
    if (policy.boundMs !== undefined && now - startedAt >= policy.boundMs) {
      runLogger.warn(
        `[thread-session] Giving up on background work after ${policy.boundMs}ms; closing the session anyway.`,
        { sessionId },
      );
      // 硬界的语义就是「等不下去了」，理由无条件给；不看 ceilingExceeded——
      // `backgroundWaitStartedAt` 每排到一轮活就清零，两者到点不同步。
      windDownBackgroundTasks(
        params,
        runningBackgroundTasks,
        'headless_wait_ceiling',
      );
      await drainSafely();
      return;
    }

    const shouldStartWindDown =
      !hasQueued &&
      runningBackgroundTasks.length > 0 &&
      (ceilingExceeded ||
        (!hasPendingTerminalNotification &&
          !runningBackgroundTasks.some(
            (task) => task.type === 'in_process_teammate',
          ) &&
          !runningBackgroundTasks.some(isNotificationBackedBackgroundTask)));

    if (shouldStartWindDown) {
      // 上限触发就立刻收（已经等够了），否则给 5s 宽限让任务自己结束。
      windDownDeadline ??= ceilingExceeded
        ? now
        : now + BACKGROUND_TASK_WIND_DOWN_GRACE_MS;
    } else {
      windDownDeadline = null;
    }

    if (windDownDeadline !== null && now >= windDownDeadline) {
      if (ceilingExceeded) {
        // daemon 的 stderr 是进程级共享的，多个会话往同一条流写会互相插话，
        // 这里用带 sessionId 的 warn。
        runLogger.warn(
          `[thread-session] Background tasks are still running after ${Math.round(waitCeiling / 1000)}s; terminating the wait.`,
          { sessionId },
        );
      }
      windDownBackgroundTasks(
        params,
        runningBackgroundTasks,
        ceilingExceeded ? 'headless_wait_ceiling' : undefined,
      );
      await drainSafely();
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, BACKGROUND_TASK_POLL_MS);
      timer.unref?.();
    });
  }
}
