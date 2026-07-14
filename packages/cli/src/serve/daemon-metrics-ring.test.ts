/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DaemonMetricsRing,
  computeCpuPercent,
  type DaemonMetricsGauges,
} from './daemon-metrics-ring.js';

const GAUGES: DaemonMetricsGauges = {
  cpuPercent: 12,
  rssBytes: 100,
  heapUsedBytes: 50,
  activeSessions: 2,
  activePrompts: 1,
  queuedPrompts: 3,
  eventLoopLagP99Ms: 3,
  sseConnections: 4,
  wsConnections: 1,
  acpConnections: 2,
  rateLimitRejected: 5,
  childCpuPercent: 7,
  childRssBytes: 200,
};

describe('DaemonMetricsRing', () => {
  it('sums requests/errors and computes latency percentiles per window', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordRequest(10, 200);
    ring.recordRequest(20, 200);
    ring.recordRequest(30, 500); // error (5xx)
    ring.recordRequest(100, 404); // error (4xx)
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    expect(b.requests).toBe(4);
    expect(b.errors).toBe(2);
    // nearest-rank p50 of [10,20,30,100] -> ceil(.5*4)=2 -> idx1 -> 20
    expect(b.latencyP50Ms).toBe(20);
    expect(b.latencyP95Ms).toBe(100);
    // gauges are snapshot verbatim at seal time
    expect(b.rssBytes).toBe(100);
    expect(b.activePrompts).toBe(1);
    expect(b.eventLoopLagP99Ms).toBe(3);
    expect(b.t).toBe(1000);
  });

  it('sums token increments and counts completed prompts', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordTokens(100, 20);
    ring.recordTokens(50, 10); // a second round in the same window
    ring.recordPromptDuration(1200);
    ring.recordPromptQueueWait(300);
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    expect(b.tokensIn).toBe(150);
    expect(b.tokensOut).toBe(30);
    expect(b.promptsCompleted).toBe(1);
    expect(b.promptDurationP95Ms).toBe(1200);
    expect(b.promptQueueWaitP95Ms).toBe(300);
  });

  it('records LLM round-trip + pipe bytes, snapshots new gauges, and resets them', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordLlmDuration(2000);
    ring.recordLlmDuration(8000);
    ring.recordPipe('inbound', 1024);
    ring.recordPipe('inbound', 512);
    ring.recordPipe('outbound', 256);
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    // LLM round-trip percentiles over [2000, 8000]
    expect(b.llmApiP50Ms).toBe(2000);
    expect(b.llmApiP95Ms).toBe(8000);
    // pipe bytes summed per direction
    expect(b.pipeInBytes).toBe(1536);
    expect(b.pipeOutBytes).toBe(256);
    // new gauges snapshot verbatim
    expect(b.cpuPercent).toBe(12);
    expect(b.queuedPrompts).toBe(3);
    expect(b.sseConnections).toBe(4);
    expect(b.wsConnections).toBe(1);
    expect(b.acpConnections).toBe(2);
    expect(b.rateLimitRejected).toBe(5);
    expect(b.childCpuPercent).toBe(7);
    expect(b.childRssBytes).toBe(200);
    // window aggregates reset on the next seal
    ring.sample(2000, GAUGES);
    const nb = ring.snapshot()[1];
    expect(nb.llmApiP50Ms).toBe(0);
    expect(nb.pipeInBytes).toBe(0);
    expect(nb.pipeOutBytes).toBe(0);
  });

  it('sums model API errors + automatic retries per window and resets them', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordApiActivity(1, 1); // a transient error that was retried
    ring.recordApiActivity(2, 0); // two errors in a later round, no retry
    ring.recordApiActivity(0, 3); // three retries in another round
    // Malformed / non-positive increments are ignored, never poison the total.
    ring.recordApiActivity(Number.NaN, -5);
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    expect(b.llmApiErrors).toBe(3);
    expect(b.llmApiRetries).toBe(4);
    // Window aggregates reset on the next seal (idle window reads clean zero).
    ring.sample(2000, GAUGES);
    const nb = ring.snapshot()[1];
    expect(nb.llmApiErrors).toBe(0);
    expect(nb.llmApiRetries).toBe(0);
  });

  it('resets accumulators after each seal (idle window reads clean zero)', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordRequest(10, 200);
    ring.recordTokens(100, 20);
    ring.sample(1000, GAUGES);
    ring.sample(2000, GAUGES); // no activity in the second window
    const buckets = ring.snapshot();
    expect(buckets).toHaveLength(2);
    expect(buckets[1].requests).toBe(0);
    expect(buckets[1].tokensIn).toBe(0);
    expect(buckets[1].latencyP50Ms).toBe(0);
    // gauges still reported even in an idle window
    expect(buckets[1].activeSessions).toBe(2);
  });

  it('evicts oldest buckets past capacity, preserving order', () => {
    const ring = new DaemonMetricsRing({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      ring.recordRequest(i, 200);
      ring.sample(i * 1000, GAUGES);
    }
    const buckets = ring.snapshot();
    expect(buckets).toHaveLength(3);
    // t=0 and t=1000 evicted; retained oldest→newest is 2000,3000,4000
    expect(buckets.map((b) => b.t)).toEqual([2000, 3000, 4000]);
  });

  it('rejects non-finite / negative inputs defensively', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordTokens(NaN, -5); // both rejected
    ring.recordRequest(-1, 200); // counts, but -1 not sampled for percentile
    ring.recordPromptQueueWait(Infinity); // rejected from percentile sample
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    expect(b.tokensIn).toBe(0);
    expect(b.tokensOut).toBe(0);
    expect(b.requests).toBe(1);
    expect(b.latencyP50Ms).toBe(0);
    expect(b.promptQueueWaitP95Ms).toBe(0);
  });

  it('rejects non-finite / negative pipe byte counts defensively', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.recordPipe('inbound', NaN); // rejected
    ring.recordPipe('inbound', -100); // rejected (negative)
    ring.recordPipe('outbound', Infinity); // rejected
    ring.recordPipe('outbound', -1); // rejected (negative)
    ring.recordPipe('inbound', 512); // valid → counts
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    expect(b.pipeInBytes).toBe(512);
    expect(b.pipeOutBytes).toBe(0);
  });

  it('caps per-window percentile samples but still counts every request', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    // Push well past MAX_SAMPLES_PER_WINDOW (4096) durations in one window.
    for (let i = 0; i < 5000; i++) {
      ring.recordRequest(i + 1, 200); // duration 1..5000, all finite/positive
    }
    ring.sample(1000, GAUGES);
    const [b] = ring.snapshot();
    // The plain counter accrues the full 5000 requests past the cap...
    expect(b.requests).toBe(5000);
    // ...but only the first 4096 durations feed the percentile sample, so p95
    // is nearest-rank over [1..4096] = ceil(0.95*4096)=3892 → 3892. Were the
    // full 5000 sampled it would be ceil(0.95*5000)=4750 → 4750, so this value
    // pins the truncation.
    expect(b.latencyP95Ms).toBe(3892);
  });

  it('sanitizes non-finite gauges to 0 so they never serialize as JSON null', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.sample(1000, {
      ...GAUGES,
      cpuPercent: NaN,
      eventLoopLagP99Ms: Number.POSITIVE_INFINITY,
      rssBytes: Number.NEGATIVE_INFINITY,
    });
    const [b] = ring.snapshot();
    expect(b.cpuPercent).toBe(0);
    expect(b.eventLoopLagP99Ms).toBe(0);
    expect(b.rssBytes).toBe(0);
    // finite gauges still pass through untouched
    expect(b.activeSessions).toBe(2);
    expect(b.childRssBytes).toBe(200);
  });

  it('snapshot returns a copy (mutating it does not corrupt the ring)', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.sample(1000, GAUGES);
    const snap = ring.snapshot();
    snap.push({ ...snap[0], t: 9999 });
    expect(ring.snapshot()).toHaveLength(1);
  });
});

describe('computeCpuPercent', () => {
  const cpu = (userUs: number, systemUs: number): NodeJS.CpuUsage => ({
    user: userUs,
    system: systemUs,
  });

  it('returns 0 when either sample is null (failed/absent read)', () => {
    expect(computeCpuPercent(null, cpu(1_000_000, 0), 1000, 1)).toBe(0);
    expect(computeCpuPercent(cpu(0, 0), null, 1000, 1)).toBe(0);
    expect(computeCpuPercent(null, null, 1000, 1)).toBe(0);
  });

  it('returns 0 for a non-positive window', () => {
    expect(computeCpuPercent(cpu(0, 0), cpu(1_000_000, 0), 0, 1)).toBe(0);
    expect(computeCpuPercent(cpu(0, 0), cpu(1_000_000, 0), -5, 1)).toBe(0);
  });

  it('computes a normalized, clamped windowed percent', () => {
    // 1s of CPU (1e6 µs user) over a 1000ms wall window on 1 core = 100%.
    expect(computeCpuPercent(cpu(0, 0), cpu(1_000_000, 0), 1000, 1)).toBe(100);
    // Same delta across 4 cores = 25%.
    expect(computeCpuPercent(cpu(0, 0), cpu(1_000_000, 0), 1000, 4)).toBe(25);
    // 0.5s user + 0.5s system over 2000ms on 1 core = 50%.
    expect(computeCpuPercent(cpu(0, 0), cpu(500_000, 500_000), 2000, 1)).toBe(
      50,
    );
  });

  it('clamps a huge delta to 100 (phantom-spike guard)', () => {
    // An init baseline of {0,0} then a big first read would exceed 100 without
    // the clamp — the exact spike the null-init guard is designed to prevent.
    expect(computeCpuPercent(cpu(0, 0), cpu(999_000_000, 0), 1000, 1)).toBe(
      100,
    );
  });

  it('clamps a negative delta to 0 (non-monotonic cpuUsage)', () => {
    expect(computeCpuPercent(cpu(1_000_000, 0), cpu(0, 0), 1000, 1)).toBe(0);
  });
});
