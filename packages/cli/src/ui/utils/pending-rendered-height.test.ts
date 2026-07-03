/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TABLE_CHROME_ROWS,
  estimateWrappedRows,
  isTableStart,
  fitPendingSlice,
  splitMarkdownTableRow,
} from './pending-rendered-height.js';

describe('splitMarkdownTableRow', () => {
  it('splits a simple row into trimmed cells', () => {
    expect(splitMarkdownTableRow('a | b | c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps escaped pipes inside a cell', () => {
    expect(splitMarkdownTableRow('a \\| b | c')).toEqual(['a | b', 'c']);
  });

  it('does not split on a pipe inside an inline code span', () => {
    expect(splitMarkdownTableRow('`a | b` | c')).toEqual(['`a | b`', 'c']);
  });
});

describe('estimateWrappedRows', () => {
  it('returns 1 for a line that fits within the width', () => {
    expect(estimateWrappedRows('hello', 80)).toBe(1);
  });

  it('returns 1 for an empty line', () => {
    expect(estimateWrappedRows('', 80)).toBe(1);
  });

  it('wraps a line wider than the content width', () => {
    // 30 ASCII cols at width 10 → ceil(30/10) = 3 rows.
    expect(estimateWrappedRows('a'.repeat(30), 10)).toBe(3);
  });

  it('counts CJK double-width characters when wrapping', () => {
    // 10 CJK chars = 20 display cols; at width 10 → 2 rows.
    expect(estimateWrappedRows('一二三四五六七八九十', 10)).toBe(2);
  });

  it('falls back to 1 row when width is zero or negative', () => {
    expect(estimateWrappedRows('a'.repeat(50), 0)).toBe(1);
    expect(estimateWrappedRows('a'.repeat(50), -5)).toBe(1);
  });
});

describe('isTableStart', () => {
  const lines = ['| A | B |', '| --- | --- |', '| 1 | 2 |', 'text'];

  it('detects a header row followed by a separator', () => {
    expect(isTableStart(lines, 0)).toBe(true);
  });

  it('is false for a data row (no separator after)', () => {
    expect(isTableStart(lines, 2)).toBe(false);
  });

  it('is false for a non-table line', () => {
    expect(isTableStart(lines, 3)).toBe(false);
  });

  it('is false when the header is the last line (no next line)', () => {
    expect(isTableStart(['| A | B |'], 0)).toBe(false);
  });

  it('is false when the separator column count differs from the header', () => {
    // 2-column header but a 3-column separator → not a table (matches the
    // renderer, which rejects the mismatch and treats it as plain text).
    expect(isTableStart(['| A | B |', '| --- | --- | --- |'], 0)).toBe(false);
  });

  it('is true when header and separator column counts match', () => {
    expect(isTableStart(['| A | B |', '| --- | --- |'], 0)).toBe(true);
  });
});

describe('fitPendingSlice', () => {
  const CLAMP = 1000; // effectively unclamped unless a test sets it small

  it('keeps everything when the content fits the budget', () => {
    const lines = ['a', 'b', 'c'];
    expect(fitPendingSlice(lines, 80, 10, CLAMP)).toEqual({
      keptLines: 3,
      clipped: false,
    });
  });

  it('clips plain text at the budget', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 5, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(5);
  });

  it('charges a table its block height (2*dataRows + chrome), not its line count', () => {
    // 4 data rows → 2*4 + 5 = 13 rendered rows. Budget 10 → does not fit,
    // and since the table is the first block it is kept (clamp bounds it).
    const lines = [
      '| A | B |',
      '| - | - |',
      '|1|2|',
      '|3|4|',
      '|5|6|',
      '|7|8|',
    ];
    const { keptLines } = fitPendingSlice(lines, 80, 10, CLAMP);
    // First-block table is kept whole (walk stops after it).
    expect(keptLines).toBe(lines.length);
    expect(TABLE_CHROME_ROWS).toBe(5);
  });

  it('cuts BEFORE a non-first table that would overflow the remaining budget', () => {
    // 3 text lines (3 rows) then a 4-row table (13 rows). Budget 8: text fits,
    // table would overflow → cut before the table.
    const lines = [
      't1',
      't2',
      't3',
      '| A | B |',
      '| - | - |',
      '|1|2|',
      '|3|4|',
      '|5|6|',
      '|7|8|',
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 8, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(3); // stops before the table row (index 3)
  });

  it('caps a table cost at tableClampRows', () => {
    // A huge first-block table with a small clamp: cost = clamp, so the walk
    // keeps it and stops (kept = all lines), never exceeding the clamp.
    const rows = Array.from({ length: 40 }, () => '|1|2|');
    const lines = ['| A | B |', '| - | - |', ...rows];
    const { keptLines } = fitPendingSlice(lines, 80, 100, /* clamp */ 8);
    expect(keptLines).toBe(lines.length);
  });

  it('returns keptLines=0 when the first line alone overflows (wide/CJK line)', () => {
    // One line of 200 CJK cols at width 10 → 20 rows > budget 5.
    const lines = ['一'.repeat(100)];
    const { keptLines, clipped } = fitPendingSlice(lines, 10, 5, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(0);
  });

  it('accounts for wrapping of non-table lines', () => {
    // Each line is 30 cols at width 10 → 3 rows. Budget 6 → 2 lines fit.
    const lines = Array.from({ length: 5 }, () => 'a'.repeat(30));
    const { keptLines, clipped } = fitPendingSlice(lines, 10, 6, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(2);
  });
});
