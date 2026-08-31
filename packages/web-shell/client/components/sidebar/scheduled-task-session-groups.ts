import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

// Mirrors `SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX` in
// acp-bridge/session-source.ts. The client cannot import that package.
const SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX = 'scheduled_task_run:';
const SCHEDULED_TASK_RUN_TIME_SUFFIX = / · \d{2}-\d{2} \d{2}:\d{2}$/u;

export interface ScheduledTaskSessionGroupIdentity {
  id: string;
  label: string;
}

export function getScheduledTaskSessionGroup(
  session: DaemonSessionSummary,
): ScheduledTaskSessionGroupIdentity | undefined {
  if (session.sourceType !== 'default') return undefined;
  const sourceId = session.sourceId;
  if (!sourceId?.startsWith(SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX)) {
    return undefined;
  }
  const taskId = sourceId.slice(SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX.length);
  if (!taskId) return undefined;
  const displayName = session.displayName?.trim();
  const label = displayName?.replace(SCHEDULED_TASK_RUN_TIME_SUFFIX, '').trim();
  return {
    id: `scheduled-task:${taskId}`,
    label: label || taskId,
  };
}
