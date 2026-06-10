/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import { RuntimeSampleRing } from './memoryPressureMonitor.js';

describe('RuntimeSampleRing', () => {
  let ring: RuntimeSampleRing;

  beforeEach(() => {
    ring = new RuntimeSampleRing();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a sample with correct memory fields', () => {
    const mem = {
      rss: 500_000_000,
      heapUsed: 300_000_000,
      heapTotal: 400_000_000,
      external: 10_000_000,
      arrayBuffers: 5_000_000,
    };

    const sample = ring.record(mem);

    expect(sample.rss).toBe(500_000_000);
    expect(sample.heapUsed).toBe(300_000_000);
    expect(sample.heapTotal).toBe(400_000_000);
    expect(sample.external).toBe(10_000_000);
    expect(sample.ts).toBeGreaterThan(0);
    expect(typeof sample.cpuPercent).toBe('number');
  });

  it('computes cpuPercent as a normalized percentage', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    // First call establishes baseline
    ring.record(mem);

    // Wait a bit to get nonzero elapsed
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
    const sample = ring.record(mem);

    // cpuPercent should be a finite number (exact value depends on real CPU work)
    expect(Number.isFinite(sample.cpuPercent)).toBe(true);
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
  });

  it('returns previous sample when elapsed is 0 (same ms tick)', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    const fixedNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const first = ring.record(mem);

    // Same timestamp — should return copy of first sample
    const second = ring.record(mem);
    expect(second).toEqual(first);

    // Verify it's a copy, not the same reference
    expect(second).not.toBe(first);
  });

  it('accumulates the CPU delta from a same-tick sample into the next sample', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    let mockCpu = { user: 0, system: 0 };
    vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ ...mockCpu }));
    let mockTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

    // Construct under mocked time so the baseline is deterministic:
    // prevCpuUsage = {0, 0}, prevSampleTime = 1000.
    const localRing = new RuntimeSampleRing();

    mockTime = 1100;
    mockCpu = { user: 4000, system: 4000 }; // 8ms CPU over 100ms
    const first = localRing.record(mem);

    // Same ms tick (elapsed = 0): the 8ms of CPU accrued since `first`
    // must NOT be consumed — prevCpuUsage/prevSampleTime stay untouched.
    mockCpu = { user: 8000, system: 8000 };
    const second = localRing.record(mem);
    expect(second).toEqual(first);

    mockTime = 1200;
    mockCpu = { user: 12000, system: 12000 };
    const third = localRing.record(mem);

    // 16ms of CPU (8ms from the skipped tick + 8ms after) over 100ms = 16%,
    // normalized by core count. A regression that updates prevCpuUsage in the
    // elapsed <= 0 branch would yield only 8% / cores here.
    const coreCount = os.cpus().length || 1;
    expect(third.cpuPercent).toBeCloseTo(16 / coreCount, 2);
  });

  it('evicts oldest sample when exceeding buffer size', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    // Mock time must start AFTER the ring's construction time to ensure elapsed > 0.
    let mockTime = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockTime += 1000;
      return mockTime;
    });

    for (let i = 0; i < 65; i++) {
      ring.record(mem);
    }

    const all = ring.getAll();
    expect(all.length).toBe(60);
  });

  it('getAll returns a copy that does not affect internal state', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    let mockTime = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockTime += 1000;
      return mockTime;
    });

    ring.record(mem);
    ring.record(mem);

    const snapshot = ring.getAll();
    expect(snapshot.length).toBe(2);

    snapshot.length = 0;
    expect(ring.getAll().length).toBe(2);
  });

  it('reset clears all samples', () => {
    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    let mockTime = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockTime += 1000;
      return mockTime;
    });

    ring.record(mem);
    ring.record(mem);
    expect(ring.getAll().length).toBe(2);

    ring.reset();
    expect(ring.getAll().length).toBe(0);
  });
});
