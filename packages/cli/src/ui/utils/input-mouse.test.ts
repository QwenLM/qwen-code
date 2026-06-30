/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  visualClickToOffset,
  type ClickableBufferState,
} from './input-mouse.js';

describe('visualClickToOffset', () => {
  it('maps a click within a single logical line to the char boundary', () => {
    const buffer: ClickableBufferState = {
      lines: ['abc', 'def'],
      allVisualLines: ['abc', 'def'],
      visualToLogicalMap: [
        [0, 0],
        [1, 0],
      ],
    };
    // Row 0, col 1 → between 'a' and 'b' → logical (0,1) → offset 1.
    expect(visualClickToOffset(buffer, 0, 1)).toBe(1);
    // Row 0, col 0 → start of line → offset 0.
    expect(visualClickToOffset(buffer, 0, 0)).toBe(0);
  });

  it('accounts for the newline between logical lines', () => {
    const buffer: ClickableBufferState = {
      lines: ['abc', 'def'],
      allVisualLines: ['abc', 'def'],
      visualToLogicalMap: [
        [0, 0],
        [1, 0],
      ],
    };
    // Row 1 ('def'), col 2 → logical (1,2). Offset = len('abc')=3 + 1 newline + 2 = 6.
    expect(visualClickToOffset(buffer, 1, 2)).toBe(6);
  });

  it('uses the visual line start column for wrapped lines', () => {
    // 'abcdef' wrapped at width 3 → two visual rows of one logical line.
    const buffer: ClickableBufferState = {
      lines: ['abcdef'],
      allVisualLines: ['abc', 'def'],
      visualToLogicalMap: [
        [0, 0],
        [0, 3],
      ],
    };
    // Row 1 ('def'), col 1 → startCol 3 + 1 = logical col 4 → offset 4.
    expect(visualClickToOffset(buffer, 1, 1)).toBe(4);
  });

  it('maps wide (CJK) characters by display width', () => {
    const buffer: ClickableBufferState = {
      lines: ['abc', '日本'],
      allVisualLines: ['abc', '日本'],
      visualToLogicalMap: [
        [0, 0],
        [1, 0],
      ],
    };
    // '日' is 2 cells wide. Col 0 → before '日' (logical col 0). Offset = 3+1+0 = 4.
    expect(visualClickToOffset(buffer, 1, 0)).toBe(4);
    // Col 2 → just past '日' → between '日' and '本' (logical col 1). Offset 5.
    expect(visualClickToOffset(buffer, 1, 2)).toBe(5);
  });

  it('snaps to the right side when the right half of a wide char is clicked', () => {
    const buffer: ClickableBufferState = {
      lines: ['日本'],
      allVisualLines: ['日本'],
      visualToLogicalMap: [[0, 0]],
    };
    // '日' occupies cells 0–1. Clicking its left cell (col 0) lands before it
    // (logical col 0 → offset 0); clicking its right cell (col 1) lands after
    // it (logical col 1 → offset 1).
    expect(visualClickToOffset(buffer, 0, 0)).toBe(0);
    expect(visualClickToOffset(buffer, 0, 1)).toBe(1);
    // '本' occupies cells 2–3. Right cell (col 3) lands after it (offset 2).
    expect(visualClickToOffset(buffer, 0, 2)).toBe(1);
    expect(visualClickToOffset(buffer, 0, 3)).toBe(2);
  });

  it('keeps a combining mark attached to its base character', () => {
    // 'e' + U+0301 (combining acute) renders as a single cell, followed by 'x'.
    const decomposed = 'e\u0301x';
    const buffer: ClickableBufferState = {
      lines: [decomposed],
      allVisualLines: [decomposed],
      visualToLogicalMap: [[0, 0]],
    };
    // Col 0 → before the base 'e' (offset 0).
    expect(visualClickToOffset(buffer, 0, 0)).toBe(0);
    // Col 1 → the visible 'x'. The cursor must land after the full 'é'
    // grapheme (code-point offset 2), not between 'e' and the accent.
    expect(visualClickToOffset(buffer, 0, 1)).toBe(2);
    // Col 2 → past 'x' → end of line (offset 3).
    expect(visualClickToOffset(buffer, 0, 2)).toBe(3);
  });

  it('clicking past the end of the text lands at the line end', () => {
    const buffer: ClickableBufferState = {
      lines: ['hi'],
      allVisualLines: ['hi'],
      visualToLogicalMap: [[0, 0]],
    };
    // Col 99 is well past 'hi' → clamp to end (logical col 2) → offset 2.
    expect(visualClickToOffset(buffer, 0, 99)).toBe(2);
  });

  it('returns null for a visual row outside the map', () => {
    const buffer: ClickableBufferState = {
      lines: ['abc'],
      allVisualLines: ['abc'],
      visualToLogicalMap: [[0, 0]],
    };
    expect(visualClickToOffset(buffer, 5, 0)).toBeNull();
  });
});
