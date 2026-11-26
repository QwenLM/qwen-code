/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { createRequire } from 'node:module';
import stripAnsi from 'strip-ansi';
import { getGraphemeSegmenter } from './stubs/intl.js';
import sliceAnsi from './stubs/sliceAnsi.js';
import { stringWidth } from './stringWidth.js';

type WrapAnsiOptions = {
  hard?: boolean;
  wordWrap?: boolean;
  trim?: boolean;
};

type WrapAnsiFunction = (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string;

// Use globalThis to avoid TS2868 (Cannot find name 'Bun')
const globalWithOptionalBun = globalThis as typeof globalThis & {
  Bun?: { wrapAnsi?: WrapAnsiFunction };
};

const wrapAnsiBun =
  typeof globalThis !== 'undefined' &&
  typeof globalWithOptionalBun.Bun?.wrapAnsi === 'function'
    ? globalWithOptionalBun.Bun.wrapAnsi
    : null;

function stripVisibleWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function trimWrappedLine(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function trimLeadingVisibleWhitespace(value: string): string {
  const visibleValue = stripAnsi(value);
  let leadingWhitespaceWidth = 0;

  while (
    leadingWhitespaceWidth < visibleValue.length &&
    (visibleValue[leadingWhitespaceWidth] === ' ' ||
      visibleValue[leadingWhitespaceWidth] === '\t')
  ) {
    leadingWhitespaceWidth++;
  }

  return leadingWhitespaceWidth === 0
    ? value
    : sliceAnsi(value, leadingWhitespaceWidth);
}

/**
 * Linear wrap for plain (non-ANSI) lines.
 *
 * Mirrors the legacy algorithm's chunk selection, word-boundary handling and
 * whitespace trimming, but walks the line once with cumulative grapheme widths
 * instead of re-slicing and re-measuring the remaining text per output line.
 * Pure ASCII keeps a minimal code-unit loop; Unicode uses Intl.Segmenter so one
 * emoji or combining sequence cannot force the whole line back to the quadratic
 * legacy path or be split across output lines.
 */
function fastWrapPlainLine(
  line: string,
  columns: number,
  trim: boolean,
  wordWrap: boolean,
  wrappedLines: string[],
): void {
  const length = line.length;
  if (length === 0) {
    wrappedLines.push('');
    return;
  }

  // Grapheme layout: raw start and cumulative display width. Keep pure ASCII
  // on a tight loop because giant JSON payloads are overwhelmingly ASCII.
  const starts: number[] = [];
  const cumulative: number[] = [0];
  let totalWidth = 0;
  let isAscii = true;
  for (let i = 0; i < length; i++) {
    if (line.charCodeAt(i) >= 0x7f) {
      isAscii = false;
      break;
    }
  }

  if (isAscii) {
    for (let i = 0; i < length; i++) {
      starts.push(i);
      totalWidth += line.charCodeAt(i) >= 0x20 ? 1 : 0;
      cumulative.push(totalWidth);
    }
  } else {
    for (const { index, segment } of getGraphemeSegmenter().segment(line)) {
      starts.push(index);
      totalWidth += stringWidth(segment);
      cumulative.push(totalWidth);
    }
  }
  const graphemeCount = starts.length;

  const isSpaceOrTab = (index: number): boolean => {
    if (index < 0 || index >= graphemeCount) return false;
    const c = line.charCodeAt(starts[index]!);
    return c === 0x20 || c === 0x09;
  };
  const isSpace = (index: number): boolean =>
    index >= 0 &&
    index < graphemeCount &&
    line.charCodeAt(starts[index]!) === 0x20;
  const skipLeadingWhitespace = (from: number): number => {
    let index = from;
    while (isSpaceOrTab(index)) index++;
    return index;
  };
  const rawSlice = (from: number, to: number): string => {
    const start = starts[from]!;
    const end = to >= graphemeCount ? length : starts[to]!;
    return line.slice(start, end);
  };

  let pos = trim ? skipLeadingWhitespace(0) : 0;
  if (pos >= graphemeCount) {
    wrappedLines.push('');
    return;
  }

  while (pos < graphemeCount) {
    // Whole remainder fits: emit it as the final line.
    if (totalWidth - cumulative[pos]! <= columns) {
      const chunk = rawSlice(pos, graphemeCount);
      wrappedLines.push(trim ? trimWrappedLine(chunk) : chunk);
      return;
    }

    // Longest prefix (capped at `columns` graphemes) with width <= columns.
    let count = 0;
    while (
      count < columns &&
      pos + count < graphemeCount &&
      cumulative[pos + count + 1]! - cumulative[pos]! <= columns
    ) {
      count++;
    }

    if (count === 0) {
      // First grapheme alone exceeds the width: emit it unsplit.
      wrappedLines.push(rawSlice(pos, pos + 1));
      pos = pos + 1;
      if (trim || wordWrap) {
        pos = skipLeadingWhitespace(pos);
      }
      continue;
    }

    let lastSpace = -1;
    if (wordWrap) {
      for (let u = count - 1; u >= 0; u--) {
        if (isSpace(pos + u)) {
          lastSpace = u;
          break;
        }
      }
    }

    let chunk: string;
    let next: number;
    let keptWhitespace = false;
    if (lastSpace <= 0) {
      chunk = rawSlice(pos, pos + count);
      next = pos + count;
    } else {
      const wordBoundary = rawSlice(pos, pos + lastSpace);
      if (stripVisibleWhitespace(wordBoundary).length === 0) {
        chunk = rawSlice(pos, pos + count);
        next = pos + count;
      } else if (!trim) {
        // Keep the break-point space at the end of this line when trimming is
        // disabled (Ink's `wrap`), matching npm wrap-ansi's `trim: false`
        // output — see the legacy path's comment on continuation-column
        // alignment for the rationale.
        chunk = rawSlice(pos, pos + lastSpace + 1);
        next = pos + lastSpace + 1;
        keptWhitespace = true;
      } else {
        chunk = wordBoundary;
        next = pos + lastSpace + 1;
        while (isSpace(next)) next++;
      }
    }

    wrappedLines.push(trim ? trimWrappedLine(chunk) : chunk);
    pos = next;
    if (trim || (wordWrap && !keptWhitespace)) {
      pos = skipLeadingWhitespace(pos);
    }
  }
}

function selectVisibleChunk(
  text: string,
  columns: number,
  wordWrap: boolean,
  keepWhitespace: boolean,
): { chunk: string; nextStart: number; keptWhitespace: boolean } {
  let best = '';

  for (let width = 1; width <= columns; width++) {
    const candidate = sliceAnsi(text, 0, width);
    if (stringWidth(candidate) > columns) {
      break;
    }
    best = candidate;
  }

  if (!best) {
    return {
      chunk: sliceAnsi(text, 0, 1),
      nextStart: 1,
      keptWhitespace: false,
    };
  }

  if (!wordWrap) {
    return {
      chunk: best,
      nextStart: stringWidth(best),
      keptWhitespace: false,
    };
  }

  const visibleText = stripAnsi(best);
  const lastSpace = visibleText.lastIndexOf(' ');

  if (lastSpace <= 0 || stringWidth(text) <= columns) {
    return {
      chunk: best,
      nextStart: stringWidth(best),
      keptWhitespace: false,
    };
  }

  const wordBoundary = sliceAnsi(best, 0, lastSpace);
  if (stripVisibleWhitespace(wordBoundary).length === 0) {
    return {
      chunk: best,
      nextStart: stringWidth(best),
      keptWhitespace: false,
    };
  }

  let nextStart = lastSpace + 1;

  // Keep the break-point whitespace at the end of this line when trimming is
  // disabled (Ink's `wrap`), matching npm wrap-ansi's `trim: false` output.
  // Swallowing it makes the wrapped text one character shorter than the input,
  // and the styling pass maps wrapped characters back to the original string
  // position by position (see applyStylesToWrappedText), so the whole
  // continuation line shifts one column: a soft-wrapped inline link rendered
  // its first character outside the OSC 8 range, showing `ttps://…` as the
  // clickable text. The whitespace is part of `best`, so the extended chunk
  // still fits within `columns`.
  if (keepWhitespace) {
    return {
      chunk: sliceAnsi(best, 0, nextStart),
      nextStart,
      keptWhitespace: true,
    };
  }

  const visibleFullText = stripAnsi(text);
  while (visibleFullText[nextStart] === ' ') {
    nextStart++;
  }

  return { chunk: wordBoundary, nextStart, keptWhitespace: false };
}

function legacyWrapAnsiLine(
  line: string,
  columns: number,
  trim: boolean,
  wordWrap: boolean,
  wrappedLines: string[],
): void {
  if (stringWidth(line) <= columns) {
    wrappedLines.push(trim ? trimWrappedLine(line) : line);
    return;
  }

  let remaining = trim ? trimLeadingVisibleWhitespace(line) : line;

  while (remaining.length > 0) {
    if (stringWidth(remaining) <= columns) {
      wrappedLines.push(trim ? trimWrappedLine(remaining) : remaining);
      break;
    }

    const { chunk, nextStart, keptWhitespace } = selectVisibleChunk(
      remaining,
      columns,
      wordWrap,
      !trim,
    );
    wrappedLines.push(trim ? trimWrappedLine(chunk) : chunk);
    remaining = sliceAnsi(remaining, nextStart);
    if (trim || (wordWrap && !keptWhitespace)) {
      remaining = trimLeadingVisibleWhitespace(remaining);
    }
  }
}

function fallbackWrapAnsi(
  input: string,
  columns: number,
  options: WrapAnsiOptions = {},
): string {
  if (columns <= 0 || input.length === 0) {
    return '';
  }

  const trim = options.trim ?? true;
  const wordWrap = options.wordWrap ?? true;
  const lines = input.split('\n');
  const wrappedLines: string[] = [];
  for (const line of lines) {
    if (line.includes('\x1b')) {
      legacyWrapAnsiLine(line, columns, trim, wordWrap, wrappedLines);
    } else {
      fastWrapPlainLine(line, columns, trim, wordWrap, wrappedLines);
    }
  }

  return wrappedLines.join('\n');
}

function loadWrapAnsiFromNpm(): WrapAnsiFunction | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('wrap-ansi');
    const candidate =
      typeof loaded === 'function'
        ? (loaded as WrapAnsiFunction)
        : typeof loaded?.default === 'function'
          ? (loaded.default as WrapAnsiFunction)
          : null;

    if (!candidate) {
      return null;
    }

    // Some installs resolve wrap-ansi@7 to string-width@7+, which makes the
    // CommonJS implementation throw at runtime. Probe once and fall back to the
    // local implementation when the dependency graph is incompatible.
    const probe = candidate('wrap ansi probe', 8, {
      hard: true,
      trim: false,
    });

    return typeof probe === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

const wrapAnsiNpm = loadWrapAnsiFromNpm();

const wrapAnsi: WrapAnsiFunction =
  wrapAnsiBun ?? wrapAnsiNpm ?? fallbackWrapAnsi;

export { fallbackWrapAnsi, wrapAnsi };
