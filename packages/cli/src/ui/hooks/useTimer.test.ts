/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimer } from './useTimer.js';

describe('useTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with 0', () => {
    const { result } = renderHook(() => useTimer(false, 0));
    expect(result.current).toBe(0);
  });

  it('should not increment time if isActive is false', () => {
    const { result } = renderHook(() => useTimer(false, 0));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(0);
  });

  it('should increment time every second if isActive is true', () => {
    const { result } = renderHook(() => useTimer(true, 0));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(3);
  });

  it('should report sub-second wall-clock time while active', () => {
    const { result } = renderHook(() => useTimer(true, 0));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(0.5);
  });

  it('should keep timing stable if the system clock moves backward', () => {
    const { result } = renderHook(() => useTimer(true, 0));

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);

    act(() => {
      vi.setSystemTime(new Date(0));
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(2);
  });

  it('should reset to 0 and start incrementing when isActive becomes true from false', () => {
    const { result, rerender } = renderHook(
      ({ isActive, resetKey }) => useTimer(isActive, resetKey),
      { initialProps: { isActive: false, resetKey: 0 } },
    );
    expect(result.current).toBe(0);

    rerender({ isActive: true, resetKey: 0 });
    expect(result.current).toBe(0); // Should reset to 0 upon becoming active

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
  });

  it('should reset to 0 when resetKey changes while active', () => {
    const { result, rerender } = renderHook(
      ({ isActive, resetKey }) => useTimer(isActive, resetKey),
      { initialProps: { isActive: true, resetKey: 0 } },
    );
    act(() => {
      vi.advanceTimersByTime(3000); // 3s
    });
    expect(result.current).toBe(3);

    rerender({ isActive: true, resetKey: 1 }); // Change resetKey
    expect(result.current).toBe(0); // Should reset to 0

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1); // Starts incrementing from 0
  });

  it('should be 0 if isActive is false, regardless of resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ isActive, resetKey }) => useTimer(isActive, resetKey),
      { initialProps: { isActive: false, resetKey: 0 } },
    );
    expect(result.current).toBe(0);

    rerender({ isActive: false, resetKey: 1 });
    expect(result.current).toBe(0);
  });

  it('should clear timer on unmount', () => {
    const { unmount } = renderHook(() => useTimer(true, 0));
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('should preserve elapsedTime when isActive becomes false, and reset to 0 when it becomes active again', () => {
    const { result, rerender } = renderHook(
      ({ isActive, resetKey }) => useTimer(isActive, resetKey),
      { initialProps: { isActive: true, resetKey: 0 } },
    );

    act(() => {
      vi.advanceTimersByTime(3000); // Advance to 3 seconds
    });
    expect(result.current).toBe(3);

    rerender({ isActive: false, resetKey: 0 });
    expect(result.current).toBe(3); // Time should be preserved when timer becomes inactive

    // Now make it active again, it should reset to 0
    rerender({ isActive: true, resetKey: 0 });
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
  });

  it('should pause elapsedTime without resetting when isPaused is true', () => {
    const { result, rerender } = renderHook(
      ({ isPaused }) => useTimer(true, 0, isPaused),
      { initialProps: { isPaused: false } },
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(2);

    rerender({ isPaused: true });
    expect(result.current).toBe(2);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(2);

    rerender({ isPaused: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(3);
  });

  it('should reset while paused when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ resetKey, isPaused }) => useTimer(true, resetKey, isPaused),
      { initialProps: { resetKey: 0, isPaused: false } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);

    rerender({ resetKey: 0, isPaused: true });
    rerender({ resetKey: 1, isPaused: true });
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(0);

    rerender({ resetKey: 1, isPaused: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(0.5);
  });

  it('should accumulate elapsedTime across multiple pause and resume cycles', () => {
    const { result, rerender } = renderHook(
      ({ isPaused }) => useTimer(true, 0, isPaused),
      { initialProps: { isPaused: false } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);

    rerender({ isPaused: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);

    rerender({ isPaused: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(1.5);

    rerender({ isPaused: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1.5);

    rerender({ isPaused: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(2);
  });
});
