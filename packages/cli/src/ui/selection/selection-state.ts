/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScreenSelection } from 'ink';

/** A point in composited-frame coordinates: column `x`, grid row `y`. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Selection granularity. `char` follows the pointer; `word` and `line` snap the
 * range to word/line boundaries (double/triple click, added in M4).
 */
export type SelectionMode = 'char' | 'word' | 'line';

/** Reading-order selection range, inclusive on both ends. */
export type NormalizedSelection = ScreenSelection;

/**
 * The anchor/focus selection model in visible-frame coordinates. The state is
 * pure: coordinate mapping (terminal → frame) and clearing on scroll live in the
 * hook that drives it. In VP mode (B1) the selection is visible-region only and
 * is cleared on scroll, so frame coordinates are sufficient.
 */
export class SelectionState {
  anchor: Point | null = null;
  focus: Point | null = null;
  dragging = false;
  mode: SelectionMode = 'char';

  start(point: Point, mode: SelectionMode = 'char'): void {
    this.anchor = point;
    this.focus = point;
    this.dragging = true;
    this.mode = mode;
  }

  extend(point: Point): void {
    if (this.anchor) {
      this.focus = point;
    }
  }

  /** Select a resolved word/line span from a multi-click (not a drag). */
  selectSpan(
    span: { sx: number; sy: number; ex: number; ey: number },
    mode: SelectionMode,
  ): void {
    this.anchor = { x: span.sx, y: span.sy };
    this.focus = { x: span.ex, y: span.ey };
    this.dragging = false;
    this.mode = mode;
  }

  finish(): void {
    this.dragging = false;
  }

  clear(): void {
    this.anchor = null;
    this.focus = null;
    this.dragging = false;
    this.mode = 'char';
  }

  get isEmpty(): boolean {
    return this.anchor === null || this.focus === null;
  }

  /** True when the selection is a single point (a click with no drag). */
  get isCollapsed(): boolean {
    return (
      !this.isEmpty &&
      this.anchor!.x === this.focus!.x &&
      this.anchor!.y === this.focus!.y
    );
  }

  /** Anchor/focus ordered into reading order, or null when empty. */
  normalized(): NormalizedSelection | null {
    if (!this.anchor || !this.focus) {
      return null;
    }
    const { anchor, focus } = this;
    const anchorFirst =
      anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
    const start = anchorFirst ? anchor : focus;
    const end = anchorFirst ? focus : anchor;
    return { sx: start.x, sy: start.y, ex: end.x, ey: end.y };
  }
}
