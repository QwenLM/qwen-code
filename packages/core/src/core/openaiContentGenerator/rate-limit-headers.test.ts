/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  extractRateLimitHeaders,
  getAllRateLimits,
  getLastRateLimit,
  isRateLimitHeader,
  recordRateLimitHeaders,
  resetRateLimits,
} from './rate-limit-headers.js';

afterEach(() => {
  resetRateLimits();
});

describe('isRateLimitHeader', () => {
  it('matches every spelling providers actually use', () => {
    // Matching a list of names would have kept the first and dropped the rest.
    expect(isRateLimitHeader('x-ratelimit-remaining-requests')).toBe(true);
    expect(isRateLimitHeader('X-RateLimit-Reset-Tokens')).toBe(true);
    expect(isRateLimitHeader('anthropic-ratelimit-unified-5h-utilization')).toBe(
      true,
    );
    expect(isRateLimitHeader('some-gateway-rate-limit-left')).toBe(true);
    expect(isRateLimitHeader('Retry-After')).toBe(true);
    expect(isRateLimitHeader('retry-after-ms')).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isRateLimitHeader('content-type')).toBe(false);
    expect(isRateLimitHeader('date')).toBe(false);
    expect(isRateLimitHeader('x-request-id')).toBe(false);
  });
});

describe('extractRateLimitHeaders', () => {
  it('keeps the rate-limit headers and lower-cases their names', () => {
    const headers = new Headers({
      'X-RateLimit-Remaining-Requests': '499',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'Retry-After': '17',
      'Content-Type': 'text/event-stream',
    });

    expect(extractRateLimitHeaders(headers)).toEqual({
      'x-ratelimit-remaining-requests': '499',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'retry-after': '17',
    });
  });

  it('reports nothing rather than an empty reading', () => {
    // An empty object drawn as a meter reads as a full account; "nobody asked"
    // and "nothing left" are different answers.
    expect(extractRateLimitHeaders(new Headers({ 'content-type': 'x' }))).toBeNull();
    expect(extractRateLimitHeaders(undefined)).toBeNull();
    expect(extractRateLimitHeaders(null)).toBeNull();
  });
});

describe('recordRateLimitHeaders', () => {
  it('remembers the newest reading per provider', () => {
    recordRateLimitHeaders(
      'dashscope',
      new Headers({ 'x-ratelimit-remaining-requests': '499' }),
      1000,
    );
    recordRateLimitHeaders(
      'openai',
      new Headers({ 'x-ratelimit-remaining-requests': '12' }),
      1001,
    );
    recordRateLimitHeaders(
      'dashscope',
      new Headers({ 'x-ratelimit-remaining-requests': '498' }),
      2000,
    );

    expect(getLastRateLimit('dashscope')).toEqual({
      headers: { 'x-ratelimit-remaining-requests': '498' },
      observedAt: 2000,
    });
    expect(getLastRateLimit('openai')?.headers).toEqual({
      'x-ratelimit-remaining-requests': '12',
    });
    expect(getAllRateLimits().size).toBe(2);
  });

  it('does not erase a known reading with a silent response', () => {
    recordRateLimitHeaders(
      'dashscope',
      new Headers({ 'x-ratelimit-remaining-requests': '499' }),
      1000,
    );
    recordRateLimitHeaders('dashscope', new Headers({ 'content-type': 'x' }), 2000);

    expect(getLastRateLimit('dashscope')?.headers).toEqual({
      'x-ratelimit-remaining-requests': '499',
    });
  });

  it('has no reading for a provider that never answered', () => {
    expect(getLastRateLimit('never-called')).toBeUndefined();
  });
});
