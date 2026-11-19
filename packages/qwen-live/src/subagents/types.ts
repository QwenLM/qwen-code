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
export type SubagentPermission = {
  requestHandle: string;
  title: string;
  titleTruncated?: boolean;
  backend?: string;
  sessionId?: string;
  choices: Array<{
    decision: 'allow' | 'deny';
    scope?: 'once' | 'always';
  }>;
};
export const SUBAGENT_STOP_REASONS = [
  'stopping',
  'unsupported',
  'untracked',
  'ended',
] as const;
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
  canStop?: boolean;
  stopReason?: (typeof SUBAGENT_STOP_REASONS)[number];
  permissions?: SubagentPermission[];
  permissionsOmitted?: number;
};
export type SubagentsSnapshot = {
  revision: number;
  pendingUnassignedPermissions?: number;
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
export const MAX_SUBAGENT_PERMISSIONS = 8;
export const MAX_SUBAGENTS_REQUEST_BYTES = 4 * 1024;
export const MAX_SUBAGENTS_CONTROL_BYTES = 1024 * 1024;

export type SubagentsPage = {
  snapshot: SubagentsSnapshot;
  offset: number;
  total: number;
  selected?: SubagentTask;
  unassignedPermissions?: SubagentPermission[];
  unassignedPermissionsOmitted?: number;
};
export type SubagentsControlRequest =
  | { action: 'list'; offset?: number; selectedId?: string }
  | { action: 'stop'; taskId: string }
  | {
      action: 'permission';
      requestHandle: string;
      decision: 'allow' | 'deny';
    };
export const SUBAGENTS_CONTROL_ERROR_CODES = [
  'unsupported',
  'unavailable',
  'invalid_request',
  'not_found',
  'not_stoppable',
  'permission_unavailable',
  'action_failed',
  'stale_instance',
] as const;
export type SubagentsControlErrorCode =
  (typeof SUBAGENTS_CONTROL_ERROR_CODES)[number];
export type SubagentsControlResult =
  | { type: 'page'; page: SubagentsPage }
  | {
      type: 'outcome';
      outcome: 'stopping' | 'stopped' | 'already_ended' | 'allowed' | 'denied';
      taskId?: string;
      requestHandle?: string;
    }
  | { type: 'error'; code: SubagentsControlErrorCode };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number =>
  number(value) && Number.isSafeInteger(value);
const identifier = (value: unknown): value is string =>
  text(value, 128) && value.length > 0;

function fits(value: unknown, max: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= max;
  } catch {
    return false;
  }
}

function validPermissions(value: unknown): value is SubagentPermission[] {
  if (!Array.isArray(value) || value.length > MAX_SUBAGENT_PERMISSIONS)
    return false;
  const handles = new Set<string>();
  for (const permission of value) {
    if (
      !record(permission) ||
      !identifier(permission['requestHandle']) ||
      handles.has(permission['requestHandle']) ||
      !text(permission['title'], 4096) ||
      (permission['titleTruncated'] !== undefined &&
        typeof permission['titleTruncated'] !== 'boolean') ||
      !Array.isArray(permission['choices']) ||
      permission['choices'].length > 2
    )
      return false;
    handles.add(permission['requestHandle']);
    for (const key of ['backend', 'sessionId'])
      if (permission[key] !== undefined && !text(permission[key], 256))
        return false;
    const decisions = new Set<string>();
    for (const choice of permission['choices']) {
      if (
        !record(choice) ||
        (permission['titleTruncated'] === true &&
          choice['decision'] === 'allow') ||
        (choice['decision'] !== 'allow' && choice['decision'] !== 'deny') ||
        decisions.has(choice['decision']) ||
        (choice['scope'] !== undefined &&
          choice['scope'] !== 'once' &&
          choice['scope'] !== 'always')
      )
        return false;
      decisions.add(choice['decision']);
    }
  }
  return true;
}

function validTask(task: unknown): task is SubagentTask {
  if (
    !record(task) ||
    !identifier(task['id']) ||
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
    return false;
  for (const key of ['backend', 'sessionId', 'source'])
    if (task[key] !== undefined && !text(task[key], 256)) return false;
  for (const key of [
    'triggerCount',
    'pendingNotifications',
    'permissionsOmitted',
  ])
    if (task[key] !== undefined && !integer(task[key])) return false;
  if (task['remainingSec'] !== undefined && !number(task['remainingSec']))
    return false;
  for (const key of ['outputTruncated', 'canStop'])
    if (task[key] !== undefined && typeof task[key] !== 'boolean') return false;
  if (
    task['stopReason'] !== undefined &&
    !SUBAGENT_STOP_REASONS.includes(
      task['stopReason'] as (typeof SUBAGENT_STOP_REASONS)[number],
    )
  )
    return false;
  if (
    task['permissions'] !== undefined &&
    !validPermissions(task['permissions'])
  )
    return false;
  if (
    task['notification'] !== undefined &&
    (typeof task['notification'] !== 'string' ||
      !['queued', 'speaking', 'delivered'].includes(task['notification']))
  )
    return false;
  return task['events'].every(
    (event) =>
      record(event) &&
      number(event['at']) &&
      typeof event['kind'] === 'string' &&
      [
        'status',
        'message',
        'plan',
        'tool',
        'observation',
        'notification',
      ].includes(event['kind']) &&
      text(event['text'], 1024),
  );
}

export function parseSubagentsSnapshot(
  value: unknown,
): SubagentsSnapshot | undefined {
  if (
    !record(value) ||
    !integer(value['revision']) ||
    (value['pendingUnassignedPermissions'] !== undefined &&
      !integer(value['pendingUnassignedPermissions'])) ||
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
    if (!validTask(task)) return undefined;
    if (ids.has(task['id'])) return undefined;
    ids.add(task['id']);
  }
  if (!fits(value, MAX_SUBAGENTS_SNAPSHOT_BYTES)) return undefined;
  return value as SubagentsSnapshot;
}

export function parseSubagentsControlRequest(
  value: unknown,
): SubagentsControlRequest | undefined {
  if (!record(value) || !fits(value, MAX_SUBAGENTS_REQUEST_BYTES))
    return undefined;
  const keys = Object.keys(value);
  if (
    value['action'] === 'list' &&
    keys.every((key) => ['action', 'offset', 'selectedId'].includes(key)) &&
    (value['offset'] === undefined || integer(value['offset'])) &&
    (value['selectedId'] === undefined || identifier(value['selectedId']))
  )
    return value as SubagentsControlRequest;
  if (
    value['action'] === 'stop' &&
    keys.every((key) => ['action', 'taskId'].includes(key)) &&
    identifier(value['taskId'])
  )
    return value as SubagentsControlRequest;
  if (
    value['action'] === 'permission' &&
    keys.every((key) =>
      ['action', 'requestHandle', 'decision'].includes(key),
    ) &&
    identifier(value['requestHandle']) &&
    (value['decision'] === 'allow' || value['decision'] === 'deny')
  )
    return value as SubagentsControlRequest;
  return undefined;
}

export function parseSubagentsControlResult(
  value: unknown,
): SubagentsControlResult | undefined {
  if (!record(value) || !fits(value, MAX_SUBAGENTS_CONTROL_BYTES))
    return undefined;
  if (value['type'] === 'error')
    return SUBAGENTS_CONTROL_ERROR_CODES.includes(
      value['code'] as SubagentsControlErrorCode,
    )
      ? (value as SubagentsControlResult)
      : undefined;
  if (value['type'] === 'outcome') {
    if (
      (['stopping', 'stopped', 'already_ended'].includes(
        value['outcome'] as string,
      ) &&
        identifier(value['taskId'])) ||
      (['allowed', 'denied'].includes(value['outcome'] as string) &&
        identifier(value['requestHandle']))
    )
      return value as SubagentsControlResult;
    return undefined;
  }
  if (value['type'] !== 'page' || !record(value['page'])) return undefined;
  const page = value['page'];
  const snapshot = parseSubagentsSnapshot(page['snapshot']);
  if (
    !snapshot ||
    !integer(page['offset']) ||
    !integer(page['total']) ||
    page['offset'] > page['total'] ||
    snapshot.tasks.length > page['total'] - page['offset'] ||
    (page['selected'] !== undefined && !validTask(page['selected'])) ||
    (page['unassignedPermissions'] !== undefined &&
      !validPermissions(page['unassignedPermissions'])) ||
    (page['unassignedPermissionsOmitted'] !== undefined &&
      !integer(page['unassignedPermissionsOmitted']))
  )
    return undefined;
  return value as SubagentsControlResult;
}
