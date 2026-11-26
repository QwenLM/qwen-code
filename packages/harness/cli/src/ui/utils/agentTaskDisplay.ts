/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentUnifiedTask } from '@qwen-code/core';

export function isInProcessTeammateTask(task: AgentUnifiedTask): boolean {
  return task.type === 'in_process_teammate';
}

export function agentTaskDisplayName(task: AgentUnifiedTask): string {
  const name = task.agentName || task.agentType;
  return isInProcessTeammateTask(task) ? `@${name}` : name;
}

export function agentTaskKindLabel(task: AgentUnifiedTask): string {
  return isInProcessTeammateTask(task) ? 'teammate' : 'agent';
}

export function agentTaskSectionLabel(
  task: AgentUnifiedTask,
  teammateCount: number,
  agentCount: number,
): string {
  return isInProcessTeammateTask(task)
    ? `Teammates (${teammateCount})`
    : `Agents (${agentCount})`;
}
