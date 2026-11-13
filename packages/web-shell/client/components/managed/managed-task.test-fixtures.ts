import type {
  ManagedTask,
  ManagedTaskCancelOperation,
  ManagedTaskEvent,
} from './managed-agent-provider';

export const task: ManagedTask = {
  sessionId: 's1',
  taskId: 'task_0123456789abcdef',
  kind: 'child_agent',
  state: 'running',
  runtimeState: 'ready',
  createdAt: 1,
  startedAt: 2,
  artifactRefs: [],
  actionCapabilities: ['cancel'],
};
export const taskOperation: ManagedTaskCancelOperation = {
  operationId: 'op1',
  sessionId: 's1',
  taskId: task.taskId,
  type: 'task_cancel',
  status: 'completed',
  admissionStage: 'harness_confirmed',
  deliveryState: 'confirmed',
  receiptId: 'receipt',
  replayed: false,
};
export function taskEvent(
  cursor: string,
  type = 'state_changed',
): ManagedTaskEvent {
  return {
    sessionId: task.sessionId,
    taskId: task.taskId,
    schemaVersion: 1,
    projectionVersion: 1,
    cursor,
    type,
    createdAt: 3,
    ...(type === 'state_changed' ? { state: 'running' as const } : {}),
  };
}
