/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drag-select / multi-click selection parity for the OpenTUI renderer
 * (PR1 slice 4).
 *
 * Framework-neutral port of the ink TUI's selection stack:
 *  - `selection-state.ts` — anchor/focus selection model (`char` drag,
 *    `word` / `line` multi-click snaps);
 *  - `selection-span.ts` — double/triple-click word/line spans with
 *    wide-character spacer handling;
 *  - `selection-text.ts` — copy-text extraction (wide glyphs appear once,
 *    non-selectable cells are skipped);
 *  - `use-text-selection.tsx` — the gesture controller: 400 ms multi-click
 *    detection, drag clamp to the viewport, copy on release, and the
 *    visible-region-only invalidation rules.
 *
 * The grid model replaces ink's composited frame: a row of cells where a
 * wide glyph occupies two cells — the base cell (`fullWidth`, carrying the
 * character) and a trailing spacer cell (`value === ''`).
 */

import {
  clampToViewport,
  pointInViewport,
  type MousePoint,
  type MouseRect,
} from './mouse-hit.js';

/** One rendered terminal cell. */
export interface MouseGridCell {
  /** The cell's character; `''` marks a wide-character spacer cell. */
  value: string;
  /** True on the base cell of a 2-column glyph. */
  fullWidth?: boolean;
  /** Non-selectable layout cells are skipped by copy extraction. */
  selectable?: boolean;
}

export type MouseGridRow = readonly MouseGridCell[];
export type MouseGrid = readonly MouseGridRow[];

/** Selection granularity: drag (`char`), double (`word`) or triple (`line`). */
export type MouseSelectionMode = 'char' | 'word' | 'line';

/** Reading-order selection range, inclusive on both ends. */
export interface NormalizedSpan {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

/**
 * Snap a clicked cell off a wide-character spacer: when the cell is a spacer
 * (`value === ''`) preceded by a `fullWidth` base cell, the hit belongs to
 * that glyph. Parity with the snap in `use-text-selection.tsx#mapEvent`.
 */
export function snapWidePoint(
  row: MouseGridRow | undefined,
  point: MousePoint,
): MousePoint {
  if (
    point.x > 0 &&
    row?.[point.x]?.value === '' &&
    row[point.x - 1]?.fullWidth
  ) {
    return { ...point, x: point.x - 1 };
  }
  return point;
}

/** A cell counts as part of a word when it is non-empty and not whitespace. */
function isWordCell(value: string): boolean {
  return value !== '' && value !== ' ' && !/^\s$/u.test(value);
}

/** Trailing column of the last non-space cell on a row, or -1 if blank. */
function lastContentColumn(row: MouseGridRow): number {
  for (let x = row.length - 1; x >= 0; x--) {
    if (row[x].value !== '' && row[x].value !== ' ') {
      return x;
    }
  }
  return -1;
}

/**
 * Word span (maximal run of non-whitespace cells) around a click, or null
 * when the click is on whitespace. Wide-character spacer cells belong to the
 * preceding glyph's run. Parity with `selection-span.ts#wordSpanAt`.
 */
export function wordSpanAt(
  grid: MouseGrid | null,
  x: number,
  y: number,
): NormalizedSpan | null {
  const row = grid?.[y];
  if (!row) return null;
  const cell = row[x];
  if (!cell || !isWordCell(cell.value)) return null;
  let sx = x;
  while (
    sx > 0 &&
    (row[sx - 1].value === '' || isWordCell(row[sx - 1].value))
  ) {
    sx--;
  }
  let ex = x;
  while (
    ex < row.length - 1 &&
    (row[ex + 1].value === '' || isWordCell(row[ex + 1].value))
  ) {
    ex++;
  }
  return { sx, sy: y, ex, ey: y };
}

/**
 * Whole visual line span (first column to last non-space), or null if blank.
 * Parity with `selection-span.ts#lineSpanAt`.
 */
export function lineSpanAt(
  grid: MouseGrid | null,
  y: number,
): NormalizedSpan | null {
  const row = grid?.[y];
  if (!row) return null;
  const end = lastContentColumn(row);
  if (end < 0) return null;
  return { sx: 0, sy: y, ex: end, ey: y };
}

/**
 * Extract the selected text from the grid. Wide-character spacer cells carry
 * an empty value and contribute nothing (a wide glyph appears once);
 * non-selectable cells are skipped; visual lines join with `\n`. Parity with
 * `selection-text.ts#getSelectedText` (the original's soft-wrap boundary
 * resolution needs ink flow metadata; the grid model joins with newlines).
 */
export function selectionText(
  grid: MouseGrid | null,
  selection: NormalizedSpan,
): string {
  if (!grid) return '';
  const { sx, sy, ex, ey } = selection;
  let text = '';
  for (let y = sy; y <= ey; y++) {
    const row = grid[y];
    if (!row) {
      if (y < ey) text += '\n';
      continue;
    }
    const startX = y === sy ? sx : 0;
    const endX = y === ey ? ex : row.length - 1;
    for (let x = Math.max(0, startX); x <= endX && x < row.length; x++) {
      const cell = row[x];
      if (cell.selectable === false) continue;
      text += cell.value;
    }
    if (y < ey) text += '\n';
  }
  return text;
}

/** Max gap between clicks (ms) to count as a double/triple click. */
export const MULTI_CLICK_MS = 400;

interface ClickRecord {
  x: number;
  y: number;
  time: number;
  count: number;
}

/**
 * Double/triple click detection. A click counts as a continuation of the
 * previous one when it lands on the same row, within one column, inside the
 * 400 ms window; the count caps at 3 (double = word, triple = line). Parity
 * with the detection in `use-text-selection.tsx`.
 */
export class MultiClickTracker {
  private lastClick: ClickRecord | null = null;

  /** Record a press; returns the resulting click count (1..3). */
  recordClick(x: number, y: number, now: number): number {
    const prev = this.lastClick;
    const near =
      prev != null &&
      prev.y === y &&
      Math.abs(prev.x - x) <= 1 &&
      now - prev.time < MULTI_CLICK_MS;
    const count = near ? Math.min(prev!.count + 1, 3) : 1;
    this.lastClick = { x, y, time: now, count };
    return count;
  }

  /** A drag abandons multi-click detection (parity: move clears the record). */
  reset(): void {
    this.lastClick = null;
  }
}

/**
 * The anchor/focus selection model. Port of `selection-state.ts` —
 * coordinates are grid points; start/extend drive a drag, selectSpan applies
 * a resolved word/line span, normalized() orders anchor/focus for reading.
 */
export class MouseSelectionState {
  anchor: MousePoint | null = null;
  focus: MousePoint | null = null;
  dragging = false;
  mode: MouseSelectionMode = 'char';

  start(point: MousePoint, mode: MouseSelectionMode = 'char'): void {
    this.anchor = point;
    this.focus = point;
    this.dragging = true;
    this.mode = mode;
  }

  extend(point: MousePoint): void {
    if (this.anchor) {
      this.focus = point;
    }
  }

  /** Select a resolved word/line span from a multi-click (not a drag). */
  selectSpan(span: NormalizedSpan, mode: MouseSelectionMode): void {
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
  normalized(): NormalizedSpan | null {
    if (!this.anchor || !this.focus) return null;
    const { anchor, focus } = this;
    const anchorFirst =
      anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
    const start = anchorFirst ? anchor : focus;
    const end = anchorFirst ? focus : anchor;
    return { sx: start.x, sy: start.y, ex: end.x, ey: end.y };
  }
}

/** The event names the gesture controller understands. */
export type MouseGestureName =
  | 'left-press'
  | 'left-release'
  | 'move'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right';

export interface MouseGestureEvent {
  name: MouseGestureName;
  col: number;
  row: number;
}

export interface SelectionControllerProps {
  /** Maps a 1-based terminal event onto grid coordinates (anchor-corrected). */
  toGridPoint: (col: number, row: number) => MousePoint;
  /** Reads the history viewport region (grid coordinates). */
  getViewportRect: () => MouseRect | null;
  /** Reads the composited grid at event time. */
  getGrid: () => MouseGrid | null;
  /** Current scroll offset; a scroll under an active drag clears it. */
  getScrollTop: () => number;
  /** True when the press landed on the scrollbar track. */
  hitTestScrollbar?: (location: { col: number; row: number }) => boolean;
  /** Highlight the current range (null clears the highlight). */
  onHighlight: (span: NormalizedSpan | null) => void;
  /** Deliver copy-ready text after a completed gesture. */
  onCopy: (text: string) => void;
  /** Injectable clock for multi-click detection. */
  now?: () => number;
}

/**
 * Headless controller that turns press/drag/release in the history viewport
 * into a text selection: double/triple click snap to a word/line and copy;
 * a drag clamps to the viewport and copies on release; any scroll (or a
 * scroll under the drag) clears it. Visible-region only, cleared on
 * scroll/resize/streaming change via `invalidate()`. Parity with the gesture
 * flow in `use-text-selection.tsx#handleMouse`.
 */
export class MouseSelectionController {
  readonly state = new MouseSelectionState();
  private readonly tracker = new MultiClickTracker();
  private dragScrollTop: number | null = null;

  constructor(private readonly props: SelectionControllerProps) {}

  private now(): number {
    return this.props.now ? this.props.now() : Date.now();
  }

  handleMouse(event: MouseGestureEvent): void {
    const { state, props } = this;

    if (event.name.startsWith('scroll-')) {
      this.clearSelection();
      return;
    }

    if (event.name === 'left-press') {
      if (props.hitTestScrollbar?.({ col: event.col, row: event.row })) {
        this.clearSelection();
        return;
      }
      const rect = props.getViewportRect();
      const grid = props.getGrid();
      if (!rect || !grid) {
        this.clearSelection();
        return;
      }
      const gridPoint = props.toGridPoint(event.col, event.row);
      const point = snapWidePoint(grid[gridPoint.y], gridPoint);
      if (!pointInViewport(point, rect)) {
        this.clearSelection();
        return;
      }

      const count = this.tracker.recordClick(point.x, point.y, this.now());
      if (count >= 2) {
        const span =
          count === 2
            ? wordSpanAt(grid, point.x, point.y)
            : lineSpanAt(grid, point.y);
        if (span) {
          state.selectSpan(span, count === 2 ? 'word' : 'line');
          this.applyHighlight();
          this.copySelection();
          return;
        }
      }

      state.start(point);
      this.dragScrollTop = props.getScrollTop();
      this.applyHighlight();
      return;
    }

    if (event.name === 'move') {
      if (!state.dragging) return;
      this.tracker.reset();
      const rect = props.getViewportRect();
      const grid = props.getGrid();
      if (!rect || !grid) return;
      if (props.getScrollTop() !== this.dragScrollTop) {
        this.clearSelection();
        return;
      }
      const gridPoint = props.toGridPoint(event.col, event.row);
      const point = snapWidePoint(grid[gridPoint.y], gridPoint);
      state.extend(clampToViewport(point, rect));
      this.applyHighlight();
      return;
    }

    if (event.name === 'left-release') {
      // Word/line click-selects are not drags; leave them intact.
      if (!state.dragging) return;
      const rect = props.getViewportRect();
      const grid = props.getGrid();
      if (rect && grid) {
        const gridPoint = props.toGridPoint(event.col, event.row);
        const point = snapWidePoint(grid[gridPoint.y], gridPoint);
        state.extend(clampToViewport(point, rect));
      }
      state.finish();
      if (state.isCollapsed || state.isEmpty) {
        this.clearSelection();
        return;
      }
      this.applyHighlight();
      this.copySelection();
    }
  }

  /**
   * Any scroll, resize, or streaming content change moves the frame under a
   * fixed selection — visible-region-only scope drops it (B1 rules).
   */
  invalidate(): void {
    this.clearSelection();
  }

  clearSelection(): void {
    if (this.state.isEmpty) return;
    this.state.clear();
    this.props.onHighlight(null);
  }

  private applyHighlight(): void {
    const { state } = this;
    const normalized = state.normalized();
    // A word/line span of a single cell still highlights, but a bare
    // char-mode click (collapsed) does not.
    const shouldHighlight =
      normalized !== null && (!state.isCollapsed || state.mode !== 'char');
    this.props.onHighlight(shouldHighlight ? normalized : null);
  }

  private copySelection(): void {
    const normalized = this.state.normalized();
    const text = normalized
      ? selectionText(this.props.getGrid(), normalized)
      : '';
    if (text) this.props.onCopy(text);
  }
}
