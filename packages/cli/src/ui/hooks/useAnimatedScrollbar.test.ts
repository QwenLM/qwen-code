/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnimatedScrollbar } from './useAnimatedScrollbar.js';

describe('useAnimatedScrollbar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts hidden so the bar does not flash on initial mount', () => {
    const { result } = renderHook(() => useAnimatedScrollbar());
    expect(result.current.isVisible).toBe(false);
  });

  it('flashScrollbar() sets isVisible=true synchronously', () => {
    const { result } = renderHook(() => useAnimatedScrollbar());
    act(() => result.current.flashScrollbar());
    expect(result.current.isVisible).toBe(true);
  });

  it('hides again after the idle timeout', () => {
    const { result } = renderHook(() =>
      useAnimatedScrollbar({ idleHideMs: 1000 }),
    );
    act(() => result.current.flashScrollbar());
    expect(result.current.isVisible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.isVisible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isVisible).toBe(false);
  });

  it('successive flashes reset the idle timer (no premature hide)', () => {
    const { result } = renderHook(() =>
      useAnimatedScrollbar({ idleHideMs: 1000 }),
    );
    act(() => result.current.flashScrollbar());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.flashScrollbar());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // 1600ms total elapsed but timer was reset at 800ms; thumb still visible.
    expect(result.current.isVisible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.isVisible).toBe(false);
  });

  it('idleHideMs<=0 disables the auto-hide (stays visible forever)', () => {
    const { result } = renderHook(() =>
      useAnimatedScrollbar({ idleHideMs: 0 }),
    );
    act(() => result.current.flashScrollbar());
    expect(result.current.isVisible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.isVisible).toBe(true);
  });

  it('cleans up the pending timer on unmount (no late state update)', () => {
    const { result, unmount } = renderHook(() =>
      useAnimatedScrollbar({ idleHideMs: 1000 }),
    );
    act(() => result.current.flashScrollbar());
    unmount();
    // After unmount the timer must not fire and try to update state;
    // vitest's fake timers will surface "Can't perform a React state
    // update on an unmounted component" warnings if it does.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });
});
