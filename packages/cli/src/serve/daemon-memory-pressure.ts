/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getHeapStatistics } from 'node:v8';

/**
 * Thresholds mirror `MemoryPressureMonitor` in core
 * (`packages/core/src/services/memoryPressureMonitor.ts`), which is the
 * established contract for what these words mean in this codebase. They are
 * duplicated rather than imported: the monitor is only constructed by
 * `Config.initialize()`, which the daemon never calls, and its limit
 * resolution is a private method. Consolidating means extracting from
 * `packages/core/src/services/**`, which is a maintainer-gated change and
 * belongs in its own review.
 */
export const SOFT_PRESSURE_RATIO = 0.5;
export const HARD_PRESSURE_RATIO = 0.65;
export const CRITICAL_PRESSURE_RATIO = 0.8;

export type DaemonMemoryPressureLevel = 'normal' | 'soft' | 'hard' | 'critical';

/**
 * Which side produced the reported ratio, or `unknown` when neither was
 * usable. `unknown` is not the same as `normal`: it says the daemon could not
 * measure its own pressure, which a consumer must not read as "fine".
 *
 * A side is usable only when *both* its numerator and its denominator are, so
 * this is also the field that says a reported `rssBytes: 0` / `heapUsedBytes:
 * 0` is a placeholder rather than a reading.
 */
export type DaemonMemoryPressureSource = 'rss' | 'heap' | 'unknown';

export interface DaemonMemoryPressure {
  level: DaemonMemoryPressureLevel;
  /** The larger of the two ratios below, which is what `level` classifies. */
  ratio: number;
  source: DaemonMemoryPressureSource;
  rssBytes: number;
  rssRatio: number;
  /**
   * Bytes the daemon tree may use: the cgroup limit, else host memory.
   *
   * Those two are not equally trustworthy as a denominator, and
   * `limits.memory.availableMemorySource` is what tells them apart. Under a
   * cgroup (`constrained`) this is exactly the number the OOM killer watches,
   * so `rssRatio` is the real thing. On bare metal (`host`) it is the size of
   * the machine, and the daemon is killed when the *machine* runs out — which
   * depends on every other process on the box. A daemon at 20% of a 64 GB host
   * beside a 55 GB neighbour reports `normal` right up until it dies, so under
   * `source: 'host'` read `rssRatio` as a lower bound on real pressure rather
   * than as a measurement of it. This is a denominator caveat and is not
   * covered by the separate one about the thresholds being uncalibrated.
   */
  availableBytes: number;
  heapUsedBytes: number;
  heapRatio: number;
  /**
   * V8's `heap_size_limit` for this process — the whole heap, not only the old
   * space `--max-old-space-size` names, which is what `heapUsedBytes` measures
   * against.
   */
  heapLimitBytes: number;
}

function classify(ratio: number): DaemonMemoryPressureLevel {
  if (ratio >= CRITICAL_PRESSURE_RATIO) return 'critical';
  if (ratio >= HARD_PRESSURE_RATIO) return 'hard';
  if (ratio >= SOFT_PRESSURE_RATIO) return 'soft';
  return 'normal';
}

/**
 * Classifies the daemon root's memory pressure against two independent
 * denominators, and reports the worse one.
 *
 * Both are needed: a container usually dies by RSS against its cgroup limit,
 * while a process on a large host can exhaust V8's old space long before RSS
 * is a meaningful fraction of the machine. Reporting only one hides whichever
 * failure the deployment is actually heading for.
 *
 * This covers the daemon root process only. Aggregate child RSS is a separate
 * measurement — the sampler currently reads the primary ACP child alone — so
 * this figure must not be read as process-tree pressure.
 */
export function computeDaemonMemoryPressure(input: {
  /** Bytes, to match the sampler's gauges. Callers holding MB must convert. */
  rssBytes: number;
  heapUsedBytes: number;
  /**
   * Bytes. `DaemonMemoryBudget.availableMemoryMb` is in **megabytes** — the
   * one place these two modules meet, and the one place a factor of 1024² can
   * hide, since either unit produces a plausible-looking ratio.
   */
  availableBytes: number;
  /** Test seam; defaults to this process's real V8 ceiling. */
  heapLimitBytes?: number;
}): DaemonMemoryPressure {
  const heapLimitBytes = usableDenominator(
    input.heapLimitBytes ?? getHeapStatistics().heap_size_limit,
  );
  // A denominator that is absent, zero, or non-finite means "not measurable",
  // not "infinitely bad". The sampler already sanitizes non-finite gauges to 0
  // (`finiteGauge` in daemon-metrics-ring), so a 0 arriving here is a real
  // possibility rather than a defensive hypothetical.
  const availableBytes = usableDenominator(input.availableBytes);
  // Numerators need the same treatment, and they need it separately. Coercing
  // an unusable numerator to 0 the way a denominator is coerced would publish
  // `rssBytes: 0, rssRatio: 0, level: 'normal', source: 'rss'` — a claim that
  // the daemon measured itself using almost nothing, indistinguishable on the
  // wire from a genuinely idle daemon. That is the exact confusion `source:
  // 'unknown'` and `sampled: 0` exist to prevent everywhere else here, so an
  // unusable numerator retires its side instead, and `source` reports which
  // side actually produced the ratio. Unreachable from the sole production
  // caller (`process.memoryUsage()` cannot return NaN), but this is a public
  // wire contract and the docs invite readers to check the ratios by hand.
  //
  // Zero is a reading for a numerator and not for a denominator: a daemon
  // using no memory is merely implausible, while dividing by nothing is
  // undefined. Hence the two helpers rather than one.
  const rss = usableNumerator(input.rssBytes);
  const heapUsed = usableNumerator(input.heapUsedBytes);
  const rssBytes = rss ?? 0;
  const heapUsedBytes = heapUsed ?? 0;

  const rssMeasured = availableBytes > 0 && rss !== null;
  const heapMeasured = heapLimitBytes > 0 && heapUsed !== null;
  const rssRatio = rssMeasured ? rssBytes / availableBytes : 0;
  const heapRatio = heapMeasured ? heapUsedBytes / heapLimitBytes : 0;

  let source: DaemonMemoryPressureSource;
  if (!rssMeasured && !heapMeasured) source = 'unknown';
  else if (!heapMeasured) source = 'rss';
  else if (!rssMeasured) source = 'heap';
  // Ties go to RSS. Arbitrary but deterministic, and it only arises when the
  // two ratios are equal — in which case either name describes the same
  // number, and `level` is unaffected either way.
  else source = rssRatio >= heapRatio ? 'rss' : 'heap';

  const ratio = Math.max(rssRatio, heapRatio);
  return {
    level: classify(ratio),
    ratio,
    source,
    rssBytes,
    rssRatio,
    availableBytes,
    heapUsedBytes,
    heapRatio,
    heapLimitBytes,
  };
}

/**
 * Coerces a divisor to a usable positive number; NaN/Infinity/<=0 become 0,
 * which every caller reads as "this denominator is not measurable".
 */
function usableDenominator(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A measured gauge, or `null` when it is not one. Unlike a denominator, 0 is a
 * legitimate reading here, so only non-finite and negative values are retired.
 */
function usableNumerator(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}
