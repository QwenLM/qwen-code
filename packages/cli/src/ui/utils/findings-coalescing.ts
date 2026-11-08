/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The report_findings contract is "a later call replaces the whole list, it
// never appends." The tool enforces that against the active report's
// identity; this module is the transcript side of the same rule. Every
// delivered report in one session is a successive state of a single logical
// report, so a rendered transcript keeps only the LAST delivered list and
// collapses every earlier one to a one-line marker — the initial report and
// its outcome re-report must not show two checklists side by side.

import type { FindingsResultDisplay } from '@qwen-code/qwen-code-core';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';

/** Replaces the display of a findings list a later call superseded. */
export const SUPERSEDED_FINDINGS_MESSAGE =
  '(findings replaced by a later report_findings call)';

export function isFindingsListDisplay(
  value: unknown,
): value is FindingsResultDisplay {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'findings_list'
  );
}

/**
 * Keeps only the last delivered findings list across the tool groups; every
 * earlier one takes the replacement marker. The superseded display stays on
 * the tool so a rewind past the replacing call can restore it. Returns the
 * input array itself when there is nothing to coalesce (at most one
 * delivered list).
 */
export function coalesceFindingsHistoryItems<T extends HistoryItemWithoutId>(
  items: T[],
): T[] {
  let lastItem = -1;
  let lastTool = -1;
  for (let i = items.length - 1; i >= 0 && lastItem === -1; i -= 1) {
    const item = items[i];
    if (item.type !== 'tool_group') continue;
    for (let j = item.tools.length - 1; j >= 0; j -= 1) {
      if (isFindingsListDisplay(item.tools[j].resultDisplay)) {
        lastItem = i;
        lastTool = j;
        break;
      }
    }
  }
  if (lastItem === -1) return items;

  let changed = false;
  const next = items.map((item, i) => {
    if (item.type !== 'tool_group') return item;
    let toolsChanged = false;
    const tools: IndividualToolCallDisplay[] = item.tools.map((tool, j) => {
      if (i === lastItem && j === lastTool) return tool;
      if (!isFindingsListDisplay(tool.resultDisplay)) return tool;
      toolsChanged = true;
      return {
        ...tool,
        resultDisplay: SUPERSEDED_FINDINGS_MESSAGE,
        supersededFindingsDisplay:
          tool.supersededFindingsDisplay ?? tool.resultDisplay,
      };
    });
    if (!toolsChanged) return item;
    changed = true;
    return { ...item, tools } as T;
  });
  return changed ? next : items;
}

/**
 * Truncation/rewind repair: restores superseded displays whose replacing
 * call no longer survives, then coalesces the survivors again so the
 * keep-only-the-last-list invariant holds over the truncated transcript.
 */
export function recoalesceFindingsHistoryItems<T extends HistoryItemWithoutId>(
  items: T[],
): T[] {
  let restored = false;
  const next = items.map((item) => {
    if (item.type !== 'tool_group') return item;
    let toolsChanged = false;
    const tools: IndividualToolCallDisplay[] = item.tools.map((tool) => {
      if (
        tool.resultDisplay !== SUPERSEDED_FINDINGS_MESSAGE ||
        !tool.supersededFindingsDisplay
      ) {
        return tool;
      }
      toolsChanged = true;
      return {
        ...tool,
        resultDisplay: tool.supersededFindingsDisplay,
        supersededFindingsDisplay: undefined,
      };
    });
    if (!toolsChanged) return item;
    restored = true;
    return { ...item, tools } as T;
  });
  return coalesceFindingsHistoryItems(restored ? next : items);
}
