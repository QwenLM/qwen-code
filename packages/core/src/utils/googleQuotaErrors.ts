/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseGoogleApiError,
  type ErrorInfo,
  type GoogleApiError,
  type QuotaFailure,
  type RetryInfo,
} from './googleErrors.js';
import { getErrorStatus, ModelNotFoundError } from './httpErrors.js';

/**
 * A non-retryable error indicating a hard quota limit has been reached (e.g., daily limit).
 */
export class TerminalQuotaError extends Error {
  retryDelayMs?: number;
  reason?: string;

  constructor(
    message: string,
    override readonly cause: GoogleApiError,
    retryDelaySeconds?: number,
    reason?: string,
  ) {
    super(message);
    this.name = 'TerminalQuotaError';
    this.retryDelayMs = retryDelaySeconds
      ? retryDelaySeconds * 1000
      : undefined;
    this.reason = reason;
  }
}

/**
 * A retryable error indicating a temporary quota issue (e.g., per-minute limit).
 */
export class RetryableQuotaError extends Error {
  retryDelayMs?: number;

  constructor(
    message: string,
    override readonly cause: GoogleApiError,
    retryDelaySeconds?: number,
  ) {
    super(message);
    this.name = 'RetryableQuotaError';
    this.retryDelayMs = retryDelaySeconds
      ? retryDelaySeconds * 1000
      : undefined;
  }
}

/**
 * Parses a duration string (e.g., "34.074824224s", "60s", "900ms") and returns the time in seconds.
 * @param duration The duration string to parse.
 * @returns The duration in seconds, or null if parsing fails.
 */
function parseDurationInSeconds(duration: string): number | null {
  if (duration.endsWith('ms')) {
    const milliseconds = parseFloat(duration.slice(0, -2));
    return isNaN(milliseconds) ? null : milliseconds / 1000;
  }
  if (duration.endsWith('s')) {
    const seconds = parseFloat(duration.slice(0, -1));
    return isNaN(seconds) ? null : seconds;
  }
  return null;
}

/**
 * Maximum retry delay (in seconds) before a retryable error is treated as terminal.
 * If the server suggests waiting longer than this, the user is effectively locked out,
 * so we trigger the fallback/credits flow instead of silently waiting.
 */
const MAX_RETRYABLE_DELAY_SECONDS = 300; // 5 minutes

/**
 * Cloud Code API domains whose ErrorInfo reasons are trusted for classification.
 */
const CLOUDCODE_DOMAINS = [
  'cloudcode-pa.googleapis.com',
  'staging-cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.googleapis.com',
];

/**
 * Checks if the given domain belongs to a Cloud Code API endpoint.
 * Sanitizes stray characters that SSE stream parsing can inject into the
 * domain string before comparing.
 */
function isCloudCodeDomain(domain: string): boolean {
  const sanitized = domain.replace(/[^a-zA-Z0-9.-]/g, '');
  return CLOUDCODE_DOMAINS.includes(sanitized);
}

/**
 * Analyzes a caught error and classifies it as a specific error type if applicable.
 *
 * Classification logic:
 * - 404 errors are classified as `ModelNotFoundError`.
 * - 429 errors are classified as either `TerminalQuotaError` or `RetryableQuotaError`:
 *   - CloudCode API: `RATE_LIMIT_EXCEEDED` → `RetryableQuotaError`, `QUOTA_EXHAUSTED` → `TerminalQuotaError`.
 *   - If the error indicates a daily limit (in QuotaFailure), it's a `TerminalQuotaError`.
 *   - If the error has a retry delay, it's a `RetryableQuotaError`.
 *   - If the error indicates a per-minute limit, it's a `RetryableQuotaError`.
 *   - If the error message contains the phrase "Please retry in X[s|ms]", it's a `RetryableQuotaError`.
 *
 * @param error The error to classify.
 * @returns A classified error or the original `unknown` error.
 */
export function classifyGoogleError(error: unknown): unknown {
  const googleApiError = parseGoogleApiError(error);
  const status = googleApiError?.code ?? getErrorStatus(error);

  if (status === 404) {
    const message =
      googleApiError?.message ||
      (error instanceof Error ? error.message : 'Model not found');
    return new ModelNotFoundError(message, status);
  }

  // Check for 503 Service Unavailable errors
  if (status === 503) {
    const errorMessage =
      googleApiError?.message ||
      (error instanceof Error ? error.message : String(error));
    return new RetryableQuotaError(
      errorMessage,
      googleApiError ?? {
        code: 503,
        message: errorMessage,
        details: [],
      },
    );
  }

  if (
    !googleApiError ||
    (googleApiError.code !== 429 && googleApiError.code !== 499) ||
    googleApiError.details.length === 0
  ) {
    // Fallback: try to parse the error message for a retry delay
    const errorMessage =
      googleApiError?.message ||
      (error instanceof Error ? error.message : String(error));
    const match = errorMessage.match(/Please retry in ([0-9.]+(?:ms|s))/);
    if (match?.[1]) {
      const retryDelaySeconds = parseDurationInSeconds(match[1]);
      if (retryDelaySeconds !== null) {
        const cause = googleApiError ?? {
          code: status ?? 429,
          message: errorMessage,
          details: [],
        };
        if (retryDelaySeconds > MAX_RETRYABLE_DELAY_SECONDS) {
          return new TerminalQuotaError(errorMessage, cause, retryDelaySeconds);
        }
        return new RetryableQuotaError(errorMessage, cause, retryDelaySeconds);
      }
    } else if (status === 429 || status === 499) {
      // Fallback: If it is a 429 or 499 but doesn't have a specific "retry in" message,
      // assume it is a temporary rate limit and retry after 5 sec (same as DEFAULT_RETRY_OPTIONS).
      return new RetryableQuotaError(
        errorMessage,
        googleApiError ?? {
          code: status,
          message: errorMessage,
          details: [],
        },
      );
    }

    return error; // Not a retryable error we can handle with structured details or a parsable retry message.
  }

  const quotaFailure = googleApiError.details.find(
    (d): d is QuotaFailure =>
      d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure',
  );

  const errorInfo = googleApiError.details.find(
    (d): d is ErrorInfo =>
      d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo',
  );

  const retryInfo = googleApiError.details.find(
    (d): d is RetryInfo =>
      d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
  );

  // 1. Check for long-term limits in QuotaFailure or ErrorInfo
  if (quotaFailure) {
    for (const violation of quotaFailure.violations) {
      const quotaId = violation.quotaId ?? '';
      if (quotaId.includes('PerDay') || quotaId.includes('Daily')) {
        return new TerminalQuotaError(
          `You have exhausted your daily quota on this model.`,
          googleApiError,
        );
      }
    }
  }
  let delaySeconds;

  if (retryInfo?.retryDelay) {
    const parsedDelay = parseDurationInSeconds(retryInfo.retryDelay);
    if (parsedDelay) {
      delaySeconds = parsedDelay;
    }
  }

  if (errorInfo) {
    // New Cloud Code API quota handling
    if (errorInfo.domain) {
      if (isCloudCodeDomain(errorInfo.domain)) {
        if (errorInfo.reason === 'RATE_LIMIT_EXCEEDED') {
          const effectiveDelay = delaySeconds ?? 10;
          if (effectiveDelay > MAX_RETRYABLE_DELAY_SECONDS) {
            return new TerminalQuotaError(
              `${googleApiError.message}`,
              googleApiError,
              effectiveDelay,
              errorInfo.reason,
            );
          }
          return new RetryableQuotaError(
            `${googleApiError.message}`,
            googleApiError,
            effectiveDelay,
          );
        }
        if (errorInfo.reason === 'QUOTA_EXHAUSTED') {
          return new TerminalQuotaError(
            `${googleApiError.message}`,
            googleApiError,
            delaySeconds,
            errorInfo.reason,
          );
        }
      }
    }
  }

  // 2. Check for delays in RetryInfo
  if (retryInfo?.retryDelay && delaySeconds) {
    if (delaySeconds > MAX_RETRYABLE_DELAY_SECONDS) {
      return new TerminalQuotaError(
        `${googleApiError.message}\nSuggested retry after ${retryInfo.retryDelay}.`,
        googleApiError,
        delaySeconds,
      );
    }
    return new RetryableQuotaError(
      `${googleApiError.message}\nSuggested retry after ${retryInfo.retryDelay}.`,
      googleApiError,
      delaySeconds,
    );
  }

  // 3. Check for short-term limits in QuotaFailure or ErrorInfo
  if (quotaFailure) {
    for (const violation of quotaFailure.violations) {
      const quotaId = violation.quotaId ?? '';
      if (quotaId.includes('PerMinute')) {
        return new RetryableQuotaError(
          `${googleApiError.message}\nSuggested retry after 60s.`,
          googleApiError,
          60,
        );
      }
    }
  }

  if (errorInfo) {
    const quotaLimit = errorInfo.metadata?.['quota_limit'] ?? '';
    if (quotaLimit.includes('PerMinute')) {
      return new RetryableQuotaError(
        `${errorInfo.reason}\nSuggested retry after 60s.`,
        googleApiError,
        60,
      );
    }
  }

  // If we reached this point and the status is still 429 or 499, we return retryable.
  if (status === 429 || status === 499) {
    const errorMessage =
      googleApiError?.message ||
      (error instanceof Error ? error.message : String(error));
    return new RetryableQuotaError(
      errorMessage,
      googleApiError ?? {
        code: status,
        message: errorMessage,
        details: [],
      },
    );
  }
  return error; // Fallback to original error if no specific classification fits.
}
