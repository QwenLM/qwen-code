/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage, isAbortError, isNodeError } from './errors.js';

describe('getErrorMessage cause unwrapping', () => {
  it('returns the plain message when there is no cause', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('surfaces an undici-style fetch-failed AggregateError cause (ECONNREFUSED)', () => {
    // undici "TypeError: fetch failed" wraps an AggregateError whose own
    // message is empty; the useful detail lives in `.errors[].code`.
    const inner = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:29900'),
      { code: 'ECONNREFUSED' },
    );
    const agg = new AggregateError([inner]); // message === ''
    const err = new TypeError('fetch failed', { cause: agg });

    const msg = getErrorMessage(err);
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('ECONNREFUSED');
  });

  it('surfaces a single Error cause that has a code but empty message', () => {
    const cause = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });
    expect(getErrorMessage(err)).toBe('fetch failed (cause: ECONNREFUSED)');
  });

  it('keeps the existing behavior for a cause with a meaningful message', () => {
    const err = new Error('outer', { cause: new Error('inner detail') });
    expect(getErrorMessage(err)).toBe('outer (cause: inner detail)');
  });

  it('does not append a redundant cause equal to the message', () => {
    const err = new Error('same', { cause: new Error('same') });
    expect(getErrorMessage(err)).toBe('same');
  });

  it('uses the message from plain error-like objects', () => {
    expect(
      getErrorMessage({
        code: -32603,
        message: 'path escapes workspace: /root/.qwen/skills/example.md',
        data: { errorKind: 'path_outside_workspace' },
      }),
    ).toBe('path escapes workspace: /root/.qwen/skills/example.md');
  });

  it('stringifies plain objects without a message', () => {
    expect(getErrorMessage({ code: -32603 })).toBe('{"code":-32603}');
  });

  it('bounds stringified plain objects without a message', () => {
    const message = getErrorMessage({ detail: 'x'.repeat(2000) });

    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain('"detail"');
  });

  it('uses String formatting for arrays', () => {
    expect(getErrorMessage([1, 2, 3])).toBe('1,2,3');
  });
});

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
