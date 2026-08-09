/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI long-session capacity parity: chunked history
 * loading mirrors MainContent's progressive replay thresholds, and the row
 * window math renders exactly the items intersecting the viewport with a
 * correct prefix offset for sticky-bottom chat transcripts.
 */

import { describe, it, expect } from 'vitest';
import {
  CAPACITY_LOAD_CHUNK,
  CAPACITY_LOAD_THRESHOLD,
  initialLoadCount,
  nextLoadCount,
  shouldRenderFull,
  computeMessageWindow,
  stickyBottomScrollTop,
} from './session-capacity.js';

describe('session-capacity chunked loading (progressive replay parity)', () => {
  it('keeps the original threshold/chunk constants', () => {
    expect(CAPACITY_LOAD_THRESHOLD).toBe(100);
    expect(CAPACITY_LOAD_CHUNK).toBe(50);
  });

  it('loads a short transcript in one shot', () => {
    expect(initialLoadCount(0)).toBe(0);
    expect(initialLoadCount(1)).toBe(1);
    expect(initialLoadCount(100)).toBe(100);
  });

  it('starts a long transcript at one chunk', () => {
    expect(initialLoadCount(101)).toBe(50);
    expect(initialLoadCount(5000)).toBe(50);
  });

  it('grows by one chunk while the gap is large', () => {
    expect(nextLoadCount(50, 500)).toBe(100);
    expect(nextLoadCount(100, 500)).toBe(150);
  });

  it('jumps straight to the full length once the remainder is one chunk', () => {
    expect(nextLoadCount(450, 500)).toBe(500);
    expect(nextLoadCount(460, 500)).toBe(500);
  });

  it('returns null once fully caught up', () => {
    expect(nextLoadCount(500, 500)).toBeNull();
    expect(nextLoadCount(600, 500)).toBeNull();
  });

  it('renders the full array while the tail gap is small', () => {
    expect(shouldRenderFull(49, 100)).toBe(false);
    expect(shouldRenderFull(50, 100)).toBe(true);
    expect(shouldRenderFull(100, 100)).toBe(true);
  });
});

describe('session-capacity message row window', () => {
  const heights = [3, 5, 2, 8, 1]; // totalRows = 19

  it('renders from the top when not scrolled', () => {
    const win = computeMessageWindow({
      heights,
      viewportRows: 10,
      scrollTop: 0,
    });
    expect(win).toEqual({ start: 0, end: 3, offsetRows: 0, totalRows: 19 });
  });

  it('includes the item intersecting the viewport top', () => {
    // scrollTop 4 lands inside item 1 (rows 3..8)
    const win = computeMessageWindow({
      heights,
      viewportRows: 6,
      scrollTop: 4,
    });
    expect(win.start).toBe(1);
    expect(win.offsetRows).toBe(3);
    expect(win.totalRows).toBe(19);
  });

  it('clamps an over-scrolled position to the bottom', () => {
    const win = computeMessageWindow({
      heights,
      viewportRows: 10,
      scrollTop: 9999,
    });
    expect(win.end).toBe(heights.length);
    expect(win.start + 1).toBeLessThanOrEqual(heights.length);
  });

  it('returns an empty window for an empty transcript', () => {
    const win = computeMessageWindow({
      heights: [],
      viewportRows: 10,
      scrollTop: 0,
    });
    expect(win).toEqual({ start: 0, end: 0, offsetRows: 0, totalRows: 0 });
  });

  it('ignores negative heights', () => {
    const win = computeMessageWindow({
      heights: [2, -4, 3],
      viewportRows: 100,
      scrollTop: 0,
    });
    expect(win.totalRows).toBe(5);
    expect(win.end).toBe(3);
  });

  it('pins sticky-bottom scroll to the newest rows', () => {
    expect(stickyBottomScrollTop(heights, 10)).toBe(9);
    expect(stickyBottomScrollTop(heights, 100)).toBe(0);
    expect(stickyBottomScrollTop([], 10)).toBe(0);
  });
});
