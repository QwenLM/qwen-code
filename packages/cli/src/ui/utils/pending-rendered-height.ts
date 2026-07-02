/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getCachedStringWidth } from './textUtils.js';

/**
 * Shared rendered-height accounting for bounding the live (pending) markdown
 * frame during streaming. A single source line does NOT map to a single
 * terminal row: a wide/CJK line wraps, and a markdown table renders ~2 rows per
 * data row (TableRenderer draws a separator between every data row) plus
 * borders and vertical margin. Both the incremental scrollback commit
 * (useGeminiStream) and the render-side safety-net slice (MarkdownDisplay) use
 * this module so they agree on how tall the pending content will render — a
 * divergent estimate would let the safety net engage out of step with the
 * commit and flicker.
 */

/** TableRenderer draws `2 * dataRows + 5` rows: N-1 inter-row separators, plus
 *  top / header / header-separator / bottom borders and a `marginY` of 1 (2
 *  rows). */
export const TABLE_CHROME_ROWS = 5;

const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR_RE =
  /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;

/** Estimated terminal rows a non-table line occupies once wrapped to `width`. */
export function estimateWrappedRows(line: string, width: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.ceil(getCachedStringWidth(line) / width));
}

/** True when `lines[i]` starts a markdown table (a row followed by a separator). */
export function isTableStart(lines: string[], i: number): boolean {
  return (
    TABLE_ROW_RE.test(lines[i]!) &&
    i + 1 < lines.length &&
    TABLE_SEPARATOR_RE.test(lines[i + 1]!)
  );
}

export interface PendingSliceResult {
  /**
   * Number of leading source lines whose combined RENDERED height fits within
   * `budget`. May be 0 when even the first line/table alone overflows (the
   * caller then renders nothing plus a "more" cue rather than an oversized row).
   */
  keptLines: number;
  /** True when some trailing source lines were dropped to fit the budget. */
  clipped: boolean;
}

/**
 * How many leading source lines of `allLines` fit within `budget` RENDERED
 * terminal rows. Block-aware:
 *  - a non-table line costs {@link estimateWrappedRows};
 *  - a *completed* table costs `min(2*dataRows + TABLE_CHROME_ROWS, tableClampRows)`
 *    — capped because a streaming table is height-clamped by TableRenderer;
 *  - a table that would overflow the remaining budget is cut *before* (kept for
 *    a later chunk / commit) unless it is the first block, in which case it is
 *    kept and the clamp bounds it, then the walk stops.
 *
 * The result is an upper bound on the true rendered height of the kept prefix,
 * so callers that slice to `keptLines` can never overflow the viewport.
 */
export function fitPendingSlice(
  allLines: string[],
  contentWidth: number,
  budget: number,
  tableClampRows: number,
): PendingSliceResult {
  let rendered = 0;
  let kept = allLines.length;
  for (let i = 0; i < allLines.length; ) {
    if (isTableStart(allLines, i)) {
      let j = i + 2;
      while (j < allLines.length && TABLE_ROW_RE.test(allLines[j]!)) j++;
      const cost = Math.min(
        2 * (j - (i + 2)) + TABLE_CHROME_ROWS,
        tableClampRows,
      );
      if (rendered + cost > budget && i > 0) {
        kept = i;
        break;
      }
      rendered += cost;
      i = j;
      if (rendered >= budget) {
        kept = j;
        break;
      }
    } else {
      rendered += estimateWrappedRows(allLines[i]!, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  return { keptLines: kept, clipped: kept < allLines.length };
}
