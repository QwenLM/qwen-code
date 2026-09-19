/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesHttpError } from './responses-http-error.js';
import { retryWithBackoff } from './retry.js';
import { classifyRetryError } from './retryErrorClassification.js';
import { getRetryAfterDelayMs } from './retryPolicy.js';

describe('Responses HTTP recovery', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [408, undefined, true],
    [409, undefined, true],
    [404, undefined, false],
    [404, 'true', true],
    [500, 'false', false],
    [429, 'false', false],
    [503, undefined, true],
    [401, undefined, false],
    [400, undefined, false],
    [404, 'invalid', false],
  ] as const)(
    'handles HTTP %i with directive %s',
    async (status, directive, retry) => {
      vi.useFakeTimers();
      const headers = new Headers();
      if (directive) headers.set('x-should-retry', directive);
      const error = new ResponsesHttpError(status, '{}', headers);
      const call = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('recovered');
      const result = retryWithBackoff(call, {
        maxAttempts: 2,
        initialDelayMs: 10,
        persistentMode: false,
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBe(retry ? 'recovered' : error);
      expect(call).toHaveBeenCalledTimes(retry ? 2 : 1);
      expect(classifyRetryError(error).diagnosis).toBe(
        retry ? 'retryable' : 'fail-fast',
      );
    },
  );

  it('honors Retry-After for a retryable 404 without the exponential cap', async () => {
    vi.useFakeTimers();
    const error = new ResponsesHttpError(
      404,
      '{}',
      new Headers({ 'x-should-retry': 'true', 'retry-after': '3' }),
    );
    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    const result = retryWithBackoff(call, {
      maxAttempts: 2,
      initialDelayMs: 10,
      maxDelayMs: 20,
      persistentMode: false,
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('aborts a provider-directed wait without issuing another request', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const error = new ResponsesHttpError(
      408,
      '{}',
      new Headers({ 'retry-after': '100' }),
    );
    const call = vi.fn().mockRejectedValue(error);
    const result = retryWithBackoff(call, {
      signal: abort.signal,
      persistentMode: false,
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    expect(await result).toMatchObject({ message: 'Retry aborted by signal' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('respects the existing configurable retry codes', () => {
    const error = new ResponsesHttpError(418, '{}');
    expect(error.shouldRetry()).toBe(false);
    expect(error.shouldRetry([418])).toBe(true);
  });

  it('uses retry-after-ms before Retry-After, falling back on invalid milliseconds', () => {
    expect(
      getRetryAfterDelayMs(
        new ResponsesHttpError(
          408,
          '{}',
          new Headers({ 'retry-after-ms': '125.5', 'retry-after': '9' }),
        ),
      ),
    ).toBe(125.5);
    expect(
      getRetryAfterDelayMs(
        new ResponsesHttpError(
          408,
          '{}',
          new Headers({ 'retry-after-ms': '-1', 'retry-after': '9' }),
        ),
      ),
    ).toBe(9000);
  });
});
