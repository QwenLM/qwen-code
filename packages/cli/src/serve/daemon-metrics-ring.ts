/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One time-bucketed sample of daemon activity, sized for bottleneck analysis:
 * load, throughput, latency, resource pressure, and token burn are all stamped
 * on the SAME timeline so an operator can line up "10 tasks running at once"
 * against event-loop lag, queue wait, memory, and API latency to see *where*
 * the daemon is actually spending / stalling.
 *
 * Each bucket covers the window `(t - intervalMs, t]`. Fields fall into two
 * kinds:
 *  - **window aggregates** (`requests`, `tokensIn`, the `*P95Ms`/`*P50Ms`
 *    percentiles, `promptsCompleted`): summarize everything that happened
 *    *during* the window.
 *  - **gauges** (`activeSessions`, `activePrompts`, `rssBytes`,
 *    `heapUsedBytes`, `eventLoopLagP99Ms`): the instantaneous reading at seal
 *    time `t`.
 * Windowing server-side means the client never diffs cumulative counters — it
 * plots the series verbatim.
 */
export interface DaemonMetricsBucket {
  /** Epoch ms at which this bucket was sealed (window end). */
  t: number;

  // —— Load / concurrency (gauge @ seal) ——
  /** Active sessions at seal time. */
  activeSessions: number;
  /** In-flight prompts at seal time — the count of tasks running concurrently. */
  activePrompts: number;

  // —— HTTP throughput / latency (window aggregate) ——
  /** HTTP requests completed in this window. */
  requests: number;
  /** Subset of `requests` that returned a 4xx/5xx status. */
  errors: number;
  /** Median HTTP request duration over the window (ms); 0 when idle. */
  latencyP50Ms: number;
  /** p95 HTTP request duration over the window (ms); 0 when idle. */
  latencyP95Ms: number;

  // —— Prompt (task) latency (window aggregate) ——
  /** Prompts that finished in this window (task throughput). */
  promptsCompleted: number;
  /** p95 time prompts spent waiting in the per-session FIFO queue (ms); 0 when
   *  none finished. A rising queue-wait under load is the backpressure signal. */
  promptQueueWaitP95Ms: number;
  /** p95 end-to-end prompt duration, dispatch→completion (ms); 0 when none. */
  promptDurationP95Ms: number;

  // —— Resource pressure (gauge @ seal) ——
  /** Resident set size at seal time (bytes). */
  rssBytes: number;
  /** V8 heap used at seal time (bytes). */
  heapUsedBytes: number;
  /** Event-loop lag p99 over the window (ms) — the CPU-saturation / blocking
   *  signal. Sampled from a window-scoped histogram the host resets each seal,
   *  so it reflects *this* interval, not a since-start average. */
  eventLoopLagP99Ms: number;

  // —— Token burn (window aggregate) ——
  /** Input (prompt) tokens attributed to model turns in this window. */
  tokensIn: number;
  /** Output (completion) tokens attributed to model turns in this window. */
  tokensOut: number;
}

/** Instantaneous gauges the host reads and hands to {@link DaemonMetricsRing.sample}. */
export interface DaemonMetricsGauges {
  rssBytes: number;
  heapUsedBytes: number;
  activeSessions: number;
  activePrompts: number;
  eventLoopLagP99Ms: number;
}

export interface DaemonMetricsRingOptions {
  /** Max buckets retained; the oldest is evicted once full. */
  capacity: number;
}

// Cap the per-window sample used for percentiles so a burst in a single
// interval can't grow an unbounded array. Far more than a loopback daemon sees
// in one window, and keeps the per-seal sort cheap; the plain counters
// (`requests`, `promptsCompleted`, tokens) still accrue exactly past the cap.
const MAX_SAMPLES_PER_WINDOW = 4096;

/**
 * Fixed-size ring of {@link DaemonMetricsBucket}. Accumulates event-driven
 * activity (requests, prompt latencies, tokens) into an open window;
 * {@link sample} folds in the gauges and seals the window into a bucket on a
 * fixed cadence driven by the daemon host. Pure data structure — no Node/timer
 * deps — so it unit-tests directly and the host owns the clock and the
 * gauge reads. Lives in the daemon process, so history survives dialog
 * open/close and browser reload.
 */
export class DaemonMetricsRing {
  private readonly capacity: number;
  private readonly buckets: DaemonMetricsBucket[] = [];
  private curRequests = 0;
  private curErrors = 0;
  private readonly curDurations: number[] = [];
  private curPromptsCompleted = 0;
  private readonly curQueueWaits: number[] = [];
  private readonly curPromptDurations: number[] = [];
  private curTokensIn = 0;
  private curTokensOut = 0;

  constructor(options: DaemonMetricsRingOptions) {
    this.capacity = Math.max(1, Math.floor(options.capacity));
  }

  /** Fold one completed HTTP request into the open window. */
  recordRequest(durationMs: number, statusCode: number): void {
    this.curRequests += 1;
    if (statusCode >= 400) this.curErrors += 1;
    pushCapped(this.curDurations, durationMs);
  }

  /** Fold one prompt's queue wait (dispatched from the per-session FIFO). */
  recordPromptQueueWait(durationMs: number): void {
    pushCapped(this.curQueueWaits, durationMs);
  }

  /** Fold one finished prompt's end-to-end duration (also counts throughput). */
  recordPromptDuration(durationMs: number): void {
    this.curPromptsCompleted += 1;
    pushCapped(this.curPromptDurations, durationMs);
  }

  /** Fold one model turn's token usage into the open window. */
  recordTokens(inputTokens: number, outputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.curTokensIn += inputTokens;
    }
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      this.curTokensOut += outputTokens;
    }
  }

  /**
   * Seal the open window into a bucket stamped at `now` (folding in the
   * gauges), append it, evict the oldest past capacity, then reset the
   * accumulators for the next window.
   */
  sample(now: number, gauges: DaemonMetricsGauges): void {
    this.buckets.push({
      t: now,
      activeSessions: gauges.activeSessions,
      activePrompts: gauges.activePrompts,
      requests: this.curRequests,
      errors: this.curErrors,
      latencyP50Ms: percentile(this.curDurations, 0.5),
      latencyP95Ms: percentile(this.curDurations, 0.95),
      promptsCompleted: this.curPromptsCompleted,
      promptQueueWaitP95Ms: percentile(this.curQueueWaits, 0.95),
      promptDurationP95Ms: percentile(this.curPromptDurations, 0.95),
      rssBytes: gauges.rssBytes,
      heapUsedBytes: gauges.heapUsedBytes,
      eventLoopLagP99Ms: gauges.eventLoopLagP99Ms,
      tokensIn: this.curTokensIn,
      tokensOut: this.curTokensOut,
    });
    if (this.buckets.length > this.capacity) {
      this.buckets.splice(0, this.buckets.length - this.capacity);
    }
    this.curRequests = 0;
    this.curErrors = 0;
    this.curDurations.length = 0;
    this.curPromptsCompleted = 0;
    this.curQueueWaits.length = 0;
    this.curPromptDurations.length = 0;
    this.curTokensIn = 0;
    this.curTokensOut = 0;
  }

  /** Oldest→newest copy of the retained buckets (safe to serialize). */
  snapshot(): DaemonMetricsBucket[] {
    return this.buckets.slice();
  }
}

/** Append a finite, non-negative duration up to the per-window cap. */
function pushCapped(target: number[], value: number): void {
  if (
    Number.isFinite(value) &&
    value >= 0 &&
    target.length < MAX_SAMPLES_PER_WINDOW
  ) {
    target.push(value);
  }
}

/**
 * Nearest-rank percentile over an UNSORTED sample (sorts a copy). Returns 0 for
 * an empty sample so an idle window reads as a clean zero rather than NaN.
 */
function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}
