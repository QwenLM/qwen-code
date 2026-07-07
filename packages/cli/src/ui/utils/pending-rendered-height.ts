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

/** The wrap-height threshold: when any cell wraps past this many lines,
 *  TableRenderer falls back to the (much taller) vertical layout. This is the
 *  single source of truth — TableRenderer imports it as MAX_ROW_LINES — so the
 *  renderer and this estimator can never disagree on the format decision. */
export const TABLE_MAX_ROW_LINES = 4;

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
 *  - a *completed* table costs the height of whichever layout TableRenderer will
 *    pick — horizontal (wrapped rows + chrome) or, when the terminal is too
 *    narrow OR a cell wraps past {@link TABLE_MAX_ROW_LINES}, the taller vertical
 *    `label: value` layout — capped at `tableClampRows` (TableRenderer clamps a
 *    streaming table's height to that);
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
      // its tallest wrapped cell, + chrome) OR the vertical key-value format
      // (colCount label:value lines per row + a separator between rows +
      // marginY), which is much taller for multi-column tables. It picks vertical
      // when the terminal is too narrow OR any cell wraps past MAX_ROW_LINES.
      // Charge the height it will ACTUALLY render by mirroring BOTH triggers —
      // charging vertical unconditionally over-estimates and clips a small table
      // early on a wide terminal, while modelling only the width trigger
      // under-charges a wide terminal whose long-text cells wrap tall (the
      // renderer goes vertical, the live frame overflows and locks to the top).
      const headerCells = splitMarkdownTableRow(
        TABLE_ROW_RE.exec(allLines[i]!)![1]!,
      ).map((cell) => cell.trim());
      const colCount = headerCells.length;
      // TableRenderer: borderOverhead = 1 + 3*colCount;
      // minHorizontalTableWidth = max(24, colCount*3 + borderOverhead + 4).
      const minHorizontalWidth = Math.max(24, 6 * colCount + 5);
      // Per-row WRAPPED line counts, mirroring TableRenderer's per-cell wrap.
      // TableRenderer shrinks columns PROPORTIONALLY to their content; we
      // approximate that with an equal share of the content area. That is exact
      // for uniform columns but can under-count a heterogeneous table — a narrow
      // column the renderer shrinks below the equal share wraps taller than
      // estimated here — in which case the MainContent maxHeight backstop is the
      // hard cap that still prevents the overflow/lock. MIN_COLUMN_WIDTH mirrors
      // its floor of 3.
      const perColWidth = Math.max(
        3,
        Math.floor((contentWidth - (1 + 3 * colCount) - 4) / colCount),
      );
      // One pass over the header + data rows collects both layouts' heights:
      //  - horizontal `contentRows`: each row is as tall as its tallest wrapped
      //    cell (columns share `perColWidth`);
      //  - the tallest single cell `maxRowLines` (the vertical trigger);
      //  - vertical `verticalRows`: each DATA cell becomes its own `label: value`
      //    line (TableRenderer's renderVerticalFormat prefixes the header label)
      //    that wraps at ~`contentWidth`. Charging just the value, or one flat
      //    line per cell, would under-count a long `label: value` that wraps.
      let contentRows = 0;
      let maxRowLines = 1;
      let verticalRows = 0;
      for (let r = i; r < j; r++) {
        if (r === i + 1) continue; // the separator row is not rendered content
        const cells = splitMarkdownTableRow(
          TABLE_ROW_RE.exec(allLines[r]!)![1]!,
        );
        let rowMax = 1;
        for (let colIdx = 0; colIdx < cells.length; colIdx++) {
          const trimmed = cells[colIdx]!.trim();
          rowMax = Math.max(rowMax, estimateWrappedRows(trimmed, perColWidth));
          if (r >= i + 2) {
            const label = headerCells[colIdx] ?? '';
            verticalRows += estimateWrappedRows(
              label ? `${label}: ${trimmed}` : trimmed,
              contentWidth,
            );
          }
        }
        contentRows += rowMax;
        // Vertical trigger mirrors TableRenderer, which anchors the format choice
        // to the header + FIRST data row only (r === i or i+2) so appending rows
        // never flips the format mid-stream. Heights above still sum every row.
        if (r === i || r === i + 2) {
          maxRowLines = Math.max(maxRowLines, rowMax);
        }
      }
      // `maxRowLines` (header + first row) is an upper bound on the renderer's
      // real first-row wrap count — the equal column share never widens a cell —
      // so it agrees with TableRenderer on which format is chosen.
      // With no data rows yet (a header+separator still streaming), TableRenderer
      // keeps the horizontal header box — renderVerticalFormat iterates the data
      // rows and would draw nothing — so only model vertical once a row exists.
      // Otherwise a narrow terminal would charge the 2-row vertical stub instead
      // of the taller horizontal header, under-charging the transient state.
      const usesVertical =
        dataRows > 0 &&
        (contentWidth < minHorizontalWidth ||
          maxRowLines > TABLE_MAX_ROW_LINES);
      const rows = usesVertical
        ? verticalRows + Math.max(0, dataRows - 1) + 2
        : contentRows + Math.max(0, dataRows - 1) + TABLE_CHROME_ROWS;
      // TableRenderer clamps only the inner <Text> to `tableClampRows`, but
      // wraps it in <Box marginY={1}>, so a clamped table actually renders
      // tableClampRows + 2 rows. Charge that so the two margin lines are never
      // dropped when the clamp engages.
      const cost = Math.min(rows, tableClampRows + 2);
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
