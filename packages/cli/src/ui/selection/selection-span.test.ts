/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ReadonlyFrame, FrameCell } from 'ink';
import { wordSpanAt, lineSpanAt } from './selection-span.js';

const cell = (value: string, fullWidth = false): FrameCell => ({
  type: 'char',
  value,
  fullWidth,
  styles: [],
  selectable: true,
  flowId: 1,
});

function frameFromLines(lines: string[]): ReadonlyFrame {
  const cells: FrameCell[][] = lines.map((line) => {
    const row: FrameCell[] = [];
    for (const ch of line) {
      if (/[一-鿿]/u.test(ch)) {
        row.push(cell(ch, true));
        row.push(cell(''));
      } else {
        row.push(cell(ch));
      }
    }
    return row;
  });
  const width = Math.max(0, ...cells.map((r) => r.length));
  return {
    width,
    height: cells.length,
    cells,
    boundaries: cells.map(() => Array.from({ length: width }, () => null)),
  };
}

describe('wordSpanAt', () => {
  it('selects the word under the click', () => {
    const frame = frameFromLines(['hello world foo']);
    // "world" is columns 6..10
    expect(wordSpanAt(frame, 8, 0)).toEqual({ sx: 6, sy: 0, ex: 10, ey: 0 });
  });

  it('selects the first and last word at edges', () => {
    const frame = frameFromLines(['hello world']);
    expect(wordSpanAt(frame, 0, 0)).toEqual({ sx: 0, sy: 0, ex: 4, ey: 0 });
    expect(wordSpanAt(frame, 10, 0)).toEqual({ sx: 6, sy: 0, ex: 10, ey: 0 });
  });

  it('returns null on whitespace', () => {
    const frame = frameFromLines(['hello world']);
    expect(wordSpanAt(frame, 5, 0)).toBeNull();
  });

  it('includes a wide glyph and its spacer in the run', () => {
    const frame = frameFromLines(['a中b']);
    // a=0, 中=1 (spacer=2), b=3 -> one non-space run 0..3
    expect(wordSpanAt(frame, 1, 0)).toEqual({ sx: 0, sy: 0, ex: 3, ey: 0 });
  });
});

describe('lineSpanAt', () => {
  it('spans from column 0 to the last non-space cell', () => {
    const frame = frameFromLines(['  hi there   ']);
    expect(lineSpanAt(frame, 4, 0)).toEqual({ sx: 0, sy: 0, ex: 9, ey: 0 });
  });

  it('returns null for a blank line', () => {
    const frame = frameFromLines(['     ']);
    expect(lineSpanAt(frame, 2, 0)).toBeNull();
  });

  it('stops at a non-selectable layout gap', () => {
    const frame = frameFromLines(['status    42%']);
    for (let x = 6; x < 10; x++) {
      (frame.cells[0][x] as FrameCell).selectable = false;
    }

    expect(lineSpanAt(frame, 2, 0)).toEqual({
      sx: 0,
      sy: 0,
      ex: 5,
      ey: 0,
    });
    expect(lineSpanAt(frame, 7, 0)).toEqual({
      sx: 0,
      sy: 0,
      ex: 5,
      ey: 0,
    });
    expect(lineSpanAt(frame, 9, 0)).toEqual({
      sx: 10,
      sy: 0,
      ex: 12,
      ey: 0,
    });
  });

  it('snaps non-selectable history padding and gutters to visible content', () => {
    const padded = frameFromLines(['history   ']);
    for (let x = 7; x < padded.cells[0].length; x++) {
      (padded.cells[0][x] as FrameCell).selectable = false;
    }
    expect(lineSpanAt(padded, 9, 0)).toEqual({
      sx: 0,
      sy: 0,
      ex: 6,
      ey: 0,
    });

    const gutter = frameFromLines(['  1 code']);
    for (let x = 0; x < 4; x++) {
      (gutter.cells[0][x] as FrameCell).selectable = false;
    }
    expect(lineSpanAt(gutter, 1, 0)).toEqual({
      sx: 4,
      sy: 0,
      ex: 7,
      ey: 0,
    });
  });

  it('snaps a non-selectable wide-character spacer to its glyph', () => {
    const frame = frameFromLines(['中']);
    (frame.cells[0][1] as FrameCell).selectable = false;

    expect(lineSpanAt(frame, 1, 0)).toEqual({
      sx: 0,
      sy: 0,
      ex: 0,
      ey: 0,
    });
  });
});
