/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const LOAD_ADMISSION_SAMPLE_MS = 2_000;
export const LOAD_RATIO_ENTER = 2.0;
export const LOAD_RATIO_EXIT = 1.0;
export const EVENT_LOOP_LAG_ENTER_MS = 1_000;
export const EVENT_LOOP_LAG_EXIT_MS = 250;
export const LOAD_ADMISSION_SUSTAIN_SAMPLES = 3;

export type LoadAdmissionReason = 'cpu_load' | 'event_loop_lag';

export interface LoadAdmissionSnapshot {
  readonly enabled: boolean;
  readonly overloaded: boolean;
  readonly reason: LoadAdmissionReason | null;
  readonly loadRatio: number;
  readonly eventLoopLagP99Ms: number;
  /** 0 until the first interval tick lands. */
  readonly sampledAtMs: number;
}

export interface LoadAdmissionSignals {
  readonly loadRatio: number;
  readonly eventLoopLagP99Ms: number;
}

/** Status shape reported when no monitor runs (opt-out or injected bridge). */
export const DISABLED_LOAD_ADMISSION_SNAPSHOT: LoadAdmissionSnapshot = {
  enabled: false,
  overloaded: false,
  reason: null,
  loadRatio: 0,
  eventLoopLagP99Ms: 0,
  sampledAtMs: 0,
};

export interface LoadAdmissionMonitorOptions {
  /** Test seam: replaces the real os/perf_hooks reads. */
  readonly readSignals?: () => LoadAdmissionSignals;
  readonly sampleMs?: number;
}

export interface LoadAdmissionMonitor {
  readonly snapshot: () => LoadAdmissionSnapshot;
  readonly dispose: () => void;
}

interface SignalState {
  overloaded: boolean;
  enterStreak: number;
  exitStreak: number;
}

function freshSignalState(): SignalState {
  return { overloaded: false, enterStreak: 0, exitStreak: 0 };
}

// Hysteresis + sustain: a flip needs LOAD_ADMISSION_SUSTAIN_SAMPLES
// consecutive readings past the flip threshold, so a single heavy parse or
// a momentary dip neither engages nor releases the gate.
function advanceSignal(
  state: SignalState,
  value: number,
  enter: number,
  exit: number,
): void {
  if (!state.overloaded) {
    state.enterStreak = value >= enter ? state.enterStreak + 1 : 0;
    if (state.enterStreak >= LOAD_ADMISSION_SUSTAIN_SAMPLES) {
      state.overloaded = true;
      state.exitStreak = 0;
    }
    return;
  }
  state.exitStreak = value < exit ? state.exitStreak + 1 : 0;
  if (state.exitStreak >= LOAD_ADMISSION_SUSTAIN_SAMPLES) {
    state.overloaded = false;
    state.enterStreak = 0;
  }
}

/**
 * Samples host load and daemon event-loop lag on an unref'd interval and
 * caches a synchronous snapshot for fresh-session admission. The admission
 * contract forbids async probes, so the reading is always the last tick's —
 * never a per-request measurement.
 */
export function createLoadAdmissionMonitor(
  options: LoadAdmissionMonitorOptions = {},
): LoadAdmissionMonitor {
  const sampleMs = options.sampleMs ?? LOAD_ADMISSION_SAMPLE_MS;
  const cpu = freshSignalState();
  const lag = freshSignalState();
  let latest: LoadAdmissionSignals = { loadRatio: 0, eventLoopLagP99Ms: 0 };
  let sampledAtMs = 0;
  let disposed = false;

  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let readSignals = options.readSignals;
  if (!readSignals) {
    const loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    histogram = loopDelay;
    const cores = os.availableParallelism();
    readSignals = () => {
      const loadRatio = os.loadavg()[0] / cores;
      // Window-scoped p99: reset after each read so the figure describes
      // the last interval, not the since-start average.
      const eventLoopLagP99Ms = loopDelay.percentile(99) / 1_000_000;
      loopDelay.reset();
      return { loadRatio, eventLoopLagP99Ms };
    };
  }

  const tick = () => {
    latest = readSignals!();
    sampledAtMs = Date.now();
    advanceSignal(cpu, latest.loadRatio, LOAD_RATIO_ENTER, LOAD_RATIO_EXIT);
    advanceSignal(
      lag,
      latest.eventLoopLagP99Ms,
      EVENT_LOOP_LAG_ENTER_MS,
      EVENT_LOOP_LAG_EXIT_MS,
    );
  };
  const timer = setInterval(tick, sampleMs);
  timer.unref();

  return {
    snapshot(): LoadAdmissionSnapshot {
      const overloaded = cpu.overloaded || lag.overloaded;
      return {
        enabled: true,
        overloaded,
        reason: cpu.overloaded
          ? 'cpu_load'
          : lag.overloaded
            ? 'event_loop_lag'
            : null,
        loadRatio: latest.loadRatio,
        eventLoopLagP99Ms: latest.eventLoopLagP99Ms,
        sampledAtMs,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      histogram?.disable();
    },
  };
}
