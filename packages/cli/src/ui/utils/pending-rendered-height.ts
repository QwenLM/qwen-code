/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import wrapAnsi from 'wrap-ansi';
import { getCachedStringWidth } from './textUtils.js';
import { readInlineMathSpanAt } from './inline-math.js';
import { parseCodeFenceInfo } from './markdownUtilities.js';
import { renderTableText } from './TableRenderer.js';

/**
 * Shared rendered-height accounting for bounding the live (pending) markdown
 * frame during streaming. A single source line does NOT map to a single
 * terminal row: a wide/CJK line wraps, and a markdown table renders ~2 rows per
 * data row (TableRenderer draws a separator between every data row) plus
 * borders and vertical margin. Both the incremental scrollback commit
 * (useLlmStream) and the render-side safety-net slice (MarkdownDisplay) use
 * this module so they agree on how tall the pending content will render — a
 * divergent estimate would let the safety net engage out of step with the
 * commit and flicker.
 */

/** A markdown table row: `| ... |`. Group 1 captures the inner cells. */
export const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** A markdown table separator: `| --- | :--: |` etc. */
export const TABLE_SEPARATOR_RE =
  /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;
/** A fenced code block delimiter. Group 1 is the fence (``` or ~~~ run). */
export const CODE_FENCE_RE = /^ *(`{3,}|~{3,}) *([^`]*)$/;

function readTableInlineMathSpan(row: string, index: number): string | null {
  return readInlineMathSpanAt(row, index);
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
  if (
    width <= 0 ||
    (!line.includes('\n') && getCachedStringWidth(line) <= width)
  )
    return 1;
  return wrapAnsi(line, width, { trim: false, hard: true }).split('\n').length;
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
 *  - a table costs its actual rendered text height plus margins, capped at
 *    `tableClampRows`, using the same layout function as TableRenderer;
 *  - a table that would overflow the remaining budget is cut *before* (kept for
 *    a later chunk / commit) unless it is the first pending block and its
 *    margins can fit, in which case it is kept for the renderer to clamp;
 *  - completed visual Mermaid/math blocks are rejected: source height does
 *    not bound diagrams or their copy-command headers;
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
  isPending = true,
  {
    renderVisualBlocks = true,
    showLineNumbers = true,
  }: { renderVisualBlocks?: boolean; showLineNumbers?: boolean } = {},
): PendingSliceResult {
  let rendered = 0;
  let kept = allLines.length;
  let codeFence = ''; // non-empty while inside a fenced code block
  let codeContentWidth = contentWidth;
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
      rendered += estimateWrappedRows(
        line.replace(/\t/g, '    '),
        codeContentWidth,
      );
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (fenceMatch) {
      codeFence = fenceMatch[1]!;
      // CodeColorizer adds padding and a numbered gutter, and expands tabs.
      const { lang, startLine } = parseCodeFenceInfo(fenceMatch[2]);
      // A completed diagram's height cannot be inferred from its source lines.
      if (
        !isPending &&
        renderVisualBlocks &&
        lang?.toLowerCase() === 'mermaid'
      ) {
        kept = i;
        break;
      }
      let end = i + 1;
      while (end < allLines.length) {
        const closing = CODE_FENCE_RE.exec(allLines[end]!);
        if (
          closing &&
          closing[1]!.startsWith(codeFence[0]!) &&
          closing[1]!.length >= codeFence.length
        )
          break;
        end++;
      }
      const blockLineCount = allLines
        .slice(i + 1, end)
        .join('\n')
        .replace(/\n$/, '')
        .split('\n').length;
      const gutterWidth = showLineNumbers
        ? String(startLine + blockLineCount - 1).length + 1
        : 0;
      codeContentWidth = Math.max(1, contentWidth - 1 - gutterWidth);
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (!isPending && renderVisualBlocks && /^ *\$\$ *$/.test(line)) {
      kept = i;
      break;
    }
    if (renderVisualBlocks && isTableStart(allLines, i)) {
      let j = i + 2;
      while (j < allLines.length && TABLE_ROW_RE.test(allLines[j]!)) j++;
      const headers = splitMarkdownTableRow(
        TABLE_ROW_RE.exec(allLines[i]!)![1]!,
      );
      const rows = allLines
        .slice(i + 2, j)
        .map((row) => splitMarkdownTableRow(TABLE_ROW_RE.exec(row)![1]!));
      const layoutRows = (isStreaming: boolean) =>
        renderTableText({
          headers,
          rows,
          contentWidth,
          enableInlineMath: true,
          isStreaming,
        })
          .split('\n')
          .reduce(
            (count, line) =>
              count + estimateWrappedRows(line, Math.max(1, contentWidth)),
            0,
          ) + 2;
      // Slicing can make a closed table the frontier; either layout must fit.
      const tableRows = isPending
        ? Math.max(
            layoutRows(true),
            j < allLines.length ? layoutRows(false) : 0,
          )
        : layoutRows(false);
      // TableRenderer clamps its text, with two margin rows outside the clamp.
      const cost = Math.min(tableRows, tableClampRows + 2);
      if (rendered + cost > budget && (i > 0 || !isPending || budget < 3)) {
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
      const listItem = /^([ \t]*)(?:([-*+])|(\d+)\.) +(.*)/.exec(line);
      if (listItem) {
        const markerWidth = listItem[2] ? 2 : listItem[3]!.length + 2;
        const itemWidth = Math.max(
          1,
          contentWidth - listItem[1]!.length - 1 - markerWidth,
        );
        rendered += estimateWrappedRows(listItem[4]!, itemWidth);
      } else {
        const quote = renderVisualBlocks ? /^ *> ?(.*)$/.exec(line) : null;
        rendered += estimateWrappedRows(
          quote ? quote[1]! : line,
          quote ? Math.max(1, contentWidth - 3) : contentWidth,
        );
      }
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  return { keptLines: kept, clipped: kept < allLines.length };
}
