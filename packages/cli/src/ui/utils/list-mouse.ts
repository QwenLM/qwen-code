/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure geometry helper for mapping a terminal mouse row onto a vertical list of
 * items. The DOM measurement (reading yoga layout via measureElementPosition)
 * lives in the component that owns the refs; this is pure arithmetic so it can
 * be unit-tested without a renderer.
 */

/**
 * The 0-based terminal row of the layout's top edge.
 *
 * In alternate-screen mode the frame renders from the top of the screen and, if
 * it overflows, scrolls so its BOTTOM is pinned to the terminal bottom:
 * - fits (`frameHeight <= terminalHeight`): top-anchored → top at row 0 → anchor 0.
 * - overflows (`frameHeight > terminalHeight`): bottom-anchored → the top rows
 *   scroll off → anchor `terminalHeight - frameHeight` (NEGATIVE).
 *
 * So the anchor is `min(0, terminalHeight - frameHeight)` — never positive. The
 * negative value must NOT be clamped to 0 (that was the original bug); the
 * positive value must be (a shorter-than-screen frame is top-anchored, not
 * bottom-anchored).
 */
export function frameAnchor(
  terminalHeight: number,
  frameHeight: number,
): number {
  return Math.min(0, terminalHeight - frameHeight);
}

/**
 * Convert a 1-based terminal mouse row into a 0-based layout row (directly
 * comparable to a measured element's `y`), via the frame anchor.
 */
export function terminalRowToLayoutRow(
  terminalRow1Based: number,
  anchor: number,
): number {
  return terminalRow1Based - 1 - anchor;
}

/** A visible list item's layout-space vertical span (rows). */
export interface VisibleItemRect {
  /** Index into the full items array (not the visible slice). */
  index: number;
  /** Top row of the item, in the same 0-based space as the click row. */
  top: number;
  /** Item height in rows (>= 1; multi-line items span several rows). */
  height: number;
}

/**
 * Find the item whose row span contains `layoutRow`, or null if the row falls
 * in no item (scroll arrows, gaps, or outside the list). Iterates measured
 * rects so multi-line items and inter-item gaps are handled without assuming a
 * uniform row height.
 */
export function findItemAtLayoutRow(
  rects: VisibleItemRect[],
  layoutRow: number,
): number | null {
  for (const rect of rects) {
    if (layoutRow >= rect.top && layoutRow < rect.top + rect.height) {
      return rect.index;
    }
  }
  return null;
}
