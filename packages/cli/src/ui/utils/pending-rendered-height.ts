/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import wrapAnsi from 'wrap-ansi';
import { getCachedStringWidth } from './textUtils.js';
import { readInlineMathSpanAt } from './inline-math.js';
import { parseCodeFenceInfo } from './markdown-utilities.js';
import { renderTableText, TABLE_MARGIN_ROWS } from './TableRenderer.js';

export const LIST_ITEM_PREFIX_PADDING = 1;
export const BLOCKQUOTE_PREFIX_PADDING = 1;
export const BLOCKQUOTE_PREFIX = '│ ';
export const PENDING_MERMAID_HEADER = 'Mermaid diagram is being written...';
export const MIN_PENDING_CONTENT_LINES = 1;
export const PENDING_MARKDOWN_HEADROOM_ROWS = 2;

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

/** Exact wrapped rows unless a lower bound already exceeds `maxRows`. */
export function estimateWrappedRows(
  line: string,
  width: number,
  maxRows = Number.MAX_SAFE_INTEGER,
): number {
  if (
    width <= 0 ||
    (!line.includes('\n') &&
      !line.includes('\t') &&
      getCachedStringWidth(line) <= width)
  )
    return 1;
  // A double-width grapheme can occupy a row even when width is only one.
  const rowWidth = Math.max(2, width);
  const measured = getCachedStringWidth(line);
  if (measured > rowWidth * maxRows) return Math.ceil(measured / rowWidth);
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
  /** End of a closed table that can be committed whole, even without a blank. */
  completedTableBoundary?: number;
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
 *  - visual Mermaid/math blocks can be rejected: source height does not bound
 *    diagrams or their copy-command headers;
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
    rejectVisualBlocks = !isPending,
    keepFirstTable = true,
  }: {
    renderVisualBlocks?: boolean;
    showLineNumbers?: boolean;
    rejectVisualBlocks?: boolean;
    keepFirstTable?: boolean;
  } = {},
): PendingSliceResult {
  let rendered = 0;
  let kept = allLines.length;
  let codeFence = ''; // non-empty while inside a fenced code block
  let inMathBlock = false;
  let codeContentWidth = contentWidth;
  let pendingMermaid = false;
  let lastLineEmpty = true;
  let afterTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  let tableCost = 0;
  let completedTableBoundary: number | undefined;
  const layoutRows = (isStreaming: boolean) => {
    if (tableRows.length >= tableClampRows) {
      return (tableClampRows <= 2 ? 1 : tableClampRows) + TABLE_MARGIN_ROWS;
    }
    const renderedRows = renderTableText({
      headers: tableHeaders,
      rows: tableRows,
      contentWidth,
      enableInlineMath: true,
      isStreaming,
    })
      .split('\n')
      .reduce(
        (count, line) =>
          count + estimateWrappedRows(line, Math.max(1, contentWidth)),
        0,
      );
    // TableText collapses tiny clamps to one cue only when actually clipped.
    const keptRows =
      renderedRows > tableClampRows
        ? tableClampRows <= 2
          ? 1
          : tableClampRows
        : renderedRows;
    return keptRows + TABLE_MARGIN_ROWS;
  };
  for (let i = 0; i < allLines.length; ) {
    const line = allLines[i]!;
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (inMathBlock) {
      if (/^ *\$\$ *$/.test(line)) {
        inMathBlock = false;
        if (!isPending) {
          i++;
          continue;
        }
      }
      rendered += estimateWrappedRows(line, contentWidth, budget - rendered);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
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
      // Pending diagrams truncate each source line and omit the closing fence.
      rendered += pendingMermaid
        ? codeFence
          ? 1
          : 0
        : estimateWrappedRows(
            line.replace(/\t/g, '    '),
            codeContentWidth,
            budget - rendered,
          );
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    const isBlank = line.trim().length === 0;
    // MarkdownDisplay drops leading blanks and renders one spacer per blank run.
    if (isBlank && lastLineEmpty) {
      i++;
      continue;
    }
    lastLineEmpty = isBlank;
    if (fenceMatch) {
      codeFence = fenceMatch[1]!;
      // CodeColorizer adds padding and a numbered gutter, and expands tabs.
      const { lang, startLine } = parseCodeFenceInfo(fenceMatch[2]);
      pendingMermaid =
        isPending && renderVisualBlocks && lang?.toLowerCase() === 'mermaid';
      // A diagram's height cannot be inferred from its source lines.
      if (
        rejectVisualBlocks &&
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
      const contentLines = end - i - 1;
      const blockLineCount = Math.max(
        1,
        contentLines - (allLines[end - 1] === '' ? 1 : 0),
      );
      const gutterWidth = showLineNumbers
        ? String(startLine + blockLineCount - 1).length + 1
        : 0;
      codeContentWidth = Math.max(1, contentWidth - 1 - gutterWidth);
      rendered += pendingMermaid
        ? estimateWrappedRows(
            PENDING_MERMAID_HEADER,
            Math.max(1, contentWidth - 1),
            budget - rendered,
          )
        : estimateWrappedRows(line, contentWidth, budget - rendered);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (renderVisualBlocks && /^ *\$\$ *$/.test(line)) {
      if (rejectVisualBlocks) {
        kept = i;
        break;
      }
      inMathBlock = true;
      if (!isPending) {
        i++;
        continue;
      }
    }
    const resumesTable =
      afterTable &&
      !inMathBlock &&
      (TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line));
    if (renderVisualBlocks && (resumesTable || isTableStart(allLines, i))) {
      let j = resumesTable ? i : i + 2;
      if (!resumesTable) {
        tableHeaders = splitMarkdownTableRow(TABLE_ROW_RE.exec(line)![1]!);
        tableRows = [];
        tableCost = 0;
      }
      while (j < allLines.length) {
        const row = allLines[j]!;
        if (TABLE_SEPARATOR_RE.test(row)) {
          j++;
        } else {
          const match = TABLE_ROW_RE.exec(row);
          if (!match) break;
          tableRows.push(splitMarkdownTableRow(match[1]!));
          j++;
        }
      }
      // The renderer holds the same table open across code/math blocks.
      rendered -= tableCost;
      if (
        j < allLines.length &&
        !CODE_FENCE_RE.test(allLines[j]!) &&
        !/^ *\$\$ *$/.test(allLines[j]!) &&
        !(isPending && j === allLines.length - 1 && /^\s*\|/.test(allLines[j]!))
      ) {
        completedTableBoundary = j;
      }
      if (tableRows.length === 0) {
        // MarkdownDisplay holds a table until its first data row arrives.
        afterTable = true;
        i = j;
        continue;
      }
      // Each data row needs at least one row, even in vertical layout.
      const minimumCost =
        Math.min(tableRows.length, tableClampRows <= 2 ? 1 : tableClampRows) +
        TABLE_MARGIN_ROWS;
      let cost =
        rendered + minimumCost > budget ? minimumCost : layoutRows(isPending);
      if (rendered + cost > budget) {
        kept =
          i > 0 || !isPending || !keepFirstTable || budget <= TABLE_MARGIN_ROWS
            ? i
            : j;
        break;
      }
      if (isPending && completedTableBoundary === j) {
        const completedCost = layoutRows(false);
        // Keep a fitting frontier rather than drop it for unseen following text.
        if (rendered + completedCost > budget) {
          kept = j;
          break;
        }
        cost = Math.max(cost, completedCost);
      }
      rendered += cost;
      tableCost = cost;
      afterTable = true;
      i = j;
      if (rendered >= budget) {
        kept = j;
        break;
      }
    } else {
      const listItem = /^([ \t]*)(?:([-*+])|(\d+)\.) +(.*)/.exec(line);
      if (afterTable && !inMathBlock) {
        if (!(isPending && i === allLines.length - 1 && /^\s*\|/.test(line))) {
          if (
            isPending &&
            tableRows.length > 0 &&
            completedTableBoundary !== i
          ) {
            rendered += Math.max(0, layoutRows(false) - tableCost);
          }
          completedTableBoundary = i;
        }
        // The renderer consumes a table's closing text line as inline text.
        rendered += isBlank
          ? 0
          : estimateWrappedRows(line, contentWidth, budget - rendered);
        afterTable = false;
        lastLineEmpty = false;
      } else if (isBlank) {
        rendered++;
      } else if (listItem) {
        const taskItem = renderVisualBlocks
          ? /^\[([ xX])\]\s+(.*)$/.exec(listItem[4]!)
          : null;
        const markerWidth =
          taskItem || listItem[2] ? 2 : listItem[3]!.length + 2;
        const itemWidth = Math.max(
          1,
          contentWidth -
            listItem[1]!.length -
            LIST_ITEM_PREFIX_PADDING -
            markerWidth,
        );
        rendered += estimateWrappedRows(
          taskItem ? taskItem[2]! : listItem[4]!,
          itemWidth,
          budget - rendered,
        );
      } else {
        const quote = renderVisualBlocks ? /^ *> ?(.*)$/.exec(line) : null;
        rendered += estimateWrappedRows(
          quote ? quote[1]! : line,
          quote
            ? Math.max(
                1,
                contentWidth -
                  BLOCKQUOTE_PREFIX_PADDING -
                  getCachedStringWidth(BLOCKQUOTE_PREFIX),
              )
            : contentWidth,
          budget - rendered,
        );
      }
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  // A final delimiter prefix can still grow into a fence or table separator.
  if (
    completedTableBoundary === allLines.length - 1 &&
    /^ *(?:`{1,2}|~{1,2}|\$)\s*$|^\s*[:|-][\s:|-]*$/.test(
      allLines[completedTableBoundary]!,
    )
  ) {
    completedTableBoundary = undefined;
  }
  const clipped = kept < allLines.length;
  return {
    keptLines: kept,
    clipped,
    ...(isPending &&
    clipped &&
    completedTableBoundary !== undefined &&
    completedTableBoundary <= kept
      ? { completedTableBoundary }
      : {}),
  };
}
