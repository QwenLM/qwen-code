/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import { getCachedStringWidth } from './textUtils.js';
import { theme } from '../semantic-colors.js';

/** Minimum column width to prevent degenerate layouts */
const MIN_COLUMN_WIDTH = 3;

/** Maximum number of lines per row before switching to vertical format */
const MAX_ROW_LINES = 4;

/** Safety margin to account for terminal resize races */
const SAFETY_MARGIN = 4;

export type ColumnAlign = 'left' | 'center' | 'right';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
  /** Per-column alignment parsed from markdown separator line */
  aligns?: ColumnAlign[];
}

/** Map Ink-compatible named colors to ANSI foreground codes */
const INK_COLOR_TO_ANSI: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackbright: 90,
  redbright: 91,
  greenbright: 92,
  yellowbright: 93,
  bluebright: 94,
  magentabright: 95,
  cyanbright: 96,
  whitebright: 97,
};

/** Apply an Ink-compatible color (hex or named) to text via raw ANSI codes */
function applyColor(text: string, color: string): string {
  if (!color) return text;
  if (color.startsWith('#')) {
    const hex =
      color.length === 4
        ? color[1]! + color[1]! + color[2]! + color[2]! + color[3]! + color[3]!
        : color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }
  const code = INK_COLOR_TO_ANSI[color.toLowerCase()];
  if (code !== undefined) return `\x1b[${code}m${text}\x1b[39m`;
  return text;
}

/** Get raw ANSI foreground color escape (without reset) for re-application */
function getColorCode(color: string): string {
  if (!color) return '';
  if (color.startsWith('#')) {
    const hex =
      color.length === 4
        ? color[1]! + color[1]! + color[2]! + color[2]! + color[3]! + color[3]!
        : color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  const code = INK_COLOR_TO_ANSI[color.toLowerCase()];
  if (code !== undefined) return `\x1b[${code}m`;
  return '';
}

/** ANSI text formatting helpers (always produce escape codes, unlike chalk) */
const ansiFmt = {
  bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
  italic: (t: string) => `\x1b[3m${t}\x1b[23m`,
  underline: (t: string) => `\x1b[4m${t}\x1b[24m`,
  strikethrough: (t: string) => `\x1b[9m${t}\x1b[29m`,
};

/**
 * Convert inline markdown to ANSI-styled text.
 * Mirrors RenderInline's behavior but outputs strings instead of React nodes.
 */
function renderMarkdownToAnsi(text: string): string {
  const inlineRegex =
    /(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    result += text.slice(lastIndex, match.index);
    const fullMatch = match[0]!;
    let rendered: string | null = null;

    if (
      fullMatch.startsWith('**') &&
      fullMatch.endsWith('**') &&
      fullMatch.length > 4
    ) {
      rendered = ansiFmt.bold(fullMatch.slice(2, -2));
    } else if (
      fullMatch.length > 2 &&
      ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
        (fullMatch.startsWith('_') && fullMatch.endsWith('_'))) &&
      !/\w/.test(text.substring(match.index - 1, match.index)) &&
      !/\w/.test(
        text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1),
      ) &&
      !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
      !/[./\\]\S/.test(
        text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2),
      )
    ) {
      rendered = ansiFmt.italic(fullMatch.slice(1, -1));
    } else if (
      fullMatch.startsWith('~~') &&
      fullMatch.endsWith('~~') &&
      fullMatch.length > 4
    ) {
      rendered = ansiFmt.strikethrough(fullMatch.slice(2, -2));
    } else if (
      fullMatch.startsWith('`') &&
      fullMatch.endsWith('`') &&
      fullMatch.length > 1
    ) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) {
        rendered = applyColor(codeMatch[2], theme.text.code);
      }
    } else if (
      fullMatch.startsWith('[') &&
      fullMatch.includes('](') &&
      fullMatch.endsWith(')')
    ) {
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        rendered = `${linkMatch[1]} ${applyColor(`(${linkMatch[2]})`, theme.text.link)}`;
      }
    } else if (
      fullMatch.startsWith('<u>') &&
      fullMatch.endsWith('</u>') &&
      fullMatch.length > 7
    ) {
      rendered = ansiFmt.underline(fullMatch.slice(3, -4));
    } else if (/^https?:\/\//.test(fullMatch)) {
      rendered = applyColor(fullMatch, theme.text.link);
    }

    result += rendered ?? fullMatch;
    lastIndex = inlineRegex.lastIndex;
  }

  result += text.slice(lastIndex);
  return result;
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
  // Use rendered text so link URLs are included as unbreakable tokens
  const clean = stripAnsi(renderMarkdownToAnsi(text));
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

  // Empty table — nothing to render
  if (colCount === 0) {
    return <Box />;
  }

  // ── Step 1: Calculate min (longest word) and ideal (full content) widths ──
  const minColumnWidths = headers.map((header, colIndex) => {
    let maxMin = getMinWordWidth(header);
    for (const row of rows) {
      maxMin = Math.max(maxMin, getMinWordWidth(row[colIndex] || ''));
    }
    return maxMin;
  });

  // Use rendered width (after markdown→ANSI) so link URLs etc. are accounted for
  const getRenderedWidth = (text: string): number =>
    getCachedStringWidth(stripAnsi(renderMarkdownToAnsi(text)));

  const idealWidths = headers.map((header, colIndex) => {
    let maxIdeal = Math.max(getRenderedWidth(header), MIN_COLUMN_WIDTH);
    for (const row of rows) {
      maxIdeal = Math.max(maxIdeal, getRenderedWidth(row[colIndex] || ''));
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

  // Render inline markdown to ANSI-styled text; preserve existing ANSI codes.
  const getFormattedCellText = (text: string): string =>
    renderMarkdownToAnsi(text);

  // ── Step 4: Check max row lines to decide vertical fallback ──
  // Use formatted text (same as renderRowLines) so row height estimate is accurate
  function calculateMaxRowLines(): number {
    let maxLines = 1;
    for (let i = 0; i < headers.length; i++) {
      const wrapped = wrapText(
        getFormattedCellText(headers[i]!),
        columnWidths[i]!,
        { hard: needsHardWrap },
      );
      maxLines = Math.max(maxLines, wrapped.length);
    }
    for (const row of rows) {
      for (let i = 0; i < colCount; i++) {
        const wrapped = wrapText(
          getFormattedCellText(row[i] || ''),
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
    return applyColor(line, theme.border.default);
  }

  // ── Build row lines as pure strings ──
  function renderRowLines(cells: string[], isHeader: boolean): string[] {
    // Normalize cells to exactly colCount (pad missing, truncate extras)
    const normalizedCells = Array.from(
      { length: colCount },
      (_, i) => cells[i] || '',
    );

    // Wrap each cell's formatted content. Preserve ANSI when possible.
    const cellLines = normalizedCells.map((cell, colIndex) =>
      wrapText(getFormattedCellText(cell), columnWidths[colIndex]!, {
        hard: needsHardWrap,
      }),
    );

    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    // Vertical centering offset per cell
    const offsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));

    const borderPipe = applyColor('│', theme.border.default);
    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = borderPipe;
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
        // Respect explicit alignment; default headers to center when unspecified
        const align =
          aligns?.[colIndex] != null
            ? getAlign(colIndex)
            : isHeader
              ? 'center'
              : 'left';
        const padded = padAligned(lineText, displayWidth, width, align);

        if (isHeader) {
          // Apply bold + link color; re-apply link color after inner \x1b[39m
          // resets (e.g. from inline `code`) to match Ink's nested color behavior
          const linkCode = getColorCode(theme.text.link);
          // Re-apply link color after inner foreground resets (\x1b[39m)
          const fgReset = '\x1b[39m';
          const recolored = linkCode
            ? padded.split(fgReset).join(fgReset + linkCode)
            : padded;
          const styledPadded = applyColor(
            ansiFmt.bold(recolored),
            theme.text.link,
          );
          line += ' ' + styledPadded + ' ' + borderPipe;
        } else {
          line += ' ' + padded + ' ' + borderPipe;
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
      // Normalize row to exactly colCount (consistent with horizontal format)
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const rawLabel = headers[colIndex] || `Column ${colIndex + 1}`;
        const label = renderMarkdownToAnsi(rawLabel);
        const value = getFormattedCellText(row[colIndex] || '')
          .trim()
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        lines.push(
          `${applyColor(ansiFmt.bold(`${label}:`), theme.text.link)} ${value}`,
        );
      }
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
