/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  type TaskType,
  type TaskStatus,
  type UnifiedTaskBase,
  type BashUnifiedTask,
  type AgentUnifiedTask,
  type WorkflowUnifiedTask,
  type InternalAgentUnifiedTask,
  type VideoGenUnifiedTask,
  type UnifiedTask,
  isActiveStatus,
  isTerminalStatus,
  isBashTask,
  isAgentTask,
  isWorkflowTask,
  isInternalAgentTask,
  isVideoGenTask,
} from './unified-task.js';

export { TaskRegistry } from './task-registry.js';
export {
  stopTask,
  TaskControlError,
  type TaskControlErrorCode,
  type StopTaskResult,
} from './task-control.js';

export { bridgeExecutionLifecycleToRegistry } from './execution-bridge.js';

export {
  type BackgroundWindDownPolicy,
  DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
} from './background-wind-down-policy.js';

export * from './task-list-id.js';
export * from './task-list-types.js';
export * from './task-store.js';
