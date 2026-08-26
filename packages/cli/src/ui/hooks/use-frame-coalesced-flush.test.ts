/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFrameCoalescedFlush } from './use-frame-coalesced-flush.js';

describe('useFrameCoalescedFlush', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the leading update immediately', () => {
    const flush = vi.fn();
    const { result } = renderHook(() => useFrameCoalescedFlush(flush));

    act(() => result.current.schedule());

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('waits only for the remaining frame deadline', () => {
    const flush = vi.fn();
    const { result } = renderHook(() => useFrameCoalescedFlush(flush, 16));

    act(() => result.current.schedule());
    act(() => vi.advanceTimersByTime(5));
    act(() => result.current.schedule());
    act(() => vi.advanceTimersByTime(10));
    expect(flush).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('flushes immediately after the previous deadline has passed', () => {
    const flush = vi.fn();
    const { result } = renderHook(() => useFrameCoalescedFlush(flush, 16));

    act(() => result.current.schedule());
    act(() => vi.advanceTimersByTime(40));
    act(() => result.current.schedule());

    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated schedules inside one frame', () => {
    const flush = vi.fn();
    const { result } = renderHook(() => useFrameCoalescedFlush(flush, 16));

    act(() => result.current.schedule());
    act(() => {
      result.current.schedule();
      result.current.schedule();
      result.current.schedule();
    });
    expect(flush).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(16));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending trailing flush', () => {
    const flush = vi.fn();
    const { result } = renderHook(() => useFrameCoalescedFlush(flush, 16));

    act(() => result.current.schedule());
    act(() => result.current.schedule());
    act(() => result.current.cancel());
    act(() => vi.advanceTimersByTime(16));

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('clears a pending trailing flush on unmount', () => {
    // Guard the documented "timer is always cleared on unmount" contract.
    // Deleting the cleanup effect is a surviving mutant unless unmount is
    // exercised: schedule twice (leading applies, trailing is pending),
    // unmount, then advance past the deadline — the trailing flush must not
    // run.
    const flush = vi.fn();
    const { result, unmount } = renderHook(() =>
      useFrameCoalescedFlush(flush, 16),
    );

    act(() => result.current.schedule()); // leading → applies immediately
    act(() => result.current.schedule()); // trailing → pending until deadline
    expect(flush).toHaveBeenCalledTimes(1);

    unmount();
    act(() => vi.advanceTimersByTime(16));

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
