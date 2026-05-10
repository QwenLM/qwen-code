/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

/**
 * Items that don't represent meaningful model output. Used by the
 * auto-restore-on-cancel flow to decide whether the just-submitted user
 * prompt can be rewound (no real response was produced) or must stay in
 * the transcript (the user already saw something worth keeping).
 *
 * Mirrors claude-code's `messagesAfterAreOnlySynthetic` (MessageSelector.tsx):
 * thoughts/info/error/etc. are non-meaningful; assistant text and tool runs
 * are meaningful.
 */
export function isSyntheticHistoryItem(
  item: HistoryItem | HistoryItemWithoutId,
): boolean {
  switch (item.type) {
    case 'info':
    case 'error':
    case 'warning':
    case 'success':
    case 'retry_countdown':
    case 'notification':
    case 'tool_use_summary':
    case 'gemini_thought':
    case 'gemini_thought_content':
      return true;
    default:
      return false;
  }
}

/**
 * Returns true when every item AFTER `fromIndex` is non-meaningful
 * (synthetic). An empty trailing slice also returns true.
 *
 * Used by the cancel handler: if the user hit ESC right after submitting
 * and the model produced nothing real, the prompt+trailing INFO can be
 * rewound and the prompt text restored to the input box — same UX as
 * claude-code (REPL.tsx auto-restore branch).
 */
export function itemsAfterAreOnlySynthetic(
  history: readonly HistoryItem[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < history.length; i++) {
    if (!isSyntheticHistoryItem(history[i])) return false;
  }
  return true;
}

/** Index of the last `user` (real prompt) item, or -1. */
export function findLastUserItemIndex(history: readonly HistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === 'user') return i;
  }
  return -1;
}
