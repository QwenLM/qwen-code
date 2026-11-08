/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mouse hit-testing parity layer for the OpenTUI renderer (PR1 slice 4).
 *
 * Framework-neutral port of the geometry the ink TUI uses to resolve mouse
 * coordinates onto list rows and scrollbars:
 *  - `list-mouse.ts` (`frameAnchor`, `terminalRowToLayoutRow`,
 *    `findItemAtLayoutRow`) — menu / dialog / completion row hit-testing;
 *  - `selection-coords.ts` (`terminalToGrid`, `pointInViewport`,
 *    `clampToViewport`) — frame-anchor-corrected grid coordinates;
 *  - `VirtualizedList.hitTestScrollbar` — scrollbar-track hit-testing;
 *  - `RowMouseController.resolveIndex` — container-column gating plus
 *    hover (`move`) vs select (`left-press`) dispatch, disabled rows skipped.
 *
 * Pure arithmetic so it can be unit-tested without a renderer.
 */

/** A point in composited-frame (grid/layout) coordinates. */
export interface MousePoint {
  x: number;
  y: number;
}

/** A rectangle in the same 0-based coordinate space as `MousePoint`. */
export interface MouseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The 0-based terminal row of the layout's top edge.
 *
 * When the frame overflows the terminal it is bottom-pinned, so its top rows
 * scroll off-screen and the anchor is NEGATIVE (`terminalHeight -
 * frameHeight`); a frame that fits is top-anchored (anchor 0). Parity with
 * `list-mouse.ts#frameAnchor` — the negative value must not be clamped to 0.
 */
export function frameAnchor(
  terminalHeight: number,
  frameHeight: number,
): number {
  return Math.min(0, terminalHeight - frameHeight);
}

/**
 * Convert a 1-based terminal mouse row into a 0-based layout row, via the
 * frame anchor. Parity with `list-mouse.ts#terminalRowToLayoutRow`.
 */
export function terminalRowToLayoutRow(
  terminalRow1Based: number,
  anchor: number,
): number {
  return terminalRow1Based - 1 - anchor;
}

/**
 * Map a 1-based terminal cell (col, row) to composited-frame grid
 * coordinates. Parity with `selection-coords.ts#terminalToGrid`.
 */
export function terminalToGrid(
  col: number,
  row: number,
  terminalHeight: number,
  frameHeight: number,
): MousePoint {
  const anchor = frameAnchor(terminalHeight, frameHeight);
  return { x: col - 1, y: row - 1 - anchor };
}

/** Whether a grid point falls inside a viewport region. */
export function pointInViewport(point: MousePoint, rect: MouseRect): boolean {
  return (
    point.y >= rect.y &&
    point.y < rect.y + rect.height &&
    point.x >= rect.x &&
    point.x < rect.x + rect.width
  );
}

/** Clamp a grid point to the viewport interior, for drag extension. */
export function clampToViewport(
  point: MousePoint,
  rect: MouseRect,
): MousePoint {
  return {
    x: Math.max(rect.x, Math.min(rect.x + rect.width - 1, point.x)),
    y: Math.max(rect.y, Math.min(rect.y + rect.height - 1, point.y)),
  };
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
 * Find the item whose row span contains `layoutRow`, or null when the row
 * falls in no item (scroll arrows, gaps, or outside the list). Multi-line
 * items and inter-item gaps are handled without assuming a uniform row
 * height. Parity with `list-mouse.ts#findItemAtLayoutRow`.
 */
export function findItemAtLayoutRow(
  rects: readonly VisibleItemRect[],
  layoutRow: number,
): number | null {
  for (const rect of rects) {
    if (layoutRow >= rect.top && layoutRow < rect.top + rect.height) {
      return rect.index;
    }
  }
  return null;
}

/** A list's hit-testing geometry: container bounds plus measured items. */
export interface ListHitGeometry {
  /** Container bounds in layout coordinates (horizontal gating). */
  container: MouseRect;
  /** Measured item spans, indices already offset by the scroll position. */
  items: readonly VisibleItemRect[];
}

/**
 * Resolve a layout-space pointer position to a list item index, applying the
 * `RowMouseController` rules: interactions outside the container's columns
 * are ignored (a click elsewhere on the same terminal row must not hijack a
 * selection) and disabled rows are skipped. Returns the item index or null.
 */
export function resolveListIndex(
  geometry: ListHitGeometry,
  location: MousePoint,
  isDisabled?: (index: number) => boolean,
): number | null {
  const { container, items } = geometry;
  if (
    container.width > 0 &&
    (location.x < container.x || location.x >= container.x + container.width)
  ) {
    return null;
  }
  const index = findItemAtLayoutRow(items, location.y);
  if (index === null || isDisabled?.(index)) return null;
  return index;
}

/**
 * The scrollbar track's geometry in 0-based layout coordinates. Parity with
 * `VirtualizedList#getScrollbarGeometry`: the track occupies the container's
 * rightmost column.
 */
export interface ScrollbarGeometry {
  col: number;
  top: number;
  height: number;
}

/**
 * Hit-test the scrollbar track against a 1-based terminal mouse location.
 * Parity with `VirtualizedList#hitTestScrollbar` (no frame-anchor correction:
 * the track is always in the visible region).
 */
export function hitTestScrollbar(
  geometry: ScrollbarGeometry | null,
  location: { col: number; row: number },
): boolean {
  if (!geometry) return false;
  const zeroBasedCol = location.col - 1;
  const zeroBasedRow = location.row - 1;
  return (
    zeroBasedCol === geometry.col &&
    zeroBasedRow >= geometry.top &&
    zeroBasedRow < geometry.top + geometry.height
  );
}
