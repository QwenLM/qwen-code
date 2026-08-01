/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadonlyFrame } from 'ink';
import type { NormalizedSelection } from './selection-state.js';

/** A cell counts as part of a word when it is non-empty and not whitespace. */
function isWordCell(value: string): boolean {
  return value !== '' && value !== ' ' && !/^\s$/u.test(value);
}

/** Trailing column of the last non-space cell on a row, or -1 if blank. */
function lastContentColumn(row: ReadonlyFrame['cells'][number]): number {
  for (let x = row.length - 1; x >= 0; x--) {
    if (row[x].value !== '' && row[x].value !== ' ') {
      return x;
    }
  }
  return -1;
}

/**
 * Word span (maximal run of non-whitespace cells) around a click, or null when
 * the click is on whitespace. Wide-character spacer cells (empty value) are
 * treated as part of the preceding glyph's run.
 */
export function wordSpanAt(
  frame: ReadonlyFrame | null,
  x: number,
  y: number,
): NormalizedSelection | null {
  const row = frame?.cells[y];
  if (!row) {
    return null;
  }
  const cell = row[x];
  if (!cell || !isWordCell(cell.value)) {
    return null;
  }
  let sx = x;
  while (
    sx > 0 &&
    (row[sx - 1].value === '' || isWordCell(row[sx - 1].value))
  ) {
    sx--;
  }
  let ex = x;
  while (
    ex < row.length - 1 &&
    (row[ex + 1].value === '' || isWordCell(row[ex + 1].value))
  ) {
    ex++;
  }
  return { sx, sy: y, ex, ey: y };
}

/** Whole visual line span (first column to last non-space), or null if blank. */
export function lineSpanAt(
  frame: ReadonlyFrame | null,
  y: number,
): NormalizedSelection | null {
  const row = frame?.cells[y];
  if (!row) {
    return null;
  }
  const end = lastContentColumn(row);
  if (end < 0) {
    return null;
  }
  return { sx: 0, sy: y, ex: end, ey: y };
}
