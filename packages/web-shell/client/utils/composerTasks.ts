import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';

export function isComposerTask(task: DaemonSessionTaskStatus): boolean {
  return task.kind !== 'agent';
}
