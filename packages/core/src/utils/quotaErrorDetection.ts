/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StructuredError } from '../core/turn.js';

/**
 * Represents the structure of a standard API error response.
 */
export interface ApiError {
  error: {
    code: number;
    message: string;
    status: string;
    details: unknown[];
  };
}

/**
 * Type guard to check if an error object conforms to the `ApiError` interface.
 * @param error The error object to check.
 * @returns `true` if the object is an `ApiError`, `false` otherwise.
 */
export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as ApiError).error === 'object' &&
    'message' in (error as ApiError).error
  );
}

/**
 * Type guard to check if an error object is a `StructuredError`.
 * @param error The error object to check.
 * @returns `true` if the object is a `StructuredError`, `false` otherwise.
 */
export function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as StructuredError).message === 'string'
  );
}

/**
 * Checks if an error is a "Gemini Pro Quota Exceeded" error.
 * This is a specific type of quota error that indicates the user has exhausted their quota for the Gemini Pro model.
 *
 * @param error The error object to check.
 * @returns `true` if the error is a Pro quota exceeded error, `false` otherwise.
 */
export function isProQuotaExceededError(error: unknown): boolean {
  // Check for Pro quota exceeded errors by looking for the specific pattern
  // This will match patterns like:
  // - "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'"
  // - "Quota exceeded for quota metric 'Gemini 2.5-preview Pro Requests'"
  // We use string methods instead of regex to avoid ReDoS vulnerabilities

  const checkMessage = (message: string): boolean =>
    message.includes("Quota exceeded for quota metric 'Gemini") &&
    message.includes("Pro Requests'");

  if (typeof error === 'string') {
    return checkMessage(error);
  }

  if (isStructuredError(error)) {
    return checkMessage(error.message);
  }

  if (isApiError(error)) {
    return checkMessage(error.error.message);
  }

  // Check if it's a Gaxios error with response data
  if (error && typeof error === 'object' && 'response' in error) {
    const gaxiosError = error as {
      response?: {
        data?: unknown;
      };
    };
    if (gaxiosError.response && gaxiosError.response.data) {
      if (typeof gaxiosError.response.data === 'string') {
        return checkMessage(gaxiosError.response.data);
      }
      if (
        typeof gaxiosError.response.data === 'object' &&
        gaxiosError.response.data !== null &&
        'error' in gaxiosError.response.data
      ) {
        const errorData = gaxiosError.response.data as {
          error?: { message?: string };
        };
        return checkMessage(errorData.error?.message || '');
      }
    }
  }
  return false;
}

/**
 * Checks if an error is a generic "Quota Exceeded" error.
 * This is a more general check for any error message that includes the phrase "Quota exceeded for quota metric".
 *
 * @param error The error object to check.
 * @returns `true` if the error is a generic quota exceeded error, `false` otherwise.
 */
export function isGenericQuotaExceededError(error: unknown): boolean {
  if (typeof error === 'string') {
    return error.includes('Quota exceeded for quota metric');
  }

  if (isStructuredError(error)) {
    return error.message.includes('Quota exceeded for quota metric');
  }

  if (isApiError(error)) {
    return error.error.message.includes('Quota exceeded for quota metric');
  }

  return false;
}

/**
 * Checks if an error is a Qwen "Insufficient Quota" error.
 * These errors indicate that the user's quota has been exhausted and the request should not be retried.
 *
 * @param error The error object to check.
 * @returns `true` if the error is a Qwen insufficient quota error, `false` otherwise.
 */
export function isQwenQuotaExceededError(error: unknown): boolean {
  // Check for Qwen insufficient quota errors (should not retry)
  const checkMessage = (message: string): boolean => {
    const lowerMessage = message.toLowerCase();
    return (
      lowerMessage.includes('insufficient_quota') ||
      lowerMessage.includes('free allocated quota exceeded') ||
      (lowerMessage.includes('quota') && lowerMessage.includes('exceeded'))
    );
  };

  if (typeof error === 'string') {
    return checkMessage(error);
  }

  if (isStructuredError(error)) {
    return checkMessage(error.message);
  }

  if (isApiError(error)) {
    return checkMessage(error.error.message);
  }

  return false;
}

/**
 * Checks if an error is a Qwen "Throttling" error.
 * These errors indicate that the user is sending requests too frequently and the request should be retried after a delay.
 *
 * @param error The error object to check.
 * @returns `true` if the error is a Qwen throttling error, `false` otherwise.
 */
export function isQwenThrottlingError(error: unknown): boolean {
  // Check for Qwen throttling errors (should retry)
  const checkMessage = (message: string): boolean => {
    const lowerMessage = message.toLowerCase();
    return (
      lowerMessage.includes('throttling') ||
      lowerMessage.includes('requests throttling triggered') ||
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('too many requests')
    );
  };

  // Check status code
  const getStatusCode = (error: unknown): number | undefined => {
    if (error && typeof error === 'object') {
      const errorObj = error as { status?: number; code?: number };
      return errorObj.status || errorObj.code;
    }
    return undefined;
  };

  const statusCode = getStatusCode(error);

  if (typeof error === 'string') {
    return (
      (statusCode === 429 && checkMessage(error)) ||
      error.includes('throttling')
    );
  }

  if (isStructuredError(error)) {
    return statusCode === 429 && checkMessage(error.message);
  }

  if (isApiError(error)) {
    return error.error.code === 429 && checkMessage(error.error.message);
  }

  return false;
}
