/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoadAdmissionMonitor,
  DISABLED_LOAD_ADMISSION_SNAPSHOT,
  EVENT_LOOP_LAG_ENTER_MS,
  EVENT_LOOP_LAG_EXIT_MS,
  LOAD_ADMISSION_SAMPLE_MS,
  LOAD_ADMISSION_SUSTAIN_SAMPLES,
  LOAD_RATIO_ENTER,
  LOAD_RATIO_EXIT,
  type LoadAdmissionSignals,
} from './load-admission.js';

describe('createLoadAdmissionMonitor', () => {
  let signals: LoadAdmissionSignals;

  beforeEach(() => {
    vi.useFakeTimers();
    signals = { loadRatio: 0.2, eventLoopLagP99Ms: 5 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeMonitor = () =>
    createLoadAdmissionMonitor({ readSignals: () => signals });

  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS);
    }
  };

  it('starts fail-open with an unsampled snapshot', () => {
    const monitor = makeMonitor();
    expect(monitor.snapshot()).toEqual({
      enabled: true,
      overloaded: false,
      reason: null,
      loadRatio: 0,
      eventLoopLagP99Ms: 0,
      sampledAtMs: 0,
    });
    monitor.dispose();
  });

  it('engages the CPU signal only after sustained enter readings', () => {
    const monitor = makeMonitor();
    signals = { loadRatio: LOAD_RATIO_ENTER, eventLoopLagP99Ms: 5 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES - 1);
    expect(monitor.snapshot().overloaded).toBe(false);
    tick(1);
    expect(monitor.snapshot()).toMatchObject({
      overloaded: true,
      reason: 'cpu_load',
      loadRatio: LOAD_RATIO_ENTER,
    });
    monitor.dispose();
  });

  it('resets the enter streak on a single low reading', () => {
    const monitor = makeMonitor();
    signals = { loadRatio: LOAD_RATIO_ENTER + 1, eventLoopLagP99Ms: 5 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES - 1);
    signals = { loadRatio: 0.5, eventLoopLagP99Ms: 5 };
    tick(1);
    signals = { loadRatio: LOAD_RATIO_ENTER + 1, eventLoopLagP99Ms: 5 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES - 1);
    expect(monitor.snapshot().overloaded).toBe(false);
    tick(1);
    expect(monitor.snapshot().overloaded).toBe(true);
    monitor.dispose();
  });

  it('releases the CPU signal only below the exit threshold, sustained', () => {
    const monitor = makeMonitor();
    signals = { loadRatio: LOAD_RATIO_ENTER + 1, eventLoopLagP99Ms: 5 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES);
    expect(monitor.snapshot().overloaded).toBe(true);

    // Inside the hysteresis band: stays overloaded.
    signals = {
      loadRatio: (LOAD_RATIO_ENTER + LOAD_RATIO_EXIT) / 2,
      eventLoopLagP99Ms: 5,
    };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES * 2);
    expect(monitor.snapshot().overloaded).toBe(true);

    signals = { loadRatio: LOAD_RATIO_EXIT - 0.1, eventLoopLagP99Ms: 5 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES - 1);
    expect(monitor.snapshot().overloaded).toBe(true);
    tick(1);
    expect(monitor.snapshot()).toMatchObject({
      overloaded: false,
      reason: null,
    });
    monitor.dispose();
  });

  it('engages and releases the lag signal independently of CPU load', () => {
    const monitor = makeMonitor();
    signals = { loadRatio: 0.2, eventLoopLagP99Ms: EVENT_LOOP_LAG_ENTER_MS };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES);
    expect(monitor.snapshot()).toMatchObject({
      overloaded: true,
      reason: 'event_loop_lag',
    });

    signals = { loadRatio: 0.2, eventLoopLagP99Ms: EVENT_LOOP_LAG_EXIT_MS };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES * 2);
    expect(monitor.snapshot().overloaded).toBe(true);

    signals = {
      loadRatio: 0.2,
      eventLoopLagP99Ms: EVENT_LOOP_LAG_EXIT_MS - 1,
    };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES);
    expect(monitor.snapshot().overloaded).toBe(false);
    monitor.dispose();
  });

  it('ORs the two signals and prefers cpu_load when both are active', () => {
    const monitor = makeMonitor();
    signals = {
      loadRatio: LOAD_RATIO_ENTER + 1,
      eventLoopLagP99Ms: EVENT_LOOP_LAG_ENTER_MS + 1,
    };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES);
    expect(monitor.snapshot().reason).toBe('cpu_load');

    // CPU recovers while lag stays high: still overloaded, reason flips.
    signals = {
      loadRatio: 0.2,
      eventLoopLagP99Ms: EVENT_LOOP_LAG_ENTER_MS + 1,
    };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES);
    expect(monitor.snapshot()).toMatchObject({
      overloaded: true,
      reason: 'event_loop_lag',
    });
    monitor.dispose();
  });

  it('reports the latest readings and a moving sample timestamp', () => {
    const monitor = makeMonitor();
    signals = { loadRatio: 1.25, eventLoopLagP99Ms: 42 };
    tick(1);
    const first = monitor.snapshot();
    expect(first.loadRatio).toBe(1.25);
    expect(first.eventLoopLagP99Ms).toBe(42);
    expect(first.sampledAtMs).toBeGreaterThan(0);
    tick(1);
    expect(monitor.snapshot().sampledAtMs).toBeGreaterThan(first.sampledAtMs);
    monitor.dispose();
  });

  it('stops sampling after dispose and tolerates double dispose', () => {
    const monitor = makeMonitor();
    tick(1);
    const frozen = monitor.snapshot();
    monitor.dispose();
    monitor.dispose();
    signals = { loadRatio: 99, eventLoopLagP99Ms: 99_999 };
    tick(LOAD_ADMISSION_SUSTAIN_SAMPLES * 2);
    expect(monitor.snapshot()).toEqual(frozen);
  });

  it('honors a custom sample cadence', () => {
    const monitor = createLoadAdmissionMonitor({
      readSignals: () => signals,
      sampleMs: 500,
    });
    signals = { loadRatio: LOAD_RATIO_ENTER + 1, eventLoopLagP99Ms: 5 };
    vi.advanceTimersByTime(500 * (LOAD_ADMISSION_SUSTAIN_SAMPLES - 1));
    expect(monitor.snapshot().overloaded).toBe(false);
    vi.advanceTimersByTime(500);
    expect(monitor.snapshot().overloaded).toBe(true);
    monitor.dispose();
  });

  it('builds the real os/perf_hooks reader when no seam is injected', () => {
    const monitor = createLoadAdmissionMonitor();
    // Tick the real reader: the initial zero snapshot would make every
    // assertion below vacuously true.
    vi.advanceTimersByTime(LOAD_ADMISSION_SAMPLE_MS);
    const snapshot = monitor.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.overloaded).toBe(false);
    expect(snapshot.sampledAtMs).toBeGreaterThan(0);
    expect(Number.isFinite(snapshot.loadRatio)).toBe(true);
    expect(snapshot.loadRatio).toBeGreaterThanOrEqual(0);
    // perf_hooks reports nanoseconds; a missing ns→ms conversion would
    // surface here as a multi-million "ms" p99.
    expect(snapshot.eventLoopLagP99Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.eventLoopLagP99Ms).toBeLessThan(60_000);
    monitor.dispose();
  });

  it('publishes a disabled snapshot shape for opt-out status reporting', () => {
    expect(DISABLED_LOAD_ADMISSION_SNAPSHOT).toEqual({
      enabled: false,
      overloaded: false,
      reason: null,
      loadRatio: 0,
      eventLoopLagP99Ms: 0,
      sampledAtMs: 0,
    });
  });
});
