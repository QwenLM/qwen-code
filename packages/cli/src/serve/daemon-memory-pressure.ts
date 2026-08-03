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
 * Which denominator produced the reported ratio, or `unknown` when neither was
 * usable. `unknown` is not the same as `normal`: it says the daemon could not
 * measure its own pressure, which a consumer must not read as "fine".
 */
export type DaemonMemoryPressureSource = 'rss' | 'heap' | 'unknown';

export interface DaemonMemoryPressure {
  level: DaemonMemoryPressureLevel;
  /** The larger of the two ratios below, which is what `level` classifies. */
  ratio: number;
  source: DaemonMemoryPressureSource;
  rssBytes: number;
  rssRatio: number;
  /** Bytes the daemon tree may use: the cgroup limit, else host memory. */
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
  const heapLimitBytes = usable(
    input.heapLimitBytes ?? getHeapStatistics().heap_size_limit,
  );
  // A denominator that is absent, zero, or non-finite means "not measurable",
  // not "infinitely bad". The sampler already sanitizes non-finite gauges to 0
  // (`finiteGauge` in daemon-metrics-ring), so a 0 arriving here is a real
  // possibility rather than a defensive hypothetical.
  const availableBytes = usable(input.availableBytes);
  const rssBytes = usable(input.rssBytes);
  const heapUsedBytes = usable(input.heapUsedBytes);

  const rssMeasured = availableBytes > 0;
  const heapMeasured = heapLimitBytes > 0;
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

/** Coerces a gauge to a usable non-negative number; NaN/Infinity become 0. */
function usable(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
