/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoadAdmissionMonitor,
  LOAD_ADMISSION_SAMPLE_MS,
} from './load-admission.js';

const histogram = vi.hoisted(() => ({
  enable: vi.fn(),
  reset: vi.fn(),
  disable: vi.fn(),
  percentile: vi.fn(() => 5_000_000),
}));

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => histogram),
}));

const osMock = vi.hoisted(() => ({
  loadavg: vi.fn(() => [4, 2, 1]),
  cpus: vi.fn(() => new Array(2)),
  availableParallelism: vi.fn(() => 2),
}));

vi.mock('node:os', () => ({
  default: osMock,
  ...osMock,
}));

describe('load admission default signal reader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    histogram.enable.mockClear();
    histogram.reset.mockClear();
    histogram.disable.mockClear();
    histogram.percentile.mockClear();
    osMock.loadavg.mockReturnValue([4, 2, 1]);
    osMock.cpus.mockReturnValue(new Array(2));
    osMock.availableParallelism.mockReturnValue(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enables the histogram and converts ns p99 to ms over the core count', () => {
    const monitor = createLoadAdmissionMonitor();
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS);
    const snapshot = monitor.snapshot();
    // loadavg[0] / host cores = 4 / 2.
    expect(snapshot.loadRatio).toBe(2);
    // percentile(99) = 5_000_000 ns = 5 ms.
    expect(snapshot.eventLoopLagP99Ms).toBe(5);
    expect(histogram.percentile).toHaveBeenCalledWith(99);
    monitor.dispose();
  });

  it('divides host load by host cores, not the container quota', () => {
    // A 2-CPU quota on a busy 64-core host: the ratio must stay host-scoped
    // or the gate latches into permanent refusals while the daemon is idle.
    osMock.loadavg.mockReturnValue([8, 8, 8]);
    osMock.cpus.mockReturnValue(new Array(64));
    osMock.availableParallelism.mockReturnValue(2);
    const monitor = createLoadAdmissionMonitor();
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS * 4);
    const snapshot = monitor.snapshot();
    expect(snapshot.loadRatio).toBe(0.125);
    expect(snapshot.overloaded).toBe(false);
    monitor.dispose();
  });

  it('resets the histogram every tick so p99 stays window-scoped', () => {
    const monitor = createLoadAdmissionMonitor();
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS * 3);
    expect(histogram.reset).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });

  it('disables the histogram on dispose and stops sampling', () => {
    const monitor = createLoadAdmissionMonitor();
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS);
    monitor.dispose();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS * 3);
    expect(histogram.reset).toHaveBeenCalledTimes(1);
  });
});
