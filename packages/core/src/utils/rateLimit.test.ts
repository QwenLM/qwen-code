/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getRateLimitErrorDetails,
  getRateLimitRetryDelayMs,
  isRateLimitError,
} from './rateLimit.js';
import type { StructuredError } from '../core/turn.js';
import type { HttpError } from './retry.js';

describe('isRateLimitError — detection paths', () => {
  it('should detect rate-limit from ApiError.error.code in JSON message', () => {
    const info = isRateLimitError(
      new Error(
        '{"error":{"code":"429","message":"Throttling: TPM(10680324/10000000)"}}',
      ),
    );
    expect(info).toBe(true);
  });

  it('should detect rate-limit from direct ApiError object', () => {
    const info = isRateLimitError({
      error: { code: 429, message: 'Rate limit exceeded' },
    });
    expect(info).toBe(true);
  });

  it('should detect GLM 1302 code from ApiError', () => {
    const info = isRateLimitError({
      error: { code: 1302, message: '您的账户已达到速率限制' },
    });
    expect(info).toBe(true);
  });

  it('should detect 1305 code from ApiError (issue #1918)', () => {
    const info = isRateLimitError({
      error: { code: 1305, message: 'IdealTalk rate limit' },
    });
    expect(info).toBe(true);
  });

  it('should detect rate-limit from StructuredError.status', () => {
    const error: StructuredError = { message: 'Rate limited', status: 429 };
    const info = isRateLimitError(error);
    expect(info).toBe(true);
  });

  it('should detect rate-limit from HttpError.status', () => {
    const error: HttpError = new Error('Too Many Requests');
    error.status = 429;
    const info = isRateLimitError(error);
    expect(info).toBe(true);
  });

  it('should return null for non-rate-limit codes', () => {
    expect(
      isRateLimitError({ error: { code: 400, message: 'Bad Request' } }),
    ).toBe(false);
  });

  it('should detect custom error code passed via extraCodes', () => {
    expect(
      isRateLimitError(
        { error: { code: 9999, message: 'Custom rate limit' } },
        [9999],
      ),
    ).toBe(true);
  });

  it('should not detect custom code when extraCodes is not provided', () => {
    expect(
      isRateLimitError({ error: { code: 9999, message: 'Custom rate limit' } }),
    ).toBe(false);
  });

  it('should return null for invalid inputs', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('500')).toBe(false);
  });
});

describe('isRateLimitError — return shape', () => {
  it('should detect GLM rate limit JSON string', () => {
    const info = isRateLimitError(
      '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
    );
    expect(info).toBe(true);
  });

  it('should treat HTTP 503 as rate-limit', () => {
    const error: HttpError = new Error('Service Unavailable');
    error.status = 503;
    const info = isRateLimitError(error);
    expect(info).toBe(true);
  });

  it('should return null for non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('Connection refused'))).toBe(false);
  });

  it('should fall through JSON-in-message non-numeric code when Error has .status', () => {
    // Some middleware wraps errors into plain Error instances with the
    // provider error serialised into .message AND augments .status. The
    // JSON-in-message parse must not short-circuit with null when the
    // embedded code is non-numeric — the .status on the Error should win.
    const error: HttpError = new Error(
      '{"error":{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}}',
    );
    error.status = 429;
    expect(isRateLimitError(error)).toBe(true);
  });

  it('should fall through ApiError with non-numeric code when .status is set', () => {
    // DashScope/OpenAI-SDK shape: RateLimitError with .status=429 but
    // .error.code is a non-numeric string. Must still be recognised as a
    // rate limit via the .status fallback.
    const error = Object.assign(new Error('429 Allocated quota exceeded'), {
      status: 429,
      error: {
        code: 'Throttling.AllocationQuota',
        message: 'Allocated quota exceeded',
      },
    });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('should detect DashScope SSE-embedded 429 (Throttling.AllocationQuota)', () => {
    // Reproduces the production error seen from DashScope when the stream
    // opens with HTTP 200 and the throttling is surfaced mid-stream as an
    // SSE `event:error` frame. The OpenAI SDK preserves the raw SSE payload
    // in error.message, with no numeric `.status` on the error object.
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"70acdc21-a546-489a-b5d6-650df970a4ef","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded, please increase your quota limit."}',
    );
    expect(isRateLimitError(error)).toBe(true);
  });
});

describe('rate-limit retry diagnostics', () => {
  it('should extract structured details from SSE-embedded rate-limit errors', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"70acdc21-a546-489a-b5d6-650df970a4ef","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
    );

    expect(getRateLimitErrorDetails(error)).toEqual({
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
      providerMessage: 'Allocated quota exceeded',
      requestId: '70acdc21-a546-489a-b5d6-650df970a4ef',
      transport: 'sse',
    });
  });

  it('should ignore non-object SSE JSON payloads in diagnostics', () => {
    const error = new Error('id:1\nevent:error\n:HTTP_STATUS/429\ndata:null');

    expect(getRateLimitErrorDetails(error)).toEqual({
      statusCode: 429,
      transport: 'sse',
    });
  });

  it('should extract structured details from HTTP-shaped rate-limit errors', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
      },
    });

    expect(getRateLimitErrorDetails(error)).toEqual({
      statusCode: 429,
      providerCode: 'rate_limit_exceeded',
      providerMessage: 'Rate limit exceeded',
      transport: 'http',
    });
  });

  it('should extract nested JSON provider details from error messages', () => {
    const error = new Error(
      '{"error":{"code":"429","message":"Throttling: TPM limit reached"}}',
    );

    expect(getRateLimitErrorDetails(error)).toEqual({
      providerCode: '429',
      providerMessage: 'Throttling: TPM limit reached',
      transport: 'unknown',
    });
  });

  it('should extract request id from top-level nested JSON error messages', () => {
    const error = new Error(
      '{"request_id":"req-123","error":{"code":"429","message":"Throttling: TPM limit reached"}}',
    );

    expect(getRateLimitErrorDetails(error)).toEqual({
      providerCode: '429',
      providerMessage: 'Throttling: TPM limit reached',
      requestId: 'req-123',
      transport: 'unknown',
    });
  });

  it('should increase retry delay by attempt and cap at the maximum', () => {
    expect(
      getRateLimitRetryDelayMs(0, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(60_000);
    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(60_000);
    expect(
      getRateLimitRetryDelayMs(2, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(120_000);
    expect(
      getRateLimitRetryDelayMs(10, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
      }),
    ).toBe(300_000);
  });

  it('should use Retry-After as a minimum delay when it is longer than exponential backoff', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '180' },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(180_000);
  });

  it('should keep exponential backoff when Retry-After is shorter', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '30' },
    });

    expect(
      getRateLimitRetryDelayMs(2, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(120_000);
  });

  it('should cap long Retry-After values at the maximum delay', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '600' },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(300_000);
  });

  it('should read Retry-After from response headers', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      response: {
        headers: { 'retry-after': '180' },
      },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(180_000);
  });

  it('should read Retry-After from Headers-like objects', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: {
        get: (name: string) => (name === 'retry-after' ? '180' : null),
      },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(180_000);
  });

  it('should read Retry-After headers case-insensitively', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'Retry-After': '180' },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(180_000);
  });

  it('should read HTTP-date Retry-After values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      const error = Object.assign(new Error('Too many requests'), {
        status: 429,
        headers: { 'retry-after': 'Thu, 01 Jan 2026 00:03:00 GMT' },
      });

      expect(
        getRateLimitRetryDelayMs(1, {
          initialDelayMs: 60_000,
          maxDelayMs: 300_000,
          error,
        }),
      ).toBe(180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should ignore past HTTP-date Retry-After values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'));

    try {
      const error = Object.assign(new Error('Too many requests'), {
        status: 429,
        headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' },
      });

      expect(
        getRateLimitRetryDelayMs(1, {
          initialDelayMs: 60_000,
          maxDelayMs: 300_000,
          error,
        }),
      ).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should ignore malformed Retry-After values', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': 'not a retry-after value' },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(60_000);
  });

  it('should ignore null direct headers', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: null,
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(60_000);
  });

  it('should ignore undefined direct headers', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: undefined,
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(60_000);
  });

  it('should ignore null response headers', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      response: {
        headers: null,
      },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(60_000);
  });

  it('should ignore undefined response headers', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      response: {
        headers: undefined,
      },
    });

    expect(
      getRateLimitRetryDelayMs(1, {
        initialDelayMs: 60_000,
        maxDelayMs: 300_000,
        error,
      }),
    ).toBe(60_000);
  });
});
