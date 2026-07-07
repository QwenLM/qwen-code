/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const histogram = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  mean: Number.NaN,
  max: Number.NaN,
  percentile: vi.fn((_percentile: number) => Number.NaN),
}));

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => histogram),
}));

describe('startEventLoopLagMonitor', () => {
  let startEventLoopLagMonitor: typeof import('./event-loop-lag.js').startEventLoopLagMonitor;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    histogram.mean = Number.NaN;
    histogram.max = Number.NaN;
    histogram.percentile.mockReturnValue(Number.NaN);
    ({ startEventLoopLagMonitor } = await import('./event-loop-lag.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns finite zeroes before the monitor has samples', () => {
    const monitor = startEventLoopLagMonitor({ resolutionMs: 10 });

    expect(monitor.snapshot()).toEqual({
      meanMs: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });

    monitor.dispose();
  });

  it('converts nanosecond histogram values to milliseconds', () => {
    histogram.mean = 12_000_000;
    histogram.max = 50_000_000;
    histogram.percentile.mockImplementation((percentile: number) =>
      percentile === 50 ? 20_000_000 : 45_000_000,
    );
    const monitor = startEventLoopLagMonitor({ resolutionMs: 10 });

    expect(monitor.snapshot()).toEqual({
      meanMs: 12,
      p50Ms: 20,
      p99Ms: 45,
      maxMs: 50,
    });

    monitor.dispose();
  });

  it('actively reports only new max stalls above threshold', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 15_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 10,
      onNewMaxStall,
    });

    await vi.advanceTimersByTimeAsync(10);
    histogram.max = 12_000_000;
    await vi.advanceTimersByTimeAsync(10);
    histogram.max = 20_000_000;
    await vi.advanceTimersByTimeAsync(10);

    expect(onNewMaxStall).toHaveBeenCalledTimes(2);
    expect(onNewMaxStall).toHaveBeenNthCalledWith(1, 15);
    expect(onNewMaxStall).toHaveBeenNthCalledWith(2, 20);

    monitor.dispose();
    histogram.max = 30_000_000;
    await vi.advanceTimersByTimeAsync(10);
    expect(onNewMaxStall).toHaveBeenCalledTimes(2);
  });

  it('swallows stall callback errors', async () => {
    const onNewMaxStall = vi.fn(() => {
      throw new Error('callback failed');
    });
    histogram.max = 15_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 10,
      onNewMaxStall,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(onNewMaxStall).toHaveBeenCalledWith(15);

    monitor.dispose();
  });

  it('enables and disables the underlying histogram', () => {
    const monitor = startEventLoopLagMonitor();

    expect(histogram.enable).toHaveBeenCalledTimes(1);
    monitor.dispose();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });
});
