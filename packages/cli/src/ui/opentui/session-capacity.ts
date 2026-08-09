/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink long-session capacity mitigations.
 *
 * 1. Chunked history loading — parity of MainContent's progressive Static
 *    replay (issue #3899): a long resumed / remounted transcript is fed to
 *    the renderer in CHUNK_SIZE slices instead of one O(N) blocking render,
 *    while small gaps render in full so normal appends stay identical.
 * 2. Message row windowing — replaces the ink virtualized viewport: given
 *    per-item row heights and a scroll position, only the slice that fits
 *    the viewport is rendered, with the prefix row count as its layout
 *    offset. Chat sessions pin to the bottom (sticky-bottom scrollbox).
 */

export const CAPACITY_LOAD_THRESHOLD = 100;
export const CAPACITY_LOAD_CHUNK = 50;

/** Number of items to render on the first frame for a transcript of `total` items. */
export function initialLoadCount(total: number): number {
  const length = Math.max(0, Math.floor(total));
  return length <= CAPACITY_LOAD_THRESHOLD
    ? length
    : Math.min(CAPACITY_LOAD_CHUNK, length);
}

/**
 * Next loaded item count, or `null` once fully caught up. Mirrors the ink
 * catch-up effect: when the remaining gap is at most one chunk, jump
 * straight to the full length; otherwise grow by one chunk.
 */
export function nextLoadCount(current: number, total: number): number | null {
  const length = Math.max(0, Math.floor(total));
  const count = Math.min(Math.max(0, Math.floor(current)), length);
  if (count >= length) return null;
  if (length - count <= CAPACITY_LOAD_CHUNK) return length;
  return Math.min(count + CAPACITY_LOAD_CHUNK, length);
}

/**
 * True when the renderer should bypass the partial slice and render the
 * whole history — parity of the ink tail-gap shortcut that keeps a
 * just-finalized pending item visible without a flicker frame.
 */
export function shouldRenderFull(current: number, total: number): boolean {
  const length = Math.max(0, Math.floor(total));
  const count = Math.min(Math.max(0, Math.floor(current)), length);
  return length - count <= CAPACITY_LOAD_CHUNK;
}

export interface MessageRowWindow {
  /** Index of the first rendered item (inclusive). */
  start: number;
  /** Index past the last rendered item (exclusive). */
  end: number;
  /** Rows occupied by items before `start` (layout offset for the slice). */
  offsetRows: number;
  /** Rows occupied by all items. */
  totalRows: number;
}

/**
 * Row-window over items with known rendered heights. `scrollTop` is clamped
 * into [0, totalRows - viewportRows]; items intersecting the viewport top
 * are included whole (a partially visible item still renders in full, which
 * matches how the ink virtualized list handled overscan).
 */
export function computeMessageWindow(options: {
  heights: readonly number[];
  viewportRows: number;
  scrollTop: number;
}): MessageRowWindow {
  const heights = options.heights;
  const viewportRows = Math.max(0, Math.floor(options.viewportRows));
  let totalRows = 0;
  for (const h of heights) {
    totalRows += Math.max(0, h);
  }

  const maxScroll = Math.max(0, totalRows - viewportRows);
  const top = Math.min(Math.max(0, Math.floor(options.scrollTop)), maxScroll);

  let cursor = 0;
  let start = heights.length;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(0, heights[i] ?? 0);
    if (cursor + h > top) {
      start = i;
      break;
    }
    cursor += h;
  }
  const offsetRows = cursor;

  let end = start;
  let rows = 0;
  for (let i = start; i < heights.length; i++) {
    end = i + 1;
    rows += Math.max(0, heights[i] ?? 0);
    if (rows >= viewportRows) break;
  }
  // Over-scrolled to the bottom: the window must reach the last item.
  if (top >= maxScroll) end = heights.length;

  return { start, end, offsetRows, totalRows };
}

/** Scroll offset that pins the viewport to the newest message (sticky bottom). */
export function stickyBottomScrollTop(
  heights: readonly number[],
  viewportRows: number,
): number {
  let totalRows = 0;
  for (const h of heights) {
    totalRows += Math.max(0, h);
  }
  return Math.max(0, totalRows - Math.max(0, Math.floor(viewportRows)));
}
