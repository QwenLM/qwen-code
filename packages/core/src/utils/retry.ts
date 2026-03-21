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
  maxAttempts: 10,
  initialDelayMs: 1500,
  maxDelayMs: 30000, // 30 seconds
  shouldRetryOnError: defaultShouldRetry,
};

const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
  'EPROTO',
];

const FETCH_FAILED_MESSAGE = 'fetch failed';
const INCOMPLETE_JSON_MESSAGE = 'incomplete json segment';

function getCode(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const code = (obj as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getNetworkErrorCode(error: unknown): string | undefined {
  const directCode = getCode(error);
  if (directCode) return directCode;

  let current: unknown = error;
  const maxDepth = 5;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (
      typeof current !== 'object' ||
      current === null ||
      !('cause' in current)
    ) {
      break;
    }
    current = (current as { cause: unknown }).cause;
    const code = getCode(current);
    if (code) return code;
  }

  return undefined;
}

/**
 * Checks whether an error is a transient network/SSL/TLS error
 * that should be retried.
 */
export function isRetryableError(
  error: Error | unknown,
  retryFetchErrors?: boolean,
): boolean {
  const errorCode = getNetworkErrorCode(error);
  if (errorCode && RETRYABLE_NETWORK_CODES.includes(errorCode)) {
    return true;
  }

  if (retryFetchErrors && error instanceof Error) {
    const lowerMessage = error.message.toLowerCase();
    if (
      lowerMessage.includes(FETCH_FAILED_MESSAGE) ||
      lowerMessage.includes(INCOMPLETE_JSON_MESSAGE)
    ) {
      return true;
    }
  }

  const status = getErrorStatus(error);
  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
  );
}

function defaultShouldRetry(error: Error | unknown): boolean {
  return isRetryableError(error, false);
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
          `Qwen OAuth quota exceeded: Your free daily quota has been reached.\n\n` +
            `To continue using Qwen Code without waiting, upgrade to the Alibaba Cloud Coding Plan:\n` +
            `  China:       https://help.aliyun.com/zh/model-studio/coding-plan\n` +
            `  Global/Intl: https://www.alibabacloud.com/help/en/model-studio/coding-plan\n\n` +
            `After subscribing, run /auth to configure your Coding Plan API key.`,
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
        debugLogger.warn(
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
