/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  computeDaemonMemoryPressure,
  CRITICAL_PRESSURE_RATIO,
  HARD_PRESSURE_RATIO,
  SOFT_PRESSURE_RATIO,
} from './daemon-memory-pressure.js';

const GB = 1024 * 1024 * 1024;

// Byte counts are exact multiples of the denominator so the ratio the function
// computes is exactly the one under test — rounding between the two would put
// a boundary case on the wrong side of its threshold without failing.
const AVAILABLE = 8 * GB;
function pressureAtBytes(rssBytes: number) {
  return computeDaemonMemoryPressure({
    rssBytes,
    heapUsedBytes: 0,
    availableBytes: AVAILABLE,
    heapLimitBytes: 4 * GB,
  });
}

describe('computeDaemonMemoryPressure', () => {
  it.each([
    [0, 'normal'],
    [SOFT_PRESSURE_RATIO * AVAILABLE - 1, 'normal'],
    [SOFT_PRESSURE_RATIO * AVAILABLE, 'soft'],
    [HARD_PRESSURE_RATIO * AVAILABLE - 1, 'soft'],
    [HARD_PRESSURE_RATIO * AVAILABLE, 'hard'],
    [CRITICAL_PRESSURE_RATIO * AVAILABLE - 1, 'hard'],
    [CRITICAL_PRESSURE_RATIO * AVAILABLE, 'critical'],
    [AVAILABLE * 1.5, 'critical'],
  ])('classifies %p rss bytes as %s', (rssBytes, expected) => {
    expect(pressureAtBytes(rssBytes).level).toBe(expected);
  });

  it('reports the worse of the two denominators, and which one it was', () => {
    // Heap is the one in trouble; RSS against the cgroup limit looks fine.
    const heapBound = computeDaemonMemoryPressure({
      rssBytes: 1 * GB,
      heapUsedBytes: Math.round(3.6 * GB),
      availableBytes: 32 * GB,
      heapLimitBytes: 4 * GB,
    });
    expect(heapBound).toMatchObject({ source: 'heap', level: 'critical' });
    expect(heapBound.ratio).toBeCloseTo(0.9, 5);

    // And the reverse: a container near its cgroup limit with a small heap.
    const rssBound = computeDaemonMemoryPressure({
      rssBytes: Math.round(3.5 * GB),
      heapUsedBytes: Math.round(0.2 * GB),
      availableBytes: 4 * GB,
      heapLimitBytes: 4 * GB,
    });
    expect(rssBound).toMatchObject({ source: 'rss', level: 'critical' });
  });

  it('treats an unknown denominator as no pressure rather than dividing by zero', () => {
    // `availableBytes` of 0 means detection failed, which is not the same as
    // "the machine has no memory left".
    const noLimit = computeDaemonMemoryPressure({
      rssBytes: 4 * GB,
      heapUsedBytes: 1 * GB,
      availableBytes: 0,
      heapLimitBytes: 4 * GB,
    });
    expect(noLimit.rssRatio).toBe(0);
    expect(Number.isFinite(noLimit.ratio)).toBe(true);
    expect(noLimit.source).toBe('heap');

    // Neither denominator usable: say so rather than reporting a source that
    // was never measured. `unknown` with level `normal` is the honest pair —
    // a consumer can see the reading is not evidence of health.
    const neither = computeDaemonMemoryPressure({
      rssBytes: 4 * GB,
      heapUsedBytes: 1 * GB,
      availableBytes: 0,
      heapLimitBytes: 0,
    });
    expect(neither).toMatchObject({
      ratio: 0,
      level: 'normal',
      source: 'unknown',
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'treats a %p gauge as unmeasured rather than classifying on it',
    (bad) => {
      // daemon-metrics-ring sanitizes non-finite gauges to 0 before storing
      // them, so these do reach callers in this codebase.
      //
      // `source: 'unknown'` is the assertion that matters. Without it this
      // case passes just as well when an unusable *numerator* is coerced to 0
      // and divided anyway — which publishes `level: 'normal', source: 'rss'`
      // for a daemon that measured nothing, the one reading this module exists
      // to make impossible.
      expect(
        computeDaemonMemoryPressure({
          rssBytes: bad,
          heapUsedBytes: bad,
          availableBytes: 8 * GB,
          heapLimitBytes: 4 * GB,
        }),
      ).toMatchObject({ ratio: 0, level: 'normal', source: 'unknown' });

      // One bad numerator retires only its own side; the other still reports.
      expect(
        computeDaemonMemoryPressure({
          rssBytes: bad,
          heapUsedBytes: 3 * GB,
          availableBytes: 8 * GB,
          heapLimitBytes: 4 * GB,
        }),
      ).toMatchObject({ source: 'heap', ratio: 0.75, rssRatio: 0 });

      expect(
        computeDaemonMemoryPressure({
          rssBytes: 4 * GB,
          heapUsedBytes: 0,
          availableBytes: bad,
          heapLimitBytes: 4 * GB,
        }),
      ).toMatchObject({ source: 'heap' });
    },
  );

  it('treats a zero numerator as a reading, not as an unusable gauge', () => {
    // The asymmetry the two helpers encode: 0 bytes used is merely implausible,
    // while dividing by 0 bytes available is undefined. Retiring a zero
    // numerator would make an idle daemon indistinguishable from an
    // unmeasurable one — the same collapse from the opposite direction.
    expect(
      computeDaemonMemoryPressure({
        rssBytes: 0,
        heapUsedBytes: 0,
        availableBytes: 8 * GB,
        heapLimitBytes: 4 * GB,
      }),
    ).toMatchObject({ ratio: 0, level: 'normal', source: 'rss' });
  });

  it("falls back to this process's real V8 ceiling when none is given", () => {
    // The only production caller omits `heapLimitBytes`, so the documented
    // default is the path that actually runs. Every other test here injects a
    // limit, which would leave it asserted only by the end-to-end boot test.
    const result = computeDaemonMemoryPressure({
      rssBytes: 1 * GB,
      heapUsedBytes: 1 * GB,
      availableBytes: 8 * GB,
    });

    expect(result.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
    expect(result.heapRatio).toBeCloseTo(
      (1 * GB) / getHeapStatistics().heap_size_limit,
      10,
    );
  });

  it('carries both raw figures so a reader can check the arithmetic', () => {
    expect(
      computeDaemonMemoryPressure({
        rssBytes: 2 * GB,
        heapUsedBytes: 1 * GB,
        availableBytes: 8 * GB,
        heapLimitBytes: 4 * GB,
      }),
    ).toMatchObject({
      rssBytes: 2 * GB,
      rssRatio: 0.25,
      availableBytes: 8 * GB,
      heapUsedBytes: 1 * GB,
      heapRatio: 0.25,
      heapLimitBytes: 4 * GB,
    });
  });
});
