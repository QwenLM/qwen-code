/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import { AuthType } from '../core/contentGenerator.js';
import { isQwenQuotaExceededError } from './quotaErrorDetection.js';
import { createDebugLogger } from './debugLogger.js';
import { getErrorStatus } from './errors.js';
import { isRateLimitError } from './rateLimit.js';
import { getRetryAfterDelayMs, getRetryDelayMs } from './retryPolicy.js';
import { classifyRetryError } from './retryErrorClassification.js';
import { retryContext } from './retryContext.js';

const debugLogger = createDebugLogger('RETRY');

// Persistent retry mode constants
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes — single retry backoff cap
const PERSISTENT_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours — absolute single wait cap
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

export interface HttpError extends Error {
  status?: number;
}

export interface HeartbeatInfo {
  attempt: number;
  remainingMs: number;
  error: unknown;
}

/**
 * Information passed to `RetryOptions.onRetry` after each failed attempt.
 * Lets callers (LLM call sites) emit `ApiRetryEvent` telemetry without
 * coupling `retry.ts` to telemetry concerns.
 */
export interface RetryAttemptInfo {
  /**
   * 1-based monotonic iteration counter — same value as ALS context's `attempt`.
   */
  attempt: number;
  error: unknown;
  errorStatus?: number;
  /** Computed backoff delay that follows this failed attempt (ms). */
  delayMs: number;
}

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetryOnError: (error: Error) => boolean;
  shouldRetryOnContent?: (content: GenerateContentResponse) => boolean;
  authType?: string;
  extraRetryErrorCodes?: readonly number[];
  // Persistent retry mode options
  persistentMode?: boolean;
  persistentMaxBackoffMs?: number;
  persistentCapMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFn?: (info: HeartbeatInfo) => void;
  signal?: AbortSignal;
  /**
   * Optional. Called once per failed attempt after the backoff delay is
   * computed but BEFORE the sleep. Use this to emit retry telemetry events
   * (e.g. `ApiRetryEvent` for LLM call sites); leave undefined for non-LLM
   * callers so they stay silent in LLM-specific telemetry channels.
   *
   * Contract:
   * - Invoked only after `await fn()` rejects in the catch block of
   *   `retryWithBackoff` (OUTSIDE the `retryContext.run()` ALS frame).
   *   This is true for both synchronous and asynchronous throws from `fn`.
   *   All retry-context data is passed via the `RetryAttemptInfo` parameter
   *   — do NOT read `retryContext.getStore()` inside an `onRetry` callback.
   * - Content-retries via `shouldRetryOnContent` do NOT fire `onRetry`.
   *   If a future caller wires content retries, extend `retry.ts` to fire
   *   `onRetry` on that path too.
   * - Callback errors are swallowed and logged via `debugLogger.warn`; they
   *   never affect retry behavior (best-effort telemetry).
   */
  onRetry?: (info: RetryAttemptInfo) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 7,
  initialDelayMs: 1500,
  maxDelayMs: 30000, // 30 seconds
  shouldRetryOnError: defaultShouldRetry,
};

/**
 * Default predicate function to determine if a retry should be attempted.
 * Retries on 429 (Too Many Requests) and 5xx server errors.
 * @param error The error object.
 * @returns True if the error is a transient error, false otherwise.
 */
function defaultShouldRetry(
  error: Error | unknown,
  extraRetryErrorCodes?: readonly number[],
): boolean {
  const status = getErrorStatus(error);
  // isRateLimitError already covers HTTP 429 (and 503) via RATE_LIMIT_ERROR_CODES,
  // so an explicit `status === 429` check here would be redundant.
  return (
    isRateLimitError(error, extraRetryErrorCodes) ||
    (status !== undefined && status >= 500 && status < 600)
  );
}

/**
 * Statuses that may carry a provider-directed `Retry-After` header. 429 (Too
 * Many Requests) and 503 (Service Unavailable) both commonly include it per
 * RFC 7231, and the stream-side path already honors both — the HTTP path stays
 * consistent by parsing Retry-After for the same set.
 */
function hasRetryAfterStatus(status?: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Determines if an error is a transient capacity error eligible for persistent retry.
 * Only 429 (Rate Limit) and 529 (Overloaded) qualify — HTTP 500 is excluded
 * because it may indicate a permanent server bug.
 */
export function isTransientCapacityError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status === 529;
}

/**
 * Detects whether persistent retry mode is explicitly enabled.
 * Requires the user to opt in via QWEN_CODE_UNATTENDED_RETRY — we intentionally
 * do NOT auto-activate on CI=true, because silently turning a fast-fail CI job
 * into an infinite-wait job would be surprising and dangerous.
 */
export function isUnattendedMode(): boolean {
  const val = process.env['QWEN_CODE_UNATTENDED_RETRY'];
  return val === 'true' || val === '1';
}

/**
 * Delays execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 * @param signal Optional signal used to abort the delay.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Retry aborted by signal'));
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Retry aborted by signal'));
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Re-check after listener registration to close the TOCTOU race window.
    if (signal?.aborted) {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Retry aborted by signal'));
    }
  });
}

/**
 * Sleeps in chunks, emitting heartbeat callbacks at regular intervals.
 * Supports AbortSignal for graceful cancellation.
 */
async function sleepWithHeartbeat(
  totalMs: number,
  ctx: {
    attempt: number;
    error: unknown;
    heartbeatInterval: number;
    heartbeatFn?: (info: HeartbeatInfo) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  let remaining = totalMs;

  while (remaining > 0) {
    if (ctx.signal?.aborted) {
      throw new Error('Retry aborted by signal');
    }

    const chunk = Math.max(1, Math.min(remaining, ctx.heartbeatInterval));
    await delay(chunk, ctx.signal);
    remaining -= chunk;

    if (remaining > 0 && ctx.heartbeatFn) {
      ctx.heartbeatFn({
        attempt: ctx.attempt,
        remainingMs: remaining,
        error: ctx.error,
      });
    }
  }
}

/**
 * Retries a function with exponential backoff and jitter.
 * Supports persistent retry mode for unattended/CI environments where transient
 * capacity errors (429/529) should be retried indefinitely rather than failing.
 * @param fn The asynchronous function to retry.
 * @param options Optional retry configuration.
 * @returns A promise that resolves with the result of the function if successful.
 * @throws The last error encountered if all attempts fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  if (options?.maxAttempts !== undefined && options.maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive number.');
  }

  const cleanOptions = options
    ? Object.fromEntries(Object.entries(options).filter(([_, v]) => v != null))
    : {};

  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    authType,
    extraRetryErrorCodes,
    shouldRetryOnError,
    shouldRetryOnContent,
    persistentMode,
    persistentMaxBackoffMs,
    persistentCapMs,
    heartbeatIntervalMs,
    heartbeatFn,
    signal,
    onRetry,
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...cleanOptions,
  };
  const hasCustomShouldRetryOnError =
    typeof options?.shouldRetryOnError === 'function';

  const persistent = persistentMode ?? false;
  const maxBackoff = persistentMaxBackoffMs ?? PERSISTENT_MAX_BACKOFF_MS;
  const capMs = persistentCapMs ?? PERSISTENT_CAP_MS;
  const heartbeatInterval = heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  let attempt = 0;
  let persistentAttempt = 0;
  let currentDelay = initialDelayMs;

  // Phase 4b — retry telemetry context. `iterationCount` is the monotonic
  // counter that always reflects "this is the Nth time fn was called",
  // regardless of normal vs persistent retry mode. Decoupled from the
  // `attempt` variable above which is clamped at `maxAttempts - 1` in
  // persistent mode to keep the while-loop alive.
  const requestEntryTime = Date.now();
  let iterationCount = 0;
  let retryTotalDelayMs = 0;

  // Tracks the most recent response that failed `shouldRetryOnContent`, so that
  // when content retries exhaust the attempt budget we can return that
  // best-effort result (with its real content) instead of a context-free error.
  let lastContentResult: T | undefined;
  let hadContentRetry = false;

  while (attempt < maxAttempts) {
    attempt++;
    iterationCount++;
    const requestSetupMs = Date.now() - requestEntryTime;
    try {
      const result = await retryContext.run(
        { attempt: iterationCount, retryTotalDelayMs, requestSetupMs },
        () => fn(),
      );

      if (
        shouldRetryOnContent &&
        shouldRetryOnContent(result as GenerateContentResponse)
      ) {
        lastContentResult = result;
        hadContentRetry = true;
        const delayMs = getRetryDelayMs({
          // attempt: 1 — currentDelay already tracks exponential growth;
          // getRetryDelayMs is called here only for jitter calculation.
          attempt: 1,
          initialDelayMs: currentDelay,
          maxDelayMs,
          jitterRatio: 0.3,
        });
        debugLogger.warn(
          `Attempt ${iterationCount}: response rejected by content check. ` +
            `Retrying with backoff in ${Math.ceil(delayMs / 1000)}s...`,
        );
        await delay(delayMs, signal);
        // Note: this inflates retryTotalDelayMs beyond what onRetry/ApiRetryEvent
        // reports — content-retry delays are invisible in the api_retry telemetry
        // channel (onRetry only fires from the catch-block error path). The LLM
        // span's retry_total_delay_ms attribute includes ALL delays (content +
        // error), which is the accurate "total time the user waited in backoff."
        retryTotalDelayMs += delayMs;
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }

      return result;
    } catch (error) {
      const errorStatus = getErrorStatus(error);

      // Classification drives logging plus one control decision: a 'fail-fast'
      // verdict keeps a permanent error out of the unbounded persistent loop
      // (see shouldPersist below). Normal retry control still follows
      // shouldRetryOnError and the persistent policy. Computed before the Qwen
      // quota fast-fail so the original error (status, request id, provider
      // body) is always classified and logged, even when we replace it with a
      // guidance message.
      const retryDiagnostics = classifyRetryError(error, {
        authType,
        extraRetryErrorCodes,
      });

      // Cancellation is authoritative: once the caller aborts (or the call
      // throws an abort/cancel error), never schedule another attempt,
      // regardless of a permissive shouldRetryOnError predicate.
      if (retryDiagnostics.kind === 'abort') {
        throw error;
      }

      // Check for Qwen OAuth quota exceeded error - throw immediately without retry
      if (authType === AuthType.QWEN_OAUTH && isQwenQuotaExceededError(error)) {
        debugLogger.error(
          'Qwen OAuth quota exceeded, fast-failing',
          retryDiagnostics,
          error,
        );
        throw new Error(
          `Qwen OAuth free tier has been discontinued as of 2026-04-15.\n\n` +
            `To continue using Qwen Code, try one of these alternatives:\n` +
            `  - OpenRouter:    https://openrouter.ai/docs/quickstart\n` +
            `  - Fireworks AI:  https://docs.fireworks.ai/api-reference/introduction\n` +
            `  - ModelStudio:   https://help.aliyun.com/zh/model-studio/coding-plan\n\n` +
            `After setting up your API key, run /auth to configure your provider.`,
        );
      }

      // Determine if this error qualifies for persistent retry.
      // Persistent mode still respects shouldRetryOnError — callers can force
      // fast-fail even for transient errors if they explicitly return false.
      const isTransient = isTransientCapacityError(error);
      const callerAllowsRetry = hasCustomShouldRetryOnError
        ? shouldRetryOnError(error as Error)
        : defaultShouldRetry(error, extraRetryErrorCodes);
      // A permanent business failure can surface with a transient-looking status
      // (e.g. DashScope `Throttling.AllocationQuota` arrives as HTTP 429). Such
      // errors are classified as 'fail-fast'; they must not enter the unbounded
      // persistent loop, where they would retry for hours and never recover.
      // Excluding them here falls back to the normal, maxAttempts-bounded retry
      // path so the request still gets a few attempts but is guaranteed to
      // terminate.
      const isFailFast = retryDiagnostics.diagnosis === 'fail-fast';
      const shouldPersist =
        persistent && isTransient && callerAllowsRetry && !isFailFast;

      // Check if we've exhausted retries or shouldn't retry
      if (!shouldPersist) {
        if (attempt >= maxAttempts || !callerAllowsRetry) {
          throw error;
        }
      }

      // === Calculate delay ===
      let delayMs: number;

      if (shouldPersist) {
        persistentAttempt++;

        const retryAfterMs = hasRetryAfterStatus(errorStatus)
          ? getRetryAfterDelayMs(error)
          : null;

        if (retryAfterMs !== null && retryAfterMs > 0) {
          // Retry-After is a server-specified wait — respect it, only cap at
          // the absolute limit (capMs/6h), NOT at maxBackoff (5min).
          delayMs = Math.min(retryAfterMs, capMs);
        } else {
          // Exponential backoff — cap at maxBackoff (5min) then absolute cap
          delayMs = getRetryDelayMs({
            attempt: persistentAttempt,
            initialDelayMs,
            maxDelayMs: Math.min(maxBackoff, capMs),
            jitterRatio: 0.25,
          });
        }

        const reportedAttempt = persistentAttempt;
        debugLogger.warn(
          `[Persistent] Attempt ${reportedAttempt} failed with status ${errorStatus ?? 'unknown'}. ` +
            `Retrying in ${Math.ceil(delayMs / 1000)}s...`,
          retryDiagnostics,
          error,
        );

        // Phase 4b — fire onRetry telemetry callback BEFORE sleep, so
        // operators see retry events live. Guard with signal?.aborted so we
        // don't emit a phantom retry event for an attempt that will never
        // actually proceed (signal fires during the previous sleep or between
        // catch and this point). Wrap in try/catch: a logging failure must
        // NEVER break the retry loop.
        if (!signal?.aborted) {
          try {
            onRetry?.({
              attempt: iterationCount,
              error,
              errorStatus,
              delayMs,
            });
          } catch (cbError) {
            debugLogger.warn(
              `onRetry callback threw (swallowed): ${cbError instanceof Error ? cbError.message : String(cbError)}`,
            );
          }
        }

        // Heartbeat sleep — chunked to keep CI alive
        await sleepWithHeartbeat(delayMs, {
          attempt: reportedAttempt,
          error,
          heartbeatInterval,
          heartbeatFn,
          signal,
        });
        retryTotalDelayMs += delayMs;

        // Clamp attempt so the while-loop never exits
        if (attempt >= maxAttempts) {
          attempt = maxAttempts - 1;
        }
      } else {
        // Normal retry path.
        const retryAfterMs = hasRetryAfterStatus(errorStatus)
          ? getRetryAfterDelayMs(error)
          : null;

        let actualDelayMs: number;
        if (retryAfterMs !== null && retryAfterMs > 0) {
          // Normal HTTP retries intentionally preserve provider-directed
          // Retry-After waits instead of clamping to the exponential
          // maxDelayMs. The wait remains abort-aware so cancelled requests do
          // not stay parked for the full provider delay.
          actualDelayMs = retryAfterMs;
          currentDelay = initialDelayMs;
          logRetryAtStatusLevel(
            `Attempt ${attempt} failed with status ${errorStatus ?? 'unknown'}. Retrying after explicit delay of ${retryAfterMs}ms...`,
            retryDiagnostics,
            error,
            errorStatus,
          );
        } else {
          actualDelayMs = getRetryDelayMs({
            // attempt: 1 — currentDelay already tracks exponential growth;
            // getRetryDelayMs is called here only for jitter calculation.
            attempt: 1,
            initialDelayMs: currentDelay,
            maxDelayMs,
            jitterRatio: 0.3,
          });
          currentDelay = Math.min(maxDelayMs, currentDelay * 2);
          logRetryAttempt(
            attempt,
            error,
            retryDiagnostics,
            errorStatus,
            actualDelayMs,
          );
        }

        // Phase 4b — fire onRetry telemetry callback BEFORE sleep. Guard
        // with signal?.aborted to avoid phantom events when abort fires
        // between catch and here. Wrapped in try/catch so a logging failure
        // cannot break the retry loop.
        if (!signal?.aborted) {
          try {
            onRetry?.({
              attempt: iterationCount,
              error,
              errorStatus,
              delayMs: actualDelayMs,
            });
          } catch (cbError) {
            debugLogger.warn(
              `onRetry callback threw (swallowed): ${cbError instanceof Error ? cbError.message : String(cbError)}`,
            );
          }
        }

        // Abort-aware: a cancelled request must not stay parked for the full
        // delay (including a provider-directed Retry-After wait).
        await delay(actualDelayMs, signal);
        retryTotalDelayMs += actualDelayMs;
      }
    }
  }
  // The loop only falls through here when `shouldRetryOnContent` retries
  // exhausted the attempt budget — the error path always throws inside the
  // catch, and persistent mode clamps `attempt` so it never exits normally.
  // Return the last response we received (best-effort) so the caller keeps the
  // actual content and its context rather than a context-free error.
  if (hadContentRetry) {
    return lastContentResult as T;
  }
  // Defensive fallback for type safety; not expected to be reached.
  throw new Error('Retry attempts exhausted');
}

/**
 * Logs a message for a retry attempt when using exponential backoff.
 * @param attempt The current attempt number.
 * @param error The error that caused the retry.
 * @param errorStatus The HTTP status code of the error, if available.
 */
function logRetryAttempt(
  attempt: number,
  error: unknown,
  retryDiagnostics: ReturnType<typeof classifyRetryError>,
  errorStatus?: number,
  delayMs?: number,
): void {
  const backoff =
    delayMs !== undefined
      ? `Retrying with backoff in ${Math.ceil(delayMs / 1000)}s...`
      : 'Retrying with backoff...';
  const message = errorStatus
    ? `Attempt ${attempt} failed with status ${errorStatus}. ${backoff}`
    : `Attempt ${attempt} failed. ${backoff}`;

  logRetryAtStatusLevel(message, retryDiagnostics, error, errorStatus);
}

/**
 * Logs a retry message at a severity that matches the HTTP status: 5xx server
 * errors log at `error` (so error-level alerting fires), everything else
 * (including 429/503 throttling) at `warn`.
 */
function logRetryAtStatusLevel(
  message: string,
  retryDiagnostics: ReturnType<typeof classifyRetryError>,
  error: unknown,
  errorStatus?: number,
): void {
  if (errorStatus !== undefined && errorStatus >= 500 && errorStatus < 600) {
    debugLogger.error(message, retryDiagnostics, error);
  } else {
    debugLogger.warn(message, retryDiagnostics, error);
  }
}
