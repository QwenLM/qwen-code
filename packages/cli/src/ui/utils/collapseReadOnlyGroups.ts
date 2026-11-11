/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemToolGroup } from '../types.js';
import type { Kind } from '@qwen-code/core';
import { READ_ONLY_KINDS, CoreToolCallStatus } from '@qwen-code/core';

/**
 * Set of read-only Kind values for fast lookup.
 */
const READ_ONLY_SET = new Set(READ_ONLY_KINDS);

/**
 * Check if a tool is considered "read-only" based on its kind.
 * Tools without an explicit `kind` are not considered read-only.
 */
function isReadOnlyTool(kind: Kind | undefined): boolean {
  return kind !== undefined && READ_ONLY_SET.has(kind);
}

/**
 * Check if all tools in a tool_group are read-only AND completed (not still running).
 */
function isFullyCompletedReadOnlyGroup(
  item: HistoryItem,
): item is HistoryItemToolGroup & { id: number } {
  if (item.type !== 'tool_group') return false;
  if (item.tools.length === 0) return false;

  return item.tools.every(
    (t) =>
      isReadOnlyTool(t.kind) &&
      (t.status === CoreToolCallStatus.Success ||
        t.status === CoreToolCallStatus.Error ||
        t.status === CoreToolCallStatus.Cancelled),
  );
}

/**
 * Collapse consecutive read-only tool_group history items into a single
 * merged tool_group. This reduces visual clutter for sequences of Read,
 * Search, and Fetch operations that are common during exploration.
 *
 * The merged group contains all tools from the collapsed groups in order.
 * Non-tool_group items and groups with mutating tools break the sequence.
 *
 * Ancillary items (hook warnings, etc.) between two read-only groups are
 * absorbed into the merged group rather than breaking the collapse. Trailing
 * ancillary items (after the last group in a run) remain visible.
 *
 * Only completed (non-executing) read-only groups are collapsed to avoid
 * hiding in-progress tools from the user.
 *
 * @param history The full history array.
 * @returns A new array where consecutive read-only groups are merged.
 *          Items that were not collapsed are returned by reference (no copy).
 *          Returns the original array if no collapsing happened.
 */
export function collapseReadOnlyGroups(history: HistoryItem[]): HistoryItem[] {
  if (history.length === 0) {
    return history;
  }

  const result: HistoryItem[] = [];
  let changed = false;

  let i = 0;
  while (i < history.length) {
    const item = history[i];

    // Start a potential run of read-only groups
    if (isFullyCompletedReadOnlyGroup(item) && item.type === 'tool_group') {
      const runTools = [...item.tools];
      let groupCount = 1;
      const pending: HistoryItem[] = [];
      i++;

      while (i < history.length) {
        const next = history[i];
        if (isFullyCompletedReadOnlyGroup(next)) {
          pending.length = 0;
          runTools.push(...next.tools);
          groupCount++;
          i++;
        } else if (
          next.isAncillary &&
          next.toolCallId &&
          runTools.some((t) => t.callId === next.toolCallId)
        ) {
          pending.push(next);
          i++;
        } else {
          break;
        }
      }

      // Only merge if we found 2+ read-only groups in this run
      if (groupCount >= 2) {
        changed = true;
        const mergedGroup: HistoryItem = {
          ...item,
          tools: runTools,
          borderTop: undefined,
          borderBottom: undefined,
        };
        result.push(mergedGroup);
      } else {
        // Single read-only group — keep as-is
        result.push(item);
      }
      // Trailing pending items were not confirmed absorbed — keep visible
      result.push(...pending);
    } else {
      result.push(item);
      i++;
    }
  }

  return changed ? result : history;
}
