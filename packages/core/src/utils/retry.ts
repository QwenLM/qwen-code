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

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetryOnError: (error: Error) => boolean;
  shouldRetryOnContent?: (content: GenerateContentResponse) => boolean;
  authType?: string;
  // Persistent retry mode options
  persistentMode?: boolean;
  persistentMaxBackoffMs?: number;
  persistentCapMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFn?: (info: HeartbeatInfo) => void;
  signal?: AbortSignal;
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
function defaultShouldRetry(error: Error | unknown): boolean {
  const status = getErrorStatus(error);
  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
  );
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
  return isEnvTruthy(process.env['QWEN_CODE_UNATTENDED_RETRY']);
}

function isEnvTruthy(val: string | undefined): boolean {
  const normalized = val?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized !== '' &&
    normalized !== '0' &&
    normalized !== 'false'
  );
}

/**
 * Delays execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await delay(chunk);
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
    shouldRetryOnError,
    shouldRetryOnContent,
    persistentMode,
    persistentMaxBackoffMs,
    persistentCapMs,
    heartbeatIntervalMs,
    heartbeatFn,
    signal,
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...cleanOptions,
  };

  const persistent = persistentMode ?? false;
  const maxBackoff = persistentMaxBackoffMs ?? PERSISTENT_MAX_BACKOFF_MS;
  const capMs = persistentCapMs ?? PERSISTENT_CAP_MS;
  const heartbeatInterval = heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  let attempt = 0;
  let persistentAttempt = 0;
  let currentDelay = initialDelayMs;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const result = await fn();

      if (
        shouldRetryOnContent &&
        shouldRetryOnContent(result as GenerateContentResponse)
      ) {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        await delay(delayWithJitter);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }

      return result;
    } catch (error) {
      const errorStatus = getErrorStatus(error);

      // Check for Qwen OAuth quota exceeded error - throw immediately without retry
      if (authType === AuthType.QWEN_OAUTH && isQwenQuotaExceededError(error)) {
        throw new Error(
          `Qwen OAuth quota exceeded: Your free daily quota has been reached.\n\n` +
            `To continue using Qwen Code without waiting, upgrade to the Alibaba Cloud Coding Plan:\n` +
            `  China:       https://help.aliyun.com/zh/model-studio/coding-plan\n` +
            `  Global/Intl: https://www.alibabacloud.com/help/en/model-studio/coding-plan\n\n` +
            `After subscribing, run /auth to configure your Coding Plan API key.`,
        );
      }

      // Determine if this error qualifies for persistent retry.
      // Persistent mode still respects shouldRetryOnError — callers can force
      // fast-fail even for transient errors if they explicitly return false.
      const isTransient = isTransientCapacityError(error);
      const callerAllowsRetry = shouldRetryOnError(error as Error);
      const shouldPersist = persistent && isTransient && callerAllowsRetry;

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

        // Prefer Retry-After header for 429 errors
        const retryAfterMs =
          errorStatus === 429 ? getRetryAfterDelayMs(error) : 0;

        if (retryAfterMs > 0) {
          // Retry-After is a server-specified wait — respect it, only cap at
          // the absolute limit (capMs/6h), NOT at maxBackoff (5min).
          delayMs = Math.min(retryAfterMs, capMs);
        } else {
          // Exponential backoff — cap at maxBackoff (5min) then absolute cap
          delayMs = Math.min(
            initialDelayMs * Math.pow(2, persistentAttempt - 1),
            maxBackoff,
          );
          delayMs = Math.min(delayMs, capMs);

          // Add jitter (±25%), then re-apply caps so delay never exceeds limits
          delayMs += delayMs * 0.25 * (Math.random() * 2 - 1);
          delayMs = Math.min(Math.max(0, delayMs), maxBackoff, capMs);
        }

        const reportedAttempt = persistentAttempt;
        debugLogger.warn(
          `[Persistent] Attempt ${reportedAttempt} failed with status ${errorStatus ?? 'unknown'}. ` +
            `Retrying in ${Math.ceil(delayMs / 1000)}s...`,
          error,
        );

        // Heartbeat sleep — chunked to keep CI alive
        await sleepWithHeartbeat(delayMs, {
          attempt: reportedAttempt,
          error,
          heartbeatInterval,
          heartbeatFn,
          signal,
        });

        // Clamp attempt so the while-loop never exits
        if (attempt >= maxAttempts) {
          attempt = maxAttempts - 1;
        }
      } else {
        // Normal retry path (unchanged behavior)
        const retryAfterMs =
          errorStatus === 429 ? getRetryAfterDelayMs(error) : 0;

        if (retryAfterMs > 0) {
          debugLogger.warn(
            `Attempt ${attempt} failed with status ${errorStatus ?? 'unknown'}. Retrying after explicit delay of ${retryAfterMs}ms...`,
            error,
          );
          await delay(retryAfterMs);
          currentDelay = initialDelayMs;
        } else {
          logRetryAttempt(attempt, error, errorStatus);
          const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
          const delayWithJitter = Math.max(0, currentDelay + jitter);
          await delay(delayWithJitter);
          currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        }
      }
    }
  }
  // This line should theoretically be unreachable due to the throw in the catch block.
  // Added for type safety and to satisfy the compiler that a promise is always returned.
  throw new Error('Retry attempts exhausted');
}

/**
 * Extracts the Retry-After delay from an error object's headers.
 * @param error The error object.
 * @returns The delay in milliseconds, or 0 if not found or invalid.
 */
function getRetryAfterDelayMs(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    // Check for error.response.headers (common in axios errors)
    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (error as { response: { headers?: unknown } }).response;
      if (
        'headers' in response &&
        typeof response.headers === 'object' &&
        response.headers !== null
      ) {
        const headers = response.headers as { 'retry-after'?: unknown };
        const retryAfterHeader = headers['retry-after'];
        if (typeof retryAfterHeader === 'string') {
          const retryAfterSeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(retryAfterSeconds)) {
            return retryAfterSeconds * 1000;
          }
          // It might be an HTTP date
          const retryAfterDate = new Date(retryAfterHeader);
          if (!isNaN(retryAfterDate.getTime())) {
            return Math.max(0, retryAfterDate.getTime() - Date.now());
          }
        }
      }
    }
  }
  return 0;
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
  errorStatus?: number,
): void {
  const message = errorStatus
    ? `Attempt ${attempt} failed with status ${errorStatus}. Retrying with backoff...`
    : `Attempt ${attempt} failed. Retrying with backoff...`;

  if (errorStatus === 429) {
    debugLogger.warn(message, error);
  } else if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
    debugLogger.error(message, error);
  } else {
    debugLogger.warn(message, error);
  }
}
