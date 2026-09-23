/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  visualClickToOffset,
  type ClickableBufferState,
} from './mouse-caret.js';

function buffer(
  lines: string[],
  allVisualLines?: string[],
  visualToLogicalMap?: Array<[number, number]>,
): ClickableBufferState {
  return {
    lines,
    allVisualLines: allVisualLines ?? lines,
    visualToLogicalMap: visualToLogicalMap ?? lines.map((_, i) => [i, 0]),
  };
}

describe('mouse-caret: ASCII click-to-offset (input-mouse parity)', () => {
  it('maps each cell to its left boundary', () => {
    const b = buffer(['hello']);
    expect(visualClickToOffset(b, 0, 0)).toBe(0);
    expect(visualClickToOffset(b, 0, 1)).toBe(1);
    expect(visualClickToOffset(b, 0, 4)).toBe(4);
  });

  it('clicks at/past the end clamp to the line length', () => {
    const b = buffer(['hello']);
    expect(visualClickToOffset(b, 0, 5)).toBe(5);
    expect(visualClickToOffset(b, 0, 99)).toBe(5);
  });

  it('returns null for a visual row that maps to nothing', () => {
    const b = buffer(['hello']);
    expect(visualClickToOffset(b, 1, 0)).toBeNull();
    expect(visualClickToOffset(b, 9, 0)).toBeNull();
  });

  it('empty line always resolves to its (empty) start', () => {
    expect(visualClickToOffset(buffer(['']), 0, 0)).toBe(0);
    expect(visualClickToOffset(buffer(['']), 0, 5)).toBe(0);
  });
});

describe('mouse-caret: wide-character midpoint snap', () => {
  // '你好' — two glyphs, two cells each (total width 4).
  const b = buffer(['你好']);

  it('left half of a wide glyph snaps before it', () => {
    expect(visualClickToOffset(b, 0, 0)).toBe(0); // left cell of 你
    expect(visualClickToOffset(b, 0, 2)).toBe(1); // left cell of 好
  });

  it('right half of a wide glyph snaps after it', () => {
    expect(visualClickToOffset(b, 0, 1)).toBe(1); // right cell of 你
    expect(visualClickToOffset(b, 0, 3)).toBe(2); // right cell of 好
  });

  it('past the last wide glyph clamps to end of line', () => {
    expect(visualClickToOffset(b, 0, 4)).toBe(2);
    expect(visualClickToOffset(b, 0, 40)).toBe(2);
  });
});

describe('mouse-caret: zero-width marks stay attached to the base glyph', () => {
  // 'e\u0301x' — e + combining acute (zero width) + x; renders as 2 cells.
  const b = buffer(['e\u0301x']);

  it('click on the base cell stays before the grapheme', () => {
    expect(visualClickToOffset(b, 0, 0)).toBe(0);
  });

  it('click past the base cell lands after the full grapheme', () => {
    // The combining mark is skipped, so cell 1 belongs to 'x'.
    expect(visualClickToOffset(b, 0, 1)).toBe(2);
    expect(visualClickToOffset(b, 0, 9)).toBe(3);
  });

  it('midpoint snap of a wide glyph skips trailing zero-width marks', () => {
    // 你 + combining mark: right cell of 你 must land AFTER the mark.
    const wideMark = buffer(['\u4f60\u0301y']); // 你 + mark + y
    expect(visualClickToOffset(wideMark, 0, 0)).toBe(0);
    expect(visualClickToOffset(wideMark, 0, 1)).toBe(2);
    expect(visualClickToOffset(wideMark, 0, 2)).toBe(2);
  });
});

describe('mouse-caret: multi-line and wrapped lines', () => {
  it('offsets include newline separators across logical lines', () => {
    const b = buffer(['abc', 'de']);
    expect(visualClickToOffset(b, 0, 2)).toBe(2);
    expect(visualClickToOffset(b, 1, 0)).toBe(4); // 'abc' + \n
    expect(visualClickToOffset(b, 1, 1)).toBe(5);
    expect(visualClickToOffset(b, 1, 9)).toBe(6); // clamps to 'de' length
  });

  it('wrapped visual lines map back into their logical line', () => {
    // 'abcdefgh' wrapped at width 4.
    const b = buffer(
      ['abcdefgh'],
      ['abcd', 'efgh'],
      [
        [0, 0],
        [0, 4],
      ],
    );
    expect(visualClickToOffset(b, 0, 3)).toBe(3);
    expect(visualClickToOffset(b, 1, 0)).toBe(4);
    expect(visualClickToOffset(b, 1, 2)).toBe(6);
    expect(visualClickToOffset(b, 1, 99)).toBe(8);
  });
});
