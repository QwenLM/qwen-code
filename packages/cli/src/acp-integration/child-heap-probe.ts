/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  constants as perfConstants,
  PerformanceObserver,
} from 'node:perf_hooks';
import * as v8 from 'node:v8';
import { QWEN_CODE_SERVE_ENV } from '../config/acp-channel-fallback.js';

/**
 * Spaces that count against `--max-old-space-size`. Summed.
 *
 * `old_space` alone is not the bound and reporting it would be actively
 * misleading: a child driven to a real OOM at `--max-old-space-size=256` held
 * `old_space` at 3 MB throughout while every byte accumulated in
 * `large_object_space`. V8's large-object threshold measures at 128 KiB, which
 * transcripts, journals, and replay rings all clear, so the daemon's most
 * likely growth is exactly what an `old_space`-only figure cannot see.
 */
const OLD_GENERATION_SPACES: ReadonlySet<string> = new Set([
  'old_space',
  'large_object_space',
  'code_space',
  'code_large_object_space',
  'trusted_space',
  'trusted_large_object_space',
  'shared_space',
  'shared_large_object_space',
  'shared_trusted_space',
  'shared_trusted_large_object_space',
]);

/**
 * Spaces knowingly excluded from the old-generation sum.
 *
 * A second set rather than an "everything else is unknown" rule. With one set,
 * `new_space` and `read_only_space` would land in `unclassifiedSpaceNames` on
 * every healthy child, and a field that is never empty carries no signal.
 */
const NON_OLD_GENERATION_SPACES: ReadonlySet<string> = new Set([
  'new_space',
  'new_large_object_space',
  'read_only_space',
]);

/**
 * A floor under long GC-free stretches, not the primary trigger. Deliberately
 * coarse: GC entries are what track the peaks, so this only has to stop an
 * idle-then-busy child from carrying a stale committed mark.
 */
const SAMPLE_INTERVAL_MS = 30_000;

export interface ChildHeapProbeSnapshot {
  /**
   * Lifetime high-water of committed old-generation bytes.
   *
   * Limit-dependent: V8 defers major GC in proportion to the ceiling it was
   * given, so the same workload commits roughly twice as much under a 16 GB
   * ceiling as under a ~600 MB one. Read it as an upper bound — a peak at or
   * below a candidate ceiling is strong evidence the child would survive it,
   * but a peak above one proves nothing on its own.
   */
  peakOldGenerationBytes: number;
  /**
   * Lifetime high-water of old-generation bytes still live after a major GC.
   *
   * Limit-independent — measured identical to the decimal under 16 GB and
   * ~600 MB ceilings — because it is what the workload retains rather than how
   * much rope V8 was given. That is what lets it refuse: a child whose
   * retained data exceeds a ceiling cannot run under it, whatever GC does
   * about the garbage.
   *
   * Read as an **upper bound** on the live set, not an exact one. GC entries
   * reach a `PerformanceObserver` asynchronously and in batches, so the read
   * happens at the first opportunity after the collection rather than at the
   * instant it ends, and anything allocated in between is counted. The error
   * is small in practice — the two-ceiling comparison above was taken this way
   * and still separated cleanly from the committed figure — but it runs
   * upward, so a consumer refusing on this figure risks a false refusal rather
   * than a missed one.
   */
  peakLiveSetBytes: number;
  /**
   * Lifetime high-water of `getHeapStatistics().total_heap_size`.
   *
   * A cross-check that needs no space name, and a deliberately weak one: it
   * includes the new generation, so the gap between it and the old-generation
   * sum is never zero and cannot localise a missing space. It bounds how much
   * the sum could be missing; `unclassifiedSpaceNames` says whether it is.
   */
  peakTotalHeapBytes: number;
  /** Major collections observed over the child's lifetime. */
  majorGcCount: number;
  /**
   * Total major-GC pause time. Lowering a ceiling trades memory for GC time,
   * so a policy that reports only whether children "fit" could make every
   * child materially slower with nothing on the wire saying so.
   */
  majorGcMs: number;
  /**
   * Heap space names in neither known set, so neither summed nor knowingly
   * excluded. Empty on every taxonomy known today.
   *
   * Node 22 reports 11 heap spaces and Node 24 reports 13 — `map_space` was
   * removed and the `trusted_*` spaces were added — and this repo supports
   * both, so a name-based sum has to survive a taxonomy it has never seen. The
   * direction it fails in is what makes this field necessary: an unknown space
   * silently dropped from the sum makes a child look like it fits a ceiling it
   * does not. Any consumer must treat a non-empty list as coverage unknown
   * rather than as a complete measurement.
   */
  unclassifiedSpaceNames: string[];
}

export interface ChildHeapProbe {
  /**
   * The lifetime marks, or `undefined` until at least one space read has
   * succeeded. A child whose every `getHeapSpaceStatistics()` call throws —
   * the restricted-container case the `catch` in `sample` exists for — must
   * not report a zeroed object with `unclassifiedSpaceNames: []`: downstream
   * that reads as measured, needs-nothing, and coverage-complete, the
   * manufactured zero the bridge and status layers refuse to emit. Omitting
   * the report matches what a child without the probe already sends.
   */
  snapshot(): ChildHeapProbeSnapshot | undefined;
  stop(): void;
}

/**
 * Whether this process should measure its own old-generation heap.
 *
 * Only daemon-spawned ACP children do. `QWEN_CODE_SERVE` is the marker the
 * daemon already stamps on the children it spawns, so gating on it leaves the
 * interactive CLI, the IDE companion, direct-embed bridges, and standalone ACP
 * with no GC observer and no consumer for one — and a workspace cannot forge
 * it through `.env` or `settings.env`.
 *
 * Compared against the exact string `'1'`, matching
 * `acp-channel-fallback.ts`. The looser check this avoids is a bug the marker
 * has already had once: `'0'` and `'false'` are truthy strings, and an
 * operator who sets `QWEN_CODE_SERVE=0` means the opposite of what a
 * truthiness test would conclude.
 */
export function shouldProbeChildHeap(env: NodeJS.ProcessEnv): boolean {
  return env[QWEN_CODE_SERVE_ENV] === '1';
}

interface ChildHeapProbeOptions {
  /** Injectable for tests; defaults to the real V8 readings. */
  heapSpaceStatistics?: () => v8.HeapSpaceInfo[];
  heapStatistics?: () => v8.HeapInfo;
  intervalMs?: number;
  /**
   * Injectable for tests; defaults to a `PerformanceObserver` on `gc`
   * entries. Throws where the runtime has no such entry type.
   */
  gcObserver?: (callback: (entries: PerformanceEntry[]) => void) => {
    disconnect(): void;
  };
}

/**
 * Accumulates lifetime old-generation high-water marks inside an ACP child.
 *
 * The marks accumulate here, in the child, rather than being sampled by the
 * daemon's poll, for two independent reasons. The poll runs every 5 s and is
 * gated on an active SSE/WS watcher, so with no client attached it takes no
 * sample at all while the child keeps running — observed on a live daemon
 * reporting one active child and zero samples. And a peak can be entirely
 * invisible to a cadence: a 1 s sampler recorded 0 MB across a workload whose
 * GC-triggered peak was 125 MB.
 *
 * Nothing here is reset. The marks describe the whole lifetime of the process,
 * which is the right scope for "did this child ever need more than the
 * ceiling"; a channel swap replaces the child, so lifetime and channel
 * generation coincide.
 */
export function startChildHeapProbe(
  options: ChildHeapProbeOptions = {},
): ChildHeapProbe {
  const readSpaces =
    options.heapSpaceStatistics ?? (() => v8.getHeapSpaceStatistics());
  const readHeap = options.heapStatistics ?? (() => v8.getHeapStatistics());

  let peakOldGenerationBytes = 0;
  let peakLiveSetBytes = 0;
  let peakTotalHeapBytes = 0;
  let majorGcCount = 0;
  let majorGcMs = 0;
  let sampled = false;
  const unclassified = new Set<string>();

  // Best-effort throughout, mirroring how the `workspaceResource` handler
  // already wraps `memoryUsage()` and `cpuUsage()`: a throw in a restricted
  // container leaves the accumulators at their last good values instead of
  // failing the poll that reads them.
  const sample = (afterMajorGc: boolean): void => {
    try {
      let committed = 0;
      let live = 0;
      for (const space of readSpaces()) {
        const name = space.space_name;
        if (OLD_GENERATION_SPACES.has(name)) {
          committed += space.space_size;
          live += space.space_used_size;
        } else if (!NON_OLD_GENERATION_SPACES.has(name)) {
          unclassified.add(name);
        }
      }
      if (committed > peakOldGenerationBytes)
        peakOldGenerationBytes = committed;
      // Only after a major GC. A used-size read at any other moment includes
      // uncollected garbage, which would reintroduce exactly the
      // limit-dependence that makes this the refusal figure.
      if (afterMajorGc && live > peakLiveSetBytes) peakLiveSetBytes = live;
      // Gated on the space read specifically: it is what feeds the old-gen
      // figures and `unclassifiedSpaceNames`, so its success is what makes a
      // report worth publishing at all.
      sampled = true;
    } catch {
      /* restricted container — keep the last good values */
    }
    try {
      const total = readHeap().total_heap_size;
      if (total > peakTotalHeapBytes) peakTotalHeapBytes = total;
    } catch {
      /* as above */
    }
  };

  sample(false);

  let observer: { disconnect(): void } | undefined;
  try {
    const observe =
      options.gcObserver ??
      ((callback: (entries: PerformanceEntry[]) => void) => {
        const performanceObserver = new PerformanceObserver((list) =>
          callback(list.getEntries()),
        );
        performanceObserver.observe({ entryTypes: ['gc'] });
        return performanceObserver;
      });
    observer = observe((entries) => {
      for (const entry of entries) {
        const isMajor =
          (entry as { detail?: { kind?: number } }).detail?.kind ===
          perfConstants.NODE_PERFORMANCE_GC_MAJOR;
        if (isMajor) {
          majorGcCount += 1;
          majorGcMs += entry.duration;
        }
        sample(isMajor);
      }
    });
  } catch {
    // No GC entries on this runtime. The interval below still produces
    // committed and total marks; `peakLiveSetBytes` stays 0, which reads as
    // "no major GC was observed" rather than as a measured zero.
    observer = undefined;
  }

  const timer = setInterval(
    () => sample(false),
    options.intervalMs ?? SAMPLE_INTERVAL_MS,
  );
  // Never hold the child open on account of observation.
  timer.unref?.();

  return {
    snapshot() {
      // Refresh the committed and total marks so a caller polling an idle
      // child is not told a value older than the interval.
      sample(false);
      // Nothing successfully measured yet — report absence, not zeros.
      if (!sampled) return undefined;
      return {
        peakOldGenerationBytes,
        peakLiveSetBytes,
        peakTotalHeapBytes,
        majorGcCount,
        majorGcMs,
        unclassifiedSpaceNames: [...unclassified],
      };
    },
    stop() {
      clearInterval(timer);
      observer?.disconnect();
    },
  };
}
