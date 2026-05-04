/**
 * @license
 * Copyright 2025 Google LLC
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

  it('should prefer Retry-After for HTTP request retry policy', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '180' },
    });

    expect(
      getRetryDelayMs({
        attempt: 3,
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        retryAfterMode: 'prefer',
        retryAfterMaxDelayMs: 300_000,
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
});
