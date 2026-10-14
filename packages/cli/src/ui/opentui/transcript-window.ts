/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Row-budgeted windowing for the OpenTUI transcript.
 *
 * @opentui allocates one native TextBuffer per mounted text element, and
 * allocation fails once the process runs out: an isolated probe with one-word
 * buffers returned a null pointer at 65534 live buffers, while a real
 * 2498-record resume failed at 16430 allocations with 870 MB resident. A
 * transcript that mounts every item at once gets there on a session of a few
 * thousand records: the throw lands inside a React host-instance creation,
 * @opentui/react's own error boundary catches it and tries to render a red
 * `text` fallback, which calls a `jsxDEV` the bundle does not provide and so
 * throws too, and React unmounts the whole root, leaving the terminal blank
 * with no message. Mounting only what the viewport can show keeps the count in
 * the hundreds regardless of session length (the same resume stayed under 500
 * allocations in total).
 */

/** ink's `virtualEstimatedItemHeight`: 10 rows for the first item, 3 after. */
export const ESTIMATED_ITEM_ROWS = 3;
export const ESTIMATED_FIRST_ITEM_ROWS = 10;

/** One screen of slack on each side so a wheel tick never shows a gap. */
export const OVERSCAN_ROWS = 24;

/**
 * Backstop for a window made of many one-row items, and the only bound this
 * module puts on the live native buffer count: 400 items still leaves an order
 * of magnitude of headroom under that cap.
 *
 * It binds once `viewportRows + 2 * OVERSCAN_ROWS` exceeds
 * `MAX_MOUNTED_ITEMS * rowHeight` — a 353-row viewport for one-row items, 753
 * for two-row items. From there up to a `MAX_MOUNTED_ITEMS`-row viewport the
 * mounted items still cover the viewport and only the bottom overscan is
 * trimmed; above that no window can cover it.
 */
export const MAX_MOUNTED_ITEMS = 400;

export interface TranscriptWindow {
  /** First mounted item index. */
  start: number;
  /** One past the last mounted item index. */
  end: number;
  /** Rows of spacer standing in for items before `start`. */
  topPad: number;
  /** Rows of spacer standing in for items from `end` on. */
  bottomPad: number;
}

/** Item row offsets: `offsets[i]` is the first row of item `i`. */
export function itemOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = offsets[i] + Math.max(0, heights[i]);
  }
  return offsets;
}

/** Last index whose offset is <= target, or 0. */
function lastOffsetAtMost(offsets: readonly number[], target: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function computeTranscriptWindow(opts: {
  itemCount: number;
  offsets: readonly number[];
  /** Scroll position in transcript rows, 0 at the first item. */
  scrollTop: number;
  viewportRows: number;
}): TranscriptWindow {
  const { itemCount, offsets } = opts;
  if (itemCount <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const viewportRows = Math.max(1, opts.viewportRows);
  const total = offsets[itemCount] ?? 0;

  const scrollTop = Math.min(
    Math.max(0, opts.scrollTop),
    Math.max(0, total - viewportRows),
  );
  const start = lastOffsetAtMost(
    offsets,
    Math.max(0, scrollTop - OVERSCAN_ROWS),
  );
  const reach = scrollTop + viewportRows + OVERSCAN_ROWS;
  let end = lastOffsetAtMost(offsets, reach);
  // An item straddling the bottom edge is not included by the search above.
  if (end < itemCount && offsets[end] < reach) end += 1;
  end = Math.min(end, itemCount);

  if (end - start > MAX_MOUNTED_ITEMS) {
    // Keep the top rows, which is where reading starts. Up to a
    // `MAX_MOUNTED_ITEMS`-row viewport this trims only the bottom overscan;
    // past that no window can cover the viewport at all.
    end = start + MAX_MOUNTED_ITEMS;
  }

  return {
    start,
    end,
    topPad: offsets[start] ?? 0,
    bottomPad: Math.max(0, total - (offsets[end] ?? 0)),
  };
}
