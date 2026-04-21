/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isRateLimitError } from './rateLimit.js';
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
