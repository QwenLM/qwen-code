/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { calculateExponentialBackoffMs, nextRetryDelay } from './backoff.js';

describe('calculateExponentialBackoffMs', () => {
  it('caps the exponential base before applying caller-defined jitter', () => {
    expect(
      calculateExponentialBackoffMs({
        attempt: 20,
        baseDelayMs: 500,
        maxBaseDelayMs: 30_000,
        minJitterFactor: 0.5,
        maxJitterFactor: 1,
        random: () => 0,
      }),
    ).toBe(15_000);
    expect(
      calculateExponentialBackoffMs({
        attempt: 20,
        baseDelayMs: 500,
        maxBaseDelayMs: 32_000,
        minJitterFactor: 1,
        maxJitterFactor: 1.25,
        random: () => 1,
      }),
    ).toBe(40_000);
  });
});

describe('nextRetryDelay', () => {
  it.each([
    [{ retryAfterMs: 10 }, 10],
    [{ cause: { retry_after_ms: 20 } }, 20],
    [{ retryAfterSeconds: 1.5 }, 1500],
    [{ retryAfterMs: 0 }, 0],
  ])('honors an explicit retry delay: %j', (error, expected) => {
    expect(nextRetryDelay(error, 1)).toBe(expected);
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 'invalid'])(
    'does not replace an unusable Retry-After %s with exponential backoff',
    (retryAfterMs) => {
      expect(nextRetryDelay({ retryAfterMs }, 1)).toBeUndefined();
    },
  );

  it('uses the same capped jitter policy when Retry-After is absent', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(nextRetryDelay(new Error('transient'), 1)).toBe(500);
      expect(nextRetryDelay(new Error('transient'), 2)).toBe(1000);
      expect(nextRetryDelay(new Error('transient'), 20)).toBe(32_000);
      random.mockReturnValue(1);
      expect(nextRetryDelay(new Error('transient'), 20)).toBe(40_000);
    } finally {
      random.mockRestore();
    }
  });
});
