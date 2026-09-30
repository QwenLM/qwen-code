/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ReadonlyFrame } from 'ink';
import { extractUrlFromOsc8Code, hyperlinkAtCell } from './hyperlink-at.js';

function makeFrame(rows: Array<Array<Partial<FrameCellType>>>): ReadonlyFrame {
  const cells = rows.map((row) =>
    row.map((cell) => ({
      type: 'char' as const,
      value: cell.value ?? 'x',
      fullWidth: cell.fullWidth ?? false,
      styles: cell.styles ?? [],
      selectable: true,
      flowId: null,
    })),
  );
  const width = Math.max(...cells.map((r) => r.length));
  return {
    width,
    height: cells.length,
    cells,
    boundaries: cells.map(() => []),
  } as unknown as ReadonlyFrame;
}

type FrameCellType = ReadonlyFrame['cells'][number][number];

function linkCell(url: string): Partial<FrameCellType> {
  return {
    value: 'L',
    styles: [
      { type: 'ansi', code: `\x1b]8;;${url}\x07`, endCode: '\x1b]8;;\x07' },
    ],
  };
}

describe('extractUrlFromOsc8Code', () => {
  it('extracts a BEL-terminated URL', () => {
    expect(extractUrlFromOsc8Code('\x1b]8;;https://example.com/\x07')).toBe(
      'https://example.com/',
    );
  });

  it('extracts an ST-terminated URL', () => {
    expect(extractUrlFromOsc8Code('\x1b]8;;https://example.com/\x1b\\')).toBe(
      'https://example.com/',
    );
  });

  it('extracts a C1-ST-terminated URL', () => {
    expect(extractUrlFromOsc8Code('\x1b]8;;https://example.com/\x9c')).toBe(
      'https://example.com/',
    );
  });

  it('skips the OSC 8 parameter section', () => {
    expect(
      extractUrlFromOsc8Code('\x1b]8;id=abc123;https://example.com/\x07'),
    ).toBe('https://example.com/');
  });

  it('keeps semicolons inside the URL', () => {
    expect(
      extractUrlFromOsc8Code('\x1b]8;;https://example.com/?a=1;b=2\x07'),
    ).toBe('https://example.com/?a=1;b=2');
  });

  it('handles tmux DCS passthrough with doubled ESC', () => {
    expect(
      extractUrlFromOsc8Code(
        '\x1bPtmux;\x1b\x1b]8;;https://example.com/\x07\x1b\\',
      ),
    ).toBe('https://example.com/');
  });

  it('terminates the URL at any C0 control, not just the legal terminators', () => {
    expect(
      extractUrlFromOsc8Code('\x1b]8;;https://example.com/\nrest\x07'),
    ).toBe('https://example.com/');
    expect(extractUrlFromOsc8Code('\x1b]8;;https://example.com/\rx\x07')).toBe(
      'https://example.com/',
    );
  });

  it('returns undefined for the empty link-close code', () => {
    expect(extractUrlFromOsc8Code('\x1b]8;;\x07')).toBeUndefined();
  });

  it('returns undefined for non-OSC8 codes', () => {
    expect(extractUrlFromOsc8Code('\x1b[31m')).toBeUndefined();
  });
});

describe('hyperlinkAtCell', () => {
  it('returns the URL of a linked cell', () => {
    const frame = makeFrame([[linkCell('https://example.com/')]]);
    expect(hyperlinkAtCell(frame, 0, 0)).toBe('https://example.com/');
  });

  it('returns undefined for an unlinked cell', () => {
    const frame = makeFrame([[{ value: 'a' }]]);
    expect(hyperlinkAtCell(frame, 0, 0)).toBeUndefined();
  });

  it('returns undefined out of bounds', () => {
    const frame = makeFrame([[linkCell('https://example.com/')]]);
    expect(hyperlinkAtCell(frame, 5, 5)).toBeUndefined();
    expect(hyperlinkAtCell(frame, -1, 0)).toBeUndefined();
  });

  it('handles null/undefined frames', () => {
    expect(hyperlinkAtCell(null, 0, 0)).toBeUndefined();
    expect(hyperlinkAtCell(undefined, 0, 0)).toBeUndefined();
  });

  it('snaps from a wide-character spacer to the leading cell', () => {
    const frame = makeFrame([
      [
        {
          value: '中',
          fullWidth: true,
          styles: [
            {
              type: 'ansi',
              code: '\x1b]8;;https://example.com/\x07',
              endCode: '\x1b]8;;\x07',
            },
          ],
        },
        { value: '', styles: [] },
      ],
    ]);
    expect(hyperlinkAtCell(frame, 1, 0)).toBe('https://example.com/');
  });
});
