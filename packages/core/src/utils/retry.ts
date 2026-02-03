/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import { AuthType } from '../core/contentGenerator.js';
import { isQwenQuotaExceededError } from './quotaErrorDetection.js';

export interface HttpError extends Error {
  status?: number;
}

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetryOnError: (error: Error) => boolean;
  shouldRetryOnContent?: (content: GenerateContentResponse) => boolean;
  authType?: string;
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
 * Delays execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a function with exponential backoff and jitter.
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
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...cleanOptions,
  };

  let attempt = 0;
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
          `Qwen API quota exceeded: Your Qwen API quota has been exhausted. Please wait for your quota to reset.`,
        );
      }

      // Check if we've exhausted retries or shouldn't retry
      if (attempt >= maxAttempts || !shouldRetryOnError(error as Error)) {
        throw error;
      }

      const retryAfterMs =
        errorStatus === 429 ? getRetryAfterDelayMs(error) : 0;

      if (retryAfterMs > 0) {
        // Respect Retry-After header if present and parsed
        console.warn(
          `Attempt ${attempt} failed with status ${errorStatus ?? 'unknown'}. Retrying after explicit delay of ${retryAfterMs}ms...`,
          error,
        );
        await delay(retryAfterMs);
        // Reset currentDelay for next potential non-429 error, or if Retry-After is not present next time
        currentDelay = initialDelayMs;
      } else {
        // Fallback to exponential backoff with jitter
        logRetryAttempt(attempt, error, errorStatus);
        // Add jitter: +/- 30% of currentDelay
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        await delay(delayWithJitter);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
      }
    }
  }
  // This line should theoretically be unreachable due to the throw in the catch block.
  // Added for type safety and to satisfy the compiler that a promise is always returned.
  throw new Error('Retry attempts exhausted');
}

/**
 * Extracts the HTTP status code from an error object.
 *
 * Checks the following properties in order of priority:
 * 1. `error.status` - OpenAI, Anthropic, Gemini SDK errors
 * 2. `error.statusCode` - Some HTTP client libraries
 * 3. `error.response.status` - Axios-style errors
 * 4. `error.error.code` - Nested error objects
 *
 * @param error The error object.
 * @returns The HTTP status code (100-599), or undefined if not found.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    error?: { code?: unknown };
  };

  const value =
    err.status ?? err.statusCode ?? err.response?.status ?? err.error?.code;

  return typeof value === 'number' && value >= 100 && value <= 599
    ? value
    : undefined;
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
    console.warn(message, error);
  } else if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
    console.error(message, error);
  } else {
    console.warn(message, error);
  }
}
