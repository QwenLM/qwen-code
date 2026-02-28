/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isRateLimitError, isNetworkError } from './rateLimit.js';
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
    // Use a code NOT in the built-in RATE_LIMIT_ERROR_CODES set (429, 503, 1302, 1305)
    // to ensure we are truly exercising the extraCodes branch.
    expect(
      isRateLimitError(
        { error: { code: 8888, message: 'Custom rate limit' } },
        [8888],
      ),
    ).toBe(true);
  });

  it('should not detect custom code when extraCodes is not provided', () => {
    // 9999 is not a built-in rate-limit code, so it should not be detected without extraCodes
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
    expect(isRateLimitError(new Error('Some random error'))).toBe(false);
  });
});

describe('isNetworkError — transient network failure detection', () => {
  it('should detect ECONNREFUSED', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
    (error as { code?: string }).code = 'ECONNREFUSED';
    expect(isNetworkError(error)).toBe(true);
  });

  it('should detect ETIMEDOUT', () => {
    const error = new Error('connect ETIMEDOUT');
    (error as { code?: string }).code = 'ETIMEDOUT';
    expect(isNetworkError(error)).toBe(true);
  });

  it('should detect ECONNRESET', () => {
    const error = new Error('read ECONNRESET');
    (error as { code?: string }).code = 'ECONNRESET';
    expect(isNetworkError(error)).toBe(true);
  });

  it('should NOT match by message alone (requires .code property)', () => {
    const error = new Error('connection refused by server');
    expect(isNetworkError(error)).toBe(false);
  });

  it('should NOT match non-Error values', () => {
    expect(isNetworkError('ECONNREFUSED')).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError({ code: 'ECONNREFUSED' })).toBe(false);
  });

  it('should NOT be detected by isRateLimitError (separate concerns)', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
    (error as { code?: string }).code = 'ECONNREFUSED';
    // isRateLimitError only checks numeric error codes, not network errors
    expect(isRateLimitError(error)).toBe(false);
  });
});
