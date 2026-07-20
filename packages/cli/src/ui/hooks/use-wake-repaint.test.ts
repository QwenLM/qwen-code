/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWakeRepaint } from './use-wake-repaint.js';

const HEARTBEAT_MS = 5_000;
const WAKE_THRESHOLD_MS = HEARTBEAT_MS * 2;

describe('useWakeRepaint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const repaint = vi.fn();
    const view = renderHook(() => useWakeRepaint(repaint));
    return { repaint, view };
  };

  it('does not repaint during normal heartbeat ticks', () => {
    const { repaint } = setup();

    // Advance through several normal heartbeat intervals.
    act(() => vi.advanceTimersByTime(HEARTBEAT_MS * 5));

    expect(repaint).not.toHaveBeenCalled();
  });

  it('repaints when a heartbeat gap exceeds the wake threshold', () => {
    const { repaint } = setup();

    // First tick at t=5000 — normal.
    act(() => vi.advanceTimersByTime(HEARTBEAT_MS));
    expect(repaint).not.toHaveBeenCalled();

    // Simulate sleep: jump the clock far ahead so the next tick sees a gap
    // larger than WAKE_THRESHOLD_MS.
    vi.setSystemTime(Date.now() + WAKE_THRESHOLD_MS + 1_000);
    act(() => vi.advanceTimersByTime(HEARTBEAT_MS));

    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it('repaints on SIGCONT', () => {
    const { repaint } = setup();

    act(() => {
      process.emit('SIGCONT');
    });

    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it('does not repaint on SIGCONT after unmount', () => {
    const { repaint, view } = setup();

    view.unmount();

    act(() => {
      process.emit('SIGCONT');
    });

    expect(repaint).not.toHaveBeenCalled();
  });

  it('cleans up the heartbeat timer on unmount', () => {
    const { repaint, view } = setup();

    view.unmount();

    // Advance well past the wake threshold — no timer should fire.
    vi.setSystemTime(Date.now() + WAKE_THRESHOLD_MS + 10_000);
    act(() => vi.advanceTimersByTime(HEARTBEAT_MS * 5));

    expect(repaint).not.toHaveBeenCalled();
  });

  it('uses the latest repaint callback without re-arming listeners', () => {
    const first = vi.fn();
    const second = vi.fn();

    const view = renderHook(
      ({ cb }: { cb: () => void }) => useWakeRepaint(cb),
      { initialProps: { cb: first } },
    );

    // Swap the callback.
    view.rerender({ cb: second });

    act(() => {
      process.emit('SIGCONT');
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
