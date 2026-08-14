/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractUrlHits,
  findUrlAtRow,
  readBufferRow,
  type CellGrid,
} from './link-click.js';

function gridFromRows(rows: string[]): CellGrid {
  const width = Math.max(...rows.map((r) => r.length), 1);
  const char = new Uint32Array(width * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      char[y * width + x] = row.codePointAt(x) ?? 0;
    }
  });
  return { buffers: { char }, width, height: rows.length };
}

describe('readBufferRow', () => {
  it('reads a plain ASCII row', () => {
    const row = readBufferRow(gridFromRows(['see https://a.dev now']), 0);
    expect(row.text).toBe('see https://a.dev now');
    expect(row.cellColumns.slice(4, 8)).toEqual([4, 5, 6, 7]);
  });

  it('skips zero cells (wide-char continuation / untouched)', () => {
    // '文' occupies cell 0; cell 1 is its zero continuation.
    const grid: CellGrid = {
      buffers: {
        char: Uint32Array.from([0x6587, 0, 0x68, 0x69]), // 文 h i
      },
      width: 4,
      height: 1,
    };
    const row = readBufferRow(grid, 0);
    expect(row.text).toBe('文hi');
    expect(row.cellColumns).toEqual([0, 2, 3]);
  });

  it('trims trailing whitespace and returns empty for out-of-range rows', () => {
    const grid = gridFromRows(['abc   ']);
    expect(readBufferRow(grid, 0).text).toBe('abc');
    expect(readBufferRow(grid, 5).text).toBe('');
    expect(readBufferRow(grid, -1).text).toBe('');
  });
});

describe('extractUrlHits', () => {
  it('finds scheme URLs and www matches', () => {
    const hits = extractUrlHits('a https://a.dev/path b www.b.io c');
    expect(hits.map((h) => h.url)).toEqual([
      'https://a.dev/path',
      'https://www.b.io',
    ]);
  });

  it('renders markdown links as "label (url)" — the url half is hit-able', () => {
    const hits = extractUrlHits('Docs (https://docs.example.com/x) end');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe('https://docs.example.com/x');
  });

  it('trims trailing punctuation', () => {
    const hits = extractUrlHits('see https://a.dev/x, then https://b.dev/y.');
    expect(hits.map((h) => h.url)).toEqual([
      'https://a.dev/x',
      'https://b.dev/y',
    ]);
  });

  it('keeps balanced parentheses inside the URL', () => {
    const hits = extractUrlHits('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(hits[0]!.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('refuses unsafe schemes', () => {
    expect(extractUrlHits('javascript:alert(1)')).toEqual([]);
    expect(extractUrlHits('file:///etc/passwd')).toEqual([]);
  });

  it('stops at quotes and backticks', () => {
    const hits = extractUrlHits('`https://a.dev/x` "https://b.dev/y"');
    expect(hits.map((h) => h.url)).toEqual([
      'https://a.dev/x',
      'https://b.dev/y',
    ]);
  });
});

describe('findUrlAtRow', () => {
  it('hits inside the URL and misses outside', () => {
    const row = readBufferRow(gridFromRows(['see https://a.dev now']), 0);
    expect(findUrlAtRow(row, 6)?.url).toBe('https://a.dev');
    expect(findUrlAtRow(row, 0)).toBeNull(); // on 's'
    expect(findUrlAtRow(row, 17)).toBeNull(); // on 'n' of 'now'
  });

  it('hit-tests in cell space when wide characters precede the URL', () => {
    // '文档 ' takes cells 0-3 (文=0,1 档=2,3), space at cell 4, url from 5.
    const grid: CellGrid = {
      buffers: {
        char: Uint32Array.from([
          0x6587,
          0,
          0x6863,
          0,
          0x20,
          ...'https://a.dev'.split('').map((c) => c.codePointAt(0)!),
        ]),
      },
      width: 18,
      height: 1,
    };
    const row = readBufferRow(grid, 0);
    expect(findUrlAtRow(row, 5)?.url).toBe('https://a.dev');
    expect(findUrlAtRow(row, 4)).toBeNull();
  });

  it('returns null on empty rows', () => {
    expect(findUrlAtRow({ text: '', cellColumns: [] }, 3)).toBeNull();
  });
});
