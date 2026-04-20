/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useRef } from 'react';
import { Text, Box } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import { getCachedStringWidth } from './textUtils.js';
import { theme } from '../semantic-colors.js';

/** Minimum column width to prevent degenerate layouts */
const MIN_COLUMN_WIDTH = 3;

/**
 * Thresholds for vertical format decision with hysteresis to prevent
 * layout flipping during streaming when maxRowLines oscillates around
 * the boundary. Enter vertical on >5, exit only on ≤3.
 */
const VERTICAL_ENTER_THRESHOLD = 5;
const VERTICAL_EXIT_THRESHOLD = 3;

/** Safety margin to account for terminal resize races */
const SAFETY_MARGIN = 4;

export type ColumnAlign = 'left' | 'center' | 'right';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
  /** Per-column alignment parsed from markdown separator line */
  aligns?: ColumnAlign[];
  /** True while the containing message is still streaming. When true,
   *  the vertical/horizontal decision is monotonic (once vertical, stays
   *  vertical) to prevent layout flipping across chunks. */
  isPending?: boolean;
  /** Visible terminal height in rows. Used during streaming to cap the number
   *  of table rows rendered — exceeding the viewport forces Ink's log-update
   *  to clear the entire visible area on every chunk, producing a black-frame
   *  flicker. The final (committed) render ignores this and shows all rows. */
  availableTerminalHeight?: number;
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
  const lines = wrapped.split('\n');
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
  isPending,
  availableTerminalHeight,
}) => {
  // Cross-render decision lock: keyed by the React instance (stable as long as
  // the parent supplies a stable key — MarkdownDisplay uses a headers-based key
  // so the same table keeps the same instance across streaming chunks).
  const decisionRef = useRef<{ vertical: boolean }>({ vertical: false });

  const colCount = headers.length;

  // Empty table — nothing to render
  if (colCount === 0) {
    return <Box />;
  }

  // Streaming skeleton: when a table has been detected (headers present) but
  // no data rows have arrived yet, render a vertical header-only skeleton.
  // This preserves layout height (colCount lines) so that when the first row
  // arrives, the rendered vertical table stays at the same height — avoiding
  // the "empty → tall table" flicker during streaming.
  if (rows.length === 0) {
    if (!isPending) {
      return <Box />;
    }
    const linkCode = getColorCode(theme.text.link);
    const skeletonLines = headers.map((h) => {
      const label = renderMarkdownToAnsi(h);
      const recoloredLabel = linkCode
        ? recolorAfterResets(`${label}:`, linkCode)
        : `${label}:`;
      return applyColor(ansiFmt.bold(recoloredLabel), theme.text.link);
    });
    // Lock the vertical decision so subsequent renders (once rows arrive)
    // also pick vertical, keeping the layout stable.
    decisionRef.current.vertical = true;
    return (
      <Box marginY={1}>
        <Text>{skeletonLines.join('\n')}</Text>
      </Box>
    );
  }

  // ── Precompute per-cell metrics to avoid repeated renderMarkdownToAnsi calls ──
  const computeMetrics = (text: string) => {
    const rendered = renderMarkdownToAnsi(text);
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
  // During streaming: monotonic — once vertical, stay vertical until stream ends.
  // After streaming: hysteresis — enter on >ENTER, exit only on ≤EXIT.
  let useVerticalFormat: boolean;
  if (isPending) {
    useVerticalFormat =
      decisionRef.current.vertical || maxRowLines > VERTICAL_ENTER_THRESHOLD;
  } else {
    useVerticalFormat = decisionRef.current.vertical
      ? maxRowLines > VERTICAL_EXIT_THRESHOLD
      : maxRowLines > VERTICAL_ENTER_THRESHOLD;
  }
  decisionRef.current.vertical = useVerticalFormat;

  // Streaming row cap: if pending output would exceed the visible viewport,
  // Ink's log-update clears the entire visible area on every chunk — the
  // terminal briefly renders blank between clear and rewrite. Cap the rendered
  // row count to fit within availableTerminalHeight and prepend a hint for the
  // hidden rows. The final (committed) render goes through Static with no cap.
  //
  // Per-row cost:
  //   vertical:   colCount lines (key:value pairs) + 1 inter-row separator
  //   horizontal: maxRowLines lines (wrapped content) + 1 inter-row separator
  // Fixed overhead (non-row chrome):
  //   vertical:   marginY=2
  //   horizontal: top/middle/bottom border(3) + header(maxRowLines) + marginY(2)
  // Plus 1 line reserved for the "... N earlier rows hidden ..." hint.
  const HIDDEN_HINT_RESERVED_LINES = 1;
  const perRowLines = useVerticalFormat ? colCount + 1 : maxRowLines + 1;
  const tableFixedOverhead = useVerticalFormat
    ? 2 + HIDDEN_HINT_RESERVED_LINES
    : maxRowLines + 5 + HIDDEN_HINT_RESERVED_LINES;
  const heightBudget =
    isPending && availableTerminalHeight !== undefined
      ? Math.max(perRowLines, availableTerminalHeight - tableFixedOverhead)
      : Number.POSITIVE_INFINITY;
  const maxVisibleRows = Math.max(1, Math.floor(heightBudget / perRowLines));
  const hiddenRowCount =
    isPending && rows.length > maxVisibleRows
      ? rows.length - maxVisibleRows
      : 0;
  const displayRowMetrics =
    hiddenRowCount > 0 ? rowMetrics.slice(hiddenRowCount) : rowMetrics;
  const displayRowCount = displayRowMetrics.length;
  const hiddenRowsHint =
    hiddenRowCount > 0
      ? applyColor(
          `... ${hiddenRowCount} earlier row${hiddenRowCount === 1 ? '' : 's'} hidden during streaming ...`,
          theme.text.secondary,
        )
      : null;

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
    if (hiddenRowsHint) {
      lines.push(hiddenRowsHint);
    }
    const separatorWidth = Math.max(Math.min(contentWidth - 1, 40), 0);
    const separator = separatorWidth > 0 ? '─'.repeat(separatorWidth) : '';

    displayRowMetrics.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push(separator);
      }
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const rawLabel = headers[colIndex] ?? `Column ${colIndex + 1}`;
        const label = renderMarkdownToAnsi(rawLabel);
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
  if (hiddenRowsHint) {
    tableLines.push(hiddenRowsHint);
  }
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(headerRendered, true));
  tableLines.push(renderBorderLine('middle'));
  displayRowMetrics.forEach((row, rowIndex) => {
    tableLines.push(
      ...renderRowLines(
        row.map((m) => m.rendered),
        false,
      ),
    );
    if (rowIndex < displayRowCount - 1) {
      tableLines.push(renderBorderLine('middle'));
    }
  });
  tableLines.push(renderBorderLine('bottom'));

  // ── Safety check: verify no line exceeds content width ──
  const maxLineWidth = Math.max(
    ...tableLines.map((line) => getCachedStringWidth(stripAnsi(line))),
  );
  if (maxLineWidth > contentWidth - SAFETY_MARGIN) {
    // Fallback to vertical format to prevent terminal resize flicker.
    // Record the decision so the next render doesn't immediately flip back
    // if column widths micro-adjust.
    decisionRef.current.vertical = true;
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
