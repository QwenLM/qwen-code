/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  ESTIMATED_FIRST_ITEM_ROWS,
  ESTIMATED_ITEM_ROWS,
  computeTranscriptWindow,
  itemOffsets,
} from './transcript-window.js';

function windowFor(
  itemCount: number,
  scrollTop: number,
  viewportRows: number,
  rowHeight = ESTIMATED_ITEM_ROWS,
) {
  const heights = Array.from({ length: itemCount }, (_, i) =>
    i === 0 ? ESTIMATED_FIRST_ITEM_ROWS : rowHeight,
  );
  const offsets = itemOffsets(heights);
  return {
    offsets,
    win: computeTranscriptWindow({
      itemCount,
      offsets,
      scrollTop,
      viewportRows,
    }),
  };
}

describe('itemOffsets', () => {
  it('prefix-sums heights and clamps negatives', () => {
    expect(itemOffsets([])).toEqual([0]);
    expect(itemOffsets([4, 2, 7])).toEqual([0, 4, 6, 13]);
    expect(itemOffsets([4, -9, 3])).toEqual([0, 4, 4, 7]);
  });
});

describe('computeTranscriptWindow', () => {
  it('returns an empty window for an empty transcript', () => {
    expect(
      computeTranscriptWindow({
        itemCount: 0,
        offsets: [0],
        scrollTop: 0,
        viewportRows: 24,
      }),
    ).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  it('mounts everything when the transcript fits the viewport', () => {
    const { win } = windowFor(6, 0, 40);
    expect(win).toEqual({ start: 0, end: 6, topPad: 0, bottomPad: 0 });
  });

  it('clamps an out-of-range scroll position to the bottom', () => {
    const { win } = windowFor(1000, 1e9, 24);
    expect(win.bottomPad).toBe(0);
    expect(win.end).toBe(1000);
    expect(win.end - win.start).toBeLessThanOrEqual(400);
  });

  it('covers the visible rows plus overscan at the bottom', () => {
    const { offsets, win } = windowFor(1000, 0, 24);
    expect(win.start).toBe(0);
    expect(win.topPad).toBe(0);
    // rows 0..(24 + 24 overscan) must all be mounted
    expect(offsets[win.end]).toBeGreaterThanOrEqual(48);
    expect(win.bottomPad).toBe(offsets[1000] - offsets[win.end]);
  });

  it('covers the visible rows plus overscan on both sides when scrolled', () => {
    const { offsets, win } = windowFor(1000, 300, 24);
    expect(offsets[win.start]).toBeLessThanOrEqual(300);
    expect(offsets[win.start] + ESTIMATED_ITEM_ROWS).toBeGreaterThan(300 - 24);
    expect(offsets[win.end]).toBeGreaterThanOrEqual(300 + 24 + 24);
    expect(win.topPad).toBe(offsets[win.start]);
    expect(win.bottomPad).toBe(offsets[1000] - offsets[win.end]);
  });

  it('includes an item straddling the bottom edge of the reach', () => {
    const heights = [10, 5, 500];
    const offsets = itemOffsets(heights);
    const win = computeTranscriptWindow({
      itemCount: 3,
      offsets,
      scrollTop: 0,
      viewportRows: 20,
    });
    expect(win.end).toBe(3);
    expect(win.bottomPad).toBe(0);
  });

  it('keeps the spacer arithmetic exact for mixed heights', () => {
    const heights = [10, 1, 40, 2, 7];
    const offsets = itemOffsets(heights);
    const win = computeTranscriptWindow({
      itemCount: heights.length,
      offsets,
      scrollTop: 11,
      viewportRows: 5,
    });
    expect(offsets[win.end] + win.bottomPad).toBe(offsets[heights.length]);
    expect(offsets[win.start]).toBe(win.topPad);
  });

  it('caps the mounted item count, keeping the top of the viewport', () => {
    const itemCount = 5000;
    const heights = Array.from({ length: itemCount }, () => 1);
    const offsets = itemOffsets(heights);
    // A viewport taller than the cap: no window can cover it, so the top wins.
    const scrolled = computeTranscriptWindow({
      itemCount,
      offsets,
      scrollTop: 2500,
      viewportRows: 500,
    });
    expect(scrolled).toEqual({
      start: 2476,
      end: 2876,
      topPad: 2476,
      bottomPad: 2124,
    });

    const atTop = computeTranscriptWindow({
      itemCount,
      offsets,
      scrollTop: 0,
      viewportRows: 500,
    });
    expect(atTop).toEqual({ start: 0, end: 400, topPad: 0, bottomPad: 4600 });
  });

  it('never binds the cap for a viewport of realistic height', () => {
    const itemCount = 5000;
    const offsets = itemOffsets(Array.from({ length: itemCount }, () => 1));
    for (const scrollTop of [0, 100, 2500, 4900]) {
      const win = computeTranscriptWindow({
        itemCount,
        offsets,
        scrollTop,
        viewportRows: 60,
      });
      expect(win.end - win.start).toBeLessThanOrEqual(60 + 2 * 24 + 1);
    }
  });
});
