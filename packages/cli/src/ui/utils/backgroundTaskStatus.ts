/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import stripAnsi from 'strip-ansi';
import {
  isAgentTask,
  isActiveStatus,
  isBashTask,
  isInternalAgentTask,
  isWorkflowTask,
  type InternalAgentUnifiedTask,
  type UnifiedTask,
} from '@qwen-code/core';

export type BackgroundTaskStatusKind =
  | 'Bash'
  | 'Subagent'
  | 'Teammate'
  | 'Workflow'
  | 'Memory'
  | 'Dream'
  | 'Task';

export interface BackgroundTaskStatusItem {
  id: string;
  kind: BackgroundTaskStatusKind;
  title: string;
  detail?: string;
}

export interface BackgroundTaskStatusInput {
  tasks?: readonly UnifiedTask[];
  excludeAgentSessionRailTasks?: boolean;
}

export function isAgentSessionRailInternalTask(
  task: UnifiedTask,
): task is InternalAgentUnifiedTask {
  if (!isInternalAgentTask(task)) return false;
  return (
    (task.id === 'internal-auto-dream' && task.agentType === 'dream') ||
    (task.id === 'internal-auto-memory' && task.agentType === 'memory')
  );
}

function isAgentSessionRailTask(task: UnifiedTask): boolean {
  return (
    isAgentTask(task) ||
    isWorkflowTask(task) ||
    isAgentSessionRailInternalTask(task)
  );
}

function extractOriginalCommand(command: string): string {
  const match = command.match(/^\(\n([\s\S]*?)\n\); __code=\$\?;/);
  return match ? match[1] : command;
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0]?.trim() || value.trim();
}

function cleanText(value: string): string {
  return stripAnsi(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLiveBackgroundTask(task: UnifiedTask): boolean {
  return (
    isActiveStatus(task.status) &&
    (!('isBackgrounded' in task) || task.isBackgrounded)
  );
}

function taskTitle(task: UnifiedTask): string {
  if (isBashTask(task)) {
    return (
      cleanText(firstLine(extractOriginalCommand(task.command))) ||
      cleanText(task.description)
    );
  }
  if (isWorkflowTask(task)) {
    return cleanText(task.title ?? task.workflowName);
  }
  if (isAgentTask(task)) {
    return cleanText(task.description || task.agentName);
  }
  if (isInternalAgentTask(task)) {
    return cleanText(task.description || task.agentName);
  }
  return cleanText(
    (task as { description?: string }).description ?? 'Background task',
  );
}

function taskKind(task: UnifiedTask): BackgroundTaskStatusKind {
  if (isBashTask(task)) return 'Bash';
  if (isWorkflowTask(task)) return 'Workflow';
  if (isAgentTask(task)) {
    return task.type === 'in_process_teammate' ? 'Teammate' : 'Subagent';
  }
  if (isInternalAgentTask(task)) {
    if (task.agentType === 'memory') return 'Memory';
    if (task.agentType === 'dream') return 'Dream';
  }
  return 'Task';
}

function taskDetail(task: UnifiedTask): string | undefined {
  if (isAgentTask(task)) return cleanText(task.agentType);
  if (isInternalAgentTask(task)) {
    return task.detail ? cleanText(task.detail) : cleanText(task.phase ?? '');
  }
  if (isWorkflowTask(task)) {
    const parts = [
      `${task.agentCount} agent${task.agentCount === 1 ? '' : 's'}`,
    ];
    if (task.totalToolCalls > 0) {
      parts.push(
        `${task.totalToolCalls} tool${task.totalToolCalls === 1 ? '' : 's'}`,
      );
    }
    return parts.join(', ');
  }
  return undefined;
}

function combineMemoryAndDreamItems(
  items: BackgroundTaskStatusItem[],
): BackgroundTaskStatusItem[] {
  const memoryIndex = items.findIndex((item) => item.kind === 'Memory');
  const dreamIndex = items.findIndex((item) => item.kind === 'Dream');
  if (memoryIndex === -1 || dreamIndex === -1) {
    return items;
  }

  const memory = items[memoryIndex];
  const dream = items[dreamIndex];
  const insertAt = Math.min(memoryIndex, dreamIndex);
  const combined: BackgroundTaskStatusItem = {
    id: `${memory.id}+${dream.id}`,
    kind: 'Memory',
    title: 'Memory · Dreaming',
  };

  return [
    ...items.slice(0, insertAt),
    combined,
    ...items.filter((_, index) => index > insertAt && index !== memoryIndex && index !== dreamIndex),
  ];
}

export function buildBackgroundTaskStatusItems({
  tasks = [],
  excludeAgentSessionRailTasks = false,
}: BackgroundTaskStatusInput): BackgroundTaskStatusItem[] {
  const liveTasks = tasks.filter(isLiveBackgroundTask);

  const items: BackgroundTaskStatusItem[] = liveTasks
    .filter(
      (task) =>
        !excludeAgentSessionRailTasks || !isAgentSessionRailTask(task),
    )
    .map((task) => ({
      id: task.id,
      kind: taskKind(task),
      title: taskTitle(task),
      detail: taskDetail(task),
    }));

  return combineMemoryAndDreamItems(items);
}

export function getBackgroundTaskStatusCount(
  input: BackgroundTaskStatusInput,
): number {
  return buildBackgroundTaskStatusItems(input).length;
}
