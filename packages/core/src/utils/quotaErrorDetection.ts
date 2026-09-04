/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StructuredError } from '../core/turn.js';

export interface ApiError {
  error: {
    code: number;
    message: string;
    status: string;
    details: unknown[];
  };
}

export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as ApiError).error === 'object' &&
    (error as ApiError).error !== null &&
    'message' in (error as ApiError).error
  );
}

export function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as StructuredError).message === 'string'
  );
}

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

export function isQwenQuotaExceededError(error: unknown): boolean {
  // Match the specific Qwen free-tier quota error to distinguish it from
  // temporary throttling (429 due to concurrency) or paid account quota limits.
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, code, message } = error as {
    status?: number;
    code?: string;
    message?: string;
  };
  return (
    status === 429 &&
    code === 'insufficient_quota' &&
    typeof message === 'string' &&
    message.toLowerCase().includes('free allocated quota exceeded')
  );
}

/**
 * Prefix marking a friendly quota-exhausted message produced by
 * {@link formatQuotaExhaustedMessage}. `parseAndFormatApiError` recognizes it
 * so the message is surfaced verbatim instead of being re-wrapped in
 * "[API Error: …]".
 */
export const QUOTA_EXHAUSTED_PREFIX = 'Quota exhausted: ';

/** Best-effort extraction of a human-readable message from common error shapes. */
function getQuotaMessage(error: unknown): string | null {
  let message: string | null = null;
  if (typeof error === 'string') message = error;
  else if (isStructuredError(error)) message = error.message;
  else if (isApiError(error)) message = error.error.message;
  if (message === null) return null;
  // Unwrap a JSON error body ('{"error":{"code":"429","message":"..."}}')
  // so the nested human-readable message is surfaced instead of raw JSON —
  // the same extraction parseAndFormatApiError performs.
  const start = message.indexOf('{');
  if (start !== -1) {
    try {
      const parsed = JSON.parse(message.substring(start)) as unknown;
      if (isApiError(parsed)) return parsed.error.message;
    } catch {
      /* not a JSON error body */
    }
  }
  return message;
}

/**
 * Detects permanent quota-exhaustion errors that carry a reset time.
 *
 * Unlike transient rate-limiting (TPM/RPM throttling, which lifts within
 * seconds–minutes), these signal an allocated quota fully spent and only
 * resetting at a specific future time. Retrying cannot succeed until then —
 * the caller should fast-fail and surface the reset time instead of hanging
 * the session through the full retry budget with no output.
 *
 * Matches e.g. the Bailian token-plan error surfaced via the OpenAI SDK:
 *   "429 Your token-plan 1-week quota has been exhausted. The quota will
 *    reset at 07-27 09:25:00 UTC."
 *
 * @param error The error to check (Error, ApiError, or message string).
 * @returns True when the error names a quota that is exhausted/exceeded AND
 *   carries a reset time — the combination that signals a permanent condition.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  const message = getQuotaMessage(error);
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('quota') &&
    (lower.includes('exhausted') || lower.includes('exceeded')) &&
    (lower.includes('will reset') || lower.includes('reset at'))
  );
}

/**
 * Builds a friendly, self-contained message for a permanent quota-exhaustion
 * error. Preserves the provider's verbatim wording (which names the quota and
 * the reset time) and appends an actionable hint.
 *
 * The result is prefixed with {@link QUOTA_EXHAUSTED_PREFIX} so
 * `parseAndFormatApiError` surfaces it verbatim rather than wrapping it.
 *
 * @param error The error whose message should be surfaced.
 * @returns A user-facing message starting with `QUOTA_EXHAUSTED_PREFIX`.
 */
export function formatQuotaExhaustedMessage(error: unknown): string {
  const raw = getQuotaMessage(error) ?? '';
  if (raw.startsWith(QUOTA_EXHAUSTED_PREFIX)) return raw;
  // Strip a leading "NNN " HTTP-status prefix the OpenAI SDK prepends
  // (e.g. "429 Your token-plan …") so the surfaced text does not start with
  // a bare status code.
  const stripped =
    raw.replace(/^\d{3}\s+/, '').trim() || 'quota has been exhausted';
  return `${QUOTA_EXHAUSTED_PREFIX}${stripped}\n\nPlease retry after the reset time, or switch to another API key / auth method.`;
}
