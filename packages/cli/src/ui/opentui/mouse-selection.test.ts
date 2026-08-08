/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  MULTI_CLICK_MS,
  MouseSelectionController,
  MouseSelectionState,
  MultiClickTracker,
  lineSpanAt,
  selectionText,
  snapWidePoint,
  wordSpanAt,
  type MouseGrid,
  type MouseGridCell,
  type NormalizedSpan,
} from './mouse-selection.js';

const textRow = (text: string): MouseGridCell[] =>
  Array.from(text).map((value) => ({ value }));

const wideRow = (...parts: Array<string | [string]>): MouseGridCell[] => {
  const cells: MouseGridCell[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      cells.push({ value: part[0], fullWidth: true }, { value: '' });
    } else {
      for (const ch of part) cells.push({ value: ch });
    }
  }
  return cells;
};

describe('snapWidePoint: wide-character hit correction', () => {
  const row = wideRow(['你'], ['好']);

  it('snaps a spacer click back onto the base glyph', () => {
    expect(snapWidePoint(row, { x: 1, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(snapWidePoint(row, { x: 3, y: 0 })).toEqual({ x: 2, y: 0 });
  });

  it('leaves base cells and column 0 untouched', () => {
    expect(snapWidePoint(row, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(snapWidePoint(row, { x: 2, y: 0 })).toEqual({ x: 2, y: 0 });
  });

  it('does not snap a spacer without a wide predecessor', () => {
    const narrow = textRow('ab');
    expect(snapWidePoint(narrow, { x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
    expect(snapWidePoint(undefined, { x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
  });
});

describe('wordSpanAt / lineSpanAt: span semantics (selection-span parity)', () => {
  const grid: MouseGrid = [textRow('foo bar')];

  it('selects the maximal non-whitespace run around the click', () => {
    expect(wordSpanAt(grid, 1, 0)).toEqual({ sx: 0, sy: 0, ex: 2, ey: 0 });
    expect(wordSpanAt(grid, 0, 0)).toEqual({ sx: 0, sy: 0, ex: 2, ey: 0 });
    expect(wordSpanAt(grid, 4, 0)).toEqual({ sx: 4, sy: 0, ex: 6, ey: 0 });
  });

  it('returns null when the click is on whitespace', () => {
    expect(wordSpanAt(grid, 3, 0)).toBeNull();
  });

  it('includes wide-character spacer cells in the word run', () => {
    const wide: MouseGrid = [wideRow(['你'], ['好'], ' x')];
    expect(wordSpanAt(wide, 0, 0)).toEqual({ sx: 0, sy: 0, ex: 3, ey: 0 });
    expect(selectionText(wide, { sx: 0, sy: 0, ex: 3, ey: 0 })).toBe('你好');
  });

  it('line span runs from column 0 to the last non-space cell', () => {
    const padded: MouseGrid = [textRow('  foo  ')];
    expect(lineSpanAt(padded, 0)).toEqual({ sx: 0, sy: 0, ex: 4, ey: 0 });
    expect(selectionText(padded, lineSpanAt(padded, 0)!)).toBe('  foo');
  });

  it('blank or missing rows have no span', () => {
    expect(lineSpanAt([textRow('   ')], 0)).toBeNull();
    expect(lineSpanAt(grid, 9)).toBeNull();
    expect(wordSpanAt(null, 0, 0)).toBeNull();
  });
});

describe('selectionText: copy semantics (selection-text parity)', () => {
  it('extracts a single-line span', () => {
    const grid: MouseGrid = [textRow('foo bar')];
    expect(selectionText(grid, { sx: 4, sy: 0, ex: 6, ey: 0 })).toBe('bar');
  });

  it('joins lines with newlines and handles missing rows', () => {
    const grid: MouseGrid = [textRow('ab'), [], textRow('cd')];
    const span: NormalizedSpan = { sx: 0, sy: 0, ex: 1, ey: 2 };
    expect(selectionText(grid, span)).toBe('ab\n\ncd');
  });

  it('skips non-selectable cells and emits wide glyphs once', () => {
    const row: MouseGridCell[] = [
      { value: 'a', selectable: false },
      { value: 'b' },
      { value: '你', fullWidth: true },
      { value: '' },
      { value: 'c', selectable: false },
    ];
    expect(selectionText([row], { sx: 0, sy: 0, ex: 4, ey: 0 })).toBe('b你');
  });

  it('null grid yields empty text', () => {
    expect(selectionText(null, { sx: 0, sy: 0, ex: 1, ey: 0 })).toBe('');
  });
});

describe('MultiClickTracker: double/triple detection', () => {
  it('counts up to 3 within the window on the same spot', () => {
    const t = new MultiClickTracker();
    expect(t.recordClick(5, 0, 1000)).toBe(1);
    expect(t.recordClick(5, 0, 1000 + MULTI_CLICK_MS - 1)).toBe(2);
    // Window is relative to the previous click, so keep each gap < window.
    expect(t.recordClick(5, 0, 1000 + 2 * (MULTI_CLICK_MS - 1))).toBe(3);
    expect(t.recordClick(5, 0, 1000 + 3 * (MULTI_CLICK_MS - 1))).toBe(3);
  });

  it('restarts after the window expires or the row changes', () => {
    const t = new MultiClickTracker();
    t.recordClick(5, 0, 0);
    expect(t.recordClick(5, 0, MULTI_CLICK_MS)).toBe(1); // gap == window
    t.recordClick(5, 0, 2 * MULTI_CLICK_MS);
    expect(t.recordClick(5, 1, 2 * MULTI_CLICK_MS)).toBe(1);
  });

  it('tolerates a one-column drift but not more', () => {
    const t = new MultiClickTracker();
    t.recordClick(5, 0, 0);
    expect(t.recordClick(6, 0, 10)).toBe(2);
    expect(t.recordClick(8, 0, 20)).toBe(1);
  });

  it('reset() abandons multi-click detection', () => {
    const t = new MultiClickTracker();
    t.recordClick(5, 0, 0);
    t.reset();
    expect(t.recordClick(5, 0, 10)).toBe(1);
  });
});

describe('MouseSelectionState: anchor/focus model', () => {
  it('normalizes forward and backward drags into reading order', () => {
    const s = new MouseSelectionState();
    s.start({ x: 0, y: 0 });
    s.extend({ x: 3, y: 1 });
    expect(s.normalized()).toEqual({ sx: 0, sy: 0, ex: 3, ey: 1 });

    const b = new MouseSelectionState();
    b.start({ x: 3, y: 1 });
    b.extend({ x: 1, y: 0 });
    expect(b.normalized()).toEqual({ sx: 1, sy: 0, ex: 3, ey: 1 });
  });

  it('tracks collapsed / empty / cleared states', () => {
    const s = new MouseSelectionState();
    expect(s.isEmpty).toBe(true);
    expect(s.normalized()).toBeNull();
    s.start({ x: 2, y: 2 });
    expect(s.isCollapsed).toBe(true);
    expect(s.dragging).toBe(true);
    s.extend({ x: 4, y: 2 });
    expect(s.isCollapsed).toBe(false);
    s.clear();
    expect(s.isEmpty).toBe(true);
    expect(s.mode).toBe('char');
  });

  it('selectSpan applies a resolved span without dragging', () => {
    const s = new MouseSelectionState();
    s.selectSpan({ sx: 0, sy: 1, ex: 5, ey: 1 }, 'word');
    expect(s.dragging).toBe(false);
    expect(s.mode).toBe('word');
    expect(s.normalized()).toEqual({ sx: 0, sy: 1, ex: 5, ey: 1 });
  });
});

interface Harness {
  controller: MouseSelectionController;
  highlights: Array<NormalizedSpan | null>;
  copies: string[];
  setScrollTop: (value: number) => void;
  setTime: (value: number) => void;
  grid: MouseGrid;
}

function setup(overrides?: {
  grid?: MouseGrid;
  viewport?: { x: number; y: number; width: number; height: number };
  hitTestScrollbar?: (location: { col: number; row: number }) => boolean;
}): Harness {
  let scrollTop = 0;
  let time = 1000;
  const highlights: Array<NormalizedSpan | null> = [];
  const copies: string[] = [];
  const grid = overrides?.grid ?? [textRow('foo bar')];
  const viewport = overrides?.viewport ?? { x: 0, y: 0, width: 20, height: 5 };
  const controller = new MouseSelectionController({
    toGridPoint: (col, row) => ({ x: col - 1, y: row - 1 }),
    getViewportRect: () => viewport,
    getGrid: () => grid,
    getScrollTop: () => scrollTop,
    hitTestScrollbar: overrides?.hitTestScrollbar,
    onHighlight: (span) => highlights.push(span),
    onCopy: (text) => copies.push(text),
    now: () => time,
  });
  return {
    controller,
    highlights,
    copies,
    setScrollTop: (value) => {
      scrollTop = value;
    },
    setTime: (value) => {
      time = value;
    },
    grid,
  };
}

const press = (col: number, row: number) => ({
  name: 'left-press' as const,
  col,
  row,
});
const move = (col: number, row: number) => ({
  name: 'move' as const,
  col,
  row,
});
const release = (col: number, row: number) => ({
  name: 'left-release' as const,
  col,
  row,
});

describe('MouseSelectionController: gestures', () => {
  it('drag-selects and copies on release', () => {
    const h = setup();
    h.controller.handleMouse(press(1, 1));
    h.controller.handleMouse(move(3, 1));
    expect(h.controller.state.normalized()).toEqual({
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 0,
    });
    h.controller.handleMouse(release(3, 1));
    expect(h.copies).toEqual(['foo']);
    expect(h.controller.state.dragging).toBe(false);
  });

  it('a bare click (collapsed) clears without copying', () => {
    const h = setup();
    h.controller.handleMouse(press(2, 1));
    h.controller.handleMouse(release(2, 1));
    expect(h.copies).toEqual([]);
    expect(h.controller.state.isEmpty).toBe(true);
    expect(h.highlights.at(-1)).toBeNull();
  });

  it('double click selects and copies the word', () => {
    const h = setup();
    h.controller.handleMouse(press(2, 1));
    h.setTime(1100);
    h.controller.handleMouse(press(2, 1));
    expect(h.controller.state.mode).toBe('word');
    expect(h.controller.state.normalized()).toEqual({
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 0,
    });
    expect(h.copies).toEqual(['foo']);
    // The release after a word select is not a drag and leaves it intact.
    h.controller.handleMouse(release(2, 1));
    expect(h.controller.state.isEmpty).toBe(false);
  });

  it('triple click selects and copies the whole line', () => {
    const h = setup();
    h.controller.handleMouse(press(2, 1));
    h.setTime(1100);
    h.controller.handleMouse(press(2, 1));
    h.setTime(1200);
    h.controller.handleMouse(press(2, 1));
    expect(h.controller.state.mode).toBe('line');
    expect(h.copies).toEqual(['foo', 'foo bar']);
  });

  it('a slow second click starts a new drag instead of a word', () => {
    const h = setup();
    h.controller.handleMouse(press(2, 1));
    h.setTime(1000 + MULTI_CLICK_MS + 1);
    h.controller.handleMouse(press(2, 1));
    expect(h.controller.state.mode).toBe('char');
    expect(h.controller.state.dragging).toBe(true);
  });

  it('clamps drag extension to the viewport', () => {
    const h = setup({ viewport: { x: 0, y: 0, width: 3, height: 2 } });
    h.controller.handleMouse(press(1, 1));
    h.controller.handleMouse(move(30, 30));
    expect(h.controller.state.normalized()).toEqual({
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 1,
    });
  });

  it('presses outside the viewport clear and do not start', () => {
    const h = setup({ viewport: { x: 0, y: 0, width: 3, height: 1 } });
    h.controller.handleMouse(press(10, 1));
    expect(h.controller.state.isEmpty).toBe(true);
  });

  it('any scroll clears the selection', () => {
    const h = setup();
    h.controller.handleMouse(press(1, 1));
    h.controller.handleMouse(move(3, 1));
    h.controller.handleMouse({ name: 'scroll-down', col: 1, row: 1 });
    expect(h.controller.state.isEmpty).toBe(true);
    expect(h.highlights.at(-1)).toBeNull();
  });

  it('a scroll under an active drag clears it', () => {
    const h = setup();
    h.controller.handleMouse(press(1, 1));
    h.setScrollTop(42);
    h.controller.handleMouse(move(3, 1));
    expect(h.controller.state.isEmpty).toBe(true);
  });

  it('a scrollbar press clears the selection and starts no drag', () => {
    const h = setup({ hitTestScrollbar: () => true });
    h.controller.handleMouse(press(2, 1));
    expect(h.controller.state.isEmpty).toBe(true);
  });

  it('snaps the press off a wide-character spacer before selecting', () => {
    const h = setup({ grid: [wideRow(['你'], ['好'])] });
    // Click the right (spacer) cell of 你 — hits column index 1.
    h.controller.handleMouse(press(2, 1));
    expect(h.controller.state.anchor).toEqual({ x: 0, y: 0 });
    h.controller.handleMouse(move(3, 1));
    h.controller.handleMouse(release(3, 1));
    // The spacer contributes nothing: the copy is the glyph once.
    expect(h.copies).toEqual(['你好']);
  });

  it('invalidate() drops a visible-region selection (B1 rule)', () => {
    const h = setup();
    h.controller.handleMouse(press(1, 1));
    h.controller.handleMouse(move(3, 1));
    h.controller.invalidate();
    expect(h.controller.state.isEmpty).toBe(true);
    expect(h.highlights.at(-1)).toBeNull();
  });

  it('move events outside a drag are ignored', () => {
    const h = setup();
    h.controller.handleMouse(move(3, 1));
    expect(h.highlights).toEqual([]);
    expect(h.controller.state.isEmpty).toBe(true);
  });
});
