/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import wrapAnsi from 'wrap-ansi';
import { getCachedStringWidth } from './textUtils.js';
import { readInlineMathSpanAt } from './inline-math.js';

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

/** The fixed chrome a horizontal table adds around its rows: the top,
 *  header-separator and bottom borders (3) plus a `marginY` of 1 (2 rows) = 5.
 *  fitPendingSlice adds this to the summed wrapped row heights (`contentRows`)
 *  and the N-1 inter-row separators — it is no longer a flat `2 * dataRows + 5`. */
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
/** A code fence: group 1 is the marker run, group 2 is info/trailing text. */
export const CODE_FENCE_RE = /^ *(`{3,}|~{3,}) *([^`]*)$/;
/** A list item: indent (1), marker (2), then the item text (3). */
export const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d+\.) +(.*)$/;
/** A blockquote line: `> text`. Group 1 is the quoted text. */
export const BLOCKQUOTE_LINE_RE = /^ *> ?(.*)$/;

// Mirrors MarkdownDisplay's own prefixes. They are re-declared rather than
// imported because MarkdownDisplay imports this module.
const LIST_ITEM_PREFIX_PADDING = 1;
const BLOCKQUOTE_PREFIX_PADDING = 1;
const BLOCKQUOTE_MARKER_WIDTH = 2; // "│ "
export const CODE_BLOCK_PREFIX_PADDING = 1;
const TASK_ITEM_GLYPH_WIDTH = 2; // `✓ ` / `○ `

/** Rows the renderer reserves below the viewport when it pre-slices pending
 *  or height-budgeted content (`availableTerminalHeight - 2`). Exported so the
 *  height gate measures against the same budget the renderer slices at, not
 *  the raw viewport. */
export const PENDING_RENDERED_BUDGET_RESERVE = 2;

/** Extra rows reserved when clamping a streaming table (`- 3`): marginY 2 +
 *  one row of wrapped-cell safety headroom. */
export const TABLE_PENDING_RESERVED_ROWS = 3;

/** Floor of the renderer's pending budget (streaming safety net). */
export const MIN_PENDING_CONTENT_LINES = 1;

/** The budget MarkdownDisplay actually slices at for a viewport of
 *  `availableTerminalHeight` rows. */
export function pendingRenderedBudget(availableTerminalHeight: number): number {
  return Math.max(
    MIN_PENDING_CONTENT_LINES,
    availableTerminalHeight - PENDING_RENDERED_BUDGET_RESERVE,
  );
}

/** The clamp MarkdownDisplay applies to a streaming/budgeted table for a
 *  viewport of `availableTerminalHeight` rows. */
export function pendingTableClampRows(availableTerminalHeight: number): number {
  return Math.max(2, availableTerminalHeight - TABLE_PENDING_RESERVED_ROWS);
}

/**
 * True when `lines` opens a ```mermaid (or ~~~mermaid) fence. The renderer
 * draws such a fence as a diagram whose height is bounded only by the
 * message-level viewport — never by the fence's source lines — so no
 * source-line charge models it. A completed-result gate fails closed on it
 * (plain-text fallback, the behavior every budgeted result had before
 * markdown was kept) rather than certify a fit the diagram can overflow.
 */
export function hasMermaidFence(lines: string[]): boolean {
  let fence: string | null = null;
  for (const line of lines) {
    const match = CODE_FENCE_RE.exec(line);
    if (fence) {
      // Delegate to the predicate the renderer's own walk uses: a fence line
      // carrying an info string is content inside the block, not its closer.
      if (isClosingCodeFence(match, fence)) fence = null;
      continue;
    }
    if (match) {
      // The renderer takes the language from the first token of the info
      // string, so a fence carrying anything after it — `mermaid title="x"`,
      // `mermaid qwen-code:start-line=12` — still draws a diagram. Matching
      // the whole string here would let that fence be charged by its source
      // lines and then render a diagram past the budget the gate certified.
      if (parseCodeFenceInfo(match[2]).lang?.toLowerCase() === 'mermaid')
        return true;
      fence = match[1]!;
    }
  }
  return false;
}

/**
 * Internal fence info-string directive carrying the gutter start line for a
 * code block that streaming split across commits. It rides on the re-opened
 * fence's info line — which is a delimiter line, never rendered as content — so
 * it never shows on screen; it only lets `parseCodeFenceInfo` restore
 * continuous line numbering. Namespaced to avoid colliding with real info
 * strings.
 */
export const START_LINE_DIRECTIVE_RE = /\s*\bqwen-code:start-line=(\d+)\b/;

/**
 * Parses a fenced code block's info string into its language (first token, with
 * the internal start-line directive removed) and the gutter start line (1 when
 * no directive is present). Shared by MarkdownDisplay so the directive never
 * leaks into language detection.
 */
export const parseCodeFenceInfo = (
  info: string | undefined | null,
): { lang: string | null; startLine: number } => {
  const raw = info ?? '';
  const directive = raw.match(START_LINE_DIRECTIVE_RE);
  const startLine = directive ? Math.max(1, Number(directive[1])) : 1;
  const lang = raw.replace(START_LINE_DIRECTIVE_RE, '').trim().split(/\s+/)[0];
  return { lang: lang || null, startLine };
};

export function isClosingCodeFence(
  match: RegExpMatchArray | null,
  openingFence: string,
): boolean {
  return (
    match !== null &&
    match[1]!.startsWith(openingFence[0]!) &&
    match[1]!.length >= openingFence.length &&
    // Raw CRLF lines and a stream paused before LF can retain the final CR.
    /^[ \t]*\r?$/.test(match[2] ?? '')
  );
}

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

/** Estimated terminal rows a non-table line occupies once wrapped to `width`.
 *  Charged with the renderer's own wrapper: Ink breaks at word boundaries, so a
 *  character-ceil under-counts a line whose words do not pack the last row
 *  (`aa aa aa` at width 4 renders 3 rows, ceils to 2). */
export function estimateWrappedRows(line: string, width: number): number {
  if (width <= 0) return 1;
  const wrapped = wrapAnsi(line, width, { trim: false, hard: true }).split(
    '\n',
  ).length;
  return Math.max(wrapped, Math.ceil(getCachedStringWidth(line) / width));
}

/**
 * How many rows a plain (non-table, non-code-fence) source line renders at
 * `contentWidth`. List items and blockquotes share only part of that width:
 * MarkdownDisplay insets the item text by its marker + padding, so charging the
 * whole line at `contentWidth` under-counts a wide bullet by a row (#13956).
 * Charges the narrowest width the line can render at, so the estimate stays an
 * upper bound.
 */
export function estimateLineRows(
  line: string,
  contentWidth: number,
  renderVisualBlocks = true,
): number {
  if (contentWidth <= 0) return 1;
  const listItem = LIST_ITEM_RE.exec(line);
  if (listItem) {
    // RenderListItemInternal insets the text box by the item's indent, the
    // shared prefix padding and a fixed-width marker cell, at every nesting
    // level. Render mode replaces a task marker with a two-column glyph.
    // Raw mode keeps the literal marker in the text box.
    const task = renderVisualBlocks ? /^\[[ xX]\]\s+/.exec(listItem[3]!) : null;
    const itemText = task ? listItem[3]!.slice(task[0].length) : listItem[3]!;
    const markerWidth = task
      ? TASK_ITEM_GLYPH_WIDTH
      : getCachedStringWidth(listItem[2]!) + 1;
    const indentWidth = listItem[1]!.length;
    return estimateWrappedRows(
      itemText,
      contentWidth - indentWidth - LIST_ITEM_PREFIX_PADDING - markerWidth,
    );
  }
  const blockquote = renderVisualBlocks ? BLOCKQUOTE_LINE_RE.exec(line) : null;
  if (blockquote) {
    return estimateWrappedRows(
      blockquote[1]!,
      contentWidth - BLOCKQUOTE_PREFIX_PADDING - BLOCKQUOTE_MARKER_WIDTH,
    );
  }
  return estimateWrappedRows(line, contentWidth);
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
  /**
   * RENDERED rows (not source lines) walked through `keptLines`. Unlike
   * `clipped`, this is true when the result does not fit `budget`, including
   * the case where an over-budget leading table is kept whole (the `i > 0`
   * cut rule) and `clipped` therefore stays false. Callers using this as a
   * height gate must read it alongside `clipped` — a cut at a later block
   * leaves `renderedRows` at the prefix while `clipped` is true.
   */
  renderedRows: number;
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
  options: {
    showLineNumbers?: boolean;
    renderVisualBlocks?: boolean;
    measureCompletedTableRows?: (
      headers: string[],
      rows: string[][],
      contentWidth: number,
    ) => number;
  } = {},
): PendingSliceResult {
  let rendered = 0;
  let kept = allLines.length;
  let codeFence = ''; // non-empty while inside a fenced code block
  // Width the active fence's body is charged at: RenderCodeBlock draws code
  // inside `paddingLeft={CODE_BLOCK_PREFIX_PADDING}` and colorizeCode prefixes
  // each line with a right-padded line number plus a space (`ui.showLineNumbers`
  // defaults on), so the code text box is narrower than `contentWidth`. The
  // gutter grows with the block's line count, so it is derived per block, not
  // hard-coded.
  let activeCodeLineWidth = contentWidth;
  const showLineNumbers = options.showLineNumbers ?? true;
  const renderVisualBlocks = options.renderVisualBlocks ?? true;
  for (let i = 0; i < allLines.length; ) {
    const line = allLines[i]!;
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (codeFence) {
      // Inside a code block: charge the line as code at the code box's width
      // (a code line renders verbatim — no markdown constructs), and close on
      // a matching fence. Never treat contents as a table.
      if (isClosingCodeFence(fenceMatch, codeFence)) {
        codeFence = '';
        activeCodeLineWidth = contentWidth;
      }
      rendered += estimateWrappedRows(line, activeCodeLineWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (fenceMatch) {
      codeFence = fenceMatch[1]!;
      // Lookahead to the closing fence: colorizeCode pads its line numbers to
      // the widest one the block will draw, including the start-line directive
      // on the reopened tail of a split block.
      let close = -1;
      for (let k = i + 1; k < allLines.length; k++) {
        const closing = CODE_FENCE_RE.exec(allLines[k]!);
        if (isClosingCodeFence(closing, codeFence)) {
          close = k;
          break;
        }
      }
      const bodyCount = (close === -1 ? allLines.length : close) - (i + 1);
      const { startLine } = parseCodeFenceInfo(fenceMatch[2]);
      activeCodeLineWidth =
        contentWidth -
        CODE_BLOCK_PREFIX_PADDING -
        (showLineNumbers ? String(bodyCount + startLine - 1).length + 1 : 0);
      rendered += estimateLineRows(line, contentWidth, renderVisualBlocks);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (renderVisualBlocks && isTableStart(allLines, i)) {
      let j = i + 2;
      while (j < allLines.length && TABLE_ROW_RE.test(allLines[j]!)) j++;
      if (options.measureCompletedTableRows) {
        const headers = splitMarkdownTableRow(TABLE_ROW_RE.exec(line)![1]!);
        const rows = allLines
          .slice(i + 2, j)
          .filter((row) => !TABLE_SEPARATOR_RE.test(row))
          .map((row) => splitMarkdownTableRow(TABLE_ROW_RE.exec(row)![1]!));
        if (rows.length > 0) {
          // A completed layout renders at least one line for each data row.
          // If those alone exhaust the budget, skip formatting the whole table.
          const cost =
            rows.length > budget - rendered
              ? rows.length
              : options.measureCompletedTableRows(headers, rows, contentWidth);
          if (rendered + cost > budget && i > 0) {
            kept = i;
            break;
          }
          rendered += cost;
        }
        i = j;
        if (rendered >= budget) {
          kept = j;
          break;
        }
        continue;
      }
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
      // splitMarkdownTableRow already trims each cell, so headerCells and the
      // per-row cells below need no further trimming.
      const headerCells = splitMarkdownTableRow(
        TABLE_ROW_RE.exec(allLines[i]!)![1]!,
      );
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
      let verticalRows = 0;
      // The header row's own wrapped height (reusing headerCells, not re-parsed).
      let maxRowLines = 1;
      for (const label of headerCells) {
        maxRowLines = Math.max(
          maxRowLines,
          estimateWrappedRows(label, perColWidth),
        );
      }
      contentRows += maxRowLines;
      // Data rows: sum every row's wrapped height, but anchor the vertical
      // trigger to the header + FIRST data row only (r === i + 2) so appending
      // rows never flips the format mid-stream.
      for (let r = i + 2; r < j; r++) {
        const cells = splitMarkdownTableRow(
          TABLE_ROW_RE.exec(allLines[r]!)![1]!,
        );
        let rowMax = 1;
        for (let colIdx = 0; colIdx < cells.length; colIdx++) {
          const value = cells[colIdx]!;
          rowMax = Math.max(rowMax, estimateWrappedRows(value, perColWidth));
          const label = headerCells[colIdx] ?? '';
          verticalRows += estimateWrappedRows(
            label ? `${label}: ${value}` : value,
            contentWidth,
          );
        }
        contentRows += rowMax;
        if (r === i + 2) {
          maxRowLines = Math.max(maxRowLines, rowMax);
        }
      }
      // `maxRowLines` (header + first row) drives the format choice, mirroring
      // TableRenderer. It is close to but NOT a guaranteed upper bound on the
      // renderer's real first-row wrap count — three renderer behaviours can make
      // a cell wrap taller than modelled here: (a) proportional (not equal-share)
      // column widths shrink a narrow column below `perColWidth`; (b) word-aware
      // wrapping (wrapAnsi) can break a line one row earlier than character-level
      // `estimateWrappedRows`; (c) a post-layout width-safety check can force
      // vertical. Each can only make the renderer go vertical/taller while the
      // estimate stays horizontal/shorter — an under-charge — for which the
      // `MainContent` maxHeight backstop is the hard cap that still prevents the
      // overflow/lock. Deliberately NOT over-correcting here (e.g. shrinking every
      // width or bumping the trigger), which would over-charge and clip common
      // uniform tables early.
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
      rendered += estimateLineRows(line, contentWidth, renderVisualBlocks);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  return {
    keptLines: kept,
    clipped: kept < allLines.length,
    renderedRows: rendered,
  };
}
