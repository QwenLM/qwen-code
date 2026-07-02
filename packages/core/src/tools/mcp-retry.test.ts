/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, retryWithBackoff } from './mcp-retry.js';

describe('isTransientNetworkError', () => {
  it('returns true for ECONNRESET', () => {
    expect(isTransientNetworkError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isTransientNetworkError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for ENOTFOUND', () => {
    expect(isTransientNetworkError(new Error('ENOTFOUND'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isTransientNetworkError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns true for EAI_AGAIN', () => {
    expect(isTransientNetworkError(new Error('EAI_AGAIN'))).toBe(true);
  });

  it('returns true for EPIPE', () => {
    expect(isTransientNetworkError(new Error('EPIPE'))).toBe(true);
  });

  it('returns true for EHOSTUNREACH', () => {
    expect(isTransientNetworkError(new Error('EHOSTUNREACH'))).toBe(true);
  });

  it('returns true for ENETUNREACH', () => {
    expect(isTransientNetworkError(new Error('ENETUNREACH'))).toBe(true);
  });

  it('returns true for HTTP 502 with status text', () => {
    expect(isTransientNetworkError(new Error('502 Bad Gateway'))).toBe(true);
  });

  it('returns true for HTTP 503 with status text', () => {
    expect(isTransientNetworkError(new Error('503 Service Unavailable'))).toBe(
      true,
    );
  });

  it('returns true for HTTP 504 with status text', () => {
    expect(isTransientNetworkError(new Error('504 Gateway Timeout'))).toBe(
      true,
    );
  });

  it('returns true for "status code 502"', () => {
    expect(
      isTransientNetworkError(new Error('Request failed with status code 502')),
    ).toBe(true);
  });

  it('returns true for "status: 503"', () => {
    expect(isTransientNetworkError(new Error('status: 503'))).toBe(true);
  });

  it('returns true for "HTTP/1.1 504"', () => {
    expect(
      isTransientNetworkError(new Error('HTTP/1.1 504 Gateway Timeout')),
    ).toBe(true);
  });

  it('returns true for connection closed', () => {
    expect(isTransientNetworkError(new Error('Connection closed'))).toBe(true);
  });

  it('returns true for transport error', () => {
    expect(isTransientNetworkError(new Error('transport error'))).toBe(true);
  });

  it('returns true for Streamable HTTP connection error', () => {
    expect(
      isTransientNetworkError(new Error('Streamable HTTP connection failed')),
    ).toBe(true);
  });

  it('returns false for 401 Unauthorized', () => {
    expect(isTransientNetworkError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('returns false for 403 Forbidden', () => {
    expect(isTransientNetworkError(new Error('403 Forbidden'))).toBe(false);
  });

  it('returns false for JSON-RPC Method not found (-32601)', () => {
    expect(isTransientNetworkError({ code: -32601 })).toBe(false);
  });

  it('returns false for JSON-RPC Invalid Request (-32600)', () => {
    expect(isTransientNetworkError({ code: -32600 })).toBe(false);
  });

  it('returns false for JSON-RPC Invalid Params (-32602)', () => {
    expect(isTransientNetworkError({ code: -32602 })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTransientNetworkError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it('returns false for generic Error without network codes', () => {
    expect(isTransientNetworkError(new Error('Something went wrong'))).toBe(
      false,
    );
  });

  it('returns true for error with ECONNRESET in a longer message', () => {
    expect(
      isTransientNetworkError(
        new Error('read ECONNRESET at TCPReadWrap.afterCall'),
      ),
    ).toBe(true);
  });

  it('returns false for message containing 502 as non-status number', () => {
    expect(
      isTransientNetworkError(new Error('processed 502 items successfully')),
    ).toBe(false);
  });

  it('returns false for message containing 503 as non-status number', () => {
    expect(isTransientNetworkError(new Error('timeout after 503ms'))).toBe(
      false,
    );
  });
});

describe('retryWithBackoff', () => {
  it('returns the result on first successful attempt', async () => {
    const result = await retryWithBackoff(
      () => Promise.resolve('success'),
      'test-label',
    );
    expect(result).toBe('success');
  });

  it('retries on transient error and succeeds on second attempt', async () => {
    const callCount = vi.fn();
    const fn = vi.fn(async () => {
      callCount();
      if (callCount.mock.calls.length === 1) {
        throw new Error('ECONNRESET');
      }
      return 'recovered';
    });

    const result = await retryWithBackoff(fn, 'test-retry');
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries and then throws', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(
      retryWithBackoff(fn, 'test-exhaust', { maxRetries: 2 }),
    ).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on permanent errors (401)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('401 Unauthorized');
    });

    await expect(retryWithBackoff(fn, 'test-permanent')).rejects.toThrow(
      '401 Unauthorized',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on method-not-found (-32601)', async () => {
    const fn = vi.fn(async () => {
      throw { code: -32601 };
    });

    await expect(
      retryWithBackoff(fn, 'test-method-not-found'),
    ).rejects.toMatchObject({ code: -32601 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff delay (observed timing)', async () => {
    const timestamps: number[] = [];
    const fn = vi.fn(async () => {
      timestamps.push(Date.now());
      throw new Error('ETIMEDOUT');
    });

    await expect(
      retryWithBackoff(fn, 'test-backoff', {
        maxRetries: 2,
        baseDelayMs: 50,
      }),
    ).rejects.toThrow('ETIMEDOUT');

    expect(fn).toHaveBeenCalledTimes(3);
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(50);
    expect(gap2).toBeGreaterThanOrEqual(gap1);
  });

  it('succeeds after transient 503 then success', async () => {
    const callCount = vi.fn();
    const fn = vi.fn(async () => {
      callCount();
      if (callCount.mock.calls.length === 1) {
        throw new Error('503 Service Unavailable');
      }
      return 'ok';
    });

    const result = await retryWithBackoff(fn, 'test-503');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects custom maxRetries=1 (single retry)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(
      retryWithBackoff(fn, 'test-single-retry', { maxRetries: 1 }),
    ).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('aborts immediately when signal fires during backoff', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

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

    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

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
