/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 后台子 Agent 事件的过滤与 drain。
 *
 * 后台 Agent 的工具调用立即返回，engine 只在前台工具等待期间消费 `subagent-sdk-events`
 * 队列，于是 progress 与正文增量会一直停在里面。这里按 TaskRegistry 的后台任务身份过滤，
 * 只取后台任务自己的事件；`task_started` 留给 engine，保持既有的「先 task_started、后
 * 工具结果」帧序。
 */

import {
  TASK_LIFECYCLE_SUBTYPES,
  drainSubagentSdkEvents,
  getSubagentSdkEventTaskIdentity,
  type QueryEvent,
} from '@qwen-code/core';

export interface BackgroundSubagentTaskIdentity {
  readonly taskIds: ReadonlySet<string>;
  readonly toolUseIds: ReadonlySet<string>;
}

export interface BackgroundAgentTask {
  readonly id: string;
  readonly publicId?: string;
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly type: 'local_agent' | 'in_process_teammate';
  readonly isBackgrounded: boolean;
}

export function isBackgroundAgentTask(task: {
  readonly type: string;
  readonly isBackgrounded?: boolean;
}): task is BackgroundAgentTask {
  return (
    (task.type === 'local_agent' || task.type === 'in_process_teammate') &&
    task.isBackgrounded === true
  );
}

export function isBackgroundSubagentEvent(
  event: QueryEvent,
  identity: BackgroundSubagentTaskIdentity,
): boolean {
  if (event.type === 'system') {
    if (event.subtype === 'task_started') return false;
    if (event.subtype === 'background_tasks_changed') {
      return identity.taskIds.size > 0 || identity.toolUseIds.size > 0;
    }
    if (!TASK_LIFECYCLE_SUBTYPES.has(event.subtype)) return false;
  }
  const task = getSubagentSdkEventTaskIdentity(event);
  return (
    (task.taskId !== undefined && identity.taskIds.has(task.taskId)) ||
    (task.toolUseId !== undefined && identity.toolUseIds.has(task.toolUseId))
  );
}

export function drainBackgroundSubagentEvents(
  sessionId: string,
  identity: BackgroundSubagentTaskIdentity,
): QueryEvent[] {
  return drainSubagentSdkEvents(sessionId, (event) =>
    isBackgroundSubagentEvent(event, identity),
  );
}
