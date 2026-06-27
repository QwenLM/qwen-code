/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  RESIZE_REPAINT_SETTLE_MS,
  useResizeSettleRepaint,
} from './useResizeSettleRepaint.js';

describe('useResizeSettleRepaint (#4891)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (initialWidth: number) => {
    const refreshStatic = vi.fn();
    const view = renderHook(
      ({ width }: { width: number }) =>
        useResizeSettleRepaint(width, refreshStatic),
      { initialProps: { width: initialWidth } },
    );
    return { refreshStatic, view };
  };

  it('does not repaint on first mount', () => {
    const { refreshStatic } = setup(80);

    act(() => {
      vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS + 50);
    });

    expect(refreshStatic).not.toHaveBeenCalled();
  });

  it('coalesces a burst of width changes into one repaint after settle', () => {
    const { refreshStatic, view } = setup(80);

    // Three rapid width changes, each well within the settle window.
    act(() => view.rerender({ width: 90 }));
    act(() => vi.advanceTimersByTime(100));
    act(() => view.rerender({ width: 100 }));
    act(() => vi.advanceTimersByTime(100));
    act(() => view.rerender({ width: 110 }));

    // Burst not yet settled (measured from the last change): nothing fired.
    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS - 1));
    expect(refreshStatic).not.toHaveBeenCalled();

    // Settle window elapses → exactly one repaint for the whole burst.
    act(() => vi.advanceTimersByTime(1));
    expect(refreshStatic).toHaveBeenCalledTimes(1);
  });

  it('does not repaint when a drag returns to the original width', () => {
    const { refreshStatic, view } = setup(80);

    act(() => view.rerender({ width: 100 }));
    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS - 1)); // pending
    act(() => view.rerender({ width: 80 })); // back to start before it fires

    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS + 50));
    expect(refreshStatic).not.toHaveBeenCalled();
  });

  it('repaints exactly once after a single settled width change', () => {
    const { refreshStatic, view } = setup(80);

    act(() => view.rerender({ width: 100 }));
    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS));

    expect(refreshStatic).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing when a re-render leaves the width unchanged', () => {
    // A height-only resize re-renders with the same width: no repaint.
    const { refreshStatic, view } = setup(80);

    act(() => view.rerender({ width: 80 }));
    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS + 50));

    expect(refreshStatic).not.toHaveBeenCalled();
  });

  it('cancels a pending repaint when unmounted mid-settle', () => {
    const { refreshStatic, view } = setup(80);

    act(() => view.rerender({ width: 100 }));
    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS - 1)); // pending
    view.unmount();

    act(() => vi.advanceTimersByTime(RESIZE_REPAINT_SETTLE_MS + 50));
    expect(refreshStatic).not.toHaveBeenCalled();
  });
});
