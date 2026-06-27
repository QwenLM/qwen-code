/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { getRetryAfterDelayMs, getRetryDelayMs } from './retryPolicy.js';

describe('getRetryDelayMs', () => {
  it('should calculate capped exponential delays without jitter', () => {
    expect(
      getRetryDelayMs({
        attempt: 0,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(60_000);
    expect(
      getRetryDelayMs({
        attempt: 2,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(120_000);
    expect(
      getRetryDelayMs({
        attempt: 10,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(300_000);
  });

  it('should use Retry-After as a minimum delay for stream retry policy', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '180' },
    });

    expect(
      getRetryDelayMs({
        attempt: 1,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'minimum',
        error,
      }),
    ).toBe(180_000);
    expect(
      getRetryDelayMs({
        attempt: 2,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'minimum',
        error: Object.assign(new Error('Too many requests'), {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
      }),
    ).toBe(120_000);
  });

  it('should cap Retry-After using retryAfterMaxDelayMs', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '600' },
    });

    expect(
      getRetryDelayMs({
        attempt: 1,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'minimum',
        retryAfterMaxDelayMs: 300_000,
        error,
      }),
    ).toBe(300_000);
  });

  it('should not cap the exponential floor with retryAfterMaxDelayMs in minimum mode', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '30' },
    });

    expect(
      getRetryDelayMs({
        attempt: 4,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'minimum',
        retryAfterMaxDelayMs: 100_000,
        error,
      }),
    ).toBe(300_000);
  });

  it('should not apply jitter when Retry-After is honored', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '180' },
    });

    expect(
      getRetryDelayMs({
        attempt: 1,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'minimum',
        retryAfterMaxDelayMs: 300_000,
        jitterRatio: 0.3,
        random: () => 1,
        error,
      }),
    ).toBe(180_000);
  });

  it('should apply deterministic jitter and clamp to max delay', () => {
    expect(
      getRetryDelayMs({
        attempt: 2,
        initialDelayMs: 100,
        maxDelayMs: 250,
        jitterRatio: 0.3,
        random: () => 1,
      }),
    ).toBe(250);
    expect(
      getRetryDelayMs({
        attempt: 2,
        initialDelayMs: 100,
        maxDelayMs: 250,
        jitterRatio: 0.3,
        random: () => 0,
      }),
    ).toBe(140);
  });
});

describe('getRetryAfterDelayMs', () => {
  it('should read Retry-After from direct headers', () => {
    expect(
      getRetryAfterDelayMs({
        headers: { 'retry-after': '180' },
      }),
    ).toBe(180_000);
  });

  it('should read Retry-After from response headers', () => {
    expect(
      getRetryAfterDelayMs({
        response: { headers: { 'retry-after': '180' } },
      }),
    ).toBe(180_000);
  });

  it('should read Retry-After from Headers-like objects', () => {
    expect(
      getRetryAfterDelayMs({
        headers: {
          get: (name: string) => (name === 'retry-after' ? '180' : null),
        },
      }),
    ).toBe(180_000);
  });

  it('should read Retry-After case-insensitively from plain objects', () => {
    expect(
      getRetryAfterDelayMs({
        headers: { 'Retry-After': '180' },
      }),
    ).toBe(180_000);
  });

  it('should read HTTP-date Retry-After values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      expect(
        getRetryAfterDelayMs({
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:03:00 GMT' },
        }),
      ).toBe(180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should return 0 for past HTTP-date Retry-After values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'));

    try {
      expect(
        getRetryAfterDelayMs({
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' },
        }),
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should ignore malformed and nullish Retry-After header shapes', () => {
    expect(
      getRetryAfterDelayMs({
        headers: { 'retry-after': 'not a retry-after value' },
      }),
    ).toBeNull();
    expect(getRetryAfterDelayMs({ headers: null })).toBeNull();
    expect(
      getRetryAfterDelayMs({ response: { headers: undefined } }),
    ).toBeNull();
  });

  it('should cap oversized numeric Retry-After at the setTimeout ceiling', () => {
    // 30 days in seconds → 2.592e9 ms, which exceeds the signed 32-bit
    // setTimeout limit and would otherwise fire immediately.
    expect(
      getRetryAfterDelayMs({ headers: { 'retry-after': '2592000' } }),
    ).toBe(2_147_483_647);
  });

  it('should reject non-RFC numeric Retry-After shapes', () => {
    // Number() would accept these (16, 1000) but RFC 7231 allows decimal
    // digits only; they are not valid HTTP-dates either, so the result is null.
    expect(
      getRetryAfterDelayMs({ headers: { 'retry-after': '0x10' } }),
    ).toBeNull();
    expect(
      getRetryAfterDelayMs({ headers: { 'retry-after': '1e3' } }),
    ).toBeNull();
  });

  it('should honor fractional Retry-After seconds', () => {
    expect(getRetryAfterDelayMs({ headers: { 'retry-after': '1.5' } })).toBe(
      1500,
    );
  });

  it('should cap far-future HTTP-date Retry-After at the setTimeout ceiling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      expect(
        getRetryAfterDelayMs({
          headers: { 'retry-after': 'Fri, 01 Jan 2100 00:00:00 GMT' },
        }),
      ).toBe(2_147_483_647);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getRetryDelayMs - exponential overflow', () => {
  it('clamps to maxDelayMs for very large attempt counts without overflowing', () => {
    // attempt high enough that 2^(attempt-1) would be Infinity if uncapped.
    expect(
      getRetryDelayMs({
        attempt: 5000,
        initialDelayMs: 1000,
        maxDelayMs: 300_000,
      }),
    ).toBe(300_000);
  });

  it('clamps to the setTimeout ceiling when maxDelayMs itself is oversized', () => {
    // A caller-supplied maxDelayMs above the 32-bit setTimeout limit must not
    // let the exponential delay overflow the timer.
    expect(
      getRetryDelayMs({
        attempt: 5000,
        initialDelayMs: 1000,
        maxDelayMs: 5_000_000_000,
      }),
    ).toBe(2_147_483_647);
  });

  it('clamps jitter to the setTimeout ceiling when maxDelayMs is oversized', () => {
    // Max positive jitter on a maxed-out exponential must still not exceed the
    // setTimeout ceiling.
    expect(
      getRetryDelayMs({
        attempt: 5000,
        initialDelayMs: 1000,
        maxDelayMs: 5_000_000_000,
        jitterRatio: 0.3,
        random: () => 1,
      }),
    ).toBe(2_147_483_647);
  });
});
