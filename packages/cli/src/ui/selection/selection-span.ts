/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadonlyFrame } from 'ink';
import type {
  NormalizedSelection,
  Point,
  SelectionMode,
} from './selection-state.js';

/** A cell counts as part of a word when it is non-empty and not whitespace. */
function isWordCell(value: string): boolean {
  return value !== '' && value !== ' ' && !/^\s$/u.test(value);
}

/** Trailing column of the last non-space cell in a row range, or -1 if blank. */
function lastContentColumn(
  row: ReadonlyFrame['cells'][number],
  start: number,
  end: number,
): number {
  for (let x = end; x >= start; x--) {
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

function selectableLineSpan(
  row: ReadonlyFrame['cells'][number],
  x: number,
  y: number,
): NormalizedSelection {
  let start = x;
  while (start > 0 && row[start - 1].selectable) {
    start--;
  }
  let runEnd = x;
  while (runEnd < row.length - 1 && row[runEnd + 1].selectable) {
    runEnd++;
  }
  const contentEnd = lastContentColumn(row, start, runEnd);
  return { sx: start, sy: y, ex: contentEnd, ey: y };
}

function isSelectableContent(
  cell: ReadonlyFrame['cells'][number][number],
): boolean {
  return cell.selectable && cell.value !== '' && cell.value !== ' ';
}

/** Nearest contiguous selectable line span around a click, or null if blank. */
export function lineSpanAt(
  frame: ReadonlyFrame | null,
  x: number,
  y: number,
): NormalizedSelection | null {
  const row = frame?.cells[y];
  if (!row || row.length === 0) {
    return null;
  }

  const origin = Math.max(0, Math.min(x, row.length - 1));
  for (let distance = 0; distance < row.length; distance++) {
    const left = origin - distance;
    if (left >= 0 && isSelectableContent(row[left])) {
      return selectableLineSpan(row, left, y);
    }
    const right = origin + distance;
    if (distance > 0 && right < row.length && isSelectableContent(row[right])) {
      return selectableLineSpan(row, right, y);
    }
  }
  return null;
}

/** Resolve the span at a point for a word/line selection mode. */
export function spanAtForMode(
  frame: ReadonlyFrame | null,
  mode: Exclude<SelectionMode, 'char'>,
  point: Point,
): NormalizedSelection | null {
  return mode === 'word'
    ? wordSpanAt(frame, point.x, point.y)
    : lineSpanAt(frame, point.x, point.y);
}
