/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExecutionLifecycleService,
  isAgentTask,
  isActiveStatus,
  isInternalAgentTask,
  isTerminalStatus,
  isWorkflowTask,
  type TaskRegistry,
  type UnifiedTask,
} from '@qwen-code/core';

/**
 * Shared dismiss/kill logic for the unified task panel.
 *
 * - Terminal tasks (killed/completed/failed): removed from registry.
 * - Active tasks: killed via ExecutionLifecycleService, registry updated
 *   to 'killed', and an info message emitted for agent tasks.
 * - Paused workflows: transitioned to 'killed' without restarting execution.
 */
export function dismissTask(
  registry: TaskRegistry | null,
  task: UnifiedTask,
  addInfoMessage?: (text: string) => void,
): void {
  if (isTerminalStatus(task.status)) {
    registry?.remove(task.id);
  } else if (isInternalAgentTask(task) && task.killable === false) {
    addInfoMessage?.(
      `${task.agentName} is managed by the background service.`,
    );
  } else if (task.status === 'paused' && isWorkflowTask(task)) {
    registry?.update(task.id, {
      status: 'killed',
      endTime: Date.now(),
      notified: true,
    });
  } else if (isActiveStatus(task.status)) {
    if (task.type === 'local_bash') {
      // The lifecycle owns the terminal transition. A failed stop must remain
      // visible and retryable instead of being dismissed as already killed.
      void ExecutionLifecycleService.kill(task.executionId).catch(
        (error: unknown) => {
          addInfoMessage?.(`Could not stop task: ${String(error)}`);
        },
      );
      return;
    }
    if (isWorkflowTask(task)) {
      registry?.kill(task.id, 'user_stop');
    }
    void ExecutionLifecycleService.kill(
      task.executionId,
      isWorkflowTask(task) ? 'user_stop' : undefined,
    );
    registry?.update(task.id, {
      status: 'killed',
      endTime: Date.now(),
      notified: true,
    });
    if (isAgentTask(task)) {
      addInfoMessage?.(`Agent "${task.description}" was stopped`);
    }
  }
}
