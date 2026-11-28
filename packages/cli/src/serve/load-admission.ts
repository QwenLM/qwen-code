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
export const LOAD_CORROBORATION_ENTER_MS = 250;
export const LOAD_CORROBORATION_EXIT_MS = 100;
export const LOAD_ADMISSION_SUSTAIN_SAMPLES = 3;

export type LoadAdmissionReason =
  | 'cpu_load'
  | 'event_loop_lag'
  | 'observation_gap';

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
  /**
   * False when the CPU signal could not be read (core count unavailable).
   * The tick then skips the CPU state machine instead of feeding it a
   * fabricated 0, which would release a latched `cpu_load` on a reading
   * that carries no information. Omitted means readable.
   */
  readonly loadReadable?: boolean;
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
  /**
   * Monotonic millisecond clock for the observation-gap latch. Deliberately
   * not Date.now(): an NTP step or suspend must not fake a sampling gap.
   */
  readonly now?: () => number;
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
// a momentary dip neither engages nor releases the gate. An optional
// corroboration couples the flip to a second signal: enter additionally
// requires it, exit is satisfied by either the value draining or the
// corroboration clearing.
function advanceSignal(
  state: SignalState,
  value: number,
  enter: number,
  exit: number,
  corroborate?: { enter: boolean; exit: boolean },
): void {
  if (!state.overloaded) {
    const enterOk = value >= enter && (corroborate?.enter ?? true);
    state.enterStreak = enterOk ? state.enterStreak + 1 : 0;
    if (state.enterStreak >= LOAD_ADMISSION_SUSTAIN_SAMPLES) {
      state.overloaded = true;
      state.exitStreak = 0;
    }
    return;
  }
  const exitOk = value < exit || (corroborate?.exit ?? false);
  state.exitStreak = exitOk ? state.exitStreak + 1 : 0;
  if (state.exitStreak >= LOAD_ADMISSION_SUSTAIN_SAMPLES) {
    state.overloaded = false;
    state.enterStreak = 0;
  }
}

/**
 * Host load per core, or 0 when the CPU signal is unreadable. `os.cpus()`
 * returns an empty array on Android/Termux (libuv cannot read /proc/stat)
 * while /proc/loadavg stays readable, so `loadavg / 0` is `Infinity`:
 * `Infinity >= LOAD_RATIO_ENTER` holds on every sample and
 * `Infinity < LOAD_RATIO_EXIT` never does, which latches `cpu_load`
 * permanently. An unreadable core count is not evidence of overload, so the
 * CPU signal reports 0 and the event-loop lag / observation-gap signals keep
 * guarding admission. Core count stays host scope on purpose (see the note
 * in createLoadAdmissionMonitor).
 */
export function hostLoadRatio(loadavg1m: number, cores: number): number {
  if (!Number.isFinite(loadavg1m) || !(cores > 0)) return 0;
  return loadavg1m / cores;
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
  const now = options.now ?? (() => performance.now());
  const cpu = freshSignalState();
  const lag = freshSignalState();
  let latest: LoadAdmissionSignals = { loadRatio: 0, eventLoopLagP99Ms: 0 };
  let sampledAtMs = 0;
  let disposed = false;
  // Observation-gap latch: a stalled event loop runs no ticks, so the cached
  // verdict would stay healthy exactly when the lag signal matters. Latch
  // when the monotonic age of the last tick exceeds three intervals; clear
  // only after three timely healthy ticks. Cold start (no tick yet) stays
  // fail-open by design.
  let lastTickMono: number | null = null;
  let gapLatched = false;
  let healthyTimelyStreak = 0;

  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let readSignals = options.readSignals;
  if (!readSignals) {
    const loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    histogram = loopDelay;
    // Host scope on both sides: /proc/loadavg is not namespaced, while
    // availableParallelism() honours cgroup quota/affinity — dividing one by
    // the other latches a CPU-limited daemon into permanent refusals.
    // Container-level starvation is the event-loop-lag signal's job.
    // Read once, as before; keep retrying only while it is unreadable (0).
    let cores = 0;
    readSignals = () => {
      if (!(cores > 0)) cores = os.cpus().length;
      const load = os.loadavg()[0];
      const loadRatio = hostLoadRatio(load, cores);
      const loadReadable = cores > 0 && Number.isFinite(load);
      // Window-scoped p99: reset after each read so the figure describes
      // the last interval, not the since-start average.
      const eventLoopLagP99Ms = loopDelay.percentile(99) / 1_000_000;
      loopDelay.reset();
      return { loadRatio, eventLoopLagP99Ms, loadReadable };
    };
  }

  const tick = () => {
    const mono = now();
    const timely = lastTickMono === null || mono - lastTickMono <= 3 * sampleMs;
    if (!timely) {
      // Overdue ticks often fire before queued HTTP handlers on the timers
      // phase; latch here too so refreshing lastTickMono does not erase the
      // stall before snapshot() sees it.
      gapLatched = true;
      healthyTimelyStreak = 0;
    }
    lastTickMono = mono;
    latest = readSignals!();
    sampledAtMs = Date.now();
    // Linux loadavg counts uninterruptible IO wait, so an IO storm refuses
    // creations with idle CPUs; macOS (XNU) loadavg samples runnable
    // threads, but its decaying average still rides high after a boot or
    // indexing CPU burst while CPUs and this loop have gone idle
    // (2026-11-26 Spotlight storm: ratio 10.8, 63% idle CPU, p99 21–30 ms,
    // ~13 min of false refusals). Either way host load alone misreads
    // daemon capacity: engage only when the loop already feels the
    // pressure; release once it is healthy again, even if host load stays
    // high.
    // An unreadable CPU signal is a non-reading, not a reading of zero: skip
    // the state machine so it neither latches nor releases on it. Releasing
    // on a fabricated 0 would also let the corroboration-OR clear an already
    // latched cpu_load, and block the clear while the loop stays busy.
    if (latest.loadReadable !== false) {
      advanceSignal(cpu, latest.loadRatio, LOAD_RATIO_ENTER, LOAD_RATIO_EXIT, {
        enter: latest.eventLoopLagP99Ms >= LOAD_CORROBORATION_ENTER_MS,
        exit: latest.eventLoopLagP99Ms < LOAD_CORROBORATION_EXIT_MS,
      });
    }
    advanceSignal(
      lag,
      latest.eventLoopLagP99Ms,
      EVENT_LOOP_LAG_ENTER_MS,
      EVENT_LOOP_LAG_EXIT_MS,
    );
    // Skipped intervals are not healthy readings: only timely ticks with
    // both signals clear count toward releasing an active gap latch.
    if (gapLatched) {
      if (timely && !cpu.overloaded && !lag.overloaded) {
        healthyTimelyStreak += 1;
        if (healthyTimelyStreak >= LOAD_ADMISSION_SUSTAIN_SAMPLES) {
          gapLatched = false;
          healthyTimelyStreak = 0;
        }
      } else {
        healthyTimelyStreak = 0;
      }
    }
  };
  const timer = setInterval(tick, sampleMs);
  timer.unref();

  let frozen: LoadAdmissionSnapshot | null = null;
  const snapshot = (): LoadAdmissionSnapshot => {
    // A disposed monitor is dead: freeze its last verdict instead of
    // re-deriving a gap from a clock that keeps moving.
    if (disposed && frozen) return frozen;
    if (lastTickMono !== null && now() - lastTickMono > 3 * sampleMs) {
      gapLatched = true;
    }
    const overloaded = gapLatched || cpu.overloaded || lag.overloaded;
    const verdict: LoadAdmissionSnapshot = {
      enabled: true,
      overloaded,
      reason: gapLatched
        ? 'observation_gap'
        : cpu.overloaded
          ? 'cpu_load'
          : lag.overloaded
            ? 'event_loop_lag'
            : null,
      loadRatio: latest.loadRatio,
      eventLoopLagP99Ms: latest.eventLoopLagP99Ms,
      sampledAtMs,
    };
    frozen = verdict;
    return verdict;
  };
  return {
    snapshot,
    dispose() {
      if (disposed) return;
      frozen = snapshot();
      disposed = true;
      clearInterval(timer);
      histogram?.disable();
    },
  };
}
