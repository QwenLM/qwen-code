/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import { getPlainTextLength } from './InlineMarkdownRenderer.js';
import { getCachedStringWidth } from './textUtils.js';

/** Minimum column width to prevent degenerate layouts */
const MIN_COLUMN_WIDTH = 3;

/** Maximum number of lines per row before switching to vertical format */
const MAX_ROW_LINES = 4;

/** Safety margin to account for terminal resize races */
const SAFETY_MARGIN = 4;

/** ANSI escape codes for text formatting */
const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

export type ColumnAlign = 'left' | 'center' | 'right';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
  /** Per-column alignment parsed from markdown separator line */
  aligns?: ColumnAlign[];
}

const INLINE_MARKDOWN_REGEX =
  /(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>)/;

/**
 * Strip inline markdown syntax from text to get plain content.
 * Used for column width calculation and text wrapping.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/<u>(.*?)<\/u>/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');
}

function hasInlineMarkdown(text: string): boolean {
  return INLINE_MARKDOWN_REGEX.test(text);
}

/**
 * Pad `content` to `targetWidth` according to alignment.
 * `displayWidth` is the visible width of `content` — caller computes this
 * via stringWidth so ANSI codes in `content` don't affect padding.
 */
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: ColumnAlign,
): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content;
  }
  // left (default)
  return content + ' '.repeat(padding);
}

/**
 * Wrap text to fit within a given width, returning array of lines.
 * ANSI-aware: preserves styling across line breaks.
 */
function wrapText(
  text: string,
  width: number,
  options?: { hard?: boolean },
): string[] {
  if (width <= 0) return [text];
  const trimmedText = text.trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  const lines = wrapped.split('\n').filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

/**
 * Get the visual width of the longest word in a cell text.
 * This determines the minimum column width to avoid breaking words.
 */
function getMinWordWidth(text: string): number {
  const clean = stripAnsi(stripInlineMarkdown(text));
  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return MIN_COLUMN_WIDTH;
  return Math.max(
    ...words.map((w) => getCachedStringWidth(w)),
    MIN_COLUMN_WIDTH,
  );
}

/**
 * Custom table renderer for markdown tables.
 *
 * Builds the table as pure ANSI strings (like Claude Code does)
 * to prevent Ink from inserting mid-row line breaks.
 *
 * Improvements over original:
 * 1. ANSI-aware + CJK-aware column width calculation via stringWidth
 * 2. Cell content wraps (multi-line) instead of truncation
 * 3. Supports left/center/right alignment from markdown separator markers
 * 4. Vertical fallback format when rows would be too tall
 * 5. Safety check against terminal resize races
 */
export const TableRenderer: React.FC<TableRendererProps> = ({
  headers,
  rows,
  contentWidth,
  aligns,
}) => {
  const colCount = headers.length;

  // ── Step 1: Calculate min (longest word) and ideal (full content) widths ──
  const minColumnWidths = headers.map((header, colIndex) => {
    let maxMin = getMinWordWidth(header);
    for (const row of rows) {
      maxMin = Math.max(maxMin, getMinWordWidth(row[colIndex] || ''));
    }
    return maxMin;
  });

  const idealWidths = headers.map((header, colIndex) => {
    let maxIdeal = Math.max(getPlainTextLength(header), MIN_COLUMN_WIDTH);
    for (const row of rows) {
      maxIdeal = Math.max(maxIdeal, getPlainTextLength(row[colIndex] || ''));
    }
    return maxIdeal;
  });

  // ── Step 2: Calculate available space ──
  // Border overhead: │ content │ content │ = 1 + (width + 3) per column
  const borderOverhead = 1 + colCount * 3;
  const availableWidth = Math.max(
    contentWidth - borderOverhead - SAFETY_MARGIN,
    colCount * MIN_COLUMN_WIDTH,
  );

  // ── Step 3: Calculate column widths that fit available space ──
  const totalMin = minColumnWidths.reduce((sum, w) => sum + w, 0);
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);

  let needsHardWrap = false;
  let columnWidths: number[];

  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map(
      (ideal, i) => ideal - minColumnWidths[i]!,
    );
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);

    columnWidths = minColumnWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      const extra = Math.floor((overflows[i]! / totalOverflow) * extraSpace);
      return min + extra;
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minColumnWidths.map((w) =>
      Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH),
    );
  }

  // ── Helper: Get plain text for a cell (strips markdown + ANSI) ──
  const getCellPlainText = (text: string): string =>
    stripAnsi(stripInlineMarkdown(text));

  // Preserve ANSI when possible; markdown currently falls back to plain text.
  const getFormattedCellText = (text: string): string =>
    hasInlineMarkdown(text) ? stripInlineMarkdown(text) : text;

  // ── Step 4: Check max row lines to decide vertical fallback ──
  function calculateMaxRowLines(): number {
    let maxLines = 1;
    for (let i = 0; i < headers.length; i++) {
      const wrapped = wrapText(
        getCellPlainText(headers[i]!),
        columnWidths[i]!,
        { hard: needsHardWrap },
      );
      maxLines = Math.max(maxLines, wrapped.length);
    }
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const wrapped = wrapText(
          getCellPlainText(row[i] || ''),
          columnWidths[i]!,
          { hard: needsHardWrap },
        );
        maxLines = Math.max(maxLines, wrapped.length);
      }
    }
    return maxLines;
  }

  const maxRowLines = calculateMaxRowLines();
  const useVerticalFormat = maxRowLines > MAX_ROW_LINES;

  // ── Helper: Get alignment for a column ──
  const getAlign = (colIndex: number): ColumnAlign =>
    aligns?.[colIndex] ?? 'left';

  // ── Build horizontal border as pure string ──
  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string];

    let line = left;
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return line;
  }

  // ── Build row lines as pure strings ──
  function renderRowLines(cells: string[], isHeader: boolean): string[] {
    // Wrap each cell's formatted content. Preserve ANSI when possible.
    const cellLines = cells.map((cell, colIndex) =>
      wrapText(getFormattedCellText(cell || ''), columnWidths[colIndex]!, {
        hard: needsHardWrap,
      }),
    );

    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    // Vertical centering offset per cell
    const offsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));

    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '│';
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const lines = cellLines[colIndex]!;
        const offset = offsets[colIndex]!;
        const contentLineIdx = lineIdx - offset;
        const lineText =
          contentLineIdx >= 0 && contentLineIdx < lines.length
            ? lines[contentLineIdx]!
            : '';

        const width = columnWidths[colIndex]!;
        const displayWidth = getCachedStringWidth(stripAnsi(lineText));
        // Header row always center-aligned; data uses column alignment
        const align = isHeader ? 'center' : getAlign(colIndex);
        const padded = padAligned(lineText, displayWidth, width, align);

        if (isHeader) {
          const headerText = lineText.includes('\x1b[')
            ? padded
            : `${ANSI_BOLD_START}${padded}${ANSI_BOLD_END}`;
          line += ' ' + headerText + ' │';
        } else {
          line += ' ' + padded + ' │';
        }
      }
      result.push(line);
    }
    return result;
  }

  // ── Vertical format (key-value pairs) for narrow terminals ──
  function renderVerticalFormat(): string {
    const lines: string[] = [];
    const separatorWidth = Math.max(Math.min(contentWidth - 1, 40), 0);
    const separator = separatorWidth > 0 ? '─'.repeat(separatorWidth) : '';

    rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push(separator);
      }
      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `Column ${colIndex + 1}`;
        const value = getFormattedCellText(cell || '')
          .trim()
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        lines.push(`${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${value}`);
      });
    });
    return lines.join('\n');
  }

  // ── Choose format ──
  if (useVerticalFormat) {
    return (
      <Box marginY={1}>
        <Text>{renderVerticalFormat()}</Text>
      </Box>
    );
  }

  // ── Build the complete horizontal table as strings ──
  const tableLines: string[] = [];
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(headers, true));
  tableLines.push(renderBorderLine('middle'));
  rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false));
    if (rowIndex < rows.length - 1) {
      tableLines.push(renderBorderLine('middle'));
    }
  });
  tableLines.push(renderBorderLine('bottom'));

  // ── Safety check: verify no line exceeds content width ──
  const maxLineWidth = Math.max(
    ...tableLines.map((line) => getCachedStringWidth(stripAnsi(line))),
  );
  if (maxLineWidth > contentWidth - SAFETY_MARGIN) {
    // Fallback to vertical format to prevent terminal resize flicker
    return (
      <Box marginY={1}>
        <Text>{renderVerticalFormat()}</Text>
      </Box>
    );
  }

  // Render as a single Text block to prevent Ink wrapping mid-row
  return (
    <Box flexDirection="column" marginY={1}>
      <Text>{tableLines.join('\n')}</Text>
    </Box>
  );
};
