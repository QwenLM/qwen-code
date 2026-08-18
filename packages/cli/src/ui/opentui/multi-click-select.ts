/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Double/triple-click word/line selection for the OpenTUI renderer (ink
 * parity; audit gap: multi-click gestures).
 *
 * The framework's selection state machine only knows char-level drags —
 * `processSingleMouseEvent` starts a point selection on `down` and has no
 * multi-click concept. This controller rides on top of it instead of
 * replacing it: when a `down` lands on selectable text the framework has
 * already created a dragging selection anchored at that press, and the event
 * bubbles up to a container's `onMouseDown`. There we detect double/triple
 * clicks (reusing the ported tracker from `mouse-selection.ts`), resolve the
 * word/line span from the rendered buffer, and rewrite the framework's point
 * selection to the span by simulating a drag across it. Highlighting, text
 * extraction, and the copy-on-release pipeline are all handled by the
 * framework (`emit("selection")` → `useSelectionHandler` → `copyText`).
 *
 * Leaving the selection in its dragging state (no manual finish) keeps the
 * gesture composable: release finishes it through the framework's `up` path,
 * and dragging after a double-click extends the selection from the word end.
 */

import { MouseButton } from '@opentui/core';
import type { CellGrid } from './link-click.js';
import {
  lineSpanAt,
  wordSpanAt,
  MultiClickTracker,
  type MouseGridRow,
} from './mouse-selection.js';

/**
 * Minimal structural view of the framework selection APIs this controller
 * touches (the real `CliRenderer` satisfies it; tests inject a stub).
 */
export interface SelectionHost {
  getSelection(): { isDragging: boolean } | null;
  updateSelection(
    currentRenderable: undefined,
    x: number,
    y: number,
    options?: { finishDragging?: boolean },
  ): void;
}

/** Minimal structural view of a core mouse event. */
export interface MultiClickPointer {
  x: number;
  y: number;
  button: number;
  modifiers: { ctrl: boolean };
}

/**
 * One rendered buffer row as a `MouseGridRow`: code point 0 cells are
 * wide-character spacers (or untouched background) and read back as spacer
 * cells, matching the grid model `wordSpanAt`/`lineSpanAt` expect.
 */
export function bufferRowToMouseGridRow(
  grid: CellGrid,
  y: number,
): MouseGridRow | null {
  if (y < 0 || y >= grid.height) return null;
  const chars = grid.buffers.char;
  const base = y * grid.width;
  const row: Array<{ value: string }> = [];
  for (let x = 0; x < grid.width; x++) {
    const codePoint = chars[base + x];
    row.push({ value: codePoint ? String.fromCodePoint(codePoint) : '' });
  }
  return row;
}

/**
 * Snap a press off a wide-character spacer cell onto its base cell. A spacer
 * is the only empty cell whose left neighbor is non-empty; untouched
 * background cells come in runs, so they never snap.
 */
function snapOffSpacer(row: MouseGridRow, x: number): number {
  if (x > 0 && row[x]?.value === '' && row[x - 1]?.value !== '') {
    return x - 1;
  }
  return x;
}

export class MultiClickSelectionController {
  private readonly tracker = new MultiClickTracker();

  constructor(
    private readonly getGrid: () => CellGrid | null,
    private readonly host: SelectionHost,
  ) {}

  /**
   * Container `onMouseDown` handler. Rewrites the framework's just-started
   * point selection to the word/line span on the 2nd/3rd click. `now` is
   * injectable for tests.
   */
  handleMouseDown(e: MultiClickPointer, now: number = Date.now()): void {
    // ctrl+down is the framework's extend-selection gesture; other buttons
    // never start text selection.
    if (e.button !== MouseButton.LEFT || e.modifiers.ctrl) return;
    const count = this.tracker.recordClick(e.x, e.y, now);
    if (count < 2) return;
    // Only rewrite a selection this very press started: `isDragging` is set
    // by the framework's down path before the event bubbles here. A stale
    // non-dragging selection (click on non-selectable chrome) is left alone.
    const selection = this.host.getSelection();
    if (!selection?.isDragging) return;
    const grid = this.getGrid();
    if (!grid) return;
    const row = bufferRowToMouseGridRow(grid, e.y);
    if (!row) return;
    const x = snapOffSpacer(row, e.x);
    const span = count === 2 ? wordSpanAt([row], x, 0) : lineSpanAt([row], 0);
    if (!span) return;
    // Simulate a drag across the span (anchor is this press's position, so
    // the final bounds cover the span exactly). The framework's up/drag
    // paths finish or extend the selection.
    this.host.updateSelection(undefined, span.sx, e.y);
    this.host.updateSelection(undefined, span.ex, e.y);
  }
}
