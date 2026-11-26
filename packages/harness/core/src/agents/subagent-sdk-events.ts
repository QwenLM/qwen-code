/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { QueryEvent } from '../core/query-event.js';
import type { SystemMessage } from '../protocol/transcript/message.js';
import type { TaskRegistry } from '../tasks/task-registry.js';

const MAX_QUEUE_SIZE = 1000;

type EventMatcher = (event: QueryEvent) => boolean;

interface PendingWaiter {
  matches: EventMatcher;
  resolve: (event: QueryEvent | null) => void;
}

interface SessionEventQueue {
  events: QueryEvent[];
  waiters: PendingWaiter[];
}

const sessionQueues = new Map<string, SessionEventQueue>();
const backgroundTaskSignatures = new Map<string, string>();

function getQueue(sessionId: string): SessionEventQueue {
  let queue = sessionQueues.get(sessionId);
  if (!queue) {
    queue = { events: [], waiters: [] };
    sessionQueues.set(sessionId, queue);
  }
  return queue;
}

function cleanupQueue(sessionId: string): void {
  const queue = sessionQueues.get(sessionId);
  if (!queue) {
    return;
  }
  if (queue.events.length === 0 && queue.waiters.length === 0) {
    sessionQueues.delete(sessionId);
  }
}

/**
 * Tear down a session's event queue, resolving any pending waiters with null.
 * Call this when a session terminates to prevent leaked entries in the
 * module-level sessionQueues Map.
 */
export function disposeSessionEventQueue(sessionId: string): void {
  backgroundTaskSignatures.delete(sessionId);
  const queue = sessionQueues.get(sessionId);
  if (!queue) {
    return;
  }
  for (const waiter of queue.waiters) {
    waiter.resolve(null);
  }
  sessionQueues.delete(sessionId);
}

export function enqueueSubagentSdkEvent(
  sessionId: string,
  event: QueryEvent,
): void {
  const queue = getQueue(sessionId);
  const waiterIndex = queue.waiters.findIndex((waiter) =>
    waiter.matches(event),
  );
  if (waiterIndex >= 0) {
    const [waiter] = queue.waiters.splice(waiterIndex, 1);
    waiter?.resolve(event);
    cleanupQueue(sessionId);
    return;
  }

  queue.events.push(event);
  if (queue.events.length > MAX_QUEUE_SIZE) {
    queue.events.shift();
  }
}

export function drainSubagentSdkEvents(
  sessionId: string,
  matches: EventMatcher,
): QueryEvent[] {
  const queue = sessionQueues.get(sessionId);
  if (!queue || queue.events.length === 0) {
    return [];
  }

  const drained: QueryEvent[] = [];
  const remaining: QueryEvent[] = [];
  for (const event of queue.events) {
    if (matches(event)) {
      drained.push(event);
    } else {
      remaining.push(event);
    }
  }
  queue.events = remaining;
  cleanupQueue(sessionId);
  return drained;
}

/** 子 Agent 事件归属的任务身份；字段读取留在 core，会话层只消费中立身份。 */
export interface SubagentSdkEventTaskIdentity {
  readonly taskId?: string;
  readonly toolUseId?: string;
}

export function getSubagentSdkEventTaskIdentity(
  event: QueryEvent,
): SubagentSdkEventTaskIdentity {
  if (
    event.type === 'assistant' ||
    event.type === 'user' ||
    event.type === 'stream_event'
  ) {
    const toolUseId = event.parent_tool_use_id;
    return typeof toolUseId === 'string' && toolUseId.length > 0
      ? { toolUseId }
      : {};
  }
  if (event.type !== 'system') {
    return {};
  }
  return {
    ...(event.task_id ? { taskId: event.task_id } : {}),
    ...(event.tool_use_id ? { toolUseId: event.tool_use_id } : {}),
  };
}

export function waitForSubagentSdkEvent(
  sessionId: string,
  matches: EventMatcher,
  signal?: AbortSignal,
): Promise<QueryEvent | null> {
  const queue = getQueue(sessionId);
  const immediateIndex = queue.events.findIndex((event) => matches(event));
  if (immediateIndex >= 0) {
    const [event] = queue.events.splice(immediateIndex, 1);
    cleanupQueue(sessionId);
    return Promise.resolve(event ?? null);
  }

  return new Promise<QueryEvent | null>((resolve) => {
    const waiter: PendingWaiter = {
      matches,
      resolve: (event) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(event);
      },
    };

    const onAbort = () => {
      const currentQueue = sessionQueues.get(sessionId);
      if (currentQueue) {
        currentQueue.waiters = currentQueue.waiters.filter((w) => w !== waiter);
      }
      cleanupQueue(sessionId);
      resolve(null);
    };

    if (signal?.aborted) {
      resolve(null);
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    queue.waiters.push(waiter);
  });
}

export function createTaskStartedEvent(params: {
  sessionId: string;
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  prompt?: string;
  /**
   * Names of all tools available to the subagent at task start time
   * (post tool whitelist / MCP discovery / disallowedTools blacklist).
   * Forwarded into SDKTaskStartedMessage.tools for SDK-side observability.
   */
  tools?: string[];
}): SystemMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    content: '',
    level: 'info',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    task_type: params.taskType,
    subagent_type: params.subagentType,
    workflow_name: params.workflowName,
    prompt: params.prompt,
    tools: params.tools,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: params.sessionId,
  };
}

export function createTaskProgressEvent(params: {
  sessionId: string;
  taskId: string;
  toolUseId?: string;
  description: string;
  lastToolName?: string;
  summary?: string;
  subagentType?: string;
  usage?: {
    total_tokens?: number;
    tool_uses: number;
    duration_ms: number;
  };
}): SystemMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    content: '',
    level: 'info',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    last_tool_name: params.lastToolName,
    summary: params.summary,
    subagent_type: params.subagentType,
    usage: params.usage,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: params.sessionId,
  };
}

export type TaskUpdatedPatch = NonNullable<SystemMessage['patch']>;

export function createTaskUpdatedEvent(
  params:
    | {
        sessionId: string;
        taskId: string;
        patch: TaskUpdatedPatch;
      }
    | {
        sessionId: string;
        taskId: string;
        status: 'completed' | 'failed' | 'killed';
        endTime: number;
      },
): SystemMessage {
  const patch =
    'patch' in params
      ? params.patch
      : { status: params.status, end_time: params.endTime };
  return {
    type: 'system',
    subtype: 'task_updated',
    content: '',
    level: 'info',
    task_id: params.taskId,
    patch,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: params.sessionId,
  };
}

export function createBackgroundTasksChangedEvent(params: {
  sessionId: string;
  tasks: Array<{
    taskId: string;
    taskType: string;
    description: string;
  }>;
}): SystemMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    content: '',
    level: 'info',
    tasks: params.tasks.map((task) => ({
      task_id: task.taskId,
      task_type: task.taskType,
      description: task.description,
    })),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: params.sessionId,
  };
}

/** Emit one deduplicated SDK snapshot of the session's user-visible background tasks. */
export function enqueueBackgroundTasksChangedFromRegistry(
  sessionId: string,
  registry: TaskRegistry,
): boolean {
  const tasks = registry
    .all()
    .filter(
      (task) =>
        (task.sessionId === undefined || task.sessionId === sessionId) &&
        (task.status === 'pending' || task.status === 'running') &&
        'isBackgrounded' in task &&
        task.isBackgrounded &&
        task.completionBehavior !== 'silent',
    )
    .map((task) => ({
      taskId: task.publicId ?? task.id,
      taskType: task.type,
      description: task.description,
    }));
  const signature = JSON.stringify(tasks);
  if (backgroundTaskSignatures.get(sessionId) === signature) {
    return false;
  }
  backgroundTaskSignatures.set(sessionId, signature);
  enqueueSubagentSdkEvent(
    sessionId,
    createBackgroundTasksChangedEvent({ sessionId, tasks }),
  );
  return true;
}

export function createTaskNotificationEvent(params: {
  sessionId: string;
  taskId: string;
  toolUseId?: string;
  status: 'completed' | 'failed' | 'stopped';
  outputFile: string;
  summary: string;
  usage?: {
    total_tokens?: number;
    tool_uses: number;
    duration_ms: number;
  };
}): SystemMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    content: '',
    level: 'info',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    status: params.status,
    output_file: params.outputFile,
    summary: params.summary,
    usage: params.usage,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: params.sessionId,
  };
}

export function countUsageTotalTokens(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined,
): number {
  if (!usage) {
    return 0;
  }
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
