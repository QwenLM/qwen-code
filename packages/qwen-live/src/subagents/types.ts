/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export const SUBAGENT_STATUSES = [
  'queued',
  'starting',
  'running',
  'monitoring',
  'waiting',
  'delivering',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];
export type SubagentActivity = {
  at: number;
  kind: 'status' | 'message' | 'plan' | 'tool' | 'observation' | 'notification';
  text: string;
};
export type SubagentTask = {
  id: string;
  kind: 'harness' | 'proactive';
  title: string;
  status: SubagentStatus;
  createdAt: number;
  updatedAt: number;
  backend?: string;
  sessionId?: string;
  source?: string;
  request: string;
  activity: string;
  output: string;
  outputTruncated?: boolean;
  events: SubagentActivity[];
  triggerCount?: number;
  pendingNotifications?: number;
  notification?: 'queued' | 'speaking' | 'delivered';
  remainingSec?: number;
};
export type SubagentsSnapshot = {
  revision: number;
  counts: {
    running: number;
    completed: number;
    needsAttention: number;
    failed: number;
    cancelled: number;
    interrupted: number;
  };
  tasks: SubagentTask[];
  omitted: number;
};
export const MAX_SUBAGENTS_SNAPSHOT_BYTES = 240 * 1024;
export const MAX_SUBAGENT_TASKS = 32;

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number =>
  number(value) && Number.isSafeInteger(value);

export function parseSubagentsSnapshot(
  value: unknown,
): SubagentsSnapshot | undefined {
  if (
    !record(value) ||
    !integer(value['revision']) ||
    !integer(value['omitted']) ||
    !record(value['counts']) ||
    !Array.isArray(value['tasks']) ||
    value['tasks'].length > MAX_SUBAGENT_TASKS
  )
    return undefined;
  const counts = value['counts'];
  if (
    ![
      'running',
      'completed',
      'needsAttention',
      'failed',
      'cancelled',
      'interrupted',
    ].every((key) => integer(counts[key]))
  )
    return undefined;
  const ids = new Set<string>();
  for (const task of value['tasks']) {
    if (
      !record(task) ||
      !text(task['id'], 128) ||
      !task['id'] ||
      typeof task['kind'] !== 'string' ||
      !['harness', 'proactive'].includes(task['kind']) ||
      !text(task['title'], 240) ||
      !SUBAGENT_STATUSES.includes(task['status'] as SubagentStatus) ||
      !number(task['createdAt']) ||
      !number(task['updatedAt']) ||
      !text(task['request'], 4096) ||
      !text(task['activity'], 1024) ||
      !text(task['output'], 16384) ||
      !Array.isArray(task['events']) ||
      task['events'].length > 24
    )
      return undefined;
    if (ids.has(task['id'])) return undefined;
    ids.add(task['id']);
    for (const key of ['backend', 'sessionId', 'source'])
      if (task[key] !== undefined && !text(task[key], 256)) return undefined;
    for (const key of ['triggerCount', 'pendingNotifications'])
      if (task[key] !== undefined && !integer(task[key])) return undefined;
    if (task['remainingSec'] !== undefined && !number(task['remainingSec']))
      return undefined;
    if (
      task['outputTruncated'] !== undefined &&
      typeof task['outputTruncated'] !== 'boolean'
    )
      return undefined;
    if (
      task['notification'] !== undefined &&
      (typeof task['notification'] !== 'string' ||
        !['queued', 'speaking', 'delivered'].includes(task['notification']))
    )
      return undefined;
    for (const event of task['events'])
      if (
        !record(event) ||
        !number(event['at']) ||
        typeof event['kind'] !== 'string' ||
        ![
          'status',
          'message',
          'plan',
          'tool',
          'observation',
          'notification',
        ].includes(event['kind']) ||
        !text(event['text'], 1024)
      )
        return undefined;
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).length >
      MAX_SUBAGENTS_SNAPSHOT_BYTES
    )
      return undefined;
  } catch {
    return undefined;
  }
  return value as SubagentsSnapshot;
}
