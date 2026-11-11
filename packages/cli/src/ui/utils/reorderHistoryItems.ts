/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem } from '../types.js';

/**
 * Reorder ancillary history items (hook warnings, permission decisions, etc.)
 * to sit immediately after their associated tool_group, rather than scattered
 * by event arrival time.
 *
 * Items without a toolCallId, or whose tool_group appears later in the array
 * (not yet committed), remain in their original position.
 *
 * @param history The full history array.
 * @returns A new array with ancillary items relocated. Returns the original
 *          array by reference if no reordering was needed.
 */
export function reorderHistoryItems(history: HistoryItem[]): HistoryItem[] {
  if (history.length === 0) return history;

  const callIdToGroupIndex = new Map<string, number>();
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.type === 'tool_group') {
      for (const tool of item.tools) {
        callIdToGroupIndex.set(tool.callId, i);
      }
    }
  }

  if (callIdToGroupIndex.size === 0) return history;

  const insertions = new Map<number, HistoryItem[]>();
  const removed = new Set<number>();

  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.isAncillary && item.toolCallId) {
      const groupIndex = callIdToGroupIndex.get(item.toolCallId);
      if (groupIndex !== undefined && groupIndex < i) {
        removed.add(i);
        let list = insertions.get(groupIndex);
        if (!list) {
          list = [];
          insertions.set(groupIndex, list);
        }
        list.push(item);
      }
    }
  }

  if (removed.size === 0) return history;

  const result: HistoryItem[] = [];
  for (let i = 0; i < history.length; i++) {
    if (removed.has(i)) continue;
    result.push(history[i]);
    const items = insertions.get(i);
    if (items) {
      result.push(...items);
    }
  }

  return result;
}
