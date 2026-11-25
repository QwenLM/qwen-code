/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useSyncExternalStore } from 'react';
import {
  type Config,
  type TodoList,
} from '@qwen-code/core';
import { useUIState } from '../../contexts/UIStateContext.js';
import type { HistoryItemToolGroup } from '../../types.js';
import { Checklist } from '../Checklist.js';
import type { ChecklistItemData } from '../ChecklistItem.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';
import {
  emptyTaskTrayStore,
  getTaskTrayStore,
} from '../../state/taskTrayStore.js';

export const TodoTray: React.FC<{
  config?: Config;
}> = ({ config }) => {
  const uiState = useUIState();
  const tasksEnabled = config?.isTasksEnabled() ?? false;
  const taskStore =
    tasksEnabled && config ? config.getTaskStore() : undefined;
  const taskTrayStore = taskStore
    ? getTaskTrayStore(taskStore)
    : emptyTaskTrayStore;
  const tasks = useSyncExternalStore(
    taskTrayStore.subscribe,
    taskTrayStore.getSnapshot,
    taskTrayStore.getSnapshot,
  );

  const todos: TodoList | null = useMemo(() => {
    for (let index = uiState.history.length - 1; index >= 0; index -= 1) {
      const entry = uiState.history[index];
      if (entry.type !== 'tool_group') continue;
      const toolGroup = entry as HistoryItemToolGroup;
      for (const tool of toolGroup.tools) {
        if (
          typeof tool.resultDisplay === 'object' &&
          tool.resultDisplay !== null &&
          'todos' in tool.resultDisplay
        ) {
          return tool.resultDisplay;
        }
      }
    }
    return null;
  }, [uiState.history]);

  const todoItems: ChecklistItemData[] = useMemo(() => {
    if (!todos?.todos) return [];
    return todos.todos.map((todo) => ({
      status: todo.status,
      label: todo.description,
    }));
  }, [todos]);

  if (tasksEnabled) {
    const completedIds = new Set(
      tasks
        .filter((task) => task.status === 'completed')
        .map((task) => task.id),
    );
    const taskItems: ChecklistItemData[] = tasks.map((task) => {
      const label =
        task.status === 'in_progress' && task.activeForm
          ? task.activeForm
          : task.subject;
      const owner = task.owner ? ` · ${task.owner}` : '';
      const unresolvedBlockers = task.blockedBy.filter(
        (id) => !completedIds.has(id),
      );
      const blockers =
        unresolvedBlockers.length > 0
          ? ` · blocked by ${unresolvedBlockers.map((id) => `#${id}`).join(', ')}`
          : '';
      return {
        status: task.status,
        label: `#${task.id} ${label}${owner}${blockers}`,
      };
    });
    return (
      <Checklist
        title="Tasks"
        items={taskItems}
        isExpanded={uiState.showFullTodos}
        toggleHint={`${formatCommand(Command.SHOW_FULL_TODOS)} to toggle`}
      />
    );
  }

  if (!todos?.todos) return null;
  return (
    <Checklist
      title="Todo"
      items={todoItems}
      isExpanded={uiState.showFullTodos}
      toggleHint={`${formatCommand(Command.SHOW_FULL_TODOS)} to toggle`}
    />
  );
};
