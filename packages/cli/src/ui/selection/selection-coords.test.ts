/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  terminalToGrid,
  pointInViewport,
  clampToViewport,
} from './selection-coords.js';

describe('terminalToGrid', () => {
  it('maps directly when the frame fits the terminal (anchor 0)', () => {
    // terminalHeight 30 >= frameHeight 10 -> anchor 0
    expect(terminalToGrid(5, 3, 30, 10)).toEqual({ x: 4, y: 2 });
  });

  it('offsets by the negative anchor when the frame overflows (bottom-pinned)', () => {
    // terminalHeight 30 < frameHeight 50 -> anchor = -20;
    // terminal row 1 shows frame row 20.
    expect(terminalToGrid(1, 1, 30, 50)).toEqual({ x: 0, y: 20 });
    expect(terminalToGrid(1, 30, 30, 50)).toEqual({ x: 0, y: 49 });
  });
});

describe('pointInViewport', () => {
  const rect = { x: 0, y: 2, width: 40, height: 10 };

  it('accepts a point inside the viewport', () => {
    expect(pointInViewport({ x: 5, y: 5 }, rect)).toBe(true);
  });

  it('rejects points above, below, or past the right edge', () => {
    expect(pointInViewport({ x: 5, y: 1 }, rect)).toBe(false); // above
    expect(pointInViewport({ x: 5, y: 12 }, rect)).toBe(false); // below
    expect(pointInViewport({ x: 40, y: 5 }, rect)).toBe(false); // right edge exclusive
  });
});

describe('clampToViewport', () => {
  const rect = { x: 2, y: 2, width: 10, height: 5 };

  it('clamps a point outside the viewport to its interior', () => {
    expect(clampToViewport({ x: 100, y: 100 }, rect)).toEqual({ x: 11, y: 6 });
    expect(clampToViewport({ x: -5, y: -5 }, rect)).toEqual({ x: 2, y: 2 });
  });

  it('leaves an interior point unchanged', () => {
    expect(clampToViewport({ x: 5, y: 4 }, rect)).toEqual({ x: 5, y: 4 });
  });
});
