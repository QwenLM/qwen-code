/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFrameCoalescedFlush } from './use-frame-coalesced-flush.js';

describe('scroll frame delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  it('delivers the leading event immediately and coalesces later input', () => {
    const flush = vi.fn(() => false);
    const { result } = renderHook(() => useFrameCoalescedFlush(flush));
    act(() => result.current.schedule());
    expect(flush).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(9);
      result.current.schedule();
      result.current.schedule();
      vi.advanceTimersByTime(6);
    });
    expect(flush).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(flush).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(100));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('drains buffered motion on frames and stops once it is consumed', () => {
    const flush = vi
      .fn(() => false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    const { result } = renderHook(() => useFrameCoalescedFlush(flush));
    act(() => result.current.schedule());
    expect(flush).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(32));
    expect(flush).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the tail and lets a new gesture respond immediately', () => {
    const flush = vi.fn(() => true);
    const { result, unmount } = renderHook(() => useFrameCoalescedFlush(flush));
    act(() => {
      result.current.schedule();
      result.current.cancel();
      vi.advanceTimersByTime(100);
    });
    expect(flush).toHaveBeenCalledTimes(1);
    act(() => result.current.schedule());
    expect(flush).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes synchronous rendering cost in the frame budget', () => {
    const starts: number[] = [];
    const flush = () => {
      starts.push(performance.now());
      vi.advanceTimersByTime(8);
      return starts.length < 2;
    };
    const { result } = renderHook(() => useFrameCoalescedFlush(flush));
    act(() => result.current.schedule());
    act(() => vi.advanceTimersByTime(8));
    expect(starts).toEqual([0, 16]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
