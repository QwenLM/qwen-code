/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const histogram = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  mean: Number.NaN,
  max: Number.NaN,
  percentile: vi.fn((_percentile: number) => Number.NaN),
}));

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => histogram),
}));

const cpuUsage = vi.hoisted(() => vi.fn());

describe('startEventLoopLagMonitor', () => {
  let startEventLoopLagMonitor: typeof import('./event-loop-lag.js').startEventLoopLagMonitor;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    cpuUsage.mockReset();
    cpuUsage
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValue({ user: 0, system: 0 });
    vi.spyOn(process, 'cpuUsage').mockImplementation(cpuUsage);
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

  it('reads snapshots without advancing suspension detection state', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 300_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 300_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 300_000);
    expect(monitor.snapshot().maxMs).toBe(300_000);
    expect(cpuUsage).toHaveBeenCalledOnce();
    expect(histogram.reset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(onNewMaxStall).not.toHaveBeenCalled();

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

  it('resets suspended samples without reporting them as stalls', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 15_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 10_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it('keeps snapshots pure while suspension filtering runs on the interval', async () => {
    histogram.mean = 15_000_000_000;
    histogram.max = 15_000_000_000;
    histogram.percentile.mockReturnValue(15_000_000_000);
    histogram.reset.mockImplementation(() => {
      histogram.mean = Number.NaN;
      histogram.max = Number.NaN;
      histogram.percentile.mockReturnValue(Number.NaN);
    });
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      suspendThresholdMs: 10_000,
    });

    vi.setSystemTime(Date.now() + 10_000);
    expect(monitor.snapshot()).toEqual({
      meanMs: 15_000,
      p50Ms: 15_000,
      p99Ms: 15_000,
      maxMs: 15_000,
    });
    expect(histogram.reset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(monitor.snapshot()).toEqual({
      meanMs: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });

    monitor.dispose();
  });

  it('reports lower stalls after resetting a suspended sample', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 15_000_000_000;
    histogram.reset.mockImplementation(() => {
      histogram.max = Number.NaN;
    });
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 10_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10);
    histogram.max = 5_000_000_000;
    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).toHaveBeenCalledOnce();
    expect(onNewMaxStall).toHaveBeenCalledWith(5_000);

    monitor.dispose();
  });

  it('reports a real stall below the suspend threshold', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 5_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 10_000,
      onNewMaxStall,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).not.toHaveBeenCalled();
    expect(onNewMaxStall).toHaveBeenCalledWith(5_000);

    monitor.dispose();
  });

  it('reports a low-CPU gap just below the configured suspend threshold', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 299_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 300_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).not.toHaveBeenCalled();
    expect(onNewMaxStall).toHaveBeenCalledWith(299_000);

    monitor.dispose();
  });

  it('resets a low-CPU sample at the default suspend threshold', async () => {
    const onNewMaxStall = vi.fn();
    histogram.max = 300_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it('reports a long active stall when CPU time advanced', async () => {
    const onNewMaxStall = vi.fn();
    cpuUsage
      .mockReset()
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValue({ user: 20_000_000, system: 0 });
    histogram.max = 600_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      onNewMaxStall,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).not.toHaveBeenCalled();
    expect(onNewMaxStall).toHaveBeenCalledWith(600_000);

    monitor.dispose();
  });

  it('reports rather than suppressing when CPU usage is unavailable', async () => {
    const onNewMaxStall = vi.fn();
    cpuUsage.mockImplementation(() => {
      throw new Error('cpu accounting unavailable');
    });
    histogram.max = 600_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      onNewMaxStall,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).not.toHaveBeenCalled();
    expect(onNewMaxStall).toHaveBeenCalledWith(600_000);

    monitor.dispose();
  });

  it('does not suppress an old histogram max after a short idle check', async () => {
    const onNewMaxStall = vi.fn();
    cpuUsage
      .mockReset()
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValueOnce({ user: 20_000_000, system: 0 })
      .mockReturnValue({ user: 20_000_000, system: 0 });
    histogram.max = 600_000_000_000;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 300_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(onNewMaxStall).toHaveBeenCalledOnce();
    expect(histogram.reset).not.toHaveBeenCalled();

    monitor.dispose();
  });
  it('suppresses a suspension gap whose histogram max lands one tick late', async () => {
    const onNewMaxStall = vi.fn();
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      suspendThresholdMs: 10_000,
      onNewMaxStall,
    });

    vi.setSystemTime(Date.now() + 10_000);
    // Tick 1: our interval sees the 10 s gap but the histogram has not
    // published the matching max yet.
    await vi.advanceTimersByTimeAsync(10);
    expect(histogram.reset).not.toHaveBeenCalled();

    // The histogram publishes the gap between ticks.
    histogram.max = 10_000_000_000;
    // Tick 2: the carried gap qualifies the late histogram max.
    await vi.advanceTimersByTimeAsync(10);

    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it('enables and disables the underlying histogram', () => {
    const monitor = startEventLoopLagMonitor();

    expect(histogram.enable).toHaveBeenCalledTimes(1);
    monitor.dispose();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });
});
