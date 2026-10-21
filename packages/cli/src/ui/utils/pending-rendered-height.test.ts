/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import wrapAnsi from 'wrap-ansi';
import * as tableRenderer from './TableRenderer.js';
import {
  estimateWrappedRows,
  isTableStart,
  fitPendingSlice,
  splitMarkdownTableRow,
} from './pending-rendered-height.js';

vi.mock('wrap-ansi', async (importOriginal) => {
  const { default: wrap } = await importOriginal<typeof import('wrap-ansi')>();
  return { default: vi.fn(wrap) };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

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

  it('does not let escaped math consume table separators', () => {
    expect(splitMarkdownTableRow('$x$ | \\$a|b$ | c')).toEqual([
      '$x$',
      '\\$a',
      'b$',
      'c',
    ]);
  });

  it('keeps pipes inside math that contains an escaped dollar', () => {
    expect(splitMarkdownTableRow(String.raw`$x + \$5|y$ | c`)).toEqual([
      String.raw`$x + \$5|y$`,
      'c',
    ]);
  });
});

describe('estimateWrappedRows', () => {
  it('returns 1 for a line that fits within the width', () => {
    expect(estimateWrappedRows('hello', 80)).toBe(1);
  });

  it('counts newlines even when their combined width fits', () => {
    expect(estimateWrappedRows('aaa\nbbbb\ncc', 80)).toBe(3);
  });

  it('counts tab stops even when the printable characters fit', () => {
    expect(estimateWrappedRows('\t'.repeat(12) + 'x'.repeat(20), 80)).toBe(2);
  });

  it('returns 1 for an empty line', () => {
    expect(estimateWrappedRows('', 80)).toBe(1);
  });

  it('wraps a line wider than the content width', () => {
    // 30 ASCII cols at width 10 → ceil(30/10) = 3 rows.
    expect(estimateWrappedRows('a'.repeat(30), 10)).toBe(3);
  });

  it('counts word wrapping rather than dividing the total character width', () => {
    expect(
      estimateWrappedRows(`${'a'.repeat(40)} `.repeat(22).trim(), 78),
    ).toBe(22);
  });

  it('counts CJK double-width characters when wrapping', () => {
    // 10 CJK chars = 20 display cols; at width 10 → 2 rows.
    expect(estimateWrappedRows('一二三四五六七八九十', 10)).toBe(2);
  });

  it('keeps exact wrapping for fitting double-width glyphs at width one', () => {
    expect(estimateWrappedRows('一'.repeat(10), 1, 12)).toBe(11);
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

  it.each([false, true])(
    'collapses plain blank runs without dropping source lines with pending=%s',
    (isPending) => {
      for (const [text, budget] of [
        ['\n \t\n', 0],
        ['\n\n**one**\n**two**', 2],
        ['**one**\n\n' + ' '.repeat(200) + '\n**two**', 3],
        ['**one**\n**two**\n**three**\n\n\n', 4],
      ] as const) {
        const lines = text.split('\n');
        expect(fitPendingSlice(lines, 80, budget, CLAMP, isPending)).toEqual({
          keptLines: lines.length,
          clipped: false,
        });
        if (budget > 0) {
          expect(
            fitPendingSlice(lines, 80, budget - 1, CLAMP, isPending).clipped,
          ).toBe(true);
        }
      }
    },
  );

  it('does not collapse blank lines inside code or literal math', () => {
    expect(
      fitPendingSlice(['```', '', '', '', '```', 'after'], 80, 5, CLAMP),
    ).toEqual({ keptLines: 5, clipped: true });
    expect(
      fitPendingSlice(['$$', '', '', '', '$$', 'after'], 80, 3, CLAMP, false, {
        rejectVisualBlocks: false,
      }),
    ).toEqual({ keptLines: 5, clipped: true });
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

  it('adds the marginY (2 rows) to a clamped table cost', () => {
    // TableRenderer clamps the inner <Text> to `tableClampRows` but wraps it in
    // <Box marginY={1}>, so a clamped table renders clampRows + 2. A non-first
    // huge table with clamp 5 costs min(rows, 5+2)=7. intro(1)+7 = 8 > budget 7
    // → cut before it. With the old `min(rows, clampRows)`=5 charge, 1+5 = 6 ≤ 7
    // would keep it, dropping the two margin lines.
    const rows = Array.from({ length: 40 }, () => '|1|2|');
    const lines = ['intro', '| A | B |', '| - | - |', ...rows];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 7, /* clamp */ 5);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1);
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

  it('charges wrapped vertical rows when the `label: value` line itself wraps', () => {
    // Narrow terminal (20 < minHorizontalWidth 24 for 2 cols) → vertical. Each
    // data cell renders as `label: value`; here that is `Key: vvv…` = 45 chars,
    // wrapping to ceil(45/20)=3 lines PER cell — not 1. So vertical = 3+3 data
    // lines + 2 margin = 8. intro(1)+8 = 9 > budget 7 → cut before the table.
    // The old value-only (or flat one-line-per-cell) charge would be 2+2+2 = 6,
    // giving 1+6 = 7 ≤ 7 and wrongly keeping the table — under-charging a table
    // whose vertical lines wrap, the exact miss that overflows the live frame.
    const val = 'v'.repeat(40);
    const lines = [
      'intro',
      '| Key | Val |',
      '| --- | --- |',
      `| ${val} | ${val} |`,
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 20, 7, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1);
  });

  it.each([false, true])(
    'does not charge a hidden zero-data-row table with pending=%s',
    (isPending) => {
      const lines = ['intro', '| A | B | C | D |', '| - | - | - | - |', 'TAIL'];
      expect(fitPendingSlice(lines, 20, 2, CLAMP, isPending)).toEqual({
        keptLines: lines.length,
        clipped: false,
      });
      expect(fitPendingSlice(lines, 20, 1, CLAMP, isPending)).toEqual({
        keptLines: 3,
        clipped: true,
        ...(isPending ? { completedTableBoundary: 3 } : {}),
      });
    },
  );

  it('charges wrapped HORIZONTAL rows when cells wrap within MAX_ROW_LINES', () => {
    // 2 cols at width 40 → minHorizontalWidth 24, so horizontal. perColWidth =
    // floor((40-7-4)/2)=14; a 15-char cell wraps to ceil(15/14)=2 lines, so the
    // data row is 2 rows tall (not 1). horizontal = header(1)+row(2) + chrome(5)
    // = 8. intro(1)+8 = 9 > budget 8 → cut before it. The old flat 2*dataRows+5
    // = 7 charge would give 1+7 = 8 ≤ 8 and wrongly keep it — this guards the
    // per-row wrapped `contentRows` sum against a regression to the flat count.
    const cell = 'c'.repeat(15);
    const lines = [
      'intro',
      '| A | B |',
      '| --- | --- |',
      `| ${cell} | ${cell} |`,
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 40, 8, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1);
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
    // The streaming frontier stays horizontal; the long cell takes eight rows
    // at the renderer's proportional width. A complete table switches to the
    // shorter vertical layout, which fits the same budget.
    const tall = 'z'.repeat(500);
    const lines = [
      'intro',
      '| A | B |',
      '| - | - |',
      '| x | y |',
      `| ${tall} | y |`,
    ];
    const { keptLines, clipped } = fitPendingSlice(lines, 80, 14, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(1);
    expect(fitPendingSlice(lines, 80, 14, CLAMP, false).clipped).toBe(false);
  });

  it('bounds a table that becomes the frontier after slicing following text', () => {
    const lines = [
      'intro',
      '| A | B |',
      '| --- | --- |',
      '| x | y |',
      `| ${'z'.repeat(500)} | y |`,
      'after',
    ];
    expect(fitPendingSlice(lines, 80, 14, CLAMP).keptLines).toBe(1);
  });

  it('keeps a followed table as a frontier when only its streaming layout fits', () => {
    const lines = [
      'intro',
      '| A | B | C | D | E |',
      '| - | - | - | - | - |',
      ...Array.from(
        { length: 6 },
        (_, i) => `| a | b | c | d | ${i === 5 ? 'z'.repeat(240) : 'e'} |`,
      ),
      'after',
    ];
    expect(fitPendingSlice(lines, 80, 28, 26)).toEqual({
      keptLines: 9,
      clipped: true,
      completedTableBoundary: 9,
    });
    expect(fitPendingSlice(lines, 80, 100, CLAMP)).toEqual({
      keptLines: 10,
      clipped: false,
    });
  });

  it.each([false, true])(
    'charges the merged table across code blocks instead of always cutting with pending=%s',
    (isPending) => {
      const lines = [
        '| A | B |',
        '| --- | --- |',
        '| x | y |',
        '```text',
        'x',
        '```',
        '| z | w |',
        'TAIL',
      ];
      expect(fitPendingSlice(lines, 80, 100, CLAMP, isPending).clipped).toBe(
        false,
      );
      const tall = [
        ...lines.slice(0, 6),
        ...Array<string>(30).fill('| z | w |'),
        'TAIL',
      ];
      expect(fitPendingSlice(tall, 80, 15, CLAMP, isPending).clipped).toBe(
        true,
      );
    },
  );

  it.each([
    { suffix: [] },
    { suffix: ['| unfinished'] },
    { suffix: ['`'] },
    { suffix: ['``'] },
    { suffix: ['~'] },
    { suffix: ['~~'] },
    { suffix: ['$'] },
    { suffix: ['-'] },
    { suffix: [':--'] },
    { suffix: ['```text', 'still inside code'] },
    { suffix: ['$$', 'still inside math'] },
  ])(
    'does not offer an open table as a commit boundary with suffix $suffix',
    ({ suffix }) => {
      const lines = ['| A | B |', '| --- | --- |', '| x | y |', ...suffix];
      expect(
        fitPendingSlice(lines, 80, 3, CLAMP).completedTableBoundary,
      ).toBeUndefined();
    },
  );

  it('does not offer raw table-like text as a table commit boundary', () => {
    const lines = ['| A | B |', '| --- | --- |', '| x | y |', 'after'];
    expect(
      fitPendingSlice(lines, 80, 3, CLAMP, true, { renderVisualBlocks: false })
        .completedTableBoundary,
    ).toBeUndefined();
  });

  it('lets a tool fit probe reject an oversized first pending table', () => {
    const lines = ['| A | B |', '| --- | --- |', '| x | y |'];
    expect(fitPendingSlice(lines, 80, 3, CLAMP).keptLines).toBe(3);
    expect(
      fitPendingSlice(lines, 80, 3, CLAMP, true, { keepFirstTable: false }),
    ).toEqual({ keptLines: 0, clipped: true });
  });

  it.each([false, true])(
    'rejects a huge unclamped tool table without full layout with pending=%s',
    (isPending) => {
      const layout = vi.spyOn(tableRenderer, 'renderTableText');
      const lines = ['| A |', '| --- |', ...Array<string>(70000).fill('| x |')];
      expect(
        fitPendingSlice(lines, 80, 5, Number.MAX_SAFE_INTEGER, isPending, {
          keepFirstTable: false,
        }),
      ).toEqual({ keptLines: 0, clipped: true });
      expect(layout).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['plain', ['x'.repeat(1_000_000)]],
    ['code', ['```text', 'x'.repeat(1_000_000), '```']],
    ['list', ['- ' + 'x'.repeat(1_000_000)]],
    ['quote', ['> ' + 'x'.repeat(1_000_000)]],
    ['math', ['$$', 'x'.repeat(1_000_000), '$$']],
  ])(
    'rejects an oversized %s line without wrapping its contents',
    (_kind, lines) => {
      expect(fitPendingSlice(lines, 80, 5, CLAMP)).toMatchObject({
        clipped: true,
      });
      expect(
        vi.mocked(wrapAnsi).mock.calls.some(([line]) => line.length > 1000),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'keeps a leading clamped table without full layout with pending=%s',
    (isPending) => {
      const layout = vi.spyOn(tableRenderer, 'renderTableText');
      const lines = ['| A |', '| --- |', ...Array<string>(70000).fill('| x |')];
      expect(fitPendingSlice(lines, 80, 40, 38, isPending)).toEqual({
        keptLines: lines.length,
        clipped: false,
      });
      expect(layout).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 3, 38])(
    'skips streaming and completed layouts when a closed table engages clamp %s',
    (clamp) => {
      const layout = vi.spyOn(tableRenderer, 'renderTableText');
      const table = ['| A |', '| --- |', ...Array<string>(100).fill('| x |')];
      const lines = [...table, 'after'];
      const budget = clamp <= 2 ? 3 : clamp + 2;
      expect(fitPendingSlice(lines, 80, budget, clamp)).toEqual({
        keptLines: table.length,
        clipped: true,
        completedTableBoundary: table.length,
      });
      expect(layout).not.toHaveBeenCalled();
    },
  );

  it('skips the completed-layout top-up after an interrupted clamped table', () => {
    const layout = vi.spyOn(tableRenderer, 'renderTableText');
    const lines = [
      '| A |',
      '| --- |',
      ...Array<string>(100).fill('| x |'),
      '```text',
      'x',
      '```',
      'after',
    ];
    expect(fitPendingSlice(lines, 80, 12, 3)).toEqual({
      keptLines: lines.length,
      clipped: false,
    });
    expect(layout).not.toHaveBeenCalled();
  });

  it('rejects an oversized first table when checking a completed result', () => {
    const lines = ['| A | B |', '| --- | --- |', '| x | y |'];
    expect(fitPendingSlice(lines, 80, 1, CLAMP, false)).toEqual({
      keptLines: 0,
      clipped: true,
    });
  });

  it('does not price raw pipe rows as a visual table', () => {
    const lines = [
      '| A | B |',
      '| --- | --- |',
      '| x | y |',
      'one',
      'two',
      'three',
    ];
    expect(
      fitPendingSlice(lines, 80, 6, CLAMP, false, { renderVisualBlocks: false })
        .clipped,
    ).toBe(false);
  });

  it('does not keep a pending table when even its margins cannot fit', () => {
    expect(
      fitPendingSlice(['| A | B |', '| --- | --- |', '| x | y |'], 80, 1, 1)
        .keptLines,
    ).toBe(0);
  });

  it('does not collapse the charge of an unclipped two-row vertical table', () => {
    const lines = ['| A |', '| --- |', `| ${'x'.repeat(20)} |`];
    expect(fitPendingSlice(lines, 20, 3, 2, false)).toEqual({
      keptLines: 0,
      clipped: true,
    });
    expect(fitPendingSlice(lines, 20, 4, 2, false)).toEqual({
      keptLines: lines.length,
      clipped: false,
    });
  });

  it('charges expanded tabs in code blocks', () => {
    expect(
      fitPendingSlice(['```', '\t'.repeat(6) + 'x', '```'], 24, 3, CLAMP)
        .keptLines,
    ).toBe(2);
  });

  it('charges the code gutter and padding', () => {
    expect(
      fitPendingSlice(['```', 'x'.repeat(78), '```'], 80, 3, CLAMP).keptLines,
    ).toBe(2);
  });

  it('charges the list marker and indentation', () => {
    expect(
      fitPendingSlice(['- ' + 'x'.repeat(22)], 24, 1, CLAMP).keptLines,
    ).toBe(0);
    expect(
      fitPendingSlice(['    - ' + 'x'.repeat(18)], 24, 1, CLAMP).keptLines,
    ).toBe(0);
  });

  it.each(['```mermaid', '~~~MERMAID'])(
    'charges pending %s previews without gutters or wrapping',
    (opening) => {
      const body = ['x'.repeat(78), '\t'.repeat(30) + 'tail'];
      const lines = [opening, ...body];
      expect(fitPendingSlice(lines, 80, 3, CLAMP).clipped).toBe(false);
      expect(
        fitPendingSlice([...lines, opening.slice(0, 3)], 80, 3, CLAMP).clipped,
      ).toBe(false);
      expect(fitPendingSlice(lines, 80, 2, CLAMP).keptLines).toBe(2);
      expect(
        fitPendingSlice(lines, 80, 3, CLAMP, true, {
          renderVisualBlocks: false,
        }).clipped,
      ).toBe(true);
      expect(
        fitPendingSlice(lines, 80, 3, CLAMP, false, {
          rejectVisualBlocks: false,
        }).clipped,
      ).toBe(true);
    },
  );

  it.each(['-', '123.'])(
    'strips %s task checkboxes only in render mode',
    (marker) => {
      const lines = [`${marker} [ ] ${'x'.repeat(74)}`];
      expect(fitPendingSlice(lines, 80, 1, CLAMP).keptLines).toBe(1);
      expect(
        fitPendingSlice(lines, 80, 1, CLAMP, true, {
          renderVisualBlocks: false,
        }).keptLines,
      ).toBe(0);
    },
  );

  it.each([
    ['```mermaid', 'graph TD; A-->B', '```'],
    ['$$', 'x', '$$'],
  ])('lets a live tool reject visual source height', (...lines) => {
    expect(fitPendingSlice(lines, 80, 3, CLAMP, true).clipped).toBe(false);
    expect(
      fitPendingSlice(lines, 80, 3, CLAMP, true, { rejectVisualBlocks: true })
        .clipped,
    ).toBe(true);
  });

  it('charges only the rendered rows of completed literal math', () => {
    const lines = ['$$', 'a', 'b', 'c', '$$'];
    expect(
      fitPendingSlice(lines, 80, 3, CLAMP, false, {
        rejectVisualBlocks: false,
      }),
    ).toEqual({ keptLines: lines.length, clipped: false });
    expect(
      fitPendingSlice(lines, 80, 2, CLAMP, false, {
        rejectVisualBlocks: false,
      }),
    ).toEqual({ keptLines: 3, clipped: true });
    expect(fitPendingSlice(lines, 80, 3, CLAMP).clipped).toBe(true);
    expect(fitPendingSlice(lines, 80, 5, CLAMP).clipped).toBe(false);
  });

  it('counts literal bounded math source without parsing internal fences or tables', () => {
    const lines = [
      '$$',
      '```',
      'x'.repeat(80),
      '| A | B |',
      '| --- | --- |',
      '$$',
      'after',
    ];
    expect(
      fitPendingSlice(lines, 80, lines.length - 2, CLAMP, false, {
        rejectVisualBlocks: false,
      }).clipped,
    ).toBe(false);
  });

  it('counts code gutters in raw mode too', () => {
    const lines = [
      '```text',
      ...Array.from({ length: 4 }, () => 'x'.repeat(23)),
      '```',
    ];
    expect(
      fitPendingSlice(lines, 24, 6, CLAMP, false, { renderVisualBlocks: false })
        .clipped,
    ).toBe(true);
  });

  it('does not claim a completed diagram fits from its source height', () => {
    const lines = ['```mermaid', 'graph TD; A-->B', '```'];
    expect(fitPendingSlice(lines, 80, 3, CLAMP, false).clipped).toBe(true);
    expect(
      fitPendingSlice(lines, 80, 3, CLAMP, false, { renderVisualBlocks: false })
        .clipped,
    ).toBe(false);
  });

  it('does not subtract a disabled code gutter', () => {
    const lines = [
      '```',
      ...Array.from({ length: 9 }, () => 'x'.repeat(79)),
      '```',
    ];
    expect(
      fitPendingSlice(lines, 80, 11, CLAMP, true, { showLineNumbers: false })
        .clipped,
    ).toBe(false);
  });

  it('keeps code height stable when unrelated lines are appended', () => {
    const lines = [
      '```',
      ...Array.from({ length: 9 }, () => 'x'.repeat(76)),
      '```',
    ];
    expect(fitPendingSlice(lines, 80, 11, CLAMP).keptLines).toBe(11);
    expect(
      fitPendingSlice(
        [...lines, ...Array.from({ length: 1000 }, () => 'after')],
        80,
        11,
        CLAMP,
      ).keptLines,
    ).toBe(11);
  });

  it('includes a continued code block start line in gutter width', () => {
    const body = Array.from({ length: 9 }, () => 'x'.repeat(75));
    expect(
      fitPendingSlice(
        ['``` qwen-code:start-line=999', ...body, '```'],
        80,
        11,
        CLAMP,
      ).clipped,
    ).toBe(true);
    expect(
      fitPendingSlice(['```', ...body, '```'], 80, 11, CLAMP).clipped,
    ).toBe(false);
  });

  it('does not claim a completed math block fits from its source height', () => {
    const lines = ['$$', 'x', '$$'];
    expect(fitPendingSlice(lines, 12, 3, CLAMP, false).clipped).toBe(true);
    expect(
      fitPendingSlice(lines, 12, 3, CLAMP, false, { renderVisualBlocks: false })
        .clipped,
    ).toBe(false);
  });

  it('counts the raw blockquote indentation and prefix as ordinary text', () => {
    const lines = Array.from({ length: 6 }, () => ' '.repeat(28) + '> x');
    expect(
      fitPendingSlice(lines, 24, 6, CLAMP, false, { renderVisualBlocks: false })
        .keptLines,
    ).toBe(3);
  });

  it('charges blockquote padding and marker width', () => {
    expect(
      fitPendingSlice(['> ' + 'x'.repeat(22)], 24, 1, CLAMP).keptLines,
    ).toBe(0);
  });

  it('accounts for wrapping of non-table lines', () => {
    // Each line is 30 cols at width 10 → 3 rows. Budget 6 → 2 lines fit.
    const lines = Array.from({ length: 5 }, () => 'a'.repeat(30));
    const { keptLines, clipped } = fitPendingSlice(lines, 10, 6, CLAMP);
    expect(clipped).toBe(true);
    expect(keptLines).toBe(2);
  });
});
