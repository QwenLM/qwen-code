/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { useShellElapsedTime } from './useShellElapsedTime.js';

describe('useShellElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on whole-second boundaries using the stable start time', async () => {
    const startedAt = Date.now();
    const { result, unmount } = await renderHook(() =>
      useShellElapsedTime(startedAt, true),
    );

    expect(result.current.elapsedSeconds).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1949);
    });
    expect(result.current.elapsedSeconds).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.elapsedSeconds).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.elapsedSeconds).toBe(5);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule updates while inactive', async () => {
    const { result, unmount } = await renderHook(() =>
      useShellElapsedTime(Date.now() - 5000, false),
    );

    expect(result.current).toEqual({ elapsedMs: 0, elapsedSeconds: 0 });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('refreshes the current time immediately when becoming active', async () => {
    const startedAt = Date.now() - 5000;
    const { result, rerender, unmount } = await renderHook(
      ({ active }: { active: boolean }) =>
        useShellElapsedTime(startedAt, active),
      { initialProps: { active: false } },
    );

    vi.setSystemTime(Date.now() + 10_000);
    rerender({ active: true });

    expect(result.current.elapsedSeconds).toBe(15);
    unmount();
  });
});
