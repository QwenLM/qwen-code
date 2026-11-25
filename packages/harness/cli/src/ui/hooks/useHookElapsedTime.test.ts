/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { useHookElapsedTime } from './useHookElapsedTime.js';

describe('useHookElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('ticks on second boundaries measured from the actual start', async () => {
    const { result, unmount } = await renderHook(() =>
      useHookElapsedTime(1_000_000, undefined),
    );
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(1949));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(2);
    // A delayed callback derives elapsed from timestamps rather than counting ticks.
    vi.setSystemTime(1_010_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(11);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes at the actual end and stops ticking while the UI lingers', async () => {
    const initialProps: { endedAt?: number } = {};
    const { result, rerender, unmount } = await renderHook(
      ({ endedAt }: { endedAt?: number }) =>
        useHookElapsedTime(1_000_000, endedAt),
      { initialProps },
    );
    act(() => vi.advanceTimersByTime(2100));
    rerender({ endedAt: 1_002_100 });
    expect(result.current).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(2);
    unmount();
  });

  it('immediately uses the selected batch start when switching batches', async () => {
    const { result, rerender, unmount } = await renderHook(
      ({ startedAt }: { startedAt: number }) =>
        useHookElapsedTime(startedAt, undefined),
      { initialProps: { startedAt: 990_000 } },
    );
    expect(result.current).toBe(10);
    rerender({ startedAt: 1_000_000 });
    expect(result.current).toBe(0);
    rerender({ startedAt: 990_000 });
    expect(result.current).toBe(10);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a timer without a displayed batch', async () => {
    const { result, unmount } = await renderHook(() =>
      useHookElapsedTime(undefined, undefined),
    );
    expect(result.current).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
});
