/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDoubleTap } from './use-double-tap.js';

describe('useDoubleTap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onDoubleTap when tapped twice within the timeout window', () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap }),
    );

    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(true);
    expect(onDoubleTap).not.toHaveBeenCalled();

    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(false);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('does not fire onDoubleTap when tapped once and timeout expires', () => {
    const onDoubleTap = vi.fn();
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap, onTimeout }),
    );

    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(true);

    act(() => vi.advanceTimersByTime(801));
    expect(result.current.isPending).toBe(false);
    expect(onDoubleTap).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('fires onFirstTap on the first tap', () => {
    const onDoubleTap = vi.fn();
    const onFirstTap = vi.fn();
    const { result } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap, onFirstTap }),
    );

    act(() => result.current.handleTap());
    expect(onFirstTap).toHaveBeenCalledTimes(1);
  });

  it('resets pending state via reset()', () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap }),
    );

    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(true);

    act(() => result.current.reset());
    expect(result.current.isPending).toBe(false);

    // Second tap after reset should start a new cycle, not fire double-tap
    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(true);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('does not fire onDoubleTap when second tap is after timeout', () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap }),
    );

    act(() => result.current.handleTap());
    act(() => vi.advanceTimersByTime(801));

    // This is a new first tap, not a second tap
    act(() => result.current.handleTap());
    expect(result.current.isPending).toBe(true);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('clears timer on unmount', () => {
    const onDoubleTap = vi.fn();
    const onTimeout = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap, onTimeout }),
    );

    act(() => result.current.handleTap());
    unmount();

    act(() => vi.advanceTimersByTime(801));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('handleTap has a stable identity across renders', () => {
    const onDoubleTap = vi.fn();
    const { result, rerender } = renderHook(() =>
      useDoubleTap({ timeoutMs: 800, onDoubleTap }),
    );

    const firstHandleTap = result.current.handleTap;
    rerender();
    expect(result.current.handleTap).toBe(firstHandleTap);
  });
});
