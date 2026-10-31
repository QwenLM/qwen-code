import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';

/**
 * Tasks that belong to THIS session's live background state — what the
 * status-bar pill counts and the environment panel lists.
 *
 * Agent tasks have their own surfaces, and retained workflow runs are
 * history: `getWorkflowTasks()` merges the project's saved snapshots into
 * the same list, so without the `isHistorical` exclusion a project with
 * saved runs shows "30 tasks done" in the pill the first time polling runs,
 * for the rest of the session, with no way to clear it. Consumers that
 * genuinely want the history (the workflow details provider, the tasks
 * dialog) read the unfiltered list instead.
 */
export function isComposerTask(
  task: DaemonSessionTaskWithWorkflowStatus,
): task is Exclude<DaemonSessionTaskWithWorkflowStatus, { kind: 'agent' }> {
  if (task.kind === 'agent') return false;
  return !(task.kind === 'workflow' && task.isHistorical === true);
}

/**
 * Whether the snapshot carries a background agent that is still executing.
 * Paused agents are parked, not active: they stay visible in the environment
 * panel's subagents section, so they must not re-open the footer pill in the
 * shipped entry (which would pin a stale count to parked work).
 */
export function hasActiveBackgroundAgent(
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[],
): boolean {
  return tasks.some(
    (task) =>
      task.kind === 'agent' &&
      task.isBackgrounded === true &&
      task.status === 'running',
  );
}
