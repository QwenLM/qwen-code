/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isApiError, isStructuredError } from './quotaErrorDetection.js';

// Known rate-limit error codes across providers.
// 429  - Standard HTTP "Too Many Requests" (DashScope TPM, OpenAI, etc.)
// 503  - Provider throttling/overload (treated as rate-limit for retry UI)
// 1302 - Z.AI GLM rate limit (https://docs.z.ai/api-reference/api-code)
const RATE_LIMIT_ERROR_CODES = new Set([429, 503, 1302]);

export interface RetryInfo {
  /** Formatted error message for display, produced by parseAndFormatApiError. */
  message?: string;
  /** Current retry attempt (1-based). */
  attempt: number;
  /** Max retries allowed. */
  maxRetries: number;
  /** Delay in milliseconds before the retry happens. */
  delayMs: number;
}

/**
 * Detects rate-limit / throttling errors and returns retry info.
 */
export function isRateLimitError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== null && RATE_LIMIT_ERROR_CODES.has(code);
}

/**
 * Extracts the numeric error code from various error shapes.
 * Mirrors the same parsing patterns used by parseAndFormatApiError.
 */
function getErrorCode(error: unknown): number | null {
  if (isApiError(error)) return Number(error.error.code) || null;

  // JSON in string / Error.message — check BEFORE isStructuredError because
  // Error instances also satisfy isStructuredError (both have .message).
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : null;
  if (msg) {
    const i = msg.indexOf('{');
    if (i !== -1) {
      try {
        const p = JSON.parse(msg.substring(i)) as unknown;
        if (isApiError(p)) return Number(p.error.code) || null;
      } catch {
        /* not valid JSON */
      }
    }
  }

  // StructuredError (.status) — plain objects from Gemini SDK
  if (isStructuredError(error)) {
    return typeof error.status === 'number' ? error.status : null;
  }

  // HttpError (.status on Error)
  if (error instanceof Error && 'status' in error) {
    const s = (error as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }

  return null;
}
