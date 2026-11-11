/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyHttpdnsErrorMetadata, logApiError } from './api-error-logger.js';
import { runLogger } from './runLogger.js';

function installSink() {
  const sink = vi.fn();
  runLogger.setLogSink(sink);
  return sink;
}

function messageOf(sink: ReturnType<typeof installSink>, index = 0): string {
  return String(sink.mock.calls[index]?.[0]?.message);
}

describe('logApiError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    runLogger.setLogSink(null);
  });

  it('prints a one-line summary using the first error code in the cause chain', async () => {
    const sink = installSink();
    const lookupReason = Object.assign(
      new Error('getaddrinfo ENOTFOUND api.example.com'),
      { code: 'ENOTFOUND' },
    );
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1'), {
      code: 'ECONNREFUSED',
      reason: lookupReason,
    });
    const error = Object.assign(new TypeError('fetch failed'), { cause });

    await logApiError(error, {
      operation: 'testOperation',
      url: 'https://api.example.com/v1/test',
      method: 'post',
      headers: {
        Authorization: 'Bearer very-secret-token',
      },
    });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(messageOf(sink)).toBe(
      '[API Error] POST https://api.example.com/v1/test failed: ECONNREFUSED',
    );
    expect(messageOf(sink)).not.toContain('\n');
    expect(messageOf(sink)).not.toContain('very-secret-token');
  });

  it('records uppercase request ids from request headers', async () => {
    const sink = installSink();

    await logApiError(new TypeError('fetch failed'), {
      url: 'https://openapi.example.com/v1/test',
      method: 'GET',
      headers: {
        'X-Request-ID': 'client-request-abc',
      },
    });

    expect(messageOf(sink)).toBe(
      '[API Error] GET https://openapi.example.com/v1/test failed: fetch failed requestId=CLIENT-REQUEST-ABC',
    );
  });

  it('falls back to HTTP status text when no error code exists', async () => {
    const sink = installSink();

    await logApiError(
      Object.assign(new Error('HTTP 502 Bad Gateway'), {
        response: new Response('bad gateway', {
          status: 502,
          statusText: 'Bad Gateway',
        }),
      }),
      {
        url: 'https://api.example.com/v1/test',
        method: 'GET',
      },
    );

    expect(messageOf(sink)).toBe(
      '[API Error] GET https://api.example.com/v1/test failed: 502 Bad Gateway',
    );
  });

  it('appends the raw error message when there is neither code nor response', async () => {
    const sink = installSink();

    await logApiError(new Error('socket hang up'), {
      url: 'https://api.example.com/v1/test',
      method: 'get',
    });

    expect(messageOf(sink)).toBe(
      '[API Error] GET https://api.example.com/v1/test failed: socket hang up',
    );
  });

  it('prints normalized network attempts on a second line', async () => {
    const sink = installSink();
    const error = Object.assign(new Error('network failed'), {
      code: 'ECONNRESET',
      networkAttempts: [
        {
          attemptIndex: 0,
          route: { kind: 'httpdns', source: 'config', hostname: 'api.example.com' },
          errorCode: 'ECONNRESET',
          errorMessage: 'reset',
          durationMs: 12,
        },
      ],
    });

    await logApiError(error, {
      operation: 'testOperation',
      url: 'https://api.example.com/v1/test',
      method: 'POST',
      headers: { 'request-id': 'abc' },
    });

    expect(sink).toHaveBeenCalledTimes(2);
    expect(messageOf(sink, 0)).toBe(
      '[API Error] POST https://api.example.com/v1/test failed: ECONNRESET requestId=ABC',
    );
    const attemptsLine = messageOf(sink, 1);
    expect(attemptsLine).toContain(
      '[API Network Attempts] POST https://api.example.com/v1/test requestId=ABC operation="testOperation" attempts=',
    );
    const attempts = JSON.parse(attemptsLine.split(' attempts=')[1] ?? '[]');
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptIndex: 0,
        errorCode: 'ECONNRESET',
        errorMessage: 'reset',
        durationMs: 12,
        route: expect.objectContaining({
          kind: 'httpdns',
          source: 'config',
          hostname: 'api.example.com',
        }),
      }),
    ]);
  });
});

describe('copyHttpdnsErrorMetadata', () => {
  it('copies resolved IP and attempt arrays onto the target', () => {
    const target: Record<string, unknown> = {};
    copyHttpdnsErrorMetadata(
      {
        resolvedIp: '10.0.0.1',
        httpdnsAttemptErrors: [{ code: 'ETIMEDOUT' }],
        networkAttempts: [{ attemptIndex: 1 }],
      },
      target,
    );

    expect(target).toEqual({
      resolvedIp: '10.0.0.1',
      httpdnsAttemptErrors: [{ code: 'ETIMEDOUT' }],
      networkAttempts: [{ attemptIndex: 1 }],
    });
  });

  it('leaves the target untouched for non-object inputs', () => {
    const target: Record<string, unknown> = {};
    copyHttpdnsErrorMetadata(undefined, target);
    copyHttpdnsErrorMetadata({ resolvedIp: '10.0.0.1' }, null);
    expect(target).toEqual({});
  });
});
