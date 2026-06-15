/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import type { HttpError, RetryAttemptInfo } from './retry.js';
import {
  retryWithBackoff,
  isTransientCapacityError,
  isUnattendedMode,
} from './retry.js';
import { retryContext } from './retryContext.js';
import { getErrorStatus } from './errors.js';
import { setSimulate429 } from './testUtils.js';
import { AuthType } from '../core/contentGenerator.js';

const { debugLoggerMock } = vi.hoisted(() => ({
  debugLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => debugLoggerMock,
}));

// Helper to create a mock function that fails a certain number of times
const createFailingFunction = (
  failures: number,
  successValue: string = 'success',
) => {
  let attempts = 0;
  return vi.fn(async () => {
    attempts++;
    if (attempts <= failures) {
      // Simulate a retryable error
      const error: HttpError = new Error(`Simulated error attempt ${attempts}`);
      error.status = 500; // Simulate a server error
      throw error;
    }
    return successValue;
  });
};

// Custom error for testing non-retryable conditions
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Disable 429 simulation for tests
    setSimulate429(false);
    // Suppress unhandled promise rejection warnings for tests that expect errors
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should return the result on the first attempt if successful', async () => {
    const mockFn = createFailingFunction(0);
    const result = await retryWithBackoff(mockFn);
    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed if failures are within maxAttempts', async () => {
    const mockFn = createFailingFunction(2);
    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
    });

    await vi.runAllTimersAsync(); // Ensure all delays and retries complete

    const result = await promise;
    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('passes extra retry error codes into retry diagnostics', async () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });
    const mockFn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
      shouldRetryOnError: () => true,
      extraRetryErrorCodes: [4999],
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Attempt 1 failed'),
      expect.objectContaining({
        kind: 'provider',
        diagnosis: 'retryable',
        reason: 'rate-limit',
      }),
      error,
    );
  });

  it('retries caller-provided extra retry error codes by default', async () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });
    const mockFn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
      extraRetryErrorCodes: [4999],
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('honors a custom shouldRetryOnError:false over extraRetryErrorCodes', async () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });
    const mockFn = vi.fn().mockRejectedValue(error);

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      // A custom predicate that returns false must win even though 4999 is in
      // extraRetryErrorCodes — the caller's fast-fail decision is authoritative.
      shouldRetryOnError: () => false,
      extraRetryErrorCodes: [4999],
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertion = expect(promise).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('fast-fails on an abort error even with a permissive shouldRetryOnError', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const mockFn = vi.fn().mockRejectedValue(abortError);

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      // Permissive predicate must not override cancellation.
      shouldRetryOnError: () => true,
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertion = expect(promise).rejects.toBe(abortError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  describe('shouldRetryOnContent', () => {
    it('retries on invalid content then returns the valid result', async () => {
      const bad = { text: 'bad' } as unknown;
      const good = { text: 'good' } as unknown;
      const fn = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 10,
        shouldRetryOnContent: (content) =>
          (content as { text: string }).text === 'bad',
      });

      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe(good);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns the last response when content stays invalid through all attempts', async () => {
      const bad = { text: 'bad' } as unknown;
      const fn = vi.fn().mockResolvedValue(bad);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        shouldRetryOnContent: () => true,
      });

      await vi.runAllTimersAsync();
      // Best-effort: after exhausting content retries, the caller gets the last
      // (still-invalid) response with its real content, not a context-free error.
      await expect(promise).resolves.toBe(bad);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('returns immediately when content is valid', async () => {
      const good = { text: 'good' } as unknown;
      const fn = vi.fn().mockResolvedValue(good);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        shouldRetryOnContent: () => false,
      });

      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe(good);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('should throw an error if all attempts fail', async () => {
    const mockFn = createFailingFunction(3);

    // 1. Start the retryable operation, which returns a promise.
    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
    });

    // 2. IMPORTANT: Attach the rejection expectation to the promise *immediately*.
    //    This ensures a 'catch' handler is present before the promise can reject.
    //    The result is a new promise that resolves when the assertion is met.
    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Simulated error attempt 3',
    );

    // 3. Now, advance the timers. This will trigger the retries and the
    //    eventual rejection. The handler attached in step 2 will catch it.
    await vi.runAllTimersAsync();

    // 4. Await the assertion promise itself to ensure the test was successful.
    await assertionPromise;

    // 5. Finally, assert the number of calls.
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should default to 7 maxAttempts if no options are provided', async () => {
    // This function will fail more than 7 times to ensure all retries are used.
    const mockFn = createFailingFunction(10);

    const promise = retryWithBackoff(mockFn);

    // Expect it to fail with the error from the 7th attempt.
    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Simulated error attempt 7',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;

    expect(mockFn).toHaveBeenCalledTimes(7);
  });

  it('should default to 7 maxAttempts if options.maxAttempts is undefined', async () => {
    // This function will fail more than 7 times to ensure all retries are used.
    const mockFn = createFailingFunction(10);

    const promise = retryWithBackoff(mockFn, { maxAttempts: undefined });

    // Expect it to fail with the error from the 7th attempt.
    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Simulated error attempt 7',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;

    expect(mockFn).toHaveBeenCalledTimes(7);
  });

  it('should not retry if shouldRetry returns false', async () => {
    const mockFn = vi.fn(async () => {
      throw new NonRetryableError('Non-retryable error');
    });
    const shouldRetryOnError = (error: Error) =>
      !(error instanceof NonRetryableError);

    const promise = retryWithBackoff(mockFn, {
      shouldRetryOnError,
      initialDelayMs: 10,
    });

    await expect(promise).rejects.toThrow('Non-retryable error');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if maxAttempts is not a positive number', async () => {
    const mockFn = createFailingFunction(1);

    // Test with 0
    await expect(retryWithBackoff(mockFn, { maxAttempts: 0 })).rejects.toThrow(
      'maxAttempts must be a positive number.',
    );

    // The function should not be called at all if validation fails
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should use default shouldRetry if not provided, retrying on 429', async () => {
    const mockFn = vi.fn(async () => {
      const error = new Error('Too Many Requests') as any;
      error.status = 429;
      throw error;
    });

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
    });

    // Attach the rejection expectation *before* running timers
    const assertionPromise =
      expect(promise).rejects.toThrow('Too Many Requests'); // eslint-disable-line vitest/valid-expect

    // Run timers to trigger retries and eventual rejection
    await vi.runAllTimersAsync();

    // Await the assertion
    await assertionPromise;

    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should use default shouldRetry if not provided, not retrying on 400', async () => {
    const mockFn = vi.fn(async () => {
      const error = new Error('Bad Request') as any;
      error.status = 400;
      throw error;
    });

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
    });
    await expect(promise).rejects.toThrow('Bad Request');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxDelayMs', async () => {
    const mockFn = createFailingFunction(3);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 250, // Max delay is less than 100 * 2 * 2 = 400
    });

    await vi.advanceTimersByTimeAsync(1000); // Advance well past all delays
    await promise;

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);

    // Delays should be around initial, initial*2, maxDelay (due to cap)
    // Jitter makes exact assertion hard, so we check ranges / caps
    expect(delays.length).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100 * 0.7);
    expect(delays[0]).toBeLessThanOrEqual(100 * 1.3);
    expect(delays[1]).toBeGreaterThanOrEqual(200 * 0.7);
    expect(delays[1]).toBeLessThanOrEqual(200 * 1.3);
    // The third delay should be capped by maxDelayMs (250ms), accounting for jitter
    expect(delays[2]).toBeGreaterThanOrEqual(250 * 0.7);
    expect(delays[2]).toBeLessThanOrEqual(250 * 1.3);
  });

  it('should handle jitter correctly, ensuring varied delays', async () => {
    let mockFn = createFailingFunction(5);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    // Run retryWithBackoff multiple times to observe jitter
    const runRetry = () =>
      retryWithBackoff(mockFn, {
        maxAttempts: 2, // Only one retry, so one delay
        initialDelayMs: 100,
        maxDelayMs: 1000,
      });

    // We expect rejections as mockFn fails 5 times
    const promise1 = runRetry();
    // Attach the rejection expectation *before* running timers
    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise1 = expect(promise1).rejects.toThrow();
    await vi.runAllTimersAsync(); // Advance for the delay in the first runRetry
    await assertionPromise1;

    const firstDelaySet = setTimeoutSpy.mock.calls.map(
      (call) => call[1] as number,
    );
    setTimeoutSpy.mockClear(); // Clear calls for the next run

    // Reset mockFn to reset its internal attempt counter for the next run
    mockFn = createFailingFunction(5); // Re-initialize with 5 failures

    const promise2 = runRetry();
    // Attach the rejection expectation *before* running timers
    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise2 = expect(promise2).rejects.toThrow();
    await vi.runAllTimersAsync(); // Advance for the delay in the second runRetry
    await assertionPromise2;

    const secondDelaySet = setTimeoutSpy.mock.calls.map(
      (call) => call[1] as number,
    );

    // Check that the delays are not exactly the same due to jitter
    // This is a probabilistic test, but with +/-30% jitter, it's highly likely they differ.
    if (firstDelaySet.length > 0 && secondDelaySet.length > 0) {
      // Check the first delay of each set
      expect(firstDelaySet[0]).not.toBe(secondDelaySet[0]);
    } else {
      // If somehow no delays were captured (e.g. test setup issue), fail explicitly
      throw new Error('Delays were not captured for jitter test');
    }

    // Ensure delays are within the expected jitter range [70, 130] for initialDelayMs = 100
    [...firstDelaySet, ...secondDelaySet].forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(100 * 0.7);
      expect(d).toBeLessThanOrEqual(100 * 1.3);
    });
  });

  describe('Qwen OAuth 429 error handling', () => {
    it('should retry for Qwen OAuth 429 errors that are throttling-related', async () => {
      const errorWith429: HttpError = new Error('Rate limit exceeded');
      errorWith429.status = 429;

      const fn = vi
        .fn()
        .mockRejectedValueOnce(errorWith429)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.QWEN_OAUTH,
      });

      // Fast-forward time for delays
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');

      // Should be called twice (1 failure + 1 success)
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately for Qwen OAuth with insufficient_quota message', async () => {
      const errorWithInsufficientQuota = Object.assign(
        new Error('Free allocated quota exceeded.'),
        { status: 429, code: 'insufficient_quota' },
      );

      const fn = vi.fn().mockRejectedValue(errorWithInsufficientQuota);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        authType: AuthType.QWEN_OAUTH,
      });

      await expect(promise).rejects.toThrow(
        /Qwen OAuth free tier has been discontinued/,
      );

      // Should be called only once (no retries)
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately for Qwen OAuth with free allocated quota exceeded message', async () => {
      const errorWithQuotaExceeded = Object.assign(
        new Error('Free allocated quota exceeded.'),
        { status: 429, code: 'insufficient_quota' },
      );

      const fn = vi.fn().mockRejectedValue(errorWithQuotaExceeded);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        authType: AuthType.QWEN_OAUTH,
      });

      await expect(promise).rejects.toThrow(
        /Qwen OAuth free tier has been discontinued/,
      );

      // Should be called only once (no retries)
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry for Qwen OAuth with throttling message', async () => {
      const throttlingError: HttpError = new Error(
        'requests throttling triggered',
      );
      throttlingError.status = 429;

      const fn = vi
        .fn()
        .mockRejectedValueOnce(throttlingError)
        .mockRejectedValueOnce(throttlingError)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.QWEN_OAUTH,
      });

      // Fast-forward time for delays
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');

      // Should be called 3 times (2 failures + 1 success)
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should retry for Qwen OAuth with throttling error', async () => {
      const throttlingError: HttpError = new Error('throttling');
      throttlingError.status = 429;

      const fn = vi
        .fn()
        .mockRejectedValueOnce(throttlingError)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.QWEN_OAUTH,
      });

      // Fast-forward time for delays
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');

      // Should be called 2 times (1 failure + 1 success)
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately for Qwen OAuth with quota message', async () => {
      const errorWithQuota = Object.assign(
        new Error('Free allocated quota exceeded.'),
        { status: 429, code: 'insufficient_quota' },
      );

      const fn = vi.fn().mockRejectedValue(errorWithQuota);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        authType: AuthType.QWEN_OAUTH,
      });

      await expect(promise).rejects.toThrow(
        /Qwen OAuth free tier has been discontinued/,
      );

      // Should be called only once (no retries)
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry normal errors for Qwen OAuth (not quota-related)', async () => {
      const normalError: HttpError = new Error('Network error');
      normalError.status = 500;

      const fn = createFailingFunction(2, 'success');
      // Replace the default 500 error with our normal error
      fn.mockRejectedValueOnce(normalError)
        .mockRejectedValueOnce(normalError)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.QWEN_OAUTH,
      });

      // Fast-forward time for delays
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');

      // Should be called 3 times (2 failures + 1 success)
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});

describe('isTransientCapacityError', () => {
  it('should return true for 429 errors', () => {
    const error = { status: 429 };
    expect(isTransientCapacityError(error)).toBe(true);
  });

  it('should return true for 529 errors', () => {
    const error = { status: 529 };
    expect(isTransientCapacityError(error)).toBe(true);
  });

  it('should return false for 500 errors', () => {
    const error = { status: 500 };
    expect(isTransientCapacityError(error)).toBe(false);
  });

  it('should return false for 400 errors', () => {
    const error = { status: 400 };
    expect(isTransientCapacityError(error)).toBe(false);
  });

  it('should return false for errors without status', () => {
    expect(isTransientCapacityError(new Error('generic'))).toBe(false);
    expect(isTransientCapacityError(null)).toBe(false);
  });
});

describe('isUnattendedMode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['QWEN_CODE_UNATTENDED_RETRY'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return true when QWEN_CODE_UNATTENDED_RETRY=1', () => {
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = '1';
    expect(isUnattendedMode()).toBe(true);
  });

  it('should return true when QWEN_CODE_UNATTENDED_RETRY=true', () => {
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = 'true';
    expect(isUnattendedMode()).toBe(true);
  });

  it('should return false when no env vars are set', () => {
    expect(isUnattendedMode()).toBe(false);
  });

  it('should NOT activate on CI=true alone', () => {
    process.env['CI'] = 'true';
    expect(isUnattendedMode()).toBe(false);
  });

  it('should return false for non-matching values', () => {
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = '0';
    expect(isUnattendedMode()).toBe(false);
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = 'false';
    expect(isUnattendedMode()).toBe(false);
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = '';
    expect(isUnattendedMode()).toBe(false);
  });

  it('should use strict matching consistent with parseBooleanEnvFlag', () => {
    // Only 'true' and '1' are accepted — matches project convention
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = 'TRUE';
    expect(isUnattendedMode()).toBe(false); // strict: not 'true'
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = ' 1 ';
    expect(isUnattendedMode()).toBe(false); // strict: not '1'
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = 'yes';
    expect(isUnattendedMode()).toBe(false);
  });
});

describe('retryWithBackoff - persistent mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSimulate429(false);
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should retry indefinitely for 429 errors in persistent mode', async () => {
    // Fail 10 times with 429, then succeed
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 10) {
        const error: HttpError = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3, // Would normally fail after 3
      initialDelayMs: 10,
      persistentMode: true,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(11); // 10 failures + 1 success
  });

  it('should retry indefinitely for 529 errors in persistent mode', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 8) {
        const error: HttpError = new Error('Overloaded');
        error.status = 529;
        throw error;
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: true,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(9);
  });

  it('should NOT retry indefinitely for 500 errors in persistent mode', async () => {
    const fn = vi.fn(async () => {
      const error: HttpError = new Error('Internal Server Error');
      error.status = 500;
      throw error;
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: true,
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Internal Server Error',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;

    // Should stop at maxAttempts for non-transient errors
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should NOT retry indefinitely for fail-fast quota 429s in persistent mode', async () => {
    // DashScope allocated-quota exhaustion surfaces as HTTP 429 but is a
    // permanent business error (classified fail-fast). Persistent mode must
    // fall back to the bounded maxAttempts path rather than looping forever.
    const fn = vi.fn(async () => {
      const error = Object.assign(new Error('Allocated quota exceeded'), {
        status: 429,
        code: 'Throttling.AllocationQuota',
      });
      throw error;
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: true,
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Allocated quota exceeded',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should cap single retry backoff at persistentMaxBackoffMs', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 20) {
        const error: HttpError = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      persistentMaxBackoffMs: 5000, // 5 seconds cap for test
    });

    await vi.runAllTimersAsync();
    await promise;

    // Jitter is re-capped, so no delay should exceed the cap itself
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(5000 + 1); // cap + rounding tolerance
    }
  });

  it('should call heartbeatFn during persistent retry waits', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) {
        const error: HttpError = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
      return 'success';
    });

    const heartbeatFn = vi.fn();

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      heartbeatIntervalMs: 30, // Short interval for test
      heartbeatFn,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Heartbeat should have been called at least once during waits > heartbeatInterval
    expect(heartbeatFn).toHaveBeenCalled();
    // Verify heartbeat info structure
    const call = heartbeatFn.mock.calls[0][0];
    expect(call).toHaveProperty('attempt');
    expect(call).toHaveProperty('remainingMs');
    expect(call).toHaveProperty('error');
  });

  it('should abort persistent retry when signal is aborted', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      const error: HttpError = new Error('Rate limited');
      error.status = 429;
      throw error;
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10000, // Long delay so abort happens during sleep
      persistentMode: true,
      heartbeatIntervalMs: 50,
      signal: controller.signal,
    });

    // Abort after the first retry starts waiting
    setTimeout(() => controller.abort(), 100);

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Retry aborted by signal',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;
  });

  it('should respect shouldRetryOnError even in persistent mode', async () => {
    // Caller explicitly says "don't retry 429" — persistent mode must obey
    const fn = vi.fn(async () => {
      const error: HttpError = new Error('Rate limited');
      error.status = 429;
      throw error;
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: true,
      shouldRetryOnError: () => false, // force fast-fail
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow('Rate limited');
    await vi.runAllTimersAsync();
    await assertionPromise;

    // Should fail on first attempt — shouldRetryOnError trumps persistent mode
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should not infinite-loop when heartbeatIntervalMs is 0', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) {
        const error: HttpError = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: true,
      heartbeatIntervalMs: 0, // Would cause infinite loop without Math.max(1, ...)
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not affect normal mode behavior when persistentMode is false', async () => {
    const fn = vi.fn(async () => {
      const error: HttpError = new Error('Rate limited');
      error.status = 429;
      throw error;
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      persistentMode: false,
    });

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow('Rate limited');
    await vi.runAllTimersAsync();
    await assertionPromise;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('retryWithBackoff - Retry-After handling in persistent mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSimulate429(false);
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Helper: create a 429 error with Retry-After header
  function make429WithRetryAfter(seconds: number): HttpError {
    const error: HttpError & { response: { headers: Record<string, string> } } =
      Object.assign(new Error('Rate limited'), {
        status: 429,
        response: { headers: { 'retry-after': String(seconds) } },
      });
    return error;
  }

  it('should respect Retry-After and NOT cap at maxBackoff', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 1) {
        throw make429WithRetryAfter(600); // server says wait 10 minutes
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      persistentMaxBackoffMs: 5000, // 5 seconds — Retry-After must NOT be capped to this
    });

    await vi.runAllTimersAsync();
    await promise;

    // The first retry delay should be ~600s (600000ms), not 5s (5000ms)
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    const firstRetryDelay = delays[0];
    expect(firstRetryDelay).toBeGreaterThan(5000); // NOT capped at maxBackoff
    expect(firstRetryDelay).toBeLessThanOrEqual(600 * 1000); // respects server value
  });

  it('should cap Retry-After at persistentCapMs', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 1) {
        throw make429WithRetryAfter(100); // server says wait 100s
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      persistentCapMs: 50_000, // absolute cap 50s — less than Retry-After
    });

    await vi.runAllTimersAsync();
    await promise;

    // Delay should be capped at persistentCapMs (50s), not the full 100s
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    const firstRetryDelay = delays[0];
    expect(firstRetryDelay).toBeLessThanOrEqual(50_000 + 1);
  });

  it('should NOT add jitter to Retry-After delays', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    // Run multiple times to check for jitter variance
    const observedDelays: number[] = [];

    for (let run = 0; run < 5; run++) {
      setTimeoutSpy.mockClear();
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts <= 1) {
          throw make429WithRetryAfter(10); // 10 seconds
        }
        return 'success';
      });

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 100,
        persistentMode: true,
      });

      await vi.runAllTimersAsync();
      await promise;

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
      observedDelays.push(delays[0]);
    }

    // All delays should be exactly 10000ms — no jitter
    for (const d of observedDelays) {
      expect(d).toBe(10_000);
    }
  });

  it('should apply jitter inside persistentCapMs for exponential delays', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 1) {
        const error = Object.assign(new Error('Rate limited'), {
          status: 429,
        });
        throw error;
      }
      return 'success';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100_000,
      persistentMode: true,
      persistentMaxBackoffMs: 300_000,
      persistentCapMs: 50_000,
      heartbeatIntervalMs: 100_000,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(37_500);
    expect(randomSpy).toHaveBeenCalled();
  });
});

describe('retryWithBackoff - Retry-After handling in normal mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSimulate429(false);
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should read Retry-After from direct headers', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const error = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '3' },
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(3000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should read Retry-After case-insensitively from response headers', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const error = Object.assign(new Error('Rate limited'), {
      status: 429,
      response: { headers: { 'Retry-After': '3' } },
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(3000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should respect oversized Retry-After values for normal retries', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const error = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '600' },
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(600_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should honor Retry-After on 503 responses', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const error = Object.assign(new Error('Service unavailable'), {
      status: 503,
      headers: { 'retry-after': '4' },
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(4000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs a 503 Retry-After retry at error level, 429 at warn level', async () => {
    debugLoggerMock.error.mockClear();
    debugLoggerMock.warn.mockClear();

    const e503 = Object.assign(new Error('Service unavailable'), {
      status: 503,
      headers: { 'retry-after': '1' },
    });
    const p503 = retryWithBackoff(
      vi.fn().mockRejectedValueOnce(e503).mockResolvedValue('ok'),
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100 },
    );
    await vi.runAllTimersAsync();
    await p503;

    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Retrying after explicit delay'),
      expect.anything(),
      e503,
    );

    debugLoggerMock.error.mockClear();
    const e429 = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '1' },
    });
    const p429 = retryWithBackoff(
      vi.fn().mockRejectedValueOnce(e429).mockResolvedValue('ok'),
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100 },
    );
    await vi.runAllTimersAsync();
    await p429;

    // 429 throttling stays at warn, never error.
    expect(debugLoggerMock.error).not.toHaveBeenCalled();
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retrying after explicit delay'),
      expect.anything(),
      e429,
    );
  });

  it('should abort normal Retry-After waits when signal is aborted', async () => {
    const controller = new AbortController();
    const error = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '600' },
    });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    // eslint-disable-next-line vitest/valid-expect
    const assertionPromise = expect(promise).rejects.toThrow(
      'Retry aborted by signal',
    );
    await vi.runAllTimersAsync();
    await assertionPromise;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should reject retry waits immediately when the signal is already aborted', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const controller = new AbortController();
    controller.abort();
    const error = Object.assign(new Error('server busy'), { status: 500 });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow('Retry aborted by signal');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('getErrorStatus', () => {
  it('should extract status from error.status (OpenAI/Anthropic/Gemini style)', () => {
    expect(getErrorStatus({ status: 429 })).toBe(429);
    expect(getErrorStatus({ status: 500 })).toBe(500);
    expect(getErrorStatus({ status: 503 })).toBe(503);
    expect(getErrorStatus({ status: 400 })).toBe(400);
  });

  it('should extract status from error.statusCode', () => {
    expect(getErrorStatus({ statusCode: 429 })).toBe(429);
    expect(getErrorStatus({ statusCode: 502 })).toBe(502);
  });

  it('should extract status from error.response.status (axios style)', () => {
    expect(getErrorStatus({ response: { status: 429 } })).toBe(429);
    expect(getErrorStatus({ response: { status: 503 } })).toBe(503);
  });

  it('should extract status from error.error.code (nested error style)', () => {
    expect(getErrorStatus({ error: { code: 429 } })).toBe(429);
    expect(getErrorStatus({ error: { code: 500 } })).toBe(500);
  });

  it('should prefer status over statusCode over response.status over error.code', () => {
    expect(
      getErrorStatus({
        status: 429,
        statusCode: 500,
        response: { status: 502 },
        error: { code: 503 },
      }),
    ).toBe(429);

    expect(
      getErrorStatus({
        statusCode: 500,
        response: { status: 502 },
        error: { code: 503 },
      }),
    ).toBe(500);

    expect(
      getErrorStatus({ response: { status: 502 }, error: { code: 503 } }),
    ).toBe(502);
  });

  it('should return undefined for out-of-range status codes', () => {
    expect(getErrorStatus({ status: 0 })).toBeUndefined();
    expect(getErrorStatus({ status: 99 })).toBeUndefined();
    expect(getErrorStatus({ status: 600 })).toBeUndefined();
    expect(getErrorStatus({ status: -1 })).toBeUndefined();
  });

  it('should return undefined for non-numeric status values', () => {
    expect(getErrorStatus({ status: 'not_a_number' })).toBeUndefined();
    expect(
      getErrorStatus({ error: { code: 'invalid_api_key' } }),
    ).toBeUndefined();
  });

  it('should return undefined for null, undefined, and non-object values', () => {
    expect(getErrorStatus(null)).toBeUndefined();
    expect(getErrorStatus(undefined)).toBeUndefined();
    expect(getErrorStatus(true)).toBeUndefined();
    expect(getErrorStatus(429)).toBeUndefined();
    expect(getErrorStatus('500')).toBeUndefined();
  });

  it('should handle Error instances with a status property', () => {
    const error: HttpError = new Error('Too Many Requests');
    error.status = 429;
    expect(getErrorStatus(error)).toBe(429);
  });

  it('should return undefined for Error instances without a status', () => {
    expect(getErrorStatus(new Error('generic error'))).toBeUndefined();
  });

  it('should return undefined for empty objects', () => {
    expect(getErrorStatus({})).toBeUndefined();
    expect(getErrorStatus({ response: {} })).toBeUndefined();
    expect(getErrorStatus({ error: {} })).toBeUndefined();
  });

  it('should parse HTTP_STATUS/NNN from streamed SSE error messages', () => {
    // DashScope throttling: error opens with 200 OK, then surfaces as an SSE
    // error frame. The SDK preserves the raw SSE text in error.message.
    const dashscopeThrottle = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"x","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
    );
    expect(getErrorStatus(dashscopeThrottle)).toBe(429);

    expect(getErrorStatus(new Error('upstream :HTTP_STATUS/503'))).toBe(503);
  });

  it('should prefer numeric status fields over HTTP_STATUS/NNN in message', () => {
    const error: HttpError = new Error(':HTTP_STATUS/500');
    error.status = 429;
    expect(getErrorStatus(error)).toBe(429);
  });

  it('should ignore HTTP_STATUS/NNN outside the valid range', () => {
    expect(getErrorStatus(new Error('HTTP_STATUS/999'))).toBeUndefined();
  });

  it('should not match HTTP_STATUS/NNN when adjacent to more digits', () => {
    expect(getErrorStatus(new Error('HTTP_STATUS/4291'))).toBeUndefined();
  });
});

// =========================================================================
// Phase 4b — retry telemetry (ALS context + onRetry callback + monotonic counter)
// =========================================================================
describe('retryWithBackoff — Phase 4b retry context (ALS)', () => {
  beforeEach(() => {
    // Use fake timers consistently with the rest of this file — vitest's
    // useRealTimers between describes is unreliable when other describes
    // have stubbed timer globals. We advance via vi.runAllTimersAsync().
    vi.useFakeTimers();
    setSimulate429(false);
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sets retryContext.attempt monotonically across attempts', async () => {
    const seenAttempts: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      seenAttempts.push(retryContext.getStore()?.attempt ?? -1);
      if (attempts <= 2) {
        const err: HttpError = new Error('transient');
        err.status = 500;
        throw err;
      }
      return 'ok';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(seenAttempts).toEqual([1, 2, 3]);
  });

  it('exposes retryContext.requestSetupMs / retryTotalDelayMs (== 0 for attempt 1, > 0 for retries)', async () => {
    const snapshots: Array<{ setupMs: number; totalDelayMs: number }> = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      const ctx = retryContext.getStore();
      snapshots.push({
        setupMs: ctx?.requestSetupMs ?? -1,
        totalDelayMs: ctx?.retryTotalDelayMs ?? -1,
      });
      if (attempts <= 2) {
        const err: HttpError = new Error('transient');
        err.status = 500;
        throw err;
      }
      return 'ok';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 50,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Attempt 1: nothing happened before, so both are 0.
    expect(snapshots[0]!.setupMs).toBe(0);
    expect(snapshots[0]!.totalDelayMs).toBe(0);
    // Attempts 2+: both fields populate with positive values once retries
    // have run. Exact values depend on the jittered backoff; assert monotonic.
    expect(snapshots[1]!.setupMs).toBeGreaterThanOrEqual(0);
    expect(snapshots[1]!.totalDelayMs).toBeGreaterThan(0);
    expect(snapshots[2]!.setupMs).toBeGreaterThanOrEqual(snapshots[1]!.setupMs);
    expect(snapshots[2]!.totalDelayMs).toBeGreaterThan(
      snapshots[1]!.totalDelayMs,
    );
  });

  it('first-try success: retryContext.attempt === 1, both delays === 0, onRetry never called', async () => {
    let observed: { attempt: number; setup: number; delay: number } | null =
      null;
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      const ctx = retryContext.getStore();
      observed = {
        attempt: ctx?.attempt ?? -1,
        setup: ctx?.requestSetupMs ?? -1,
        delay: ctx?.retryTotalDelayMs ?? -1,
      };
      return 'ok';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(observed).toEqual({ attempt: 1, setup: 0, delay: 0 });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('onRetry callback fires once per failed attempt with correct args', async () => {
    const onRetry = vi.fn();
    const fn = createFailingFunction(2, 'ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await promise;

    // 2 failures -> 2 onRetry invocations
    expect(onRetry).toHaveBeenCalledTimes(2);
    const first = onRetry.mock.calls[0]![0] as RetryAttemptInfo;
    expect(first.attempt).toBe(1);
    expect(first.errorStatus).toBe(500);
    expect((first.error as Error).message).toContain('attempt 1');
    expect(first.delayMs).toBeGreaterThanOrEqual(0);
    const second = onRetry.mock.calls[1]![0] as RetryAttemptInfo;
    expect(second.attempt).toBe(2);
  });

  it('absence of onRetry is silent (no exception)', async () => {
    const fn = createFailingFunction(1, 'ok');
    // No onRetry passed. Must not throw or warn.
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
  });

  it('onRetry callback throwing does NOT break the retry loop', async () => {
    const onRetry = vi.fn(() => {
      throw new Error('telemetry blew up');
    });
    const fn = createFailingFunction(2, 'ok');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('shouldRetryOnError returns false mid-loop: onRetry not called for the giveup', async () => {
    // Attempt 1 fails with 500 (retryable), attempt 2 fails with 400
    // (non-retryable). Retry loop gives up on attempt 2 without invoking
    // onRetry for it.
    const onRetry = vi.fn();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      const err: HttpError = new Error(`attempt ${n}`);
      err.status = n === 1 ? 500 : 400;
      throw err;
    });

    // Attach .catch() BEFORE the timer runs, so Vitest sees the promise has
    // a handler when the rejection lands (avoids unhandled-rejection warnings).
    const caught = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      shouldRetryOnError: (e) =>
        (e as HttpError).status === 500 || (e as HttpError).status === 429,
      onRetry,
    }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await caught;
    expect((error as Error).message).toBe('attempt 2');

    // Only the FIRST failed attempt invoked onRetry (it led to a retry).
    // The second failed attempt aborted the loop and did not.
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].attempt).toBe(1);
  });

  it('parallel retryWithBackoff calls maintain independent attempt counters', async () => {
    // Two concurrent retryWithBackoff invocations must each see their own
    // ALS context (AsyncLocalStorage isolates them by async chain).
    const callA: number[] = [];
    const callB: number[] = [];

    const makeFn = (sink: number[]) => {
      let n = 0;
      return vi.fn(async () => {
        n++;
        sink.push(retryContext.getStore()?.attempt ?? -1);
        if (n <= 1) {
          const err: HttpError = new Error('boom');
          err.status = 500;
          throw err;
        }
        return 'ok';
      });
    };

    const both = Promise.all([
      retryWithBackoff(makeFn(callA), {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 3,
      }),
      retryWithBackoff(makeFn(callB), {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 3,
      }),
    ]);

    await vi.runAllTimersAsync();
    await both;

    expect(callA).toEqual([1, 2]);
    expect(callB).toEqual([1, 2]);
  });

  it('nested retryWithBackoff reads innermost frame', async () => {
    const observed: Array<{
      layer: 'outer' | 'inner';
      attempt: number;
    }> = [];
    let innerAttempts = 0;

    const inner = vi.fn(async () => {
      innerAttempts++;
      observed.push({
        layer: 'inner',
        attempt: retryContext.getStore()?.attempt ?? -1,
      });
      if (innerAttempts <= 1) {
        const err: HttpError = new Error('inner-fail');
        err.status = 500;
        throw err;
      }
      return 'inner-ok';
    });

    const outer = vi.fn(async () => {
      observed.push({
        layer: 'outer',
        attempt: retryContext.getStore()?.attempt ?? -1,
      });
      return await retryWithBackoff(inner, {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 3,
      });
    });

    const promise = retryWithBackoff(outer, {
      maxAttempts: 1,
      initialDelayMs: 1,
      maxDelayMs: 3,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Outer call sees its own frame's attempt (1).
    // Inner calls see their own frame's attempt (1, then 2 after retry).
    // Inner DOES NOT see the outer's frame.
    expect(observed).toEqual([
      { layer: 'outer', attempt: 1 },
      { layer: 'inner', attempt: 1 },
      { layer: 'inner', attempt: 2 },
    ]);
  });

  it('persistent mode (status=429): onRetry fires with correct attempt + delayMs from persistent backoff', async () => {
    // Review comment R1 #4 + R2 #3: the highest-volume production retry path
    // (429 → persistent mode) was untested. Verify onRetry fires with the
    // monotonic iterationCount and a reasonable backoff delay.
    const onRetry = vi.fn();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n <= 2) {
        const err: HttpError = new Error(`rate limited #${n}`);
        err.status = 429;
        throw err;
      }
      return 'ok';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 50,
      maxDelayMs: 200,
      persistentMode: true,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(onRetry).toHaveBeenCalledTimes(2);
    const first = onRetry.mock.calls[0]![0] as RetryAttemptInfo;
    expect(first.attempt).toBe(1);
    expect(first.errorStatus).toBe(429);
    expect(first.delayMs).toBeGreaterThan(0);
    const second = onRetry.mock.calls[1]![0] as RetryAttemptInfo;
    expect(second.attempt).toBe(2);
    expect(second.errorStatus).toBe(429);
    // Persistent mode uses exponential backoff — second delay >= first
    expect(second.delayMs).toBeGreaterThanOrEqual(first.delayMs);
  });

  it('normal retry with Retry-After header: onRetry receives the header-derived delayMs', async () => {
    // Review comment R2 #7: verify that when the error includes a
    // `retry-after` header, `onRetry.delayMs` reflects the parsed value
    // (not the exponential backoff calculation).
    const onRetry = vi.fn();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n <= 1) {
        const err = new Error('rate limited') as HttpError & {
          response?: { headers?: { 'retry-after'?: string } };
        };
        err.status = 429;
        err.response = { headers: { 'retry-after': '2' } }; // 2 seconds
        throw err;
      }
      return 'ok';
    });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 500,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0]![0] as RetryAttemptInfo;
    // Retry-After: 2 → 2000ms
    expect(info.delayMs).toBe(2000);
    expect(info.errorStatus).toBe(429);
  });

  it('signal.aborted before onRetry: no phantom retry event emitted', async () => {
    // Review comment R2 #6: when signal fires between catch and onRetry,
    // the guard `if (!signal?.aborted)` should prevent onRetry from firing.
    const onRetry = vi.fn();
    const controller = new AbortController();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n === 1) {
        // Abort the signal during the first failure — before onRetry runs
        controller.abort();
        const err: HttpError = new Error('server error');
        err.status = 500;
        throw err;
      }
      return 'ok';
    });

    // The retry loop should detect the aborted signal and NOT fire onRetry.
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 50,
      signal: controller.signal,
      onRetry,
    }).catch((e: unknown) => e);

    await vi.runAllTimersAsync();
    await promise;

    // onRetry should NOT have been called because signal was aborted
    expect(onRetry).not.toHaveBeenCalled();
  });
});
