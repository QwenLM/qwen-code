/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { EventLoopLagMonitorOptions } from './event-loop-lag.js';

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

  const zeroes = { meanMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 };
  const tick = () => vi.advanceTimersByTimeAsync(10);
  const skipWallClock = (ms: number) => vi.setSystemTime(Date.now() + ms);

  // Seeds the histogram max (ns) and starts a 10 ms monitor with a stall spy;
  // stallThresholdMs is 1_000 unless `options` overrides it.
  function startWithMax(
    maxNs: number,
    options: Pick<
      EventLoopLagMonitorOptions,
      'stallThresholdMs' | 'suspendThresholdMs'
    > = {},
    onNewMaxStall: Mock<(maxMs: number) => void> = vi.fn(),
  ) {
    histogram.max = maxNs;
    const monitor = startEventLoopLagMonitor({
      resolutionMs: 10,
      stallThresholdMs: 1_000,
      ...options,
      onNewMaxStall,
    });
    return { monitor, onNewMaxStall };
  }

  // startWithMax, then one tick after an optional wall-clock jump of `gapMs`.
  async function afterOneTick(
    maxNs: number,
    {
      gapMs,
      ...options
    }: Parameters<typeof startWithMax>[1] & { gapMs?: number } = {},
  ) {
    const started = startWithMax(maxNs, options);
    if (gapMs !== undefined) skipWallClock(gapMs);
    await tick();
    return started;
  }

  function expectReported(onNewMaxStall: Mock, maxMs: number) {
    expect(histogram.reset).not.toHaveBeenCalled();
    expect(onNewMaxStall).toHaveBeenCalledWith(maxMs);
  }

  function expectSuppressed(onNewMaxStall: Mock) {
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).not.toHaveBeenCalled();
  }

  it('returns finite zeroes before the monitor has samples', () => {
    const monitor = startEventLoopLagMonitor({ resolutionMs: 10 });

    expect(monitor.snapshot()).toEqual(zeroes);

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
    const { monitor, onNewMaxStall } = startWithMax(300_000_000_000, {
      suspendThresholdMs: 300_000,
    });

    skipWallClock(300_000);
    expect(monitor.snapshot().maxMs).toBe(300_000);
    expect(cpuUsage).toHaveBeenCalledOnce();
    expect(histogram.reset).not.toHaveBeenCalled();

    await tick();

    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(onNewMaxStall).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it('actively reports only new max stalls above threshold', async () => {
    const { monitor, onNewMaxStall } = startWithMax(15_000_000, {
      stallThresholdMs: 10,
    });

    await tick();
    histogram.max = 12_000_000;
    await tick();
    histogram.max = 20_000_000;
    await tick();

    expect(onNewMaxStall).toHaveBeenCalledTimes(2);
    expect(onNewMaxStall).toHaveBeenNthCalledWith(1, 15);
    expect(onNewMaxStall).toHaveBeenNthCalledWith(2, 20);

    monitor.dispose();
    histogram.max = 30_000_000;
    await tick();
    expect(onNewMaxStall).toHaveBeenCalledTimes(2);
  });

  it('swallows stall callback errors', async () => {
    const throwing = vi.fn((_maxMs: number) => {
      throw new Error('callback failed');
    });
    const { monitor } = startWithMax(
      15_000_000,
      { stallThresholdMs: 10 },
      throwing,
    );

    await tick();
    expect(throwing).toHaveBeenCalledWith(15);

    monitor.dispose();
  });

  it('resets suspended samples without reporting them as stalls', async () => {
    const { monitor, onNewMaxStall } = await afterOneTick(15_000_000_000, {
      suspendThresholdMs: 10_000,
      gapMs: 10_000,
    });

    expectSuppressed(onNewMaxStall);

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

    skipWallClock(10_000);
    expect(monitor.snapshot()).toEqual({
      meanMs: 15_000,
      p50Ms: 15_000,
      p99Ms: 15_000,
      maxMs: 15_000,
    });
    expect(histogram.reset).not.toHaveBeenCalled();

    await tick();
    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(monitor.snapshot()).toEqual(zeroes);

    monitor.dispose();
  });

  it('reports lower stalls after resetting a suspended sample', async () => {
    histogram.reset.mockImplementation(() => {
      histogram.max = Number.NaN;
    });
    const { monitor, onNewMaxStall } = startWithMax(15_000_000_000, {
      suspendThresholdMs: 10_000,
    });

    skipWallClock(10_000);
    await tick();
    histogram.max = 5_000_000_000;
    await tick();

    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(onNewMaxStall).toHaveBeenCalledOnce();
    expect(onNewMaxStall).toHaveBeenCalledWith(5_000);

    monitor.dispose();
  });

  it('reports a real stall below the suspend threshold', async () => {
    const { monitor, onNewMaxStall } = await afterOneTick(5_000_000_000, {
      suspendThresholdMs: 10_000,
    });

    expectReported(onNewMaxStall, 5_000);

    monitor.dispose();
  });

  it('reports a low-CPU gap just below the configured suspend threshold', async () => {
    const { monitor, onNewMaxStall } = await afterOneTick(299_000_000_000, {
      suspendThresholdMs: 300_000,
      gapMs: 300_000,
    });

    expectReported(onNewMaxStall, 299_000);

    monitor.dispose();
  });

  it('resets a low-CPU sample at the default suspend threshold', async () => {
    const { monitor, onNewMaxStall } = await afterOneTick(300_000_000_000, {
      gapMs: 600_000,
    });

    expectSuppressed(onNewMaxStall);

    monitor.dispose();
  });

  it('reports a long active stall when CPU time advanced', async () => {
    cpuUsage
      .mockReset()
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValue({ user: 20_000_000, system: 0 });
    const { monitor, onNewMaxStall } = await afterOneTick(600_000_000_000);

    expectReported(onNewMaxStall, 600_000);

    monitor.dispose();
  });

  it('reports rather than suppressing when CPU usage is unavailable', async () => {
    cpuUsage.mockImplementation(() => {
      throw new Error('cpu accounting unavailable');
    });
    const { monitor, onNewMaxStall } = await afterOneTick(600_000_000_000);

    expectReported(onNewMaxStall, 600_000);

    monitor.dispose();
  });

  it('does not suppress an old histogram max after a short idle check', async () => {
    cpuUsage
      .mockReset()
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValueOnce({ user: 20_000_000, system: 0 })
      .mockReturnValue({ user: 20_000_000, system: 0 });
    const { monitor, onNewMaxStall } = startWithMax(600_000_000_000, {
      suspendThresholdMs: 300_000,
    });

    skipWallClock(600_000);
    await tick();
    await tick();

    expect(onNewMaxStall).toHaveBeenCalledOnce();
    expect(histogram.reset).not.toHaveBeenCalled();

    monitor.dispose();
  });
  it('suppresses a suspension gap whose histogram max lands one tick late', async () => {
    const { monitor, onNewMaxStall } = startWithMax(Number.NaN, {
      suspendThresholdMs: 10_000,
    });

    skipWallClock(10_000);
    // Tick 1 sees the 10 s gap before the histogram publishes its max.
    await tick();
    expect(histogram.reset).not.toHaveBeenCalled();

    // The max lands between ticks; tick 2's carried gap qualifies it.
    histogram.max = 10_000_000_000;
    await tick();

    expectSuppressed(onNewMaxStall);

    monitor.dispose();
  });

  it('enables and disables the underlying histogram', () => {
    const monitor = startEventLoopLagMonitor();

    expect(histogram.enable).toHaveBeenCalledTimes(1);
    monitor.dispose();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });
});
