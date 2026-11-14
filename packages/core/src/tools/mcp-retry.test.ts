/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, retryWithBackoff } from './mcp-retry.js';

describe('isTransientNetworkError', () => {
  it.each([
    ['returns true for ECONNRESET', 'ECONNRESET'],
    ['returns true for ETIMEDOUT', 'ETIMEDOUT'],
    ['returns true for ENOTFOUND', 'ENOTFOUND'],
    ['returns true for ECONNREFUSED', 'ECONNREFUSED'],
    ['returns true for EAI_AGAIN', 'EAI_AGAIN'],
    ['returns true for EPIPE', 'EPIPE'],
    ['returns true for EHOSTUNREACH', 'EHOSTUNREACH'],
    ['returns true for ENETUNREACH', 'ENETUNREACH'],
    ['returns true for HTTP 502 with status text', '502 Bad Gateway'],
    ['returns true for HTTP 503 with status text', '503 Service Unavailable'],
    ['returns true for HTTP 504 with status text', '504 Gateway Timeout'],
    [
      'returns true for "status code 502"',
      'Request failed with status code 502',
    ],
    ['returns true for "status: 503"', 'status: 503'],
    ['returns true for "HTTP/1.1 504"', 'HTTP/1.1 504 Gateway Timeout'],
    ['returns true for connection closed', 'Connection closed'],
    ['returns true for transport error', 'transport error'],
    [
      'returns true for Streamable HTTP connection error',
      'Streamable HTTP connection failed',
    ],
    [
      'returns true for error with ECONNRESET in a longer message',
      'read ECONNRESET at TCPReadWrap.afterCall',
    ],
  ])('%s', (_title, message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['returns false for 401 Unauthorized', new Error('401 Unauthorized')],
    ['returns false for 403 Forbidden', new Error('403 Forbidden')],
    ['returns false for JSON-RPC Method not found (-32601)', { code: -32601 }],
    ['returns false for JSON-RPC Invalid Request (-32600)', { code: -32600 }],
    ['returns false for JSON-RPC Invalid Params (-32602)', { code: -32602 }],
    ['returns false for null', null],
    ['returns false for undefined', undefined],
    [
      'returns false for generic Error without network codes',
      new Error('Something went wrong'),
    ],
    [
      'returns false for message containing 502 as non-status number',
      new Error('processed 502 items successfully'),
    ],
    [
      'returns false for message containing 503 as non-status number',
      new Error('timeout after 503ms'),
    ],
  ])('%s', (_title, error) => {
    expect(isTransientNetworkError(error)).toBe(false);
  });
});

describe('retryWithBackoff', () => {
  /** A fn that throws a fresh `Error(message)` on every call. */
  const throwsEvery = (message: string) =>
    vi.fn(async () => {
      throw new Error(message);
    });

  it('returns the result on first successful attempt', async () => {
    const result = await retryWithBackoff(
      () => Promise.resolve('success'),
      'test-label',
    );
    expect(result).toBe('success');
  });

  it('retries on transient error and succeeds on second attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('recovered');

    expect(await retryWithBackoff(fn, 'test-retry')).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries and then throws', async () => {
    const fn = throwsEvery('ECONNRESET');

    await expect(
      retryWithBackoff(fn, 'test-exhaust', { maxRetries: 2 }),
    ).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on permanent errors (401)', async () => {
    const fn = throwsEvery('401 Unauthorized');

    await expect(retryWithBackoff(fn, 'test-permanent')).rejects.toThrow(
      '401 Unauthorized',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on method-not-found (-32601)', async () => {
    const fn = vi.fn().mockRejectedValue({ code: -32601 });

    await expect(
      retryWithBackoff(fn, 'test-method-not-found'),
    ).rejects.toMatchObject({ code: -32601 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff delay', async () => {
    vi.useFakeTimers();
    const fn = throwsEvery('ETIMEDOUT');

    try {
      const promise = retryWithBackoff(fn, 'test-backoff', {
        maxRetries: 2,
        baseDelayMs: 50,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));

      await vi.advanceTimersByTimeAsync(100);
      const error = await errorPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('ETIMEDOUT');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('succeeds after transient 503 then success', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue('ok');

    expect(await retryWithBackoff(fn, 'test-503')).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects custom maxRetries=1 (single retry)', async () => {
    const fn = throwsEvery('ECONNRESET');

    await expect(
      retryWithBackoff(fn, 'test-single-retry', { maxRetries: 1 }),
    ).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('aborts immediately when signal fires during backoff', async () => {
    const controller = new AbortController();
    const fn = throwsEvery('ECONNRESET');

    const promise = retryWithBackoff(fn, 'test-abort', {
      maxRetries: 5,
      baseDelayMs: 10000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow('Retry aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = throwsEvery('ECONNRESET');

    await expect(
      retryWithBackoff(fn, 'test-pre-aborted', {
        maxRetries: 2,
        baseDelayMs: 10000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Retry aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
