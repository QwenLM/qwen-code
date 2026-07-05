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

/** A markdown table row: `| ... |`. Group 1 captures the inner cells. */
export const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** A markdown table separator: `| --- | :--: |` etc. */
export const TABLE_SEPARATOR_RE =
  /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;
/** A fenced code block delimiter. Group 1 is the fence (``` or ~~~ run). */
export const CODE_FENCE_RE = /^ *(`{3,}|~{3,}) *([^`]*)$/;

const INLINE_MATH_MAX_CHARS = 1024;
const TABLE_INLINE_MATH_SPAN_RE = new RegExp(
  String.raw`(?<![\w$])\$(?![\s\d$])(?=[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\S\$)[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\$(?![\w$])`,
  'y',
);

function readTableInlineMathSpan(row: string, index: number): string | null {
  TABLE_INLINE_MATH_SPAN_RE.lastIndex = index;
  return TABLE_INLINE_MATH_SPAN_RE.exec(row)?.[0] ?? null;
}

/**
 * Splits one markdown table row into its cells, honouring escaped pipes
 * (`\|`), inline code spans and inline math spans. Shared so table detection
 * and the renderer agree on column counts.
 */
export function splitMarkdownTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let activeCodeFenceLength = 0;

  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (char === '\\') {
      const next = row[index + 1];
      if (next === '|') {
        current += '|';
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '`') {
      let runLength = 1;
      while (row[index + runLength] === '`') {
        runLength += 1;
      }
      if (activeCodeFenceLength === 0) {
        activeCodeFenceLength = runLength;
      } else if (runLength === activeCodeFenceLength) {
        activeCodeFenceLength = 0;
      }
      current += '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    if (char === '$' && activeCodeFenceLength === 0) {
      const mathSpan = readTableInlineMathSpan(row, index);
      if (mathSpan) {
        current += mathSpan;
        index += mathSpan.length - 1;
        continue;
      }
    }

    if (char === '|' && activeCodeFenceLength === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

/** Estimated terminal rows a non-table line occupies once wrapped to `width`. */
export function estimateWrappedRows(line: string, width: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.ceil(getCachedStringWidth(line) / width));
}

/**
 * True when `lines[i]` starts a markdown table: a `| ... |` row immediately
 * followed by a separator row whose column count matches the header's. The
 * column-count check mirrors the renderer's own table detection so this and
 * MarkdownDisplay agree on what counts as a table.
 */
export function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  if (header === undefined || i + 1 >= lines.length) return false;
  const headerMatch = TABLE_ROW_RE.exec(header);
  if (!headerMatch) return false;
  const separator = lines[i + 1]!;
  if (!TABLE_SEPARATOR_RE.test(separator)) return false;
  const headerCols = splitMarkdownTableRow(headerMatch[1]!).length;
  const sepCols = splitMarkdownTableRow(separator).filter(
    (cell) => cell.length > 0,
  ).length;
  return headerCols === sepCols;
}

export interface PendingSliceResult {
  /**
   * Number of leading source lines whose combined RENDERED height fits within
   * `budget`. May be 0 when even the first line/table alone overflows (the
   * caller then renders nothing rather than an oversized row).
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
 *    kept and the clamp bounds it, then the walk stops;
 *  - lines inside a fenced code block are charged individually (never treated as
 *    a table) so the estimate matches the renderer, which renders them as code.
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
  let codeFence = ''; // non-empty while inside a fenced code block
  for (let i = 0; i < allLines.length; ) {
    const line = allLines[i]!;
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (codeFence) {
      // Inside a code block: charge the line as code (one row, wrapped), and
      // close on a matching fence. Never treat contents as a table.
      if (
        fenceMatch &&
        fenceMatch[1]!.startsWith(codeFence[0]!) &&
        fenceMatch[1]!.length >= codeFence.length
      ) {
        codeFence = '';
      }
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (fenceMatch) {
      codeFence = fenceMatch[1]!;
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (isTableStart(allLines, i)) {
      let j = i + 2;
      while (j < allLines.length && TABLE_ROW_RE.test(allLines[j]!)) j++;
      const dataRows = j - (i + 2);
      // TableRenderer renders EITHER the horizontal format (each row as tall as
      // its tallest wrapped cell, + chrome) OR, on a narrow terminal, the
      // vertical key-value format (colCount label:value lines per row + a
      // separator between rows + marginY), which is much taller for multi-column
      // tables. Charge the height it will ACTUALLY render by mirroring
      // TableRenderer's width-based vertical decision — charging vertical
      // unconditionally over-estimates and clips a small table early on a wide
      // terminal; under-charging lets a render overflow and lock the viewport.
      // (The maxRowLines→vertical trigger isn't modelled; the clamp is the
      // backstop.)
      const colCount = splitMarkdownTableRow(
        TABLE_ROW_RE.exec(allLines[i]!)![1]!,
      ).length;
      // TableRenderer: borderOverhead = 1 + 3*colCount;
      // minHorizontalTableWidth = max(24, colCount*3 + borderOverhead + 4).
      const minHorizontalWidth = Math.max(24, 6 * colCount + 5);
      const usesVertical = contentWidth < minHorizontalWidth;
      let rows: number;
      if (usesVertical) {
        rows = dataRows * colCount + Math.max(0, dataRows - 1) + 2;
      } else {
        // Horizontal: charge each row's WRAPPED height, not a flat one line per
        // row. Cells wrap when their content exceeds their column width, so a
        // wide table renders taller than `2*dataRows`; under-counting there lets
        // the live frame briefly overflow and jump to the top. TableRenderer
        // shrinks columns proportionally to fit `contentWidth`; approximate that
        // with an equal share of the content area (a safe upper bound — it never
        // gives a wide cell more room than TableRenderer would). For a table that
        // fits, every row is one line and this reduces to `2*dataRows + chrome`.
        // MIN_COLUMN_WIDTH mirrors TableRenderer's floor of 3.
        const perColWidth = Math.max(
          3,
          Math.floor((contentWidth - (1 + 3 * colCount) - 4) / colCount),
        );
        const wrappedRowLines = (rowInner: string): number => {
          let n = 1;
          for (const cell of splitMarkdownTableRow(rowInner)) {
            n = Math.max(n, estimateWrappedRows(cell.trim(), perColWidth));
          }
          return n;
        };
        let contentRows = wrappedRowLines(TABLE_ROW_RE.exec(allLines[i]!)![1]!);
        for (let r = i + 2; r < j; r++) {
          contentRows += wrappedRowLines(TABLE_ROW_RE.exec(allLines[r]!)![1]!);
        }
        rows = contentRows + Math.max(0, dataRows - 1) + TABLE_CHROME_ROWS;
      }
      const cost = Math.min(rows, tableClampRows);
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
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  return { keptLines: kept, clipped: kept < allLines.length };
}
