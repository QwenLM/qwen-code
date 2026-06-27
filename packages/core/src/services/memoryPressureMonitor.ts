/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { getHeapStatistics } from 'node:v8';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { MemoryDiagnosticsDumper } from './memoryDiagnosticsDumper.js';
import { microcompactHistory } from './microcompaction/microcompact.js';
import {
  recordMemoryUsage,
  recordCpuUsage,
  isPerformanceMonitoringActive,
  MemoryMetricType,
} from '../telemetry/metrics.js';

// ─── Runtime Samples Ring Buffer ─────────────────────────────────────────────

/** A single runtime sample capturing memory and CPU at a point in time. */
export interface RuntimeSample {
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  /** CPU usage as a percentage of total system capacity (0–100, normalized by core count). */
  cpuPercent: number;
}

const RING_BUFFER_SIZE = 60;

let cpuCoreCount: number | undefined;

/**
 * Effective CPU core count, resolved lazily and memoized.
 *
 * Resolved on first use (not at import time) so that test files which
 * `vi.mock('node:os')` without a `cpus`/`availableParallelism` export don't
 * crash at module-collection time — this module is transitively imported by
 * `config.ts`, i.e. by almost everything.
 *
 * Prefers `os.availableParallelism()` (Node ≥18.14), which honors cgroup CPU
 * quotas, so a 2-core container on a 64-core host isn't normalized by 64.
 * Falls back to `os.cpus().length`, then to 1 if both are unavailable or throw.
 */
function getCpuCoreCount(): number {
  if (cpuCoreCount === undefined) {
    try {
      cpuCoreCount = os.availableParallelism?.() ?? os.cpus().length ?? 1;
    } catch {
      cpuCoreCount = 1;
    }
    if (!cpuCoreCount || cpuCoreCount < 1) {
      cpuCoreCount = 1;
    }
  }
  return cpuCoreCount;
}

/**
 * `process.cpuUsage()` can throw in restricted containers that lack
 * `/proc/self/stat`. CPU sampling is an optional observability feature, so a
 * failure here must never break the surrounding memory-pressure system —
 * return a zero baseline instead. The next successful call computes its delta
 * against this zero, which at worst over-reports a single sample; far better
 * than the constructor or `reset()` throwing and disabling pressure cleanup.
 */
function safeCpuUsage(): NodeJS.CpuUsage {
  try {
    return process.cpuUsage();
  } catch {
    return { user: 0, system: 0 };
  }
}

/**
 * Ring buffer that holds the most recent N runtime samples.
 * Always active for local diagnostics dumps; OTel metric reporting is
 * gated separately by `isPerformanceMonitoringActive()`.
 */
export class RuntimeSampleRing {
  private readonly samples: RuntimeSample[] = [];
  private prevCpuUsage = safeCpuUsage();
  private prevSampleTime = Date.now();

  /**
   * Record a sample. Accepts a pre-fetched memoryUsage snapshot to avoid
   * a redundant syscall when the caller already has one.
   */
  record(mem: NodeJS.MemoryUsage): RuntimeSample {
    const now = Date.now();
    const elapsed = now - this.prevSampleTime;
    const absCpu = safeCpuUsage();
    const deltaUser = absCpu.user - this.prevCpuUsage.user;
    const deltaSystem = absCpu.system - this.prevCpuUsage.system;
    const cpuTotalUs = deltaUser + deltaSystem;

    // When elapsed is 0 (two checks in the same ms tick) the CPU delta can't be
    // computed yet, so reuse the previous sample's cpuPercent (stale) while still
    // capturing the fresh memory snapshot from `mem`. The sample is still pushed
    // — so the ring is never empty after a recorded check, even on the very first
    // call — and prevCpuUsage/prevSampleTime are left untouched so the CPU delta
    // accumulates into the next sample instead of being permanently lost.
    if (elapsed <= 0) {
      const last = this.samples[this.samples.length - 1];
      return this.push({
        ts: now,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        cpuPercent: last?.cpuPercent ?? 0,
      });
    }

    // process.cpuUsage() aggregates CPU time across all cores, so normalize by
    // the core count to keep cpuPercent within the documented 0–100 range.
    // Both clamps guard against cgroup accounting quirks: the lower bound
    // because cpuUsage() isn't strictly monotonic in some containers/VMs (a
    // delta can come back negative), the upper bound because CPU bursting can
    // transiently spend more CPU-time than wall-clock × core count.
    const cpuPercent = Math.min(
      100,
      Math.max(0, ((cpuTotalUs / (elapsed * 1000)) * 100) / getCpuCoreCount()),
    );

    this.prevCpuUsage = absCpu;
    this.prevSampleTime = now;
    return this.push({
      ts: now,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      cpuPercent: Math.round(cpuPercent * 100) / 100,
    });
  }

  /** Append a sample to the ring, evicting the oldest if over capacity. */
  private push(sample: RuntimeSample): RuntimeSample {
    this.samples.push(sample);
    if (this.samples.length > RING_BUFFER_SIZE) {
      this.samples.shift();
    }
    return sample;
  }

  getAll(): RuntimeSample[] {
    return [...this.samples];
  }

  reset(): void {
    this.samples.length = 0;
    this.prevCpuUsage = safeCpuUsage();
    this.prevSampleTime = Date.now();
  }
}

// Types

export interface MemoryPressureConfig {
  /** RSS / totalmem ratio at which light cleanup begins. Default 0.50. */
  softPressureRatio: number;
  /** RSS / totalmem ratio at which moderate cleanup begins. Default 0.65. */
  hardPressureRatio: number;
  /** RSS / totalmem ratio at which aggressive cleanup begins. Default 0.80. */
  criticalRatio: number;
  /** Minimum ms between consecutive cleanups. Default 5000. */
  cleanupCooldownMs: number;
  /** Allow global.gc() in aggressive cleanup. Requires --expose-gc. */
  enableExplicitGC: boolean;
}

export interface CleanupRecommendation {
  action: 'none' | 'light' | 'moderate' | 'aggressive';
  steps: CleanupStep[];
}

export type CleanupStep =
  | 'clear_file_cache'
  | 'evict_cold_cache'
  | 'evict_stale_cache'
  | 'trigger_gc'
  | 'compact_history';

export interface MemoryCleanupFailureEvent {
  rss: number;
  consecutiveFailures: number;
  recommendation: CleanupRecommendation;
  error: string;
}

export interface MemoryCleanupIneffectiveEvent {
  rss: number;
  freedBytes: number;
  freedRatio: number;
  consecutiveIneffectiveCleanups: number;
  recommendation: CleanupRecommendation;
}

export const DEFAULT_PRESSURE_CONFIG: MemoryPressureConfig = {
  softPressureRatio: 0.5,
  hardPressureRatio: 0.65,
  criticalRatio: 0.8,
  cleanupCooldownMs: 5_000,
  enableExplicitGC: true,
};

// Validation

export function validateMemoryPressureConfig(c: MemoryPressureConfig): void {
  for (const [name, ratio] of [
    ['softPressureRatio', c.softPressureRatio],
    ['hardPressureRatio', c.hardPressureRatio],
    ['criticalRatio', c.criticalRatio],
  ] as const) {
    if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 0.98) {
      throw new Error(`${name} must be a finite ratio in [0.3, 0.98]`);
    }
  }
  if (c.softPressureRatio >= c.hardPressureRatio) {
    throw new Error('softPressureRatio must be < hardPressureRatio');
  }
  if (c.hardPressureRatio >= c.criticalRatio) {
    throw new Error('hardPressureRatio must be < criticalRatio');
  }
  if (!Number.isFinite(c.cleanupCooldownMs) || c.cleanupCooldownMs < 0) {
    throw new Error('cleanupCooldownMs must be a non-negative number');
  }
}

const debugLogger = createDebugLogger('MEMORY_PRESSURE');
const MIN_CGROUP_MEMORY_LIMIT = 64 * 1024 * 1024;

// Monitor

export class MemoryPressureMonitor extends EventEmitter {
  private readonly config: MemoryPressureConfig;
  private readonly coreConfig: Config;

  private pendingCheck = false;
  private cleanupInProgress = false;
  // Sampling runs every pressure check, so a persistent failure would spam the
  // logs. Surface the first failure at error level (so operators can tell
  // "metrics enabled but every sample threw" from "never enabled"), then drop
  // to debug for the repeats.
  private hasLoggedSamplingError = false;
  private activeCleanupAction: CleanupRecommendation['action'] = 'none';
  private lastCleanupAction: CleanupRecommendation['action'] = 'none';
  private queuedCleanupRecommendation?: CleanupRecommendation;
  private lastCleanupTime = 0;
  private consecutiveCleanupFailures = 0;
  private consecutiveIneffectiveCleanups = 0;
  private consecutiveIneffectiveAggressiveCleanups = 0;
  private cleanupGeneration = 0;
  private readonly effectiveMemoryLimit: number;
  private readonly diagnosticsDumper: MemoryDiagnosticsDumper;
  private readonly runtimeSamples = new RuntimeSampleRing();

  constructor(coreConfig: Config, pressureConfig?: MemoryPressureConfig) {
    super();
    this.coreConfig = coreConfig;
    this.config = { ...(pressureConfig ?? DEFAULT_PRESSURE_CONFIG) };
    validateMemoryPressureConfig(this.config);
    this.effectiveMemoryLimit = this.computeEffectiveMemoryLimit();
    this.diagnosticsDumper = new MemoryDiagnosticsDumper(coreConfig);
    const heapSizeLimit = getHeapStatistics().heap_size_limit;
    debugLogger.info(
      `Effective memory limit: ${formatMiB(this.effectiveMemoryLimit)} MiB; ` +
        `V8 heap limit: ${formatMiB(heapSizeLimit)} MiB`,
    );
    if (this.effectiveMemoryLimit <= 0) {
      debugLogger.warn(
        'Effective memory limit is not positive; RSS pressure checks are disabled',
      );
    }
  }

  // Public API

  getConsecutiveFailures(): number {
    return this.consecutiveCleanupFailures;
  }

  resetConsecutiveFailures(): void {
    this.consecutiveCleanupFailures = 0;
    this.consecutiveIneffectiveCleanups = 0;
    this.consecutiveIneffectiveAggressiveCleanups = 0;
  }

  /**
   * Reset session-scoped cleanup state and invalidate any async cleanup tail
   * that was queued against the previous session's cache.
   */
  resetForNewSession(): void {
    this.cleanupGeneration++;
    this.resetConsecutiveFailures();
    this.diagnosticsDumper.resetForNewSession();
    this.runtimeSamples.reset();
    this.cleanupInProgress = false;
    this.activeCleanupAction = 'none';
    this.queuedCleanupRecommendation = undefined;
    this.lastCleanupAction = 'none';
    this.lastCleanupTime = 0;
  }

  /**
   * Schedule a deferred memory check after a tool finishes execution.
   * Uses queueMicrotask to batch checks across concurrently-completing
   * tools within the same event-loop tick.
   */
  scheduleCheck(): void {
    if (this.pendingCheck) return;
    this.pendingCheck = true;
    queueMicrotask(() => {
      try {
        this.performCheck();
      } finally {
        this.pendingCheck = false;
      }
    });
  }

  /** Force an immediate check (e.g. after a concurrent batch completes). */
  performCheck(): void {
    try {
      this.performCheckInternal();
    } catch (err) {
      debugLogger.error(
        `Memory pressure check failed: ${getErrorMessage(err)}`,
      );
    }
  }

  private performCheckInternal(): void {
    // One memoryUsage snapshot per check cycle, shared by pressure-level
    // determination and runtime sampling to avoid a redundant syscall
    // (process.memoryUsage() reads /proc/self/status on Linux).
    const mem = this.readMemoryUsage();
    // Guard on `mem`: passing undefined into getPressureLevel() would make it
    // call readMemoryUsage() a second time (its memSnapshot fallback), firing a
    // redundant failing syscall and logging the same error twice on this cycle.
    const pressure = mem ? this.getPressureLevel(mem) : 'normal';
    if (pressure !== 'critical') {
      this.consecutiveIneffectiveAggressiveCleanups = 0;
    }

    // Always record a runtime sample so the ring buffer has history for
    // local diagnostics dumps, regardless of telemetry state.
    // Telemetry metric reporting is gated separately by isPerformanceMonitoringActive.
    if (mem) {
      try {
        const sample = this.runtimeSamples.record(mem);
        if (isPerformanceMonitoringActive()) {
          recordMemoryUsage(this.coreConfig, sample.rss, {
            memory_type: MemoryMetricType.RSS,
          });
          recordMemoryUsage(this.coreConfig, sample.heapUsed, {
            memory_type: MemoryMetricType.HEAP_USED,
          });
          recordCpuUsage(this.coreConfig, sample.cpuPercent, {});
        }
      } catch (err) {
        const msg = `Runtime sampling failed: ${getErrorMessage(err)}`;
        if (this.hasLoggedSamplingError) {
          debugLogger.debug(msg);
        } else {
          this.hasLoggedSamplingError = true;
          debugLogger.error(msg);
        }
      }
    }

    if (pressure === 'normal') return;

    const recommendation = this.recommendCleanup(pressure);
    if (recommendation.action === 'none') return;

    const now = Date.now();
    const isEscalation =
      cleanupActionRank(recommendation.action) >
      cleanupActionRank(this.lastCleanupAction);
    const cleanupCooldownMs = this.getCleanupCooldownMs(recommendation.action);
    if (!isEscalation && now - this.lastCleanupTime < cleanupCooldownMs) {
      return;
    }

    // Write diagnostics to disk before cleanup. dump() uses a two-phase strategy:
    // Phase 1 (synchronous, before the first await) writes a minimal JSON via
    // writeFileSync — guaranteed to complete before executeCleanup starts because
    // async functions run synchronously up to the first await. Phase 2 enriches
    // the file asynchronously in the background; if it fails the minimal file
    // still survives for debugging.
    if (pressure === 'hard' || pressure === 'critical') {
      void this.diagnosticsDumper.dump(pressure, this.runtimeSamples.getAll());
    }

    this.executeCleanup(recommendation);
  }

  /**
   * Read the current process memory usage, returning undefined (and logging)
   * if the syscall fails. Lets callers share one snapshot per check cycle.
   */
  private readMemoryUsage(): NodeJS.MemoryUsage | undefined {
    try {
      return process.memoryUsage();
    } catch (err) {
      debugLogger.error(
        `Failed to read memory usage for pressure check: ${getErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Determine the current memory pressure level from the stronger of:
   *  - RSS as a fraction of the effective memory limit (cgroup-aware).
   *  - V8 heap usage as a fraction of V8's heap size limit.
   *
   * @param memSnapshot Optional pre-fetched memoryUsage snapshot; when
   *   provided, avoids a redundant process.memoryUsage() syscall.
   */
  getPressureLevel(
    memSnapshot?: NodeJS.MemoryUsage,
  ): 'normal' | 'soft' | 'hard' | 'critical' {
    const mem = memSnapshot ?? this.readMemoryUsage();
    if (!mem) return 'normal';

    const rssRatio =
      this.effectiveMemoryLimit > 0 ? mem.rss / this.effectiveMemoryLimit : 0;
    const heapSizeLimit = getHeapStatistics().heap_size_limit;
    const heapRatio = heapSizeLimit > 0 ? mem.heapUsed / heapSizeLimit : 0;
    const ratio = Math.max(rssRatio, heapRatio);

    if (ratio >= this.config.criticalRatio) return 'critical';
    if (ratio >= this.config.hardPressureRatio) return 'hard';
    if (ratio >= this.config.softPressureRatio) return 'soft';
    return 'normal';
  }

  // Cleanup

  private recommendCleanup(
    pressure: 'soft' | 'hard' | 'critical',
  ): CleanupRecommendation {
    switch (pressure) {
      case 'critical':
        return {
          action: 'aggressive',
          steps: [
            'evict_cold_cache',
            'compact_history',
            'clear_file_cache',
            ...(this.config.enableExplicitGC ? ['trigger_gc' as const] : []),
          ],
        };
      case 'hard':
        return {
          action: 'moderate',
          steps: ['evict_cold_cache', 'compact_history', 'clear_file_cache'],
        };
      case 'soft':
        return {
          action: 'light',
          steps: ['evict_stale_cache'],
        };
      default:
        return assertNever(pressure);
    }
  }

  private executeCleanup(recommendation: CleanupRecommendation): void {
    if (this.cleanupInProgress) {
      const recommendationRank = cleanupActionRank(recommendation.action);
      const activeRank = cleanupActionRank(this.activeCleanupAction);
      const queuedRank = this.queuedCleanupRecommendation
        ? cleanupActionRank(this.queuedCleanupRecommendation.action)
        : 0;
      if (recommendationRank > activeRank && recommendationRank > queuedRank) {
        this.queuedCleanupRecommendation = recommendation;
        debugLogger.debug(
          `Queued escalated cleanup "${recommendation.action}" while ` +
            `"${this.activeCleanupAction}" is in progress`,
        );
      } else {
        debugLogger.debug('Cleanup already in progress, skipping');
      }
      return;
    }
    let memBefore: number;
    try {
      memBefore = process.memoryUsage().rss;
    } catch (err) {
      this.recordCleanupFailure(recommendation, err);
      return;
    }

    this.cleanupInProgress = true;
    this.activeCleanupAction = recommendation.action;
    this.lastCleanupAction = recommendation.action;
    this.lastCleanupTime = Date.now();
    const cleanupGeneration = this.cleanupGeneration;

    void this.runCleanupSteps(recommendation.steps, cleanupGeneration)
      .then(() => {
        if (cleanupGeneration !== this.cleanupGeneration) {
          return;
        }
        this.consecutiveCleanupFailures = 0;
        setImmediate(() => {
          if (cleanupGeneration !== this.cleanupGeneration) {
            return;
          }
          try {
            const memAfter = process.memoryUsage().rss;
            this.logCleanupResult(memBefore, memAfter, recommendation);
          } catch (err) {
            debugLogger.error(
              `Cleanup measurement failed: ${getErrorMessage(err)}`,
            );
          } finally {
            this.finishCleanupAndRunQueued(cleanupGeneration);
          }
        });
      })
      .catch((err) => {
        if (cleanupGeneration !== this.cleanupGeneration) {
          return;
        }
        this.recordCleanupFailure(recommendation, err);
        this.finishCleanupAndRunQueued(cleanupGeneration);
      });
  }

  private finishCleanupAndRunQueued(cleanupGeneration: number): void {
    if (cleanupGeneration !== this.cleanupGeneration) {
      return;
    }
    this.cleanupInProgress = false;
    this.activeCleanupAction = 'none';
    const queuedRecommendation = this.queuedCleanupRecommendation;
    this.queuedCleanupRecommendation = undefined;
    if (queuedRecommendation) {
      try {
        this.executeCleanup(queuedRecommendation);
      } catch (err) {
        this.recordCleanupFailure(queuedRecommendation, err);
      }
    }
  }

  private getCleanupCooldownMs(
    action: CleanupRecommendation['action'],
  ): number {
    const baseCooldownMs = this.config.cleanupCooldownMs;
    if (
      action !== 'aggressive' ||
      baseCooldownMs === 0 ||
      this.consecutiveIneffectiveAggressiveCleanups < 3
    ) {
      return baseCooldownMs;
    }

    const exponent = Math.min(
      this.consecutiveIneffectiveAggressiveCleanups - 2,
      6,
    );
    return baseCooldownMs * 2 ** exponent;
  }

  private logCleanupResult(
    memBefore: number,
    memAfter: number,
    recommendation: CleanupRecommendation,
  ): void {
    const freed = memBefore - memAfter;
    const freedRatio = memBefore > 0 ? freed / memBefore : 0;

    debugLogger.info(
      `Cleanup "${recommendation.action}" completed; RSS delta ${freed} bytes ` +
        `(${(freedRatio * 100).toFixed(1)}%)`,
    );

    if (freedRatio < 0.01) {
      this.consecutiveIneffectiveCleanups++;
      if (recommendation.action === 'aggressive') {
        this.consecutiveIneffectiveAggressiveCleanups++;
      }
      if (shouldEmitRepeatedDiagnostic(this.consecutiveIneffectiveCleanups)) {
        const event = {
          rss: memAfter,
          freedBytes: freed,
          freedRatio,
          consecutiveIneffectiveCleanups: this.consecutiveIneffectiveCleanups,
          recommendation,
        } satisfies MemoryCleanupIneffectiveEvent;
        debugLogger.warn(
          `Cleanup "${recommendation.action}" has been ineffective ` +
            `${this.consecutiveIneffectiveCleanups} times consecutively`,
        );
        this.emitSafely('memory-cleanup-ineffective', event);
      }
      return;
    }

    this.consecutiveIneffectiveCleanups = 0;
    if (recommendation.action === 'aggressive') {
      this.consecutiveIneffectiveAggressiveCleanups = 0;
    }
  }

  private recordCleanupFailure(
    recommendation: CleanupRecommendation,
    err: unknown,
  ): void {
    const error = getErrorMessage(err);
    let rss = 0;
    try {
      rss = process.memoryUsage().rss;
    } catch (rssErr) {
      debugLogger.error(
        `Failed to read RSS after cleanup failure: ${getErrorMessage(rssErr)}`,
      );
    }

    this.consecutiveCleanupFailures++;
    debugLogger.error(
      `Cleanup "${recommendation.action}" failed: ${error}; ` +
        `consecutive failures: ${this.consecutiveCleanupFailures}`,
    );

    if (shouldEmitRepeatedDiagnostic(this.consecutiveCleanupFailures)) {
      this.emitSafely('memory-cleanup-failed', {
        rss,
        consecutiveFailures: this.consecutiveCleanupFailures,
        recommendation,
        error,
      } satisfies MemoryCleanupFailureEvent);
    }
  }

  private emitSafely(eventName: string, event: unknown): void {
    try {
      this.emit(eventName, event);
    } catch (err) {
      debugLogger.error(`${eventName} handler threw: ${getErrorMessage(err)}`);
    }
  }

  private async runCleanupSteps(
    steps: CleanupStep[],
    cleanupGeneration: number,
  ): Promise<void> {
    for (const step of steps) {
      if (cleanupGeneration !== this.cleanupGeneration) {
        return;
      }
      this.executeStep(step);
      // Keep a promise boundary between steps so escalated cleanups can queue
      // behind the active cleanup instead of interleaving in the same stack.
      await Promise.resolve();
    }
  }

  private executeStep(step: CleanupStep): void {
    switch (step) {
      case 'clear_file_cache': {
        this.coreConfig.getFileReadCache().clear();
        debugLogger.debug('FileReadCache cleared');
        break;
      }
      case 'evict_cold_cache': {
        const evicted = this.coreConfig
          .getFileReadCache()
          .evictNotAccessedSince(30);
        debugLogger.debug(`FileReadCache cold eviction: ${evicted} entries`);
        break;
      }
      case 'evict_stale_cache': {
        const evicted = this.coreConfig
          .getFileReadCache()
          .evictNotAccessedSince(60);
        debugLogger.debug(`FileReadCache stale eviction: ${evicted} entries`);
        break;
      }
      case 'trigger_gc': {
        if (typeof global.gc === 'function') {
          const before = process.memoryUsage().rss;
          global.gc();
          const after = process.memoryUsage().rss;
          debugLogger.debug(`global.gc() freed ${before - after} bytes`);
        } else {
          debugLogger.warn(
            'trigger_gc requested but global.gc is not available; ' +
              'start Node.js with --expose-gc',
          );
        }
        break;
      }
      case 'compact_history': {
        try {
          const client = this.coreConfig.getGeminiClient?.();
          if (!client?.isInitialized?.()) {
            debugLogger.debug(
              '[COMPACT_HISTORY] skipped: client not initialized',
            );
            break;
          }
          const chat = client.getChat();
          const history = chat.getHistoryShallow?.() ?? chat.getHistory();
          const settings = this.coreConfig.getClearContextOnIdle();
          const result = microcompactHistory(history, Date.now() - 1, {
            ...settings,
            toolResultsThresholdMinutes:
              (settings.toolResultsThresholdMinutes ?? 0) < 0
                ? settings.toolResultsThresholdMinutes
                : 0,
          });
          if (result.meta) {
            chat.setHistory(result.history);
            // Explicitly clear fileReadCache here instead of relying on
            // the subsequent clear_file_cache step. This removes the
            // implicit coupling between step ordering.
            this.coreConfig.getFileReadCache().clear();
            const m = result.meta;
            debugLogger.debug(
              `[COMPACT_HISTORY] cleared ${m.toolsCleared} tool result(s) ` +
                `+ ${m.mediaCleared} media (~${m.tokensSaved} tokens), ` +
                `kept ${m.toolsKept} tool / ${m.mediaKept} media`,
            );
          } else {
            debugLogger.debug('[COMPACT_HISTORY] nothing to compact');
          }
        } catch (err) {
          debugLogger.error(
            `[COMPACT_HISTORY] failed: ${getErrorMessage(err)}`,
          );
        }
        break;
      }
      default:
        return assertNever(step);
    }
  }

  // Memory metrics

  private computeEffectiveMemoryLimit(): number {
    const hostTotal = os.totalmem();
    const cgroupV2Limit = this.readCgroupMemoryLimit(
      '/sys/fs/cgroup/memory.max',
      hostTotal,
    );
    if (cgroupV2Limit !== undefined) {
      debugLogger.info(
        `Using cgroup v2 memory limit: ${formatMiB(cgroupV2Limit)} MiB`,
      );
      return cgroupV2Limit;
    }

    const cgroupV1Limit = this.readCgroupMemoryLimit(
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
      hostTotal,
    );
    if (cgroupV1Limit !== undefined) {
      debugLogger.info(
        `Using cgroup v1 memory limit: ${formatMiB(cgroupV1Limit)} MiB`,
      );
      return cgroupV1Limit;
    }

    debugLogger.info(`Using host memory limit: ${formatMiB(hostTotal)} MiB`);
    return hostTotal;
  }

  private readCgroupMemoryLimit(
    filePath: string,
    hostTotal: number,
  ): number | undefined {
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (raw === 'max') return undefined;

      if (!/^-?\d+$/.test(raw)) {
        debugLogger.warn(
          `Ignoring non-numeric cgroup memory limit from ${filePath}: ${raw}`,
        );
        return undefined;
      }

      const limit = Number(raw);
      if (!Number.isFinite(limit) || limit <= 0) {
        debugLogger.warn(
          `Ignoring out-of-range cgroup memory limit from ${filePath}: ${raw}`,
        );
        return undefined;
      }
      if (limit < MIN_CGROUP_MEMORY_LIMIT) {
        debugLogger.warn(
          `Ignoring unrealistically small cgroup memory limit from ` +
            `${filePath}: ${raw}`,
        );
        return undefined;
      }

      // cgroup v1 represents "unlimited" with huge sentinel values.
      if (!Number.isSafeInteger(limit)) {
        debugLogger.debug(
          `Ignoring unlimited cgroup memory limit from ${filePath}: ${raw}`,
        );
        return undefined;
      }
      if (hostTotal > 0 && limit > hostTotal) {
        debugLogger.debug(
          `Ignoring cgroup memory limit above host total from ${filePath}: ` +
            `${raw}`,
        );
        return undefined;
      }

      return limit;
    } catch (err) {
      debugLogger.debug(
        `Failed to read cgroup memory limit from ${filePath}: ` +
          getErrorMessage(err),
      );
      return undefined;
    }
  }
}

function cleanupActionRank(action: CleanupRecommendation['action']): number {
  switch (action) {
    case 'aggressive':
      return 3;
    case 'moderate':
      return 2;
    case 'light':
      return 1;
    case 'none':
      return 0;
    default:
      return assertNever(action);
  }
}

function shouldEmitRepeatedDiagnostic(count: number): boolean {
  // Emit once at the threshold, once soon after, then every 20 repeats so
  // sustained pressure remains visible without flooding event listeners.
  return count === 3 || count === 10 || (count > 10 && count % 20 === 0);
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled memory pressure monitor value: ${String(value)}`);
}
