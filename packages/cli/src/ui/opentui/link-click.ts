/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * App-level URL detection behind OpenTUI click-to-open (audit gap #54,
 * option 1). The framework renders markdown links as `label (url)` plain
 * text and does not emit OSC 8 in any @opentui 0.5.x release, while
 * `useMouse: true` makes the terminal hand pointer events to the app —
 * terminal-native cmd+click link handling included. Clicks that land on a
 * URL cell are therefore opened here. Terminal-side OSC 8 remains a
 * follow-up pending framework support (it already ships `detectLinks` +
 * `caps.hyperlinks` groundwork).
 *
 * Security reuses the ink OSC 8 constraints (scheme allowlist, trailing
 * punctuation trimming) from `../utils/osc8.js`.
 *
 * Known boundary: URLs wrapped across buffer rows are not stitched back
 * together — the same class of limitation terminal auto-detection has.
 */

import {
  BARE_URL_BREAK_CHARACTERS,
  isSafeOscScheme,
  trimTrailingUrlPunctuation,
} from '../utils/osc8.js';

export interface UrlHit {
  /** Openable URL; `www.` matches are normalized to `https://`. */
  url: string;
  /** The matched text exactly as rendered. */
  text: string;
  /** String index range [start, end) of `text` within the row text. */
  start: number;
  end: number;
}

/** Structural slice of OptimizedBuffer so tests don't need the native lib. */
export interface CellGrid {
  buffers: { char: Uint32Array };
  width: number;
  height: number;
  /**
   * Native buffers carry flag bits (not code points) in `char` and resolve
   * cell text through this API; plain-code-point stubs omit it.
   */
  getRealCharBytes?(addLineBreaks?: boolean): Uint8Array;
}

/** A buffer row as text, with the source cell column of each character. */
export interface BufferRow {
  text: string;
  /** cellColumns[i] is the terminal cell column of text[i]. */
  cellColumns: number[];
}

// `scheme://…` or `www.…`, stopped by whitespace, quotes, backticks, control
// bytes, and the shared linkification break set (CJK/fullwidth punctuation
// glued to the URL — the same body grammar as osc8's BARE_URL_PATTERN, whose
// ASCII-only trailing trimmer cannot remove fullwidth punctuation). Trailing
// ASCII punctuation (and unsafe schemes) are filtered by the osc8 helpers
// afterwards, mirroring the ink renderer.
const URL_PATTERN = new RegExp(
  `(?:[a-zA-Z][a-zA-Z0-9+.-]*://|www\\.)[^\\s<>"'\`\\u0000-\\u001f\\u007f${BARE_URL_BREAK_CHARACTERS}]+`,
  'g',
);

/**
 * High bits of native cell values are flags, not code points: 0xC0000000
 * marks a wide-character continuation (spacer) cell. Mirrors the flag
 * handling in @opentui/core's `OptimizedBuffer.getSpanLines`.
 */
const CHAR_FLAG_CONTINUATION = 0xc0000000;

function isContinuationCell(codePoint: number): boolean {
  // `&` yields a signed int32 (0xC0000000 reads as negative there), so
  // coerce back to unsigned before comparing with the hex literal —
  // the signed comparison is always false and lets continuation cells
  // leak through as real characters.
  return (codePoint & CHAR_FLAG_CONTINUATION) >>> 0 === CHAR_FLAG_CONTINUATION;
}

/**
 * Decoded character of every cell on a row, left to right; spacer and
 * untouched cells read as `''` on stub grids, `' '` on native grids (the
 * resolved text has no holes, so untouched cells fall back to a space).
 */
export function decodeRowCells(grid: CellGrid, y: number): string[] | null {
  if (y < 0 || y >= grid.height) return null;
  const chars = grid.buffers.char;
  const base = y * grid.width;
  const cells: string[] = new Array(grid.width).fill('');
  if (typeof grid.getRealCharBytes === 'function') {
    const realLines = new TextDecoder()
      .decode(grid.getRealCharBytes(true))
      .split('\n');
    const lineChars = Array.from(realLines[y] ?? '');
    let ci = 0;
    for (let x = 0; x < grid.width; x++) {
      const codePoint = chars[base + x];
      cells[x] = isContinuationCell(codePoint) ? '' : (lineChars[ci++] ?? ' ');
    }
    return cells;
  }
  for (let x = 0; x < grid.width; x++) {
    const codePoint = chars[base + x];
    cells[x] =
      codePoint > 0 && codePoint <= 0x10ffff && !isContinuationCell(codePoint)
        ? String.fromCodePoint(codePoint)
        : '';
  }
  return cells;
}

/**
 * Extract a buffer row into text. Spacer cells (wide-character
 * continuation and untouched cells) are skipped; the mapping back to
 * cell columns is preserved so a click column can be matched exactly even
 * when CJK characters precede the URL. One entry is pushed per UTF-16
 * unit: a non-BMP character (emoji) from a single cell occupies two units
 * in `text`, and the hit-test indexes `cellColumns` with UTF-16 offsets.
 */
export function readBufferRow(grid: CellGrid, y: number): BufferRow {
  const cells = decodeRowCells(grid, y);
  if (!cells) return { text: '', cellColumns: [] };
  let text = '';
  const cellColumns: number[] = [];
  for (let x = 0; x < cells.length; x++) {
    if (cells[x] === '') continue;
    text += cells[x];
    for (let i = 0; i < cells[x].length; i++) cellColumns.push(x);
  }
  return { text: text.replace(/\s+$/, ''), cellColumns };
}

/** All safe URL candidates in a rendered row, left to right. */
export function extractUrlHits(rowText: string): UrlHit[] {
  const hits: UrlHit[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of rowText.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const nextCharacter = rowText[start + raw.length] ?? '';
    const trimmed = trimTrailingUrlPunctuation(raw, nextCharacter);
    if (!trimmed) continue;

    let url: string;
    if (/^www\./i.test(trimmed)) {
      url = `https://${trimmed}`;
    } else if (isSafeOscScheme(trimmed)) {
      url = trimmed;
    } else {
      // `javascript:`, `file:`, unknown schemes… never open those.
      continue;
    }
    hits.push({ url, text: trimmed, start, end: start + trimmed.length });
  }
  return hits;
}

/**
 * The URL covering click column `x` (terminal cells), or null. Comparison
 * runs in cell space via `row.cellColumns`, so wide characters earlier in
 * the row do not shift the hit test.
 */
export function findUrlAtRow(row: BufferRow, x: number): UrlHit | null {
  for (const hit of extractUrlHits(row.text)) {
    const startCell = row.cellColumns[hit.start];
    const endCellExclusive =
      hit.end < row.cellColumns.length
        ? row.cellColumns[hit.end]
        : (row.cellColumns[row.cellColumns.length - 1] ?? 0) + 1;
    if (startCell === undefined) continue;
    if (x >= startCell && x < endCellExclusive) return hit;
  }
  return null;
}
