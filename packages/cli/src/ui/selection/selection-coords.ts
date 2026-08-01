/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { frameAnchor } from '../utils/list-mouse.js';
import type { Point } from './selection-state.js';

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Maps a 1-based terminal cell (col, row) to composited-frame grid coordinates.
 *
 * The frame from the renderer is the whole root frame; its rows are indexed
 * from the frame top. In the alternate screen the frame is top-anchored when it
 * fits and bottom-pinned when it overflows, so the terminal row maps to a frame
 * row via the frame anchor (`min(0, terminalHeight - frameHeight)`), which is
 * negative on overflow. This is the same correction `layoutRowForEvent` applies.
 */
export function terminalToGrid(
  col: number,
  row: number,
  terminalHeight: number,
  frameHeight: number,
): Point {
  const anchor = frameAnchor(terminalHeight, frameHeight);
  return { x: col - 1, y: row - 1 - anchor };
}

/** Whether a grid point falls inside the history viewport region. */
export function pointInViewport(point: Point, rect: ViewportRect): boolean {
  return (
    point.y >= rect.y &&
    point.y < rect.y + rect.height &&
    point.x >= rect.x &&
    point.x < rect.x + rect.width
  );
}

/** Clamps a grid point to the viewport interior, for drag extension. */
export function clampToViewport(point: Point, rect: ViewportRect): Point {
  return {
    x: Math.max(rect.x, Math.min(rect.x + rect.width - 1, point.x)),
    y: Math.max(rect.y, Math.min(rect.y + rect.height - 1, point.y)),
  };
}
