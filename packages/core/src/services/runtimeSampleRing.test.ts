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

  it('reuses the previous cpuPercent but captures fresh memory on a same-ms tick', () => {
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

    // Same timestamp, but memory has moved. cpuPercent can't be recomputed with
    // zero elapsed time, so it stays at the previous value — but the memory
    // fields must reflect the fresh snapshot, since the caller reports them.
    const grownMem = { ...mem, rss: 999, heapUsed: 777 };
    const second = ring.record(grownMem);

    expect(second.cpuPercent).toBe(first.cpuPercent);
    expect(second.rss).toBe(999);
    expect(second.heapUsed).toBe(777);
    expect(second).not.toBe(first);
  });

  it('records a sample even when the very first call lands on the same ms', () => {
    const mem = {
      rss: 123,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };

    // Pin time to the ring's construction instant so the first record() hits the
    // elapsed <= 0 branch with an empty buffer. The sample must still be stored,
    // otherwise the first hard/critical dump would miss it.
    const fixedNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const localRing = new RuntimeSampleRing();

    const sample = localRing.record(mem);

    expect(sample.cpuPercent).toBe(0);
    expect(sample.rss).toBe(123);
    expect(localRing.getAll()).toHaveLength(1);
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
    // Mirror getCpuCoreCount()'s resolution order so the assertion holds
    // regardless of which API the implementation reads.
    const coreCount = os.availableParallelism?.() ?? os.cpus().length ?? 1;
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

  it('survives process.cpuUsage() throwing during construction and record()', () => {
    vi.spyOn(process, 'cpuUsage').mockImplementation(() => {
      throw new Error('/proc/self/stat unavailable');
    });

    // Constructor calls safeCpuUsage() for the initial baseline — must not throw.
    const restrictedRing = new RuntimeSampleRing();

    let mockTime = Date.now() + 100;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockTime += 100;
      return mockTime;
    });

    const mem = {
      rss: 500_000_000,
      heapUsed: 300_000_000,
      heapTotal: 400_000_000,
      external: 10_000_000,
      arrayBuffers: 5_000_000,
    };

    // record() also calls safeCpuUsage() — must not throw.
    const sample = restrictedRing.record(mem);
    expect(sample.rss).toBe(500_000_000);
    expect(sample.cpuPercent).toBe(0);

    // reset() calls safeCpuUsage() for the new baseline — must not throw.
    expect(() => restrictedRing.reset()).not.toThrow();
  });

  it('clamps cpuPercent at 100 when CPU bursting exceeds wall-clock × cores', () => {
    const coreCount = os.availableParallelism?.() ?? os.cpus().length ?? 1;

    let mockCpu = { user: 0, system: 0 };
    vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ ...mockCpu }));
    let mockTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

    const localRing = new RuntimeSampleRing();

    // Advance 100ms but report enough CPU-time to exceed 100% per core.
    // 100ms = 100_000µs wall-clock. For 100% on N cores we'd need
    // N * 100_000µs of CPU. Report 2× that to trigger the clamp.
    mockTime = 1100;
    const excessiveCpuUs = coreCount * 100_000 * 2;
    mockCpu = { user: excessiveCpuUs, system: 0 };

    const mem = {
      rss: 100,
      heapUsed: 50,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 0,
    };
    const sample = localRing.record(mem);

    expect(sample.cpuPercent).toBe(100);
  });
});
