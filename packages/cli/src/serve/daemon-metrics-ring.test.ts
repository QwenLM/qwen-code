/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DaemonMetricsRing, type DaemonMetricsGauges } from './daemon-metrics-ring.js';

const GAUGES: DaemonMetricsGauges = {
  cpuPercent: 12,
  rssBytes: 100,
  heapUsedBytes: 50,
  activeSessions: 2,
  activePrompts: 1,
  pendingPrompts: 3,
  eventLoopLagP99Ms: 3,
  sseConnections: 4,
  wsConnections: 1,
  acpConnections: 2,
  rateLimitRejected: 5,
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
    expect(b.pendingPrompts).toBe(3);
    expect(b.sseConnections).toBe(4);
    expect(b.wsConnections).toBe(1);
    expect(b.acpConnections).toBe(2);
    expect(b.rateLimitRejected).toBe(5);
    // window aggregates reset on the next seal
    ring.sample(2000, GAUGES);
    const nb = ring.snapshot()[1];
    expect(nb.llmApiP50Ms).toBe(0);
    expect(nb.pipeInBytes).toBe(0);
    expect(nb.pipeOutBytes).toBe(0);
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

  it('snapshot returns a copy (mutating it does not corrupt the ring)', () => {
    const ring = new DaemonMetricsRing({ capacity: 10 });
    ring.sample(1000, GAUGES);
    const snap = ring.snapshot();
    snap.push({ ...snap[0], t: 9999 });
    expect(ring.snapshot()).toHaveLength(1);
  });
});
