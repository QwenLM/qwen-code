import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';

export function isComposerTask(
  task: DaemonSessionTaskWithWorkflowStatus,
): task is Exclude<DaemonSessionTaskWithWorkflowStatus, { kind: 'agent' }> {
  return task.kind !== 'agent';
}
