/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ReadonlyFrame, FrameCell } from 'ink';
import { SelectionState } from './selection-state.js';
import { getSelectedText } from './selection-text.js';

const cell = (value: string, fullWidth = false): FrameCell => ({
  type: 'char',
  value,
  fullWidth,
  styles: [],
});

/** Build a frame from plain strings, expanding wide glyphs into cell + spacer. */
function frameFromLines(lines: string[]): ReadonlyFrame {
  const cells: FrameCell[][] = lines.map((line) => {
    const row: FrameCell[] = [];
    for (const ch of line) {
      // Treat CJK as width-2: leading cell + empty spacer.
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
  return { width, height: cells.length, cells };
}

describe('SelectionState', () => {
  it('normalizes a forward selection', () => {
    const s = new SelectionState();
    s.start({ x: 2, y: 0 });
    s.extend({ x: 5, y: 1 });
    expect(s.normalized()).toEqual({ sx: 2, sy: 0, ex: 5, ey: 1 });
  });

  it('normalizes a backward selection into reading order', () => {
    const s = new SelectionState();
    s.start({ x: 5, y: 2 });
    s.extend({ x: 1, y: 0 });
    expect(s.normalized()).toEqual({ sx: 1, sy: 0, ex: 5, ey: 2 });
  });

  it('reports a click with no drag as collapsed', () => {
    const s = new SelectionState();
    s.start({ x: 3, y: 1 });
    expect(s.isCollapsed).toBe(true);
    s.extend({ x: 4, y: 1 });
    expect(s.isCollapsed).toBe(false);
  });

  it('clears to empty', () => {
    const s = new SelectionState();
    s.start({ x: 0, y: 0 });
    s.clear();
    expect(s.isEmpty).toBe(true);
    expect(s.normalized()).toBeNull();
  });
});

describe('getSelectedText', () => {
  it('extracts a partial single row', () => {
    const frame = frameFromLines(['hello world']);
    expect(getSelectedText(frame, { sx: 0, sy: 0, ex: 4, ey: 0 })).toBe(
      'hello',
    );
  });

  it('joins across rows with the first/last partial', () => {
    const frame = frameFromLines(['hello', 'world']);
    expect(getSelectedText(frame, { sx: 2, sy: 0, ex: 2, ey: 1 })).toBe(
      'llo\nwor',
    );
  });

  it('emits a wide glyph once and skips its spacer', () => {
    const frame = frameFromLines(['a中b']);
    // columns: a=0, 中=1 (spacer=2), b=3
    expect(getSelectedText(frame, { sx: 0, sy: 0, ex: 3, ey: 0 })).toBe('a中b');
    // Selecting only the wide glyph and its spacer yields the glyph once.
    expect(getSelectedText(frame, { sx: 1, sy: 0, ex: 2, ey: 0 })).toBe('中');
  });

  it('trims trailing whitespace per line', () => {
    const frame = frameFromLines(['hi   ', 'bye']);
    expect(getSelectedText(frame, { sx: 0, sy: 0, ex: 4, ey: 1 })).toBe(
      'hi\nbye',
    );
  });

  it('returns empty string for a null frame', () => {
    expect(getSelectedText(null, { sx: 0, sy: 0, ex: 1, ey: 0 })).toBe('');
  });
});
