/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import {
  useMemoryMonitor,
  DEFAULT_MEMORY_CHECK_INTERVAL,
  DEFAULT_MEMORY_WARNING_THRESHOLD,
} from './useMemoryMonitor.js';
import process from 'node:process';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';

// Mock settings object
const mockSettings: LoadedSettings = {
  merged: {
    performance: {
      memoryCheckInterval: DEFAULT_MEMORY_CHECK_INTERVAL,
      memoryWarningThreshold: DEFAULT_MEMORY_WARNING_THRESHOLD,
    },
  },
} as LoadedSettings;

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
      rss: DEFAULT_MEMORY_WARNING_THRESHOLD / 2,
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, settings: mockSettings }));
    vi.advanceTimersByTime(10000);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('should warn when memory usage is above threshold but below high threshold', () => {
    memoryUsageSpy.mockReturnValue({
      rss: DEFAULT_MEMORY_WARNING_THRESHOLD * 1.1, // Just above the basic threshold
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, settings: mockSettings }));
    vi.advanceTimersByTime(DEFAULT_MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.WARNING,
        text: expect.stringContaining('High memory usage detected'),
      },
      expect.any(Number),
    );
  });

  it('should error when memory usage is above high threshold', () => {
    memoryUsageSpy.mockReturnValue({
      rss: DEFAULT_MEMORY_WARNING_THRESHOLD * 2, // Well above the basic threshold but below the high one
    } as NodeJS.MemoryUsage);
    renderHook(() => useMemoryMonitor({ addItem, settings: mockSettings }));
    vi.advanceTimersByTime(DEFAULT_MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringContaining('Critical memory usage detected'),
      },
      expect.any(Number),
    );
  });

  it('should continue monitoring after exceeding threshold', () => {
    memoryUsageSpy.mockReturnValue({
      rss: DEFAULT_MEMORY_WARNING_THRESHOLD * 1.1, // Just above basic threshold
    } as NodeJS.MemoryUsage);
    const { rerender } = renderHook(() =>
      useMemoryMonitor({ addItem, settings: mockSettings }),
    );
    vi.advanceTimersByTime(DEFAULT_MEMORY_CHECK_INTERVAL);
    expect(addItem).toHaveBeenCalledTimes(1);

    // Rerender and advance timers again - with the new implementation it will continue to monitor
    memoryUsageSpy.mockReturnValue({
      rss: DEFAULT_MEMORY_WARNING_THRESHOLD * 1.1, // Just above basic threshold
    } as NodeJS.MemoryUsage);
    rerender();
    vi.advanceTimersByTime(DEFAULT_MEMORY_CHECK_INTERVAL);
    // Now it will call addItem again since we removed the clearInterval call
    expect(addItem).toHaveBeenCalledTimes(2);
  });
});
