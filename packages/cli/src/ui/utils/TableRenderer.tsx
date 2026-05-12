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
import { renderInlineLatex } from './latexRenderer.js';

/** Minimum column width to prevent degenerate layouts */
const MIN_COLUMN_WIDTH = 3;

/** Maximum number of lines per row before switching to vertical format */
const MAX_ROW_LINES = 4;

/**
 * Below this width the column-aware budget (see `minHorizontalTableWidth`
 * below) is bypassed and we always switch to vertical: even a 1-column
 * table is barely readable horizontally under ~24 cols of content.
 */
const ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH = 24;

/** Safety margin to account for terminal resize races */
const SAFETY_MARGIN = 4;

const INLINE_MATH_MAX_CHARS = 1024;

const INLINE_MATH_PATTERN = String.raw`(?<![\w$])\$(?![\s\d$])(?=[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\S\$)[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\$(?![\w$])`;
const INLINE_MARKDOWN_REGEX =
  /(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;
const INLINE_MARKDOWN_WITH_MATH_REGEX = new RegExp(
  String.raw`(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|` +
    String.raw`\`+.+?\`+|${INLINE_MATH_PATTERN}|<u>.*?<\/u>|https?:\/\/\S+)`,
  'g',
);

export type ColumnAlign = 'left' | 'center' | 'right';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
  /** Per-column alignment parsed from markdown separator line */
  aligns?: ColumnAlign[];
  enableInlineMath?: boolean;
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

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ESC = '\x1b';

/** Get raw ANSI foreground color escape (without reset) for re-application */
function getColorCode(color: string): string {
  if (!color) return '';
  if (color.startsWith('#')) {
    if (!HEX_COLOR_RE.test(color)) return '';
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

/** Apply an Ink-compatible color (hex or named) to text via raw ANSI codes */
function applyColor(text: string, color: string): string {
  const code = getColorCode(color);
  if (!code) return text;
  return `${code}${text}\x1b[39m`;
}

/**
 * Re-apply a color code after any SGR sequence that resets foreground:
 * \x1b[39m (default foreground) and \x1b[0m (full reset).
 */
function recolorAfterResets(text: string, colorCode: string): string {
  const fgReset = '\x1b[39m';
  const fullReset = '\x1b[0m';
  return text
    .split(fgReset)
    .join(fgReset + colorCode)
    .split(fullReset)
    .join(fullReset + colorCode);
}

function updateActiveForeground(
  activeForeground: string,
  paramsText: string,
): string {
  const params =
    paramsText.length > 0
      ? paramsText.split(';').map((param) => Number(param))
      : [0];
  let foreground = activeForeground;

  for (let index = 0; index < params.length; index++) {
    const code = params[index];
    if (!Number.isFinite(code)) {
      continue;
    }

    if (code === 0 || code === 39) {
      foreground = '';
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      foreground = `\x1b[${code}m`;
    } else if (code === 38) {
      const mode = params[index + 1];
      if (mode === 5 && Number.isFinite(params[index + 2])) {
        foreground = `\x1b[38;5;${params[index + 2]}m`;
        index += 2;
      } else if (
        mode === 2 &&
        Number.isFinite(params[index + 2]) &&
        Number.isFinite(params[index + 3]) &&
        Number.isFinite(params[index + 4])
      ) {
        foreground = `\x1b[38;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
        index += 4;
      }
    }
  }

  return foreground;
}

function readSgrSequence(
  text: string,
  index: number,
): { sequence: string; paramsText: string; endIndex: number } | null {
  if (text[index] !== ESC || text[index + 1] !== '[') {
    return null;
  }
  const endIndex = text.indexOf('m', index + 2);
  if (endIndex === -1) {
    return null;
  }
  const paramsText = text.slice(index + 2, endIndex);
  if (!/^[0-9;]*$/.test(paramsText)) {
    return null;
  }
  return {
    sequence: text.slice(index, endIndex + 1),
    paramsText,
    endIndex,
  };
}

function preserveForegroundAcrossLineBreaks(text: string): string {
  let activeForeground = '';
  let result = '';
  let lastIndex = 0;
  let index = 0;

  while (index < text.length) {
    const sgr = readSgrSequence(text, index);
    if (!sgr) {
      index += 1;
      continue;
    }

    const segment = text.slice(lastIndex, index);
    result += activeForeground
      ? segment.replace(/\n/g, `\x1b[39m\n${activeForeground}`)
      : segment;
    result += sgr.sequence;
    activeForeground = updateActiveForeground(activeForeground, sgr.paramsText);
    index = sgr.endIndex + 1;
    lastIndex = index;
  }

  const segment = text.slice(lastIndex);
  result += activeForeground
    ? segment.replace(/\n/g, `\x1b[39m\n${activeForeground}`)
    : segment;
  return result;
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
function renderMarkdownToAnsi(text: string, enableInlineMath = false): string {
  const inlineRegex = enableInlineMath
    ? INLINE_MARKDOWN_WITH_MATH_REGEX
    : INLINE_MARKDOWN_REGEX;
  inlineRegex.lastIndex = 0;

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
      enableInlineMath &&
      fullMatch.startsWith('$') &&
      fullMatch.endsWith('$') &&
      fullMatch.length > 2
    ) {
      rendered = applyColor(
        renderInlineLatex(fullMatch.slice(1, -1)),
        theme.text.accent,
      );
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
  const lines = preserveForegroundAcrossLineBreaks(wrapped).split('\n');
  // Trim trailing empty lines (wrap-ansi artifacts) but preserve internal ones
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines.length > 0 ? lines : [''];
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
  enableInlineMath = false,
}) => {
  const colCount = headers.length;

  // Empty table — nothing to render
  if (colCount === 0) {
    return <Box />;
  }

  // ── Precompute per-cell metrics to avoid repeated renderMarkdownToAnsi calls ──
  const computeMetrics = (text: string) => {
    const rendered = renderMarkdownToAnsi(text, enableInlineMath);
    const visible = stripAnsi(rendered);
    const words = visible.split(/\s+/).filter((w) => w.length > 0);
    return {
      rendered,
      renderedWidth: getCachedStringWidth(visible),
      minWordWidth:
        words.length > 0
          ? Math.max(
              ...words.map((w) => getCachedStringWidth(w)),
              MIN_COLUMN_WIDTH,
            )
          : MIN_COLUMN_WIDTH,
    };
  };

  const headerMetrics = headers.map((h) => computeMetrics(h));
  const rowMetrics = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => computeMetrics(row[i] || '')),
  );

  // ── Step 1: Calculate min (longest word) and ideal (full content) widths ──
  const minColumnWidths = headers.map((_, colIndex) => {
    let maxMin = headerMetrics[colIndex]!.minWordWidth;
    for (const row of rowMetrics) {
      maxMin = Math.max(maxMin, row[colIndex]!.minWordWidth);
    }
    return maxMin;
  });

  const idealWidths = headers.map((_, colIndex) => {
    let maxIdeal = Math.max(
      headerMetrics[colIndex]!.renderedWidth,
      MIN_COLUMN_WIDTH,
    );
    for (const row of rowMetrics) {
      maxIdeal = Math.max(maxIdeal, row[colIndex]!.renderedWidth);
    }
    return maxIdeal;
  });

  // ── Step 2: Calculate available space ──
  // Border overhead: │ content │ content │ = 1 + (width + 3) per column.
  // NOTE: this value is reused below in the horizontal-vs-vertical threshold
  // (`minHorizontalTableWidth`). Any change to this formula will silently
  // shift the layout threshold — adjust both call sites together.
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
    // Post-pass: MIN_COLUMN_WIDTH floor can push sum over availableWidth.
    // Shave wider columns until the total fits.
    let excess = columnWidths.reduce((s, w) => s + w, 0) - availableWidth;
    while (excess > 0) {
      const maxW = Math.max(...columnWidths);
      if (maxW <= MIN_COLUMN_WIDTH) break;
      const idx = columnWidths.indexOf(maxW);
      const reduction = Math.min(excess, maxW - MIN_COLUMN_WIDTH);
      columnWidths[idx] = maxW - reduction;
      excess -= reduction;
    }
  }

  // ── Step 4: Check max row lines to decide vertical fallback ──
  function calculateMaxRowLines(): number {
    let maxLines = 1;
    for (let i = 0; i < colCount; i++) {
      const wrapped = wrapText(headerMetrics[i]!.rendered, columnWidths[i]!, {
        hard: needsHardWrap,
      });
      maxLines = Math.max(maxLines, wrapped.length);
    }
    for (const row of rowMetrics) {
      for (let i = 0; i < colCount; i++) {
        const wrapped = wrapText(row[i]!.rendered, columnWidths[i]!, {
          hard: needsHardWrap,
        });
        maxLines = Math.max(maxLines, wrapped.length);
      }
    }
    return maxLines;
  }

  const maxRowLines = calculateMaxRowLines();
  // Column-aware horizontal-vs-vertical decision: a horizontal table needs
  // at least `MIN_COLUMN_WIDTH` per column plus the border overhead computed
  // above, with a safety margin. This avoids the prior fixed 60-col floor
  // that forced vertical mode for a 2-col table on a 50-col terminal even
  // when content fit comfortably. The downstream `maxLineWidth` safety
  // check still catches content that would actually overflow.
  const minHorizontalTableWidth = Math.max(
    ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH,
    colCount * MIN_COLUMN_WIDTH + borderOverhead + SAFETY_MARGIN,
  );
  const useVerticalFormat =
    contentWidth < minHorizontalTableWidth || maxRowLines > MAX_ROW_LINES;

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
  // renderedCells: pre-rendered ANSI text for each column (already colCount-normalized)
  function renderRowLines(
    renderedCells: string[],
    isHeader: boolean,
  ): string[] {
    const cellLines = renderedCells.map((cell, colIndex) =>
      wrapText(cell, columnWidths[colIndex]!, { hard: needsHardWrap }),
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

        // Re-apply base color after any SGR reset (\x1b[39m or \x1b[0m)
        if (isHeader) {
          const linkCode = getColorCode(theme.text.link);
          const recolored = linkCode
            ? recolorAfterResets(padded, linkCode)
            : padded;
          const styledPadded = applyColor(
            ansiFmt.bold(recolored),
            theme.text.link,
          );
          line += ' ' + styledPadded + ' ' + borderPipe;
        } else {
          const primaryCode = getColorCode(theme.text.primary);
          const recolored = primaryCode
            ? recolorAfterResets(padded, primaryCode)
            : padded;
          const styledCell = primaryCode
            ? applyColor(recolored, theme.text.primary)
            : recolored;
          line += ' ' + styledCell + ' ' + borderPipe;
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

    rowMetrics.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push(separator);
      }
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const rawLabel = headers[colIndex] ?? `Column ${colIndex + 1}`;
        const label = renderMarkdownToAnsi(rawLabel, enableInlineMath);
        const value = row[colIndex]!.rendered.trim()
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const linkCode = getColorCode(theme.text.link);
        const recoloredLabel = linkCode
          ? recolorAfterResets(`${label}:`, linkCode)
          : `${label}:`;
        const primaryCode = getColorCode(theme.text.primary);
        const styledValue = primaryCode
          ? applyColor(
              recolorAfterResets(value, primaryCode),
              theme.text.primary,
            )
          : value;
        lines.push(
          `${applyColor(ansiFmt.bold(recoloredLabel), theme.text.link)} ${styledValue}`,
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
  const headerRendered = headerMetrics.map((m) => m.rendered);
  const tableLines: string[] = [];
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(headerRendered, true));
  tableLines.push(renderBorderLine('middle'));
  rowMetrics.forEach((row, rowIndex) => {
    tableLines.push(
      ...renderRowLines(
        row.map((m) => m.rendered),
        false,
      ),
    );
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
