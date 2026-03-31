/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAbortError, isNodeError, getErrorType } from './errors.js';

describe('isAbortError', () => {
  it('should return true for DOMException-style AbortError', () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    expect(isAbortError(abortError)).toBe(true);
  });

  it('should return true for custom AbortError class', () => {
    class AbortError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'AbortError';
      }
    }

    const error = new AbortError('Custom abort error');
    expect(isAbortError(error)).toBe(true);
  });

  it('should return true for Node.js abort error (ABORT_ERR code)', () => {
    const nodeAbortError = new Error(
      'Request aborted',
    ) as NodeJS.ErrnoException;
    nodeAbortError.code = 'ABORT_ERR';

    expect(isAbortError(nodeAbortError)).toBe(true);
  });

  it('should return false for regular errors', () => {
    expect(isAbortError(new Error('Regular error'))).toBe(false);
  });

  it('should return false for null', () => {
    expect(isAbortError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isAbortError(undefined)).toBe(false);
  });

  it('should return false for non-object values', () => {
    expect(isAbortError('string error')).toBe(false);
    expect(isAbortError(123)).toBe(false);
    expect(isAbortError(true)).toBe(false);
  });

  it('should return false for errors with different names', () => {
    const timeoutError = new Error('Request timed out');
    timeoutError.name = 'TimeoutError';

    expect(isAbortError(timeoutError)).toBe(false);
  });

  it('should return false for errors with other error codes', () => {
    const networkError = new Error('Network error') as NodeJS.ErrnoException;
    networkError.code = 'ECONNREFUSED';

    expect(isAbortError(networkError)).toBe(false);
  });
});

describe('isNodeError', () => {
  it('should return true for Error with code property', () => {
    const nodeError = new Error('File not found') as NodeJS.ErrnoException;
    nodeError.code = 'ENOENT';

    expect(isNodeError(nodeError)).toBe(true);
  });

  it('should return false for Error without code property', () => {
    const regularError = new Error('Regular error');

    expect(isNodeError(regularError)).toBe(false);
  });

  it('should return false for non-Error objects', () => {
    expect(isNodeError({ code: 'ENOENT' })).toBe(false);
    expect(isNodeError('string')).toBe(false);
    expect(isNodeError(null)).toBe(false);
  });
});

describe('getErrorType', () => {
  it('should return constructor name for SDK error subclasses', () => {
    class APIConnectionError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'APIConnectionError';
      }
    }
    const error = new APIConnectionError('Connection failed');
    expect(getErrorType(error)).toBe('APIConnectionError');
  });

  it('should return sdkType for OpenAI-style errors', () => {
    const error = { type: 'invalid_request_error', message: 'Bad request' };
    expect(getErrorType(error)).toBe('invalid_request_error');
  });

  it('should return Qwen error code for Qwen API errors', () => {
    const error = {
      error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' },
    };
    expect(getErrorType(error)).toBe('rate_limit_exceeded');
  });

  it('should prioritize constructor name over sdkType', () => {
    class RateLimitError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
      }
    }
    const error = new RateLimitError('Too many requests') as {
      type?: string;
    };
    error.type = 'rate_limit_error';
    expect(getErrorType(error)).toBe('RateLimitError');
  });

  it('should prioritize sdkType over Qwen error code', () => {
    const error = {
      type: 'authentication_error',
      error: { code: 'invalid_api_key', message: 'Invalid API key' },
    };
    expect(getErrorType(error)).toBe('authentication_error');
  });

  it('should return error name for generic errors', () => {
    const error = new Error('Generic error');
    expect(getErrorType(error)).toBe('Error');
  });

  it('should append cause code for network errors', () => {
    const error = new Error('Connection refused') as Error & {
      cause?: { code: string };
    };
    error.cause = { code: 'ECONNREFUSED' };
    expect(getErrorType(error)).toBe('Error:ECONNREFUSED');
  });

  it('should return unknown for non-object values', () => {
    expect(getErrorType(null)).toBe('unknown');
    expect(getErrorType(undefined)).toBe('unknown');
    expect(getErrorType('string')).toBe('unknown');
    expect(getErrorType(123)).toBe('unknown');
  });

  it('should return unknown for plain objects without error properties', () => {
    const error = { message: 'Plain object error' };
    expect(getErrorType(error)).toBe('unknown');
  });
});
