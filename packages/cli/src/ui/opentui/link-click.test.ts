/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decodeRowCells,
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

/**
 * Minimal east-asian-wide check — enough for the test fixtures ('文' is
 * U+6587: BMP, but two columns wide).
 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp > 0xffff
  );
}

/**
 * Native-buffer simulation: `char` holds flag-tagged sentinel values (not
 * code points) and text resolves through `getRealCharBytes`, mirroring the
 * zig-backed OptimizedBuffer encoding.
 */
function nativeGridFromLines(lines: string[]): CellGrid {
  const displayWidth = (line: string) =>
    [...line].reduce(
      (w, ch) => w + (isWideChar(ch.codePointAt(0)!) ? 2 : 1),
      0,
    );
  const width = Math.max(...lines.map(displayWidth), 1);
  const char = new Uint32Array(width * lines.length).fill(0x800100ff);
  lines.forEach((line, y) => {
    let x = 0;
    for (const ch of line) {
      if (isWideChar(ch.codePointAt(0)!)) {
        char[y * width + x + 1] = 0xc0000001; // wide-char continuation
      }
      x += isWideChar(ch.codePointAt(0)!) ? 2 : 1;
    }
  });
  return {
    buffers: { char },
    width,
    height: lines.length,
    getRealCharBytes: (addLineBreaks = true) =>
      new TextEncoder().encode(
        addLineBreaks ? lines.join('\n') : lines.join(''),
      ),
  };
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

  it('decodes native flag-tagged cells through getRealCharBytes', () => {
    // Regression: native char cells hold flag bits (e.g. 0x800100FF
    // sentinels, 0xC0000000 continuation marks), not code points — decoding
    // them directly crashed with a code-point RangeError.
    const grid = nativeGridFromLines(['hi 文 there']);
    const row = readBufferRow(grid, 0);
    expect(row.text).toBe('hi 文 there');
    // '文' occupies columns 3-4; the continuation cell is skipped.
    expect(row.cellColumns).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10]);
  });

  it('decodeRowCells marks continuation cells and spaces on native grids', () => {
    const grid = nativeGridFromLines(['a文b']);
    expect(decodeRowCells(grid, 0)).toEqual(['a', '文', '', 'b']);
    expect(decodeRowCells(grid, -1)).toBeNull();
    expect(decodeRowCells(grid, 1)).toBeNull();
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

  it('stops the body at CJK/fullwidth punctuation glued to the URL', () => {
    // The shared linkification break set (osc8 BARE_URL_BREAK_CHARACTERS):
    // the ASCII-only trailing trimmer cannot remove fullwidth punctuation,
    // so the grammar itself must stop there.
    expect(extractUrlHits('文档 https://example.com/docs。其余文字')).toEqual([
      expect.objectContaining({ url: 'https://example.com/docs' }),
    ]);
    expect(extractUrlHits('见https://example.com/a，然后')).toEqual([
      expect.objectContaining({ url: 'https://example.com/a' }),
    ]);
    expect(extractUrlHits('（见https://example.com/x）')).toEqual([
      expect.objectContaining({ url: 'https://example.com/x' }),
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
