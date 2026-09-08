/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  WHEEL_LINES_PER_TICK,
  ScrollIntentController,
  scrollbarRowToScrollTop,
} from './mouse-scrollbar.js';
import type { ScrollbarGeometry } from './mouse-hit.js';

const geometry: ScrollbarGeometry = { col: 79, top: 0, height: 11 };

describe('scrollbarRowToScrollTop: drag mapping (VirtualizedList parity)', () => {
  it('maps track rows proportionally onto the scroll range', () => {
    expect(scrollbarRowToScrollTop(geometry, 1, 100)).toEqual({ scrollTop: 0 });
    expect(scrollbarRowToScrollTop(geometry, 6, 100)).toEqual({
      scrollTop: 50,
    });
    expect(scrollbarRowToScrollTop(geometry, 2, 100)).toEqual({
      scrollTop: 10,
    });
  });

  it('clamps presses above/below the track into it', () => {
    expect(scrollbarRowToScrollTop(geometry, 0, 100)).toEqual({ scrollTop: 0 });
    expect(scrollbarRowToScrollTop(geometry, 99, 100)).toEqual({
      scrollTop: 100,
      stickingToBottom: true,
    });
  });

  it('engages the sticky-bottom anchor at the end of the track', () => {
    expect(scrollbarRowToScrollTop(geometry, 11, 100)).toEqual({
      scrollTop: 100,
      stickingToBottom: true,
    });
    expect(scrollbarRowToScrollTop(geometry, 10, 100)).toEqual({
      scrollTop: 90,
    });
  });

  it('yields no intent when content fits or there is no track', () => {
    expect(scrollbarRowToScrollTop(geometry, 5, 0)).toBeNull();
    expect(scrollbarRowToScrollTop(null, 5, 100)).toBeNull();
  });

  it('handles a single-row track without dividing by zero', () => {
    const tiny: ScrollbarGeometry = { col: 0, top: 0, height: 1 };
    expect(scrollbarRowToScrollTop(tiny, 1, 40)).toEqual({ scrollTop: 0 });
  });
});

describe('ScrollIntentController: the coalesced pipeline (ScrollableList parity)', () => {
  it('accumulates wheel ticks as a relative delta', () => {
    const c = new ScrollIntentController();
    c.handleWheel('down');
    c.handleWheel('down');
    expect(c.flush(geometry, 100)).toEqual({
      scrollBy: 2 * WHEEL_LINES_PER_TICK,
    });
    c.handleWheel('up');
    c.handleWheel('down');
    expect(c.flush(geometry, 100)).toBeNull(); // -3 + 3 = 0
  });

  it('ignores horizontal wheel ticks like the original', () => {
    const c = new ScrollIntentController();
    c.handleWheel('left');
    c.handleWheel('right');
    expect(c.flush(geometry, 100)).toBeNull();
  });

  it('flush resets pending intent', () => {
    const c = new ScrollIntentController();
    c.handleWheel('down');
    c.flush(geometry, 100);
    expect(c.flush(geometry, 100)).toBeNull();
  });

  it('a scrollbar press applies immediately and cancels queued wheel intent', () => {
    const c = new ScrollIntentController();
    c.handleWheel('down');
    c.handleWheel('down');
    const immediate = c.handlePress(geometry, { col: 80, row: 6 }, 100);
    expect(immediate).toEqual({ scrollTop: 50 });
    expect(c.isDraggingScrollbar).toBe(true);
    // The queued +6 wheel burst must not fire after the press took over.
    expect(c.flush(geometry, 100)).toBeNull();
  });

  it('a press off the track starts no drag', () => {
    const c = new ScrollIntentController();
    expect(c.handlePress(geometry, { col: 1, row: 6 }, 100)).toBeNull();
    expect(c.isDraggingScrollbar).toBe(false);
    c.handleMove(6);
    expect(c.flush(geometry, 100)).toBeNull();
  });

  it('drag motion is absolute — the newest row wins', () => {
    const c = new ScrollIntentController();
    c.handlePress(geometry, { col: 80, row: 1 }, 100);
    c.handleMove(3);
    c.handleMove(6);
    expect(c.flush(geometry, 100)).toEqual({ scrollTop: 50 });
  });

  it('an absolute drag overrides a queued wheel delta in the same window', () => {
    const c = new ScrollIntentController();
    c.handlePress(geometry, { col: 80, row: 1 }, 100);
    c.handleWheel('down');
    c.handleMove(11);
    expect(c.flush(geometry, 100)).toEqual({
      scrollTop: 100,
      stickingToBottom: true,
    });
  });

  it('release ends the drag; later motion is not recorded', () => {
    const c = new ScrollIntentController();
    c.handlePress(geometry, { col: 80, row: 1 }, 100);
    c.handleRelease();
    expect(c.isDraggingScrollbar).toBe(false);
    c.handleMove(6);
    expect(c.flush(geometry, 100)).toBeNull();
  });

  it('cancelPending drops queued wheel and drag intent', () => {
    const c = new ScrollIntentController();
    c.handlePress(geometry, { col: 80, row: 1 }, 100);
    c.handleMove(6);
    c.handleWheel('down');
    c.cancelPending();
    expect(c.flush(geometry, 100)).toBeNull();
  });
});
