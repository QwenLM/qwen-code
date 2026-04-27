/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TodoItem } from '../components/TodoDisplay.js';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';

type HistoryLikeItem = HistoryItem | HistoryItemWithoutId;
type SnapshotSearchResult = TodoItem[] | null | undefined;
const STICKY_TODO_STATUS_PRIORITY: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function extractTodosFromResultDisplay(
  resultDisplay: unknown,
): TodoItem[] | null {
  if (!resultDisplay) {
    return null;
  }

  if (typeof resultDisplay === 'object') {
    const candidate = resultDisplay as Record<string, unknown>;
    if (
      candidate['type'] === 'todo_list' &&
      Array.isArray(candidate['todos'])
    ) {
      return candidate['todos'] as TodoItem[];
    }
  }

  if (typeof resultDisplay === 'string') {
    try {
      const parsed = JSON.parse(resultDisplay) as Record<string, unknown>;
      if (parsed['type'] === 'todo_list' && Array.isArray(parsed['todos'])) {
        return parsed['todos'] as TodoItem[];
      }
    } catch {
      return null;
    }
  }

  return null;
}

function findLatestTodoSnapshot(
  items: readonly HistoryLikeItem[],
): SnapshotSearchResult {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item.type !== 'tool_group') {
      continue;
    }

    for (
      let toolIndex = item.tools.length - 1;
      toolIndex >= 0;
      toolIndex -= 1
    ) {
      const tool = item.tools[toolIndex] as IndividualToolCallDisplay;
      const todos = extractTodosFromResultDisplay(tool.resultDisplay);
      if (todos) {
        return todos.length > 0 ? todos : null;
      }
    }
  }

  return undefined;
}

function areAllTodosCompleted(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed');
}

export function getStickyTodos(
  history: readonly HistoryItem[],
  pendingHistoryItems: readonly HistoryItemWithoutId[],
): TodoItem[] | null {
  const pendingSnapshot = findLatestTodoSnapshot(pendingHistoryItems);
  if (pendingSnapshot !== undefined) {
    return pendingSnapshot;
  }

  const historySnapshot = findLatestTodoSnapshot(history);
  if (historySnapshot && areAllTodosCompleted(historySnapshot)) {
    return null;
  }

  return historySnapshot ?? null;
}

export function getOrderedStickyTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort(
      (left, right) =>
        STICKY_TODO_STATUS_PRIORITY[left.todo.status] -
          STICKY_TODO_STATUS_PRIORITY[right.todo.status] ||
        left.index - right.index,
    )
    .map(({ todo }) => todo);
}
