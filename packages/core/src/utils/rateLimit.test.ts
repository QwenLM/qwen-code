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
});
