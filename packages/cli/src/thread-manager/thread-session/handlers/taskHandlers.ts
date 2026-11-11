/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 后台任务能力：`stop_task` / `background_tasks`。
 *
 * 入参是宿主解析好的产品语义值，结果经 `ThreadTaskResult` 交回；`payload: undefined` 表示
 * 无 payload 的成功回包。task 生命周期事件的 flush 经 `afterResponseSent` 交回宿主，
 * 由宿主在写完响应帧之后调用，保证「先回包、后事件」。
 */

import {
  ExecutionLifecycleService,
  TaskControlError,
  // 与导出的能力函数 stopTask 重名，按 core 侧语义取别名。
  stopTask as stopRegistryTask,
} from '@qwen-code/core';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadTaskResult } from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * `stop_task`：停止一个后台任务；任务不存在或已停止按成功回应（幂等）。
 *
 * 只按 taskId + sessionId 精确停止本会话的执行，不触碰 terminateAll。成功时 flush 经
 * `afterResponseSent`；not_found / not_running 按成功返回且不 flush。taskId 缺失抛
 * `missing task_id`，其余错误取 `err.message` 并立即 flush，均不带 code。
 */
export async function stopTask(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  taskId: string,
): Promise<ThreadTaskResult> {
  if (typeof taskId !== 'string') {
    throw new ThreadCapabilityError('missing task_id');
  }

  try {
    // 按 task.executionId + task.sessionId 精确停止单条执行，绝不调用 terminateAll()。
    await stopRegistryTask({
      registry: session.taskRegistry,
      sessionId: session.requireConfig().getSessionId(),
      taskId,
    });
    return {
      payload: undefined,
      afterResponseSent: () => session.flushTaskControlEvents(),
    };
  } catch (err) {
    if (
      err instanceof TaskControlError &&
      (err.code === 'not_found' || err.code === 'not_running')
    ) {
      // 幂等成功：不 flush，afterResponseSent 为空操作。
      return { payload: undefined, afterResponseSent: () => {} };
    }
    session.flushTaskControlEvents();
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'stop_task failed',
    );
  }
}

/**
 * `background_tasks`：带 toolUseId 时把执行中的工具调用转入后台，不带时列出当前后台任务。
 *
 * 按 sessionId 过滤，只转本会话的执行。toolUseId 类型非法抛 `invalid tool_use_id`
 * （文本里的 wire 键名不改写）；回包在带 toolUseId 时为 `{backgrounded}`，否则无 payload。
 */
export async function backgroundTasks(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  options?: { toolUseId?: string },
): Promise<ThreadTaskResult> {
  const toolUseId = options?.toolUseId;
  if (toolUseId !== undefined && typeof toolUseId !== 'string') {
    throw new ThreadCapabilityError('invalid tool_use_id');
  }

  try {
    // static Map 是进程级，但按 sessionId 过滤只转本会话执行；绝不调用 terminateAll()。
    const backgrounded = ExecutionLifecycleService.backgroundTasks({
      sessionId: session.requireConfig().getSessionId(),
      toolUseId,
      reason: 'user',
    });
    return {
      payload: toolUseId === undefined ? undefined : { backgrounded },
      afterResponseSent: () => session.flushTaskControlEvents(),
    };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'background_tasks failed',
    );
  }
}
