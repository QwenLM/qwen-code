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

  it('does not split on a pipe inside a multi-backtick code span', () => {
    expect(splitMarkdownTableRow('``a | b`` | c')).toEqual(['``a | b``', 'c']);
  });

  it('does not split on a pipe inside an inline math span', () => {
    expect(splitMarkdownTableRow('$a|b$ | c')).toEqual(['$a|b$', 'c']);
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

  it('charges a wide table by its wrapped row height, not a flat 2 rows/row', () => {
    // Cells long enough to wrap make the table taller than `2*dataRows + 5`.
    // Under-counting that lets the live frame overflow and jump to the top.
    const longCell = 'x'.repeat(30);
    const lines = [
      'intro',
      '| A | B |',
      '| - | - |',
      `| ${longCell} | ${longCell} |`,
    ];
    // Wide terminal: cells fit on one line → table is 2*1 + 5 = 7, so
    // intro (1) + table (7) = 8 fits the budget and the table is kept whole.
    expect(fitPendingSlice(lines, 200, 8, CLAMP).keptLines).toBe(lines.length);
    // Narrow terminal: each cell wraps to several lines → the table is taller
    // than 7, so it no longer fits after intro and is cut before it.
    const narrow = fitPendingSlice(lines, 30, 8, CLAMP);
    expect(narrow.clipped).toBe(true);
    expect(narrow.keptLines).toBe(1); // only 'intro' survives
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

  it('does not treat table-like lines inside a fenced code block as a table', () => {
    // 6 lines that render as code (1 row each) → fit budget 6. If the inner
    // pipe rows were mis-charged as a table (2*1 + 5 = 7 rows), the budget
    // would be exceeded and the slice would clip.
    const lines = [
      '```',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '```',
      'after',
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 6, CLAMP);
    expect(clipped).toBe(false);
    expect(keptLines).toBe(6);
  });

  it('tracks tilde (~~~) fences too', () => {
    const lines = [
      '~~~',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '~~~',
      'after',
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 6, CLAMP);
    expect(clipped).toBe(false);
    expect(keptLines).toBe(6);
  });

  it('charges the taller vertical-format height on a NARROW terminal', () => {
    // 4 cols → minHorizontalWidth = max(24, 6*4+5) = 29. contentWidth 20 < 29 →
    // vertical: 6*4 + 5 + 2 = 31 rows. intro(1)+31 > budget 20 → cut before it.
    const lines = [
      'intro',
      '| A | B | C | D |',
      '| - | - | - | - |',
      ...Array.from({ length: 6 }, (_, i) => `| ${i} | ${i} | ${i} | ${i} |`),
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 20, 20, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1); // cut before the table
  });

  it('uses the shorter horizontal height on a WIDE terminal (no early clip)', () => {
    // Same table on a wide terminal (80 ≥ 29) → horizontal: 2*6+5 = 17 rows.
    // intro(1)+17 = 18 ≤ budget 20 → the small table is NOT clipped early.
    const lines = [
      'intro',
      '| A | B | C | D |',
      '| - | - | - | - |',
      ...Array.from({ length: 6 }, (_, i) => `| ${i} | ${i} | ${i} | ${i} |`),
    ];
    const { clipped } = fitPendingSlice(lines, 80, 20, CLAMP);
    expect(clipped).toBe(false);
  });

  it('charges the vertical height on a WIDE terminal when cells wrap past MAX_ROW_LINES', () => {
    // Regression: a wide terminal (80 ≥ minHorizontalWidth 47 for 7 cols) so the
    // WIDTH trigger is off, but each data cell is 30 chars → at perColWidth
    // floor((80-22-4)/7)=7 it wraps to ceil(30/7)=5 > MAX_ROW_LINES(4), so
    // TableRenderer falls back to the taller vertical layout. The estimator must
    // mirror that: vertical = 4 rows * 7 cells (each 30 chars → 1 line at width
    // 80) + 3 separators + 2 margin = 33, not the horizontal 4*5+header+chrome.
    // With intro(1) + 33 = 34 > budget 30, the table is cut before it. Modelling
    // only the width trigger would charge the horizontal height and wrongly keep
    // it, overflowing the live frame and locking the viewport to the top.
    const wide = 'w'.repeat(30);
    const lines = [
      'intro',
      '| A | B | C | D | E | F | G |',
      '| - | - | - | - | - | - | - |',
      ...Array.from(
        { length: 4 },
        () =>
          `| ${wide} | ${wide} | ${wide} | ${wide} | ${wide} | ${wide} | ${wide} |`,
      ),
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 30, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1); // cut before the vertical-bound table
  });

  it('still uses the shorter horizontal height when wide cells stay within MAX_ROW_LINES', () => {
    // Same wide terminal and shape, but short cells (1 line each) → maxRowLines 1,
    // no vertical fallback → horizontal 4*1 + header + chrome = 13. intro(1)+13 =
    // 14 ≤ budget 30, so the small table is NOT clipped early (guards against
    // over-charging every multi-column table as vertical).
    const lines = [
      'intro',
      '| A | B | C | D | E | F | G |',
      '| - | - | - | - | - | - | - |',
      ...Array.from({ length: 4 }, () => '| 1 | 2 | 3 | 4 | 5 | 6 | 7 |'),
    ];
    const { clipped } = fitPendingSlice(lines, 80, 30, CLAMP);
    expect(clipped).toBe(false);
  });

  it('anchors the vertical trigger to the first row (a tall LATER row stays horizontal)', () => {
    // Mirrors TableRenderer: the format is decided from the header + FIRST data
    // row only, so a short first row keeps the table horizontal even when a
    // later row wraps past MAX_ROW_LINES. Horizontal height sums every row:
    // header(1)+row1(1)+row2(ceil(180/34)=6) + 1 sep + chrome 5 = 14. intro(1)+14
    // = 15 > budget 12 → clipped. If the trigger looked at all rows it would
    // charge the shorter vertical height (~9) and wrongly keep it.
    const tall = 'z'.repeat(180);
    const lines = [
      'intro',
      '| A | B |',
      '| - | - |',
      '| x | y |',
      `| ${tall} | y |`,
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 12, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1);
  });

  it('accounts for wrapping of non-table lines', () => {
    // Each line is 30 cols at width 10 → 3 rows. Budget 6 → 2 lines fit.
    const lines = Array.from({ length: 5 }, () => 'a'.repeat(30));
    const { keptLines, clipped } = fitPendingSlice(lines, 10, 6, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(2);
  });
});
