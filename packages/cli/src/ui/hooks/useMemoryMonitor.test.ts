/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import {
  useMemoryMonitor,
  MEMORY_CHECK_INTERVAL,
  MEMORY_WARNING_THRESHOLD,
  MEMORY_UI_COMPACT_THRESHOLD,
  MEMORY_DEBUG_INTERVAL,
  UI_COMPACT_COOLDOWN_MS,
} from './useMemoryMonitor.js';
import process from 'node:process';
import { MessageType } from '../types.js';

describe('useMemoryMonitor', () => {
  const memoryUsageSpy = vi.spyOn(process, 'memoryUsage');
  const addItem = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not warn when memory usage is below threshold', () => {
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD / 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem }));
    vi.advanceTimersByTime(10000);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('should warn when memory usage is above threshold', () => {
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD * 1.5,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem }));
    vi.advanceTimersByTime(MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.WARNING,
        text: 'High memory usage detected: 10.50 GB. If you experience a crash, please file a bug report by running `/bug`',
      },
      expect.any(Number),
    );
  });

  it('should only warn once', () => {
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD * 1.5,
    } as NodeJS.MemoryUsage);
    const { rerender } = renderHook(() => useMemoryMonitor({ addItem }));
    vi.advanceTimersByTime(MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);

    // Rerender and advance timers, should not warn again
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD * 1.5,
    } as NodeJS.MemoryUsage);
    rerender();
    vi.advanceTimersByTime(MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);
  });

  it('should call compactOldItems when heapUsed exceeds 5GB threshold', () => {
    const compactOldItems = vi.fn();
    memoryUsageSpy.mockReturnValue({
      rss: 1024,
      heapUsed: MEMORY_UI_COMPACT_THRESHOLD() + 1,
      heapTotal: MEMORY_UI_COMPACT_THRESHOLD() * 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, compactOldItems }));
    vi.advanceTimersByTime(MEMORY_DEBUG_INTERVAL);
    expect(compactOldItems).toHaveBeenCalledTimes(1);
  });

  it('should not call compactOldItems when heapUsed is below threshold', () => {
    const compactOldItems = vi.fn();
    memoryUsageSpy.mockReturnValue({
      rss: 1024,
      heapUsed: MEMORY_UI_COMPACT_THRESHOLD() - 1,
      heapTotal: MEMORY_UI_COMPACT_THRESHOLD() * 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, compactOldItems }));
    vi.advanceTimersByTime(MEMORY_DEBUG_INTERVAL);
    expect(compactOldItems).not.toHaveBeenCalled();
  });

  it('should respect 5-minute cooldown for compactOldItems', () => {
    const compactOldItems = vi.fn();
    memoryUsageSpy.mockReturnValue({
      rss: 1024,
      heapUsed: MEMORY_UI_COMPACT_THRESHOLD() + 1,
      heapTotal: MEMORY_UI_COMPACT_THRESHOLD() * 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, compactOldItems }));

    // First call triggers compaction
    vi.advanceTimersByTime(MEMORY_DEBUG_INTERVAL);
    expect(compactOldItems).toHaveBeenCalledTimes(1);

    // Within cooldown — should not trigger again
    vi.advanceTimersByTime(MEMORY_DEBUG_INTERVAL);
    expect(compactOldItems).toHaveBeenCalledTimes(1);

    // After cooldown — should trigger again
    vi.advanceTimersByTime(UI_COMPACT_COOLDOWN_MS);
    expect(compactOldItems).toHaveBeenCalledTimes(2);
  });

  it('should keep running compactOldItems after warning interval self-destructs', () => {
    const compactOldItems = vi.fn();
    // RSS above warning threshold, heap below compaction threshold initially
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD + 1,
      heapUsed: MEMORY_UI_COMPACT_THRESHOLD() - 1,
      heapTotal: MEMORY_UI_COMPACT_THRESHOLD() * 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, compactOldItems }));

    // Warning fires and self-destructs
    vi.advanceTimersByTime(MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);

    // Now heap exceeds threshold — compaction should still work
    memoryUsageSpy.mockReturnValue({
      rss: MEMORY_WARNING_THRESHOLD + 1,
      heapUsed: MEMORY_UI_COMPACT_THRESHOLD() + 1,
      heapTotal: MEMORY_UI_COMPACT_THRESHOLD() * 2,
    } as NodeJS.MemoryUsage);
    vi.advanceTimersByTime(MEMORY_DEBUG_INTERVAL);
    expect(compactOldItems).toHaveBeenCalledTimes(1);
  });
});
