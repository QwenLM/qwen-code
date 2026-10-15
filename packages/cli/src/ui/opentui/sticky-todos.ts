/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sticky-todo snapshot extraction for the OpenTUI backend — the live-items
 * counterpart of ink `getStickyTodos` (utils/todoSnapshot.ts). The ink
 * version searches two arrays (committed history + pending items); the
 * OpenTUI backend folds both into one live array, so the pending-snapshot
 * suppression is covered by the same recency rule: a snapshot with fewer
 * than two items after it is treated as still visible inline.
 */

import type { LiveHistoryItem } from './live-session-model.js';
import type { TodoItem } from '../components/TodoDisplay.js';

/** ink MIN_HISTORY_ITEMS_AFTER_TODO_BEFORE_STICKY (todoSnapshot.ts). */
const MIN_HISTORY_ITEMS_AFTER_TODO_BEFORE_STICKY = 2;

interface TodoSnapshot {
  itemIndex: number;
  todos: TodoItem[] | null;
}

function findLatestTodoSnapshot(
  items: readonly LiveHistoryItem[],
): TodoSnapshot | undefined {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item.kind === 'tool' && item.todos) {
      // An empty list is still a snapshot (ink returns null todos and stops
      // searching) — it must not resurface an earlier snapshot.
      return {
        itemIndex,
        todos: item.todos.length > 0 ? item.todos : null,
      };
    }
  }
  return undefined;
}

/** New user turn after the snapshot → stale todos, do not resurface. */
function hasUserMessageAfter(
  items: readonly LiveHistoryItem[],
  afterIndex: number,
): boolean {
  for (let i = afterIndex + 1; i < items.length; i++) {
    if (items[i].kind === 'user') {
      return true;
    }
  }
  return false;
}

export function getStickyTodosFromLiveItems(
  items: readonly LiveHistoryItem[],
): TodoItem[] | null {
  const snapshot = findLatestTodoSnapshot(items);
  if (snapshot === undefined || snapshot.todos === null) {
    return null;
  }

  const itemsAfterSnapshot = items.length - snapshot.itemIndex - 1;
  if (itemsAfterSnapshot < MIN_HISTORY_ITEMS_AFTER_TODO_BEFORE_STICKY) {
    return null;
  }

  if (hasUserMessageAfter(items, snapshot.itemIndex)) {
    return null;
  }

  if (snapshot.todos.every((todo) => todo.status === 'completed')) {
    return null;
  }

  return snapshot.todos;
}
