/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
import { runWithRetryWaitObserver, type RetryWaitEvent } from './retry-wait.js';
import { getErrorStatus } from './errors.js';
import { isRateLimitError } from './rateLimit.js';
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

type RetryOpts = Parameters<typeof retryWithBackoff>[1];

const httpError = (message: string, status: number) =>
  Object.assign(new Error(message), { status });
const rateLimited = () => httpError('Rate limited', 429);

// A mock that runs onCall, then throws makeError(attempt) on the first
// `failures` calls and resolves to `value` after that.
const failing = (
  failures: number,
  makeError: (attempt: number) => Error,
  value = 'success',
  onCall?: () => void,
) => {
  let attempts = 0;
  return vi.fn(async () => {
    onCall?.();
    if (++attempts <= failures) throw makeError(attempts);
    return value;
  });
};

// Helper to create a mock function that fails a certain number of times
// with a retryable (500) error.
const createFailingFunction = (failures: number, successValue = 'success') =>
  failing(
    failures,
    (n) => httpError(`Simulated error attempt ${n}`, 500),
    successValue,
  );

// Custom error for testing non-retryable conditions
class NonRetryableError extends Error {
  override name = 'NonRetryableError';
}

// Starts retryWithBackoff, then drains the fake timers (all of them, or
// advanceMs worth). A handler is attached before the timers run, so a
// rejection is never unhandled; callers still see it on the returned promise.
const runRetry = async <T>(
  fn: () => Promise<T>,
  options?: RetryOpts,
  advanceMs?: number,
) => {
  const promise = retryWithBackoff(fn, options);
  promise.catch(() => {});
  await (advanceMs === undefined
    ? vi.runAllTimersAsync()
    : vi.advanceTimersByTimeAsync(advanceMs));
  return promise;
};

const currentAttempt = () => retryContext.getStore()?.attempt ?? -1;
const spySetTimeout = () => vi.spyOn(global, 'setTimeout');
const delaysOf = (spy: ReturnType<typeof spySetTimeout>) =>
  spy.mock.calls.map((call) => call[1] as number);

// Fake timers, no simulated 429s, and console.warn silenced (it would report
// unhandled promise rejections for tests that expect errors).
function useRetryTestEnv() {
  beforeEach(() => {
    vi.useFakeTimers();
    setSimulate429(false);
    console.warn = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

describe('retryWithBackoff', () => {
  useRetryTestEnv();
  beforeEach(() => vi.clearAllMocks());
  const fast = { maxAttempts: 3, initialDelayMs: 10 };
  const throttle = () => httpError('Provider-specific throttle', 4999);

  it('should return the result on the first attempt if successful', async () => {
    const mockFn = createFailingFunction(0);
    expect(await retryWithBackoff(mockFn)).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed if failures are within maxAttempts', async () => {
    const mockFn = createFailingFunction(2);
    expect(await runRetry(mockFn, fast)).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('passes extra retry error codes into retry diagnostics', async () => {
    const error = throttle();
    const promise = runRetry(
      failing(1, () => error, 'ok'),
      {
        maxAttempts: 2,
        initialDelayMs: 10,
        shouldRetryOnError: () => true,
        extraRetryErrorCodes: [4999],
      },
    );
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
    const mockFn = failing(1, throttle, 'ok');
    await expect(
      runRetry(mockFn, {
        maxAttempts: 2,
        initialDelayMs: 10,
        extraRetryErrorCodes: [4999],
      }),
    ).resolves.toBe('ok');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('honors a custom shouldRetryOnError:false over extraRetryErrorCodes', async () => {
    const error = throttle();
    const mockFn = failing(Infinity, () => error);
    // A custom predicate returning false wins even though 4999 is in
    // extraRetryErrorCodes: the caller's fast-fail decision is authoritative.
    const promise = runRetry(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      shouldRetryOnError: () => false,
      extraRetryErrorCodes: [4999],
    });
    await expect(promise).rejects.toBe(error);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('fast-fails on an abort error even with a permissive shouldRetryOnError', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const mockFn = failing(Infinity, () => abortError);
    // Permissive predicate must not override cancellation.
    const promise = runRetry(mockFn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      shouldRetryOnError: () => true,
    });
    await expect(promise).rejects.toBe(abortError);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  describe('shouldRetryOnContent', () => {
    const bad = { text: 'bad' } as unknown;
    const good = { text: 'good' } as unknown;
    const withCheck = (
      check: (content: unknown) => boolean,
      maxAttempts = 3,
    ) => ({
      maxAttempts,
      initialDelayMs: 10,
      shouldRetryOnContent: check,
    });

    it('retries on invalid content then returns the valid result', async () => {
      const fn = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
      const check = (content: unknown) =>
        (content as { text: string }).text === 'bad';
      await expect(runRetry(fn, withCheck(check, 5))).resolves.toBe(good);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns the last response when content stays invalid through all attempts', async () => {
      const fn = vi.fn().mockResolvedValue(bad);
      // Best-effort: after exhausting content retries, the caller gets the last
      // (still-invalid) response with its real content, not a context-free error.
      await expect(
        runRetry(
          fn,
          withCheck(() => true),
        ),
      ).resolves.toBe(bad);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('returns immediately when content is valid', async () => {
      const fn = vi.fn().mockResolvedValue(good);
      await expect(
        runRetry(
          fn,
          withCheck(() => false),
        ),
      ).resolves.toBe(good);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('should throw an error if all attempts fail', async () => {
    const mockFn = createFailingFunction(3);
    await expect(runRetry(mockFn, fast)).rejects.toThrow(
      'Simulated error attempt 3',
    );
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  // The mock fails more than 7 times, so all 7 default attempts are used.
  it.each([
    ['should default to 7 maxAttempts if no options are provided', undefined],
    [
      'should default to 7 maxAttempts if options.maxAttempts is undefined',
      { maxAttempts: undefined },
    ],
  ])('%s', async (_title, options) => {
    const mockFn = createFailingFunction(10);
    await expect(runRetry(mockFn, options)).rejects.toThrow(
      'Simulated error attempt 7',
    );
    expect(mockFn).toHaveBeenCalledTimes(7);
  });

  it('should not retry if shouldRetry returns false', async () => {
    const mockFn = failing(
      Infinity,
      () => new NonRetryableError('Non-retryable error'),
    );
    const promise = runRetry(mockFn, {
      shouldRetryOnError: (error: Error) =>
        !(error instanceof NonRetryableError),
      initialDelayMs: 10,
    });
    await expect(promise).rejects.toThrow('Non-retryable error');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if maxAttempts is not a positive number', async () => {
    const mockFn = createFailingFunction(1);
    await expect(retryWithBackoff(mockFn, { maxAttempts: 0 })).rejects.toThrow(
      'maxAttempts must be a positive number.',
    );
    // The function should not be called at all if validation fails
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should use default shouldRetry if not provided, retrying on 429', async () => {
    const mockFn = failing(Infinity, () => httpError('Too Many Requests', 429));
    await expect(
      runRetry(mockFn, { maxAttempts: 2, initialDelayMs: 10 }),
    ).rejects.toThrow('Too Many Requests');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'should use default shouldRetry if not provided, not retrying on 400',
      () => httpError('Bad Request', 400),
      2,
    ],
    // Permanent local failures (missing credentials, invalid MCP config) have a
    // string `code` but no request id; the request id is what distinguishes an
    // upstream failure from one of those.
    [
      'should not retry a status-less error that carries only a provider code',
      () =>
        Object.assign(new Error('No API key configured'), {
          code: 'MISSING_API_KEY',
        }),
      3,
    ],
    // Moderation and credential rejections arrive inside an already-200 stream,
    // so no HTTP status is left to fail fast on. Re-sending the identical
    // request cannot succeed, and walking the production ladder for it costs
    // about eighty seconds.
    [
      'should not retry a permanent provider code even when the request is traced',
      () =>
        Object.assign(new Error('Content filtered'), {
          code: 'data_inspection_failed',
          requestID: 'req-1',
        }),
      3,
    ],
  ])('%s', async (_title, makeError, maxAttempts) => {
    const mockFn = failing(Infinity, makeError);
    await expect(
      runRetry(mockFn, { maxAttempts, initialDelayMs: 10 }),
    ).rejects.toThrow(makeError().message);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'should retry on transient network errors (ECONNRESET) by default',
      2,
      () =>
        Object.assign(new TypeError('terminated'), {
          cause: Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          }),
        }),
      'success',
    ],
    [
      'should retry on ETIMEDOUT by default',
      1,
      () =>
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      'ok',
    ],
    // Mirrors the OpenAI SDK shape: APIConnectionError ->
    // TypeError('fetch failed') -> cause { code: 'ECONNRESET' }.
    [
      'should retry on SDK-wrapped transport errors (code at cause depth 2)',
      1,
      () =>
        Object.assign(new Error('Connection error.'), {
          cause: Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
            }),
          }),
        }),
      'ok',
    ],
    // A gateway error pushed into an already-200 SSE stream reaches us as an
    // APIError with no HTTP status, so only the classification can open the
    // retry gate. Without it the turn died on the first attempt.
    [
      'should retry a status-less upstream error carrying a provider request id',
      1,
      () =>
        Object.assign(new Error("'id'"), {
          code: 'KeyError',
          requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
        }),
      'ok',
    ],
  ])('%s', async (_title, failures, makeError, value) => {
    const mockFn = failing(failures, makeError, value);
    expect(await runRetry(mockFn, fast, 1000)).toBe(value);
    expect(mockFn).toHaveBeenCalledTimes(failures + 1);
  });

  it('should respect maxDelayMs', async () => {
    const setTimeoutSpy = spySetTimeout();
    // Max delay is less than 100 * 2 * 2 = 400; advance well past all delays.
    await runRetry(
      createFailingFunction(3),
      { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 250 },
      1000,
    );
    const delays = delaysOf(setTimeoutSpy);
    // Around initial, initial*2, then capped at maxDelayMs (250ms); jitter
    // makes exact assertions hard, so check ranges.
    expect(delays.length).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100 * 0.7);
    expect(delays[0]).toBeLessThanOrEqual(100 * 1.3);
    expect(delays[1]).toBeGreaterThanOrEqual(200 * 0.7);
    expect(delays[1]).toBeLessThanOrEqual(200 * 1.3);
    expect(delays[2]).toBeGreaterThanOrEqual(250 * 0.7);
    expect(delays[2]).toBeLessThanOrEqual(250 * 1.3);
  });

  it('should handle jitter correctly, ensuring varied delays', async () => {
    const setTimeoutSpy = spySetTimeout();
    // One retry (so one delay) per run, with a fresh mock that fails 5 times.
    const delaysOfOneRun = async () => {
      setTimeoutSpy.mockClear();
      const promise = runRetry(createFailingFunction(5), {
        maxAttempts: 2,
        initialDelayMs: 100,
        maxDelayMs: 1000,
      });
      await expect(promise).rejects.toThrow();
      return delaysOf(setTimeoutSpy);
    };
    const firstDelaySet = await delaysOfOneRun();
    const secondDelaySet = await delaysOfOneRun();

    // Probabilistic, but with +/-30% jitter the first delays almost surely differ.
    if (firstDelaySet.length > 0 && secondDelaySet.length > 0) {
      expect(firstDelaySet[0]).not.toBe(secondDelaySet[0]);
    } else {
      throw new Error('Delays were not captured for jitter test');
    }

    // Within the jitter range [70, 130] for initialDelayMs = 100
    [...firstDelaySet, ...secondDelaySet].forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(100 * 0.7);
      expect(d).toBeLessThanOrEqual(100 * 1.3);
    });
  });

  describe('Qwen OAuth 429 error handling', () => {
    it.each([
      [
        'should retry for Qwen OAuth 429 errors that are throttling-related',
        httpError('Rate limit exceeded', 429),
        1,
      ],
      [
        'should retry for Qwen OAuth with throttling message',
        httpError('requests throttling triggered', 429),
        2,
      ],
      [
        'should retry for Qwen OAuth with throttling error',
        httpError('throttling', 429),
        1,
      ],
      [
        'should retry normal errors for Qwen OAuth (not quota-related)',
        httpError('Network error', 500),
        2,
      ],
    ])('%s', async (_title, error, failures) => {
      const fn = failing(failures, () => error);
      const promise = runRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.QWEN_OAUTH,
      });
      await expect(promise).resolves.toBe('success');
      // failures + 1 success
      expect(fn).toHaveBeenCalledTimes(failures + 1);
    });

    it('should throw immediately for Qwen OAuth with insufficient_quota message', async () => {
      const fn = vi.fn().mockRejectedValue(
        Object.assign(new Error('Free allocated quota exceeded.'), {
          status: 429,
          code: 'insufficient_quota',
        }),
      );
      const promise = runRetry(fn, {
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
  });

  describe('permanent quota-exhaustion fast-fail (any auth)', () => {
    // Bailian token-plan "1-week quota has been exhausted" surfaces as a 429
    // from the OpenAI SDK but is permanent: it must fast-fail, not retry.
    const runQuotaExhausted = () => {
      const fn = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error(
              '429 Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.',
            ),
            { status: 429 },
          ),
        );
      const promise = runRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        authType: AuthType.USE_OPENAI,
      });
      return { fn, promise };
    };

    it('should throw immediately for a permanent quota-exhaustion error', async () => {
      const { fn, promise } = runQuotaExhausted();
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('Quota exhausted'),
      });
      // Should be called only once (no retries)
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('thrown error must not be a rate-limit error (pins no-status intent)', async () => {
      // The thrown error deliberately carries no .status so that
      // isRateLimitError() returns false, which keeps the stream-side
      // rate-limit retry loop in llm-chat.ts from re-driving it.
      const thrown = await runQuotaExhausted().promise.catch((e: unknown) => e);
      expect(isRateLimitError(thrown)).toBe(false);
    });

    it('should retry a transient 429 that does not carry a reset time', async () => {
      // A plain TPM/RPM 429 (no "will reset at") stays retryable: the
      // quota-exhaustion fast-fail must not swallow transient throttling.
      const transient429 = httpError(
        'Rate limit exceeded. Please retry later.',
        429,
      );
      const fn = failing(1, () => transient429);
      const promise = runRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        authType: AuthType.USE_OPENAI,
      });
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('isTransientCapacityError', () => {
  it.each([
    ['should return true for 429 errors', 429, true],
    ['should return true for 529 errors', 529, true],
    ['should return false for 500 errors', 500, false],
    ['should return false for 400 errors', 400, false],
  ])('%s', (_title, status, expected) => {
    expect(isTransientCapacityError({ status })).toBe(expected);
  });

  it('should return false for errors without status', () => {
    expect(isTransientCapacityError(new Error('generic'))).toBe(false);
    expect(isTransientCapacityError(null)).toBe(false);
  });
});

describe('isUnattendedMode', () => {
  const originalEnv = process.env;
  const unattendedWith = (value: string) => {
    process.env['QWEN_CODE_UNATTENDED_RETRY'] = value;
    return isUnattendedMode();
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['QWEN_CODE_UNATTENDED_RETRY'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return true when QWEN_CODE_UNATTENDED_RETRY=1', () => {
    expect(unattendedWith('1')).toBe(true);
  });

  it('should return true when QWEN_CODE_UNATTENDED_RETRY=true', () => {
    expect(unattendedWith('true')).toBe(true);
  });

  it('should return false when no env vars are set', () => {
    expect(isUnattendedMode()).toBe(false);
  });

  it('should NOT activate on CI=true alone', () => {
    process.env['CI'] = 'true';
    expect(isUnattendedMode()).toBe(false);
  });

  it('should return false for non-matching values', () => {
    expect(unattendedWith('0')).toBe(false);
    expect(unattendedWith('false')).toBe(false);
    expect(unattendedWith('')).toBe(false);
  });

  it('should use strict matching consistent with parseBooleanEnvFlag', () => {
    // Only 'true' and '1' are accepted, matching project convention.
    expect(unattendedWith('TRUE')).toBe(false); // strict: not 'true'
    expect(unattendedWith(' 1 ')).toBe(false); // strict: not '1'
    expect(unattendedWith('yes')).toBe(false);
  });
});

describe('retryWithBackoff - persistent mode', () => {
  useRetryTestEnv();
  const persistent = {
    maxAttempts: 3,
    initialDelayMs: 10,
    persistentMode: true,
  };

  it.each([
    // maxAttempts 3 would normally fail after 3; 10 failures + 1 success.
    [
      'should retry indefinitely for 429 errors in persistent mode',
      10,
      rateLimited,
      {},
    ],
    [
      'should retry indefinitely for 529 errors in persistent mode',
      8,
      () => httpError('Overloaded', 529),
      {},
    ],
    // heartbeatIntervalMs 0 would cause an infinite loop without Math.max(1, ...).
    [
      'should not infinite-loop when heartbeatIntervalMs is 0',
      2,
      rateLimited,
      { heartbeatIntervalMs: 0 },
    ],
  ])('%s', async (_title, failures, makeError, extra) => {
    const fn = failing(failures, makeError);
    expect(await runRetry(fn, { ...persistent, ...extra })).toBe('success');
    expect(fn).toHaveBeenCalledTimes(failures + 1);
  });

  it.each([
    // Non-transient errors stop at maxAttempts.
    [
      'should NOT retry indefinitely for 500 errors in persistent mode',
      () => httpError('Internal Server Error', 500),
      {},
      3,
    ],
    // DashScope allocated-quota exhaustion surfaces as HTTP 429 but is a
    // permanent business error (classified fail-fast). Persistent mode must
    // fall back to the bounded maxAttempts path rather than looping forever.
    [
      'should NOT retry indefinitely for fail-fast quota 429s in persistent mode',
      () =>
        Object.assign(new Error('Allocated quota exceeded'), {
          status: 429,
          code: 'Throttling.AllocationQuota',
        }),
      {},
      3,
    ],
    // The caller explicitly says "don't retry 429": shouldRetryOnError trumps
    // persistent mode, so it fails on the first attempt.
    [
      'should respect shouldRetryOnError even in persistent mode',
      rateLimited,
      { shouldRetryOnError: () => false },
      1,
    ],
    [
      'should not affect normal mode behavior when persistentMode is false',
      rateLimited,
      { persistentMode: false },
      3,
    ],
  ])('%s', async (_title, makeError, extra, calls) => {
    const fn = failing(Infinity, makeError);
    await expect(runRetry(fn, { ...persistent, ...extra })).rejects.toThrow(
      makeError().message,
    );
    expect(fn).toHaveBeenCalledTimes(calls);
  });

  it('should cap single retry backoff at persistentMaxBackoffMs', async () => {
    const setTimeoutSpy = spySetTimeout();
    await runRetry(failing(20, rateLimited), {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      persistentMaxBackoffMs: 5000, // 5 seconds cap for test
    });
    // Jitter is re-capped, so no delay should exceed the cap itself
    for (const d of delaysOf(setTimeoutSpy)) {
      expect(d).toBeLessThanOrEqual(5000 + 1); // cap + rounding tolerance
    }
  });

  it('should call heartbeatFn during persistent retry waits', async () => {
    const heartbeatFn = vi.fn();
    await runRetry(failing(2, rateLimited), {
      maxAttempts: 3,
      initialDelayMs: 100,
      persistentMode: true,
      heartbeatIntervalMs: 30, // Short interval for test
      heartbeatFn,
    });
    // Called at least once during waits > heartbeatInterval, with this shape.
    expect(heartbeatFn).toHaveBeenCalled();
    const call = heartbeatFn.mock.calls[0][0];
    expect(call).toHaveProperty('attempt');
    expect(call).toHaveProperty('remainingMs');
    expect(call).toHaveProperty('error');
  });

  it('should abort persistent retry when signal is aborted', async () => {
    const controller = new AbortController();
    // Abort after the first retry starts waiting (the delay is long).
    setTimeout(() => controller.abort(), 100);
    const promise = runRetry(failing(Infinity, rateLimited), {
      maxAttempts: 3,
      initialDelayMs: 10000,
      persistentMode: true,
      heartbeatIntervalMs: 50,
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow('Retry aborted by signal');
  });
});

describe('retryWithBackoff - Retry-After handling in persistent mode', () => {
  useRetryTestEnv();
  let setTimeoutSpy: ReturnType<typeof spySetTimeout>;
  beforeEach(() => {
    setTimeoutSpy = spySetTimeout();
  });

  // Runs a persistent retry after one 429 carrying `Retry-After: seconds` and
  // returns the first scheduled delay.
  const firstDelay = async (seconds: number, extra: RetryOpts = {}) => {
    setTimeoutSpy.mockClear();
    const error = Object.assign(rateLimited(), {
      response: { headers: { 'retry-after': String(seconds) } },
    });
    await runRetry(
      failing(1, () => error),
      {
        maxAttempts: 3,
        initialDelayMs: 100,
        persistentMode: true,
        ...extra,
      },
    );
    return delaysOf(setTimeoutSpy)[0];
  };

  it('should respect Retry-After and NOT cap at maxBackoff', async () => {
    // Server says wait 10 minutes; persistentMaxBackoffMs (5s) must NOT cap it.
    const firstRetryDelay = await firstDelay(600, {
      persistentMaxBackoffMs: 5000,
    });
    expect(firstRetryDelay).toBeGreaterThan(5000); // NOT capped at maxBackoff
    expect(firstRetryDelay).toBeLessThanOrEqual(600 * 1000); // respects server value
  });

  it('should cap Retry-After at persistentCapMs', async () => {
    // Server says wait 100s; the absolute cap (50s) is lower.
    const firstRetryDelay = await firstDelay(100, { persistentCapMs: 50_000 });
    expect(firstRetryDelay).toBeLessThanOrEqual(50_000 + 1);
  });

  it('should NOT add jitter to Retry-After delays', async () => {
    // Several runs of a 10-second Retry-After must all wait exactly 10000ms.
    const observedDelays: number[] = [];
    for (let run = 0; run < 5; run++) {
      observedDelays.push(await firstDelay(10));
    }
    for (const d of observedDelays) {
      expect(d).toBe(10_000);
    }
  });

  it('should apply jitter inside persistentCapMs for exponential delays', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    await runRetry(failing(1, rateLimited), {
      maxAttempts: 3,
      initialDelayMs: 100_000,
      persistentMode: true,
      persistentMaxBackoffMs: 300_000,
      persistentCapMs: 50_000,
      heartbeatIntervalMs: 100_000,
    });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(37_500);
    expect(randomSpy).toHaveBeenCalled();
  });
});

describe('retryWithBackoff - Retry-After handling in normal mode', () => {
  useRetryTestEnv();
  const normal = { maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 1000 };
  const rateLimitedWith = (extra: object) =>
    Object.assign(rateLimited(), extra);

  it.each([
    [
      'should read Retry-After from direct headers',
      rateLimitedWith({ headers: { 'retry-after': '3' } }),
      3000,
    ],
    [
      'should read Retry-After case-insensitively from response headers',
      rateLimitedWith({ response: { headers: { 'Retry-After': '3' } } }),
      3000,
    ],
    [
      'should respect oversized Retry-After values for normal retries',
      rateLimitedWith({ headers: { 'retry-after': '600' } }),
      600_000,
    ],
    [
      'should honor Retry-After on 503 responses',
      Object.assign(httpError('Service unavailable', 503), {
        headers: { 'retry-after': '4' },
      }),
      4000,
    ],
  ])('%s', async (_title, error, delayMs) => {
    const setTimeoutSpy = spySetTimeout();
    const fn = failing(1, () => error, 'ok');
    await expect(runRetry(fn, normal)).resolves.toBe('ok');
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(delayMs);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs a 503 Retry-After retry at error level, 429 at warn level', async () => {
    debugLoggerMock.error.mockClear();
    debugLoggerMock.warn.mockClear();
    const options = { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100 };

    const e503 = Object.assign(httpError('Service unavailable', 503), {
      headers: { 'retry-after': '1' },
    });
    await runRetry(
      failing(1, () => e503, 'ok'),
      options,
    );
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Retrying after explicit delay'),
      expect.anything(),
      e503,
    );

    debugLoggerMock.error.mockClear();
    const e429 = rateLimitedWith({ headers: { 'retry-after': '1' } });
    await runRetry(
      failing(1, () => e429, 'ok'),
      options,
    );
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
    const error = rateLimitedWith({ headers: { 'retry-after': '600' } });
    const fn = failing(1, () => error, 'ok');
    setTimeout(() => controller.abort(), 100);
    const promise = runRetry(fn, { maxAttempts: 2, signal: controller.signal });
    await expect(promise).rejects.toThrow('Retry aborted by signal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should reject retry waits immediately when the signal is already aborted', async () => {
    const setTimeoutSpy = spySetTimeout();
    const controller = new AbortController();
    controller.abort();
    const fn = failing(1, () => httpError('server busy', 500), 'ok');
    await expect(
      retryWithBackoff(fn, { ...normal, signal: controller.signal }),
    ).rejects.toThrow('Retry aborted by signal');
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
    const fromResponse = { response: { status: 502 }, error: { code: 503 } };
    const fromStatusCode = { statusCode: 500, ...fromResponse };
    expect(getErrorStatus({ status: 429, ...fromStatusCode })).toBe(429);
    expect(getErrorStatus(fromStatusCode)).toBe(500);
    expect(getErrorStatus(fromResponse)).toBe(502);
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
    expect(getErrorStatus(httpError('Too Many Requests', 429))).toBe(429);
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
    expect(getErrorStatus(httpError(':HTTP_STATUS/500', 429))).toBe(429);
  });

  it('should ignore HTTP_STATUS/NNN outside the valid range', () => {
    expect(getErrorStatus(new Error('HTTP_STATUS/999'))).toBeUndefined();
  });

  it('should not match HTTP_STATUS/NNN when adjacent to more digits', () => {
    expect(getErrorStatus(new Error('HTTP_STATUS/4291'))).toBeUndefined();
  });
});

// Phase 4b: retry telemetry (ALS context + onRetry callback + monotonic counter)
describe('retryWithBackoff — Phase 4b retry context (ALS)', () => {
  // Fake timers like the rest of this file: useRealTimers between describes is
  // unreliable when other describes have stubbed timer globals.
  useRetryTestEnv();
  const tiny = { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 5 };
  const transient = () => httpError('transient', 500);

  it('sets retryContext.attempt monotonically across attempts', async () => {
    const seenAttempts: number[] = [];
    const fn = failing(2, transient, 'ok', () =>
      seenAttempts.push(currentAttempt()),
    );
    await expect(runRetry(fn, tiny)).resolves.toBe('ok');
    expect(seenAttempts).toEqual([1, 2, 3]);
  });

  it('exposes retryContext.requestSetupMs / retryTotalDelayMs (== 0 for attempt 1, > 0 for retries)', async () => {
    const snapshots: Array<{ setupMs: number; totalDelayMs: number }> = [];
    const fn = failing(2, transient, 'ok', () => {
      const ctx = retryContext.getStore();
      snapshots.push({
        setupMs: ctx?.requestSetupMs ?? -1,
        totalDelayMs: ctx?.retryTotalDelayMs ?? -1,
      });
    });
    await runRetry(fn, { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 50 });

    // Attempt 1: nothing happened before, so both are 0.
    expect(snapshots[0]!.setupMs).toBe(0);
    expect(snapshots[0]!.totalDelayMs).toBe(0);
    // Attempts 2+ populate both fields once retries have run; exact values
    // depend on the jittered backoff, so assert monotonic.
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
    const fn = failing(0, transient, 'ok', () => {
      const ctx = retryContext.getStore();
      observed = {
        attempt: ctx?.attempt ?? -1,
        setup: ctx?.requestSetupMs ?? -1,
        delay: ctx?.retryTotalDelayMs ?? -1,
      };
    });
    await runRetry(fn, { ...tiny, onRetry });
    expect(observed).toEqual({ attempt: 1, setup: 0, delay: 0 });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('onRetry callback fires once per failed attempt with correct args', async () => {
    const onRetry = vi.fn();
    await runRetry(createFailingFunction(2, 'ok'), { ...tiny, onRetry });

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
    // No onRetry passed. Must not throw or warn.
    await expect(runRetry(createFailingFunction(1, 'ok'), tiny)).resolves.toBe(
      'ok',
    );
  });

  it('onRetry callback throwing does NOT break the retry loop', async () => {
    const onRetry = vi.fn(() => {
      throw new Error('telemetry blew up');
    });
    const promise = runRetry(createFailingFunction(2, 'ok'), {
      ...tiny,
      onRetry,
    });
    await expect(promise).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('shouldRetryOnError returns false mid-loop: onRetry not called for the giveup', async () => {
    // Attempt 1 fails with 500 (retryable), attempt 2 with 400 (non-retryable);
    // the loop gives up on attempt 2 without invoking onRetry for it.
    const onRetry = vi.fn();
    const fn = failing(Infinity, (n) =>
      httpError(`attempt ${n}`, n === 1 ? 500 : 400),
    );
    const error = await runRetry(fn, {
      ...tiny,
      shouldRetryOnError: (e) =>
        (e as HttpError).status === 500 || (e as HttpError).status === 429,
      onRetry,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe('attempt 2');

    // Only the FIRST failed attempt (which led to a retry) invoked onRetry.
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].attempt).toBe(1);
  });

  it('parallel retryWithBackoff calls maintain independent attempt counters', async () => {
    // Two concurrent invocations must each see their own ALS context
    // (AsyncLocalStorage isolates them by async chain).
    const callA: number[] = [];
    const callB: number[] = [];
    const run = (sink: number[]) =>
      retryWithBackoff(
        failing(
          1,
          () => httpError('boom', 500),
          'ok',
          () => sink.push(currentAttempt()),
        ),
        { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 3 },
      );

    const both = Promise.all([run(callA), run(callB)]);
    await vi.runAllTimersAsync();
    await both;

    expect(callA).toEqual([1, 2]);
    expect(callB).toEqual([1, 2]);
  });

  it('nested retryWithBackoff reads innermost frame', async () => {
    const observed: Array<{ layer: 'outer' | 'inner'; attempt: number }> = [];
    const delays = { initialDelayMs: 1, maxDelayMs: 3 };
    const inner = failing(
      1,
      () => httpError('inner-fail', 500),
      'inner-ok',
      () => observed.push({ layer: 'inner', attempt: currentAttempt() }),
    );
    const outer = vi.fn(async () => {
      observed.push({ layer: 'outer', attempt: currentAttempt() });
      return await retryWithBackoff(inner, { maxAttempts: 5, ...delays });
    });

    await runRetry(outer, { maxAttempts: 1, ...delays });

    // Outer sees its own frame's attempt (1); inner sees its own (1, then 2
    // after retry) and NOT the outer's frame.
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
    const fn = failing(2, (n) => httpError(`rate limited #${n}`, 429), 'ok');
    const promise = runRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 50,
      maxDelayMs: 200,
      persistentMode: true,
      onRetry,
    });
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
    // Review comment R2 #7: when the error includes a `retry-after` header,
    // `onRetry.delayMs` reflects the parsed value, not the exponential backoff.
    const onRetry = vi.fn();
    const error = Object.assign(httpError('rate limited', 429), {
      response: { headers: { 'retry-after': '2' } }, // 2 seconds
    });
    const promise = runRetry(
      failing(1, () => error, 'ok'),
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 500,
        onRetry,
      },
    );
    await expect(promise).resolves.toBe('ok');

    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0]![0] as RetryAttemptInfo;
    // Retry-After: 2 → 2000ms
    expect(info.delayMs).toBe(2000);
    expect(info.errorStatus).toBe(429);
  });

  it('signal.aborted before onRetry: no phantom retry event emitted', async () => {
    // Review comment R2 #6: when the signal fires between catch and onRetry,
    // the `if (!signal?.aborted)` guard must keep onRetry from firing.
    const onRetry = vi.fn();
    const controller = new AbortController();
    // Abort during the first failure, before onRetry runs.
    const abortThenFail = () => {
      controller.abort();
      return httpError('server error', 500);
    };
    await runRetry(failing(1, abortThenFail, 'ok'), {
      maxAttempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 50,
      signal: controller.signal,
      onRetry,
    }).catch((e: unknown) => e);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('retryWithBackoff - retry wait notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSimulate429(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function retryAfterError(status: number, seconds: number): HttpError {
    return Object.assign(new Error('Rate limited'), {
      status,
      response: { headers: { 'retry-after': String(seconds) } },
    });
  }

  function serverError(): HttpError {
    return Object.assign(new Error('Server error'), { status: 500 });
  }

  function observe(): {
    events: RetryWaitEvent[];
    run: <T>(fn: () => Promise<T>) => Promise<T>;
  } {
    const events: RetryWaitEvent[] = [];
    return {
      events,
      run: (fn) => runWithRetryWaitObserver((e) => events.push(e), fn),
    };
  }

  it('announces each HTTP backoff with the delay it actually sleeps', async () => {
    const { events, run } = observe();
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryAfterError(429, 7))
      .mockRejectedValueOnce(serverError())
      .mockResolvedValue('ok');
    const promise = run(() =>
      retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 100, onRetry }),
    );
    await vi.advanceTimersByTimeAsync(6_999);
    expect(events).toEqual([
      { phase: 'start', waitId: expect.any(String), delayMs: 7_000 },
    ]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    const starts = events.filter((e) => e.phase === 'start');
    expect(starts.map((e) => (e as { delayMs: number }).delayMs)).toEqual(
      onRetry.mock.calls.map(([info]) => info.delayMs),
    );
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.phase)).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
    expect(events[1]!.waitId).toBe(events[0]!.waitId);
    expect(events[3]!.waitId).toBe(events[2]!.waitId);
    expect(events[2]!.waitId).not.toBe(events[0]!.waitId);
  });

  it('announces a content-check backoff without firing onRetry', async () => {
    const { events, run } = observe();
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ bad: true })
      .mockResolvedValue({ bad: false });
    const promise = run(() =>
      retryWithBackoff(fn, {
        maxAttempts: 2,
        initialDelayMs: 1000,
        shouldRetryOnContent: (r) => (r as unknown as { bad: boolean }).bad,
        onRetry,
      }),
    );
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ bad: false });
    expect(onRetry).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
  });

  it('announces one persistent sleep once, however many heartbeats it has', async () => {
    const { events, run } = observe();
    const heartbeatFn = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryAfterError(429, 120))
      .mockResolvedValue('ok');
    const promise = run(() =>
      retryWithBackoff(fn, {
        maxAttempts: 2,
        persistentMode: true,
        heartbeatIntervalMs: 30_000,
        heartbeatFn,
      }),
    );
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(heartbeatFn).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      { phase: 'start', waitId: expect.any(String), delayMs: 120_000 },
      { phase: 'end', waitId: events[0]!.waitId },
    ]);
  });

  it('ends the wait as soon as the signal aborts the backoff', async () => {
    const { events, run } = observe();
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(retryAfterError(429, 60));
    const promise = run(() =>
      retryWithBackoff(fn, { maxAttempts: 3, signal: controller.signal }),
    );
    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.map((e) => e.phase)).toEqual(['start']);
    controller.abort();
    expect(String(await settled)).toMatch(/aborted/);
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry outcome when the observer throws', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serverError())
      .mockResolvedValue('ok');
    const promise = runWithRetryWaitObserver(
      () => {
        throw new Error('observer failure');
      },
      () => retryWithBackoff(fn, { maxAttempts: 2, initialDelayMs: 10 }),
    );
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
  });
});
