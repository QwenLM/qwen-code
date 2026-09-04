/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  frameAnchor,
  terminalRowToLayoutRow,
  findItemAtLayoutRow,
  type VisibleItemRect,
} from './list-mouse.js';

describe('frameAnchor', () => {
  it('is 0 when the frame exactly fills the terminal', () => {
    expect(frameAnchor(40, 40)).toBe(0);
  });

  it('is NEGATIVE when the frame overflows the screen (top rows scrolled off)', () => {
    // Frame 4 rows taller than the screen → top 4 layout rows are above the
    // viewport, so the anchor is -4 (NOT clamped to 0 — that was the bug).
    expect(frameAnchor(40, 44)).toBe(-4);
  });

  it('is 0 when the frame is shorter than the terminal (top-anchored, not bottom)', () => {
    expect(frameAnchor(40, 12)).toBe(0);
  });
});

describe('terminalRowToLayoutRow', () => {
  it('maps directly when the anchor is 0', () => {
    expect(terminalRowToLayoutRow(1, 0)).toBe(0);
    expect(terminalRowToLayoutRow(10, 0)).toBe(9);
  });

  it('adds the overflow back for a negative anchor', () => {
    // anchor -4: terminal row 5 (1-based) maps to layout row 4 + 4 = 8.
    expect(terminalRowToLayoutRow(5, -4)).toBe(8);
  });

  it('subtracts a positive anchor (short frame)', () => {
    expect(terminalRowToLayoutRow(30, 28)).toBe(1);
  });
});

describe('findItemAtLayoutRow', () => {
  // Item 1 is multi-line (height 2) — exercises the non-uniform-height path
  // that justifies measuring each item instead of dividing by a row height.
  const rects: VisibleItemRect[] = [
    { index: 0, top: 0, height: 1 },
    { index: 1, top: 1, height: 2 },
    { index: 2, top: 3, height: 1 },
  ];

  it('finds a single-row item', () => {
    expect(findItemAtLayoutRow(rects, 0)).toBe(0);
  });

  it('finds either row of a multi-row item', () => {
    expect(findItemAtLayoutRow(rects, 1)).toBe(1);
    expect(findItemAtLayoutRow(rects, 2)).toBe(1);
  });

  it('finds the item after a multi-row item', () => {
    expect(findItemAtLayoutRow(rects, 3)).toBe(2);
  });

  it('returns null above and below the list', () => {
    expect(findItemAtLayoutRow(rects, -1)).toBeNull();
    expect(findItemAtLayoutRow(rects, 4)).toBeNull();
  });

  it('returns null for a gap row not covered by any rect', () => {
    const gapped: VisibleItemRect[] = [
      { index: 0, top: 0, height: 1 },
      { index: 1, top: 2, height: 1 }, // row 1 is an itemGap
    ];
    expect(findItemAtLayoutRow(gapped, 1)).toBeNull();
  });

  it('maps a 1-based terminal row via the alternate-screen convention', () => {
    // In alternate-screen mode the click's layout row is event.row - 1.
    // Terminal row 4 → layout row 3 → item 2.
    expect(findItemAtLayoutRow(rects, 4 - 1)).toBe(2);
  });
});
