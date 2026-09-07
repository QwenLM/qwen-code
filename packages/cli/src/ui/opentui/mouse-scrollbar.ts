/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scrollbar drag + wheel parity for the OpenTUI renderer (PR1 slice 4).
 *
 * Framework-neutral port of the scroll intent pipeline the ink TUI's
 * `ScrollableList` + `VirtualizedList` use:
 *  - wheel ticks scroll a fixed number of lines and accumulate (relative);
 *  - a scrollbar press snaps immediately and an ongoing drag is absolute
 *    (the newest reported row wins);
 *  - within one coalesced flush window a drag overrides any queued wheel
 *    delta, and a scrollbar press discards pending wheel intent so a burst
 *    scheduled moments earlier can't yank the view off the clicked row.
 */

import { hitTestScrollbar, type ScrollbarGeometry } from './mouse-hit.js';

/** Lines scrolled per wheel tick (parity with `ScrollableList`). */
export const WHEEL_LINES_PER_TICK = 3;

/** The resolved intent of one coalesced scroll flush. */
export interface ScrollIntent {
  /** Absolute scroll target (drag / scrollbar press), or */
  scrollTop?: number;
  /** relative delta (wheel), applied via scrollBy. */
  scrollBy?: number;
  /** True when the target reaches the bottom (sticky-bottom anchor). */
  stickingToBottom?: boolean;
}

/**
 * Map a 1-based terminal scrollbar row to an absolute scroll position.
 * Parity with `VirtualizedList#scrollToScrollbarRow`: the row is clamped into
 * the track, turned into a ratio of the track, scaled by `maxScroll`, and a
 * target at the bottom engages the sticky-bottom anchor. Returns null when
 * there is no scrollable overflow (content fits the viewport).
 */
export function scrollbarRowToScrollTop(
  geometry: ScrollbarGeometry | null,
  terminalRow1Based: number,
  maxScroll: number,
): ScrollIntent | null {
  if (!geometry || maxScroll <= 0) return null;
  const zeroBasedRow = terminalRow1Based - 1;
  const rowInTrack = Math.max(
    0,
    Math.min(geometry.height - 1, zeroBasedRow - geometry.top),
  );
  const scrollRatio = rowInTrack / Math.max(1, geometry.height - 1);
  const newScrollTop = Math.round(scrollRatio * maxScroll);
  if (newScrollTop >= maxScroll) {
    return { scrollTop: maxScroll, stickingToBottom: true };
  }
  return { scrollTop: newScrollTop };
}

export type WheelDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Accumulating scroll-intent controller. Feed raw mouse events, then drain
 * the coalesced intent once per frame (parity with the
 * `useFrameCoalescedFlush` pipeline in `ScrollableList`).
 */
export class ScrollIntentController {
  private draggingScrollbar = false;
  private pendingWheelDelta = 0;
  private pendingDragRow: number | null = null;

  /** True while a scrollbar drag is in progress. */
  get isDraggingScrollbar(): boolean {
    return this.draggingScrollbar;
  }

  /**
   * A left press. If it lands on the scrollbar track, begin a drag and apply
   * the absolute target immediately (discarding any queued wheel intent).
   * Returns the immediate intent for a scrollbar press, else null.
   */
  handlePress(
    geometry: ScrollbarGeometry | null,
    location: { col: number; row: number },
    maxScroll: number,
  ): ScrollIntent | null {
    if (!hitTestScrollbar(geometry, location)) return null;
    this.cancelPending();
    this.draggingScrollbar = true;
    return scrollbarRowToScrollTop(geometry, location.row, maxScroll);
  }

  /** A left release ends any in-progress scrollbar drag. */
  handleRelease(): void {
    this.draggingScrollbar = false;
  }

  /** Pointer motion: an absolute drag row is recorded only while dragging. */
  handleMove(row: number): void {
    if (this.draggingScrollbar) {
      this.pendingDragRow = row;
    }
  }

  /** A wheel tick accumulates a relative delta. */
  handleWheel(direction: WheelDirection): void {
    if (direction === 'up') this.pendingWheelDelta -= WHEEL_LINES_PER_TICK;
    else if (direction === 'down')
      this.pendingWheelDelta += WHEEL_LINES_PER_TICK;
  }

  /**
   * Drain the coalesced intent for the current frame. An absolute drag row
   * wins over any queued wheel delta; both reset afterwards. Returns null
   * when there is nothing to apply.
   */
  flush(
    geometry: ScrollbarGeometry | null,
    maxScroll: number,
  ): ScrollIntent | null {
    const dragRow = this.pendingDragRow;
    const wheelDelta = this.pendingWheelDelta;
    this.pendingDragRow = null;
    this.pendingWheelDelta = 0;
    if (dragRow !== null) {
      return scrollbarRowToScrollTop(geometry, dragRow, maxScroll);
    }
    if (wheelDelta !== 0) return { scrollBy: wheelDelta };
    return null;
  }

  /** Discard any queued wheel/drag intent (parity with `cancelPendingScroll`). */
  cancelPending(): void {
    this.pendingWheelDelta = 0;
    this.pendingDragRow = null;
  }
}
