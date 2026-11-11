/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApiError, type GenerateContentResponse } from '@google/genai';
import {
  TerminalQuotaError,
  RetryableQuotaError,
  classifyGoogleError,
} from './googleQuotaErrors.js';
import { delay, createAbortError } from './delay.js';
import { runLogger } from './runLogger.js';
import { getErrorStatus, ModelNotFoundError } from './httpErrors.js';
import { disableKeepAlive } from './fetch.js';
import { isPeerSocketClosedMessage } from '../client/utils/networkUtils.js';
import type { RetryAvailabilityContext } from '../availability/modelPolicy.js';

export type { RetryAvailabilityContext };
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface RetryOptions<T = GenerateContentResponse> {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetryOnError: (error: Error, retryFetchErrors?: boolean) => boolean;
  shouldRetryOnContent?: (content: T) => boolean;
  onPersistent429?: (
    authType?: string,
    error?: unknown,
  ) => Promise<string | boolean | null>;
  authType?: string;
  retryFetchErrors?: boolean;
  signal?: AbortSignal;
  getAvailabilityContext?: () => RetryAvailabilityContext | undefined;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions<unknown> = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  initialDelayMs: 500,
  maxDelayMs: 30000, // 30 seconds
  shouldRetryOnError: isRetryableError,
};

export const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  // SSL/TLS transient errors
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
  'EPROTO', // Generic protocol error (often SSL-related)
];

function getNetworkErrorCode(error: unknown): string | undefined {
  const getCode = (obj: unknown): string | undefined => {
    if (typeof obj !== 'object' || obj === null) {
      return undefined;
    }
    if ('code' in obj && typeof (obj as { code: unknown }).code === 'string') {
      return (obj as { code: string }).code;
    }
    return undefined;
  };

  const directCode = getCode(error);
  if (directCode) {
    return directCode;
  }

  // Traverse the cause chain to find error codes (SSL errors are often nested)
  let current: unknown = error;
  const maxDepth = 5; // Prevent infinite loops in case of circular references
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
    if (code) {
      return code;
    }
  }

  return undefined;
}

export const FETCH_FAILED_MESSAGE = 'fetch failed';
export const INCOMPLETE_JSON_MESSAGE = 'incomplete json segment';
export const SOCKET_CLOSED_MESSAGE =
  'socket connection was closed unexpectedly';

/** Stale connection error codes that indicate keep-alive pool corruption. */
const STALE_CONNECTION_CODES = ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'];

/**
 * Checks if an error is caused by a stale keep-alive socket (ECONNRESET/EPIPE,
 * undici's UND_ERR_SOCKET, or any runtime's "peer closed the socket" message).
 */
export function isStaleConnectionError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code && STALE_CONNECTION_CODES.includes(code)) {
    return true;
  }
  if (error instanceof Error) {
    if (isPeerSocketClosedMessage(error.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if an error is a retryable network-level error (connection failed, reset, etc).
 * Does NOT include HTTP status-based errors — those are checked separately.
 */
export function isRetryableNetworkError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.includes(code)) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes(FETCH_FAILED_MESSAGE) ||
      msg.includes(SOCKET_CLOSED_MESSAGE)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Categorizes an error for retry telemetry purposes.
 * Returns a safe string without PII.
 */
export function getRetryErrorType(error: unknown): string {
  if (error === 'Invalid content') {
    return 'INVALID_CONTENT';
  }

  const errorCode = getNetworkErrorCode(error);
  if (errorCode && RETRYABLE_NETWORK_CODES.includes(errorCode)) {
    return errorCode;
  }

  if (error instanceof Error) {
    const lowerMessage = error.message.toLowerCase();
    if (lowerMessage.includes(FETCH_FAILED_MESSAGE)) {
      return 'FETCH_FAILED';
    }
    if (lowerMessage.includes(INCOMPLETE_JSON_MESSAGE)) {
      return 'INCOMPLETE_JSON';
    }
  }

  const status = getErrorStatus(error);
  if (status !== undefined) {
    if (status === 429) return 'QUOTA_EXCEEDED';
    if (status >= 500 && status < 600) return 'SERVER_ERROR';
    return `HTTP_${status}`;
  }

  if (error instanceof Error) {
    return error.name;
  }

  return 'UNKNOWN';
}

/**
 * Default predicate function to determine if a retry should be attempted.
 * Retries on 429 (Too Many Requests) and 5xx server errors.
 * @param error The error object.
 * @param retryFetchErrors Whether to retry on specific fetch errors.
 * @returns True if the error is a transient error, false otherwise.
 */
export function isRetryableError(
  error: Error | unknown,
  retryFetchErrors?: boolean,
): boolean {
  // Check for common network error codes
  const errorCode = getNetworkErrorCode(error);
  if (errorCode && RETRYABLE_NETWORK_CODES.includes(errorCode)) {
    return true;
  }

  if (retryFetchErrors && error instanceof Error) {
    const lowerMessage = error.message.toLowerCase();
    // Check for generic fetch failed message, incomplete JSON segment, or socket closed
    if (
      lowerMessage.includes(FETCH_FAILED_MESSAGE) ||
      lowerMessage.includes(INCOMPLETE_JSON_MESSAGE) ||
      lowerMessage.includes(SOCKET_CLOSED_MESSAGE)
    ) {
      return true;
    }
  }

  // Priority check for ApiError
  if (error instanceof ApiError) {
    // Explicitly do not retry 400 (Bad Request)
    if (error.status === 400) return false;
    return (
      error.status === 429 ||
      error.status === 499 ||
      (error.status >= 500 && error.status < 600)
    );
  }

  // Check for status using helper (handles other error shapes)
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || status === 499 || (status >= 500 && status < 600);
  }

  return false;
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
  options?: Partial<RetryOptions<T>>,
): Promise<T> {
  if (options?.signal?.aborted) {
    throw createAbortError();
  }

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
    onPersistent429,
    authType,
    shouldRetryOnError,
    shouldRetryOnContent,
    retryFetchErrors,
    signal,
    getAvailabilityContext,
    onRetry,
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    shouldRetryOnError: isRetryableError,
    ...cleanOptions,
  };

  let attempt = 0;
  let currentDelay = initialDelayMs;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  while (attempt < maxAttempts) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    attempt++;
    try {
      const result = await fn();

      if (shouldRetryOnContent && shouldRetryOnContent(result)) {
        throwIfAborted();
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        if (onRetry) {
          onRetry(attempt, new Error('Invalid content'), delayWithJitter);
        }
        await delay(delayWithJitter, signal);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }

      const successContext = getAvailabilityContext?.();
      if (successContext) {
        successContext.service.markHealthy(successContext.policy.model);
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throwIfAborted();

      const classifiedError = classifyGoogleError(error);

      const errorCode = getErrorStatus(error);

      if (
        classifiedError instanceof TerminalQuotaError ||
        classifiedError instanceof ModelNotFoundError
      ) {
        if (onPersistent429) {
          try {
            const fallbackModel = await onPersistent429(
              authType,
              classifiedError,
            );
            if (fallbackModel) {
              attempt = 0; // Reset attempts and retry with the new model.
              currentDelay = initialDelayMs;
              continue;
            }
          } catch (fallbackError) {
            runLogger.warn('Fallback to Flash model failed:', fallbackError);
          }
        }
        // Terminal/not_found already recorded; nothing else to mark here.
        throw classifiedError; // Throw if no fallback or fallback failed.
      }

      const is500 =
        errorCode !== undefined && errorCode >= 500 && errorCode < 600;
      const isRetryableQuota = classifiedError instanceof RetryableQuotaError;

      if (isRetryableQuota || is500) {
        // Honor an explicit caller veto for quota errors as well as 5xx.
        if (
          (is500 || options?.shouldRetryOnError !== undefined) &&
          !shouldRetryOnError(error as Error, retryFetchErrors)
        ) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          const errorMessage =
            classifiedError instanceof Error ? classifiedError.message : '';
          runLogger.warn(
            `Attempt ${attempt} failed${errorMessage ? `: ${errorMessage}` : ''}. Max attempts reached`,
          );
          if (onPersistent429) {
            try {
              const fallbackModel = await onPersistent429(
                authType,
                classifiedError,
              );
              if (fallbackModel) {
                attempt = 0; // Reset attempts and retry with the new model.
                currentDelay = initialDelayMs;
                continue;
              }
            } catch (fallbackError) {
              runLogger.warn('Model fallback failed:', fallbackError);
            }
          }
          throw classifiedError instanceof RetryableQuotaError
            ? classifiedError
            : error;
        }

        if (isRetryableQuota && classifiedError.retryDelayMs !== undefined) {
          currentDelay = Math.max(currentDelay, classifiedError.retryDelayMs);
          // Positive jitter up to +20% while respecting server minimum delay
          const jitter = currentDelay * 0.2 * Math.random();
          const delayWithJitter = currentDelay + jitter;
          runLogger.warn(
            `Attempt ${attempt} failed: ${classifiedError.message}. Retrying after ${Math.round(delayWithJitter)}ms...`,
          );
          if (onRetry) {
            onRetry(attempt, error, delayWithJitter);
          }
          await delay(delayWithJitter, signal);
          currentDelay = Math.min(maxDelayMs, currentDelay * 2);
          continue;
        } else {
          const errorStatus = getErrorStatus(error);
          logRetryAttempt(attempt, error, errorStatus);

          // Exponential backoff with jitter for non-quota errors
          const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
          const delayWithJitter = Math.max(0, currentDelay + jitter);
          if (onRetry) {
            onRetry(attempt, error, delayWithJitter);
          }
          await delay(delayWithJitter, signal);
          currentDelay = Math.min(maxDelayMs, currentDelay * 2);
          continue;
        }
      }

      // Generic retry logic for other errors
      if (
        attempt >= maxAttempts ||
        !shouldRetryOnError(error as Error, retryFetchErrors)
      ) {
        throw error;
      }

      // Disable keep-alive when retrying a stale connection error
      if (isStaleConnectionError(error)) {
        disableKeepAlive();
      }

      const errorStatus = getErrorStatus(error);
      logRetryAttempt(attempt, error, errorStatus);

      // Exponential backoff with jitter for non-quota errors
      const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
      const delayWithJitter = Math.max(0, currentDelay + jitter);
      if (onRetry) {
        onRetry(attempt, error, delayWithJitter);
      }
      await delay(delayWithJitter, signal);
      currentDelay = Math.min(maxDelayMs, currentDelay * 2);
    }
  }

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
  errorStatus?: number,
): void {
  let message = `Attempt ${attempt} failed. Retrying with backoff...`;
  if (errorStatus) {
    message = `Attempt ${attempt} failed with status ${errorStatus}. Retrying with backoff...`;
  }

  if (errorStatus === 429) {
    runLogger.warn(message, error);
  } else if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
    runLogger.warn(message, error);
  } else if (error instanceof Error) {
    // Fallback for errors that might not have a status but have a message
    if (error.message.includes('429')) {
      runLogger.warn(
        `Attempt ${attempt} failed with 429 error (no Retry-After header). Retrying with backoff...`,
        error,
      );
    } else if (error.message.match(/5\d{2}/)) {
      runLogger.warn(
        `Attempt ${attempt} failed with 5xx error. Retrying with backoff...`,
        error,
      );
    } else {
      runLogger.warn(message, error); // Default to warn for other errors
    }
  } else {
    runLogger.warn(message, error); // Default to warn if error type is unknown
  }
}
