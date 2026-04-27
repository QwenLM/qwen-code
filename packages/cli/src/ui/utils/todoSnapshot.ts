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
interface TodoSnapshotSearchResult {
  itemIndex: number;
  todos: TodoItem[] | null;
}

type SnapshotSearchResult = TodoSnapshotSearchResult | undefined;

// This threshold is item-count based, not line-count based. A single long
// response can fill the viewport while still counting as one item, so the
// sticky panel may stay hidden longer than strictly necessary. That is
// preferable to duplicating a recently committed inline TodoWrite result.
const MIN_HISTORY_ITEMS_AFTER_TODO_BEFORE_STICKY = 2;
export const STICKY_TODO_MAX_VISIBLE_ITEMS = 5;
const STICKY_TODO_ROWS_PER_VISIBLE_ITEM = 5;

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
        return {
          itemIndex,
          todos: todos.length > 0 ? todos : null,
        };
      }
    }
  }

  return undefined;
}

function areAllTodosCompleted(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed');
}

function isRecentHistoryTodoSnapshot(
  snapshotItemIndex: number,
  historyLength: number,
): boolean {
  const historyItemsAfterSnapshot = historyLength - snapshotItemIndex - 1;
  return historyItemsAfterSnapshot < MIN_HISTORY_ITEMS_AFTER_TODO_BEFORE_STICKY;
}

export function getStickyTodos(
  history: readonly HistoryItem[],
  pendingHistoryItems: readonly HistoryItemWithoutId[],
): TodoItem[] | null {
  const pendingSnapshot = findLatestTodoSnapshot(pendingHistoryItems);
  if (pendingSnapshot !== undefined) {
    // The pending TodoWrite result is already rendered inline above the
    // composer, so defer the sticky panel until the turn commits to history.
    return null;
  }

  const historySnapshot = findLatestTodoSnapshot(history);
  if (historySnapshot === undefined || historySnapshot.todos === null) {
    return null;
  }

  // Ink Static writes committed history to scrollback, and does not expose a
  // reliable per-item viewport API. Treat very recent TodoWrite snapshots as
  // still visible so the footer does not duplicate the inline result.
  if (isRecentHistoryTodoSnapshot(historySnapshot.itemIndex, history.length)) {
    return null;
  }

  if (areAllTodosCompleted(historySnapshot.todos)) {
    return null;
  }

  return historySnapshot.todos;
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

export function getStickyTodosRenderKey(
  todos: readonly TodoItem[] | null,
): string {
  if (!todos) {
    return 'null';
  }

  return JSON.stringify(
    todos.map((todo) => [todo.id, todo.content, todo.status]),
  );
}

export function getStickyTodosLayoutKey(
  todos: readonly TodoItem[] | null,
  width: number,
  maxVisibleItems: number,
): string {
  if (!todos) {
    return 'null';
  }

  return JSON.stringify({
    width,
    maxVisibleItems,
    todos: todos.map((todo) => [todo.id, todo.content]),
  });
}

export function getStickyTodoMaxVisibleItems(terminalHeight: number): number {
  if (!Number.isFinite(terminalHeight) || terminalHeight <= 0) {
    return STICKY_TODO_MAX_VISIBLE_ITEMS;
  }

  return Math.max(
    1,
    Math.min(
      STICKY_TODO_MAX_VISIBLE_ITEMS,
      Math.floor(terminalHeight / STICKY_TODO_ROWS_PER_VISIBLE_ITEM),
    ),
  );
}
