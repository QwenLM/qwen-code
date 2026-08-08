/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  frameAnchor,
  terminalRowToLayoutRow,
  terminalToGrid,
  pointInViewport,
  clampToViewport,
  findItemAtLayoutRow,
  resolveListIndex,
  hitTestScrollbar,
  type ScrollbarGeometry,
  type VisibleItemRect,
} from './mouse-hit.js';

describe('mouse-hit: frame anchor (list-mouse parity)', () => {
  it('is 0 when the frame fits the terminal (top-anchored)', () => {
    expect(frameAnchor(40, 40)).toBe(0);
    expect(frameAnchor(40, 20)).toBe(0);
  });

  it('is negative when the frame overflows (bottom-pinned)', () => {
    expect(frameAnchor(40, 50)).toBe(-10);
    expect(frameAnchor(24, 100)).toBe(-76);
  });

  it('maps terminal rows through the anchor', () => {
    // Frame fits: row 1 -> layout 0.
    expect(terminalRowToLayoutRow(1, frameAnchor(40, 30))).toBe(0);
    expect(terminalRowToLayoutRow(5, frameAnchor(40, 30))).toBe(4);
    // Frame overflows: top rows scrolled off, anchor -10.
    expect(terminalRowToLayoutRow(1, frameAnchor(40, 50))).toBe(10);
    expect(terminalRowToLayoutRow(40, frameAnchor(40, 50))).toBe(49);
  });

  it('terminalToGrid applies col/row - 1 and the anchor', () => {
    expect(terminalToGrid(1, 1, 40, 30)).toEqual({ x: 0, y: 0 });
    expect(terminalToGrid(7, 3, 40, 50)).toEqual({ x: 6, y: 12 });
  });
});

describe('mouse-hit: viewport membership / clamp', () => {
  const viewport = { x: 1, y: 2, width: 10, height: 5 };

  it('accepts interior points and rejects exterior ones', () => {
    expect(pointInViewport({ x: 1, y: 2 }, viewport)).toBe(true);
    expect(pointInViewport({ x: 10, y: 6 }, viewport)).toBe(true);
    expect(pointInViewport({ x: 0, y: 2 }, viewport)).toBe(false);
    expect(pointInViewport({ x: 11, y: 2 }, viewport)).toBe(false);
    expect(pointInViewport({ x: 1, y: 1 }, viewport)).toBe(false);
    expect(pointInViewport({ x: 1, y: 7 }, viewport)).toBe(false);
  });

  it('clamps outside points onto the viewport border', () => {
    expect(clampToViewport({ x: -5, y: -5 }, viewport)).toEqual({ x: 1, y: 2 });
    expect(clampToViewport({ x: 99, y: 99 }, viewport)).toEqual({
      x: 10,
      y: 6,
    });
    expect(clampToViewport({ x: 4, y: 3 }, viewport)).toEqual({ x: 4, y: 3 });
  });
});

describe('mouse-hit: row hit-testing', () => {
  const rects: VisibleItemRect[] = [
    { index: 0, top: 0, height: 1 },
    { index: 1, top: 1, height: 3 }, // multi-line item
    { index: 2, top: 5, height: 1 }, // gap at row 4
  ];

  it('resolves single- and multi-line items', () => {
    expect(findItemAtLayoutRow(rects, 0)).toBe(0);
    expect(findItemAtLayoutRow(rects, 1)).toBe(1);
    expect(findItemAtLayoutRow(rects, 2)).toBe(1);
    expect(findItemAtLayoutRow(rects, 3)).toBe(1);
    expect(findItemAtLayoutRow(rects, 5)).toBe(2);
  });

  it('returns null for gaps and outside rows', () => {
    expect(findItemAtLayoutRow(rects, 4)).toBeNull();
    expect(findItemAtLayoutRow(rects, 6)).toBeNull();
    expect(findItemAtLayoutRow(rects, -1)).toBeNull();
  });

  it('gates interactions outside the container columns', () => {
    const geometry = {
      container: { x: 2, y: 0, width: 20, height: 6 },
      items: rects,
    };
    expect(resolveListIndex(geometry, { x: 2, y: 0 })).toBe(0);
    expect(resolveListIndex(geometry, { x: 21, y: 0 })).toBe(0);
    expect(resolveListIndex(geometry, { x: 1, y: 0 })).toBeNull();
    expect(resolveListIndex(geometry, { x: 22, y: 0 })).toBeNull();
  });

  it('skips disabled rows', () => {
    const geometry = {
      container: { x: 0, y: 0, width: 30, height: 6 },
      items: rects,
    };
    expect(
      resolveListIndex(geometry, { x: 5, y: 2 }, (i) => i === 1),
    ).toBeNull();
    expect(resolveListIndex(geometry, { x: 5, y: 0 }, (i) => i === 1)).toBe(0);
  });
});

describe('mouse-hit: scrollbar hit-testing (VirtualizedList parity)', () => {
  const geometry: ScrollbarGeometry = { col: 79, top: 0, height: 10 };

  it('hits only the exact track column within its rows', () => {
    // 1-based terminal coordinates.
    expect(hitTestScrollbar(geometry, { col: 80, row: 1 })).toBe(true);
    expect(hitTestScrollbar(geometry, { col: 80, row: 10 })).toBe(true);
    expect(hitTestScrollbar(geometry, { col: 80, row: 11 })).toBe(false);
    expect(hitTestScrollbar(geometry, { col: 79, row: 1 })).toBe(false);
    expect(hitTestScrollbar(geometry, { col: 81, row: 1 })).toBe(false);
  });

  it('offset tracks only hit inside their row span', () => {
    const offset: ScrollbarGeometry = { col: 10, top: 5, height: 4 };
    expect(hitTestScrollbar(offset, { col: 11, row: 5 })).toBe(false);
    expect(hitTestScrollbar(offset, { col: 11, row: 6 })).toBe(true);
    expect(hitTestScrollbar(offset, { col: 11, row: 9 })).toBe(true);
    expect(hitTestScrollbar(offset, { col: 11, row: 10 })).toBe(false);
  });

  it('no geometry means no hit (content fits the viewport)', () => {
    expect(hitTestScrollbar(null, { col: 80, row: 1 })).toBe(false);
  });
});
