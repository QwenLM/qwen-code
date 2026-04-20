/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRenderThrottledStateAndRef } from './useRenderThrottledStateAndRef.js';

describe('useRenderThrottledStateAndRef', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the initial value synchronously to both state and ref', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('initial', 16),
    );
    const [state, ref] = result.current;
    expect(state).toBe('initial');
    expect(ref.current).toBe('initial');
  });

  it('fires the leading edge immediately when the window has elapsed', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    act(() => {
      result.current[2]('b');
    });
    // Leading edge: state updates synchronously on the first call.
    expect(result.current[0]).toBe('b');
    expect(result.current[1].current).toBe('b');
  });

  it('updates ref synchronously even when state render is throttled', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    // Leading edge fires for the first call.
    act(() => {
      result.current[2]('b');
    });
    expect(result.current[0]).toBe('b');

    // Second call within the window: ref advances, state stays behind.
    act(() => {
      result.current[2]('c');
    });
    expect(result.current[1].current).toBe('c');
    expect(result.current[0]).toBe('b');

    // After the window elapses the trailing-edge timer commits the latest ref.
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current[0]).toBe('c');
  });

  it('coalesces multiple rapid updates into one trailing-edge commit', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    act(() => {
      result.current[2]('b'); // leading
    });
    act(() => {
      result.current[2]('c');
      result.current[2]('d');
      result.current[2]('e');
    });
    expect(result.current[1].current).toBe('e');
    expect(result.current[0]).toBe('b');

    act(() => {
      vi.advanceTimersByTime(16);
    });
    // Only the latest value ('e') should land; intermediate c/d are dropped.
    expect(result.current[0]).toBe('e');
  });

  it('bypasses throttle for nullish values', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string | null>('a', 16),
    );
    act(() => {
      result.current[2]('b'); // leading edge
    });
    expect(result.current[0]).toBe('b');

    act(() => {
      result.current[2]('c'); // throttled (trailing)
    });
    expect(result.current[0]).toBe('b');

    // null fires immediately regardless of throttle window.
    act(() => {
      result.current[2](null);
    });
    expect(result.current[0]).toBeNull();
    expect(result.current[1].current).toBeNull();
  });

  it('flush() forces the latest ref value into state immediately', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    act(() => {
      result.current[2]('b'); // leading
    });
    act(() => {
      result.current[2]('c'); // trailing scheduled
    });
    expect(result.current[0]).toBe('b');

    act(() => {
      result.current[3](); // flush
    });
    expect(result.current[0]).toBe('c');
  });

  it('flush() clears any pending timer so it does not fire a duplicate setState', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    act(() => {
      result.current[2]('b');
    });
    act(() => {
      result.current[2]('c');
    });
    act(() => {
      result.current[3]();
    });
    expect(result.current[0]).toBe('c');

    // A trailing timer, if it had not been cleared, would fire here and
    // re-setState. State should still be 'c'.
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current[0]).toBe('c');
  });

  it('resolves functional updates against the latest ref value', () => {
    const { result } = renderHook(() =>
      useRenderThrottledStateAndRef<number>(0, 16),
    );
    act(() => {
      result.current[2]((prev) => prev + 1);
    });
    expect(result.current[1].current).toBe(1);
    expect(result.current[0]).toBe(1);

    act(() => {
      result.current[2]((prev) => prev + 1);
      result.current[2]((prev) => prev + 1);
    });
    // Ref sees both increments even while state is throttled.
    expect(result.current[1].current).toBe(3);
    expect(result.current[0]).toBe(1);

    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current[0]).toBe(3);
  });

  it('clears the timer on unmount without throwing', () => {
    const { result, unmount } = renderHook(() =>
      useRenderThrottledStateAndRef<string>('a', 16),
    );
    act(() => {
      result.current[2]('b');
    });
    act(() => {
      result.current[2]('c'); // schedules trailing timer
    });
    expect(() => unmount()).not.toThrow();
    // Advancing timers after unmount must not throw (timer is cleaned up).
    expect(() => {
      vi.advanceTimersByTime(50);
    }).not.toThrow();
  });
});
