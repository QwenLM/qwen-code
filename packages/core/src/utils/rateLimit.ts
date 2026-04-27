/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorStatus } from './errors.js';
import { isApiError, isStructuredError } from './quotaErrorDetection.js';

// Known rate-limit error codes across providers.
// 429  - Standard HTTP "Too Many Requests" (DashScope TPM, OpenAI, etc.)
// 503  - Provider throttling/overload (treated as rate-limit for retry UI)
// 1302 - Z.AI GLM rate limit (https://docs.z.ai/api-reference/api-code)
// 1305 - DashScope/IdealTalk internal rate limit (issue #1918)
const RATE_LIMIT_ERROR_CODES = new Set([429, 503, 1302, 1305]);

export interface RetryInfo {
  /** Formatted error message for display, produced by parseAndFormatApiError. */
  message?: string;
  /** Current retry attempt (1-based). */
  attempt: number;
  /** Max retries allowed. */
  maxRetries: number;
  /** Delay in milliseconds before the retry happens. */
  delayMs: number;
  /** When called, resolves the delay promise early so the retry happens immediately. */
  skipDelay: () => void;
}

/**
 * Detects rate-limit / throttling errors and returns retry info.
 *
 * @param error - The error to check.
 * @param extraCodes - Additional error codes to treat as rate-limit errors,
 *   merged with the built-in set at call time (not mutating the default set).
 */
export function isRateLimitError(
  error: unknown,
  extraCodes?: readonly number[],
): boolean {
  const code = getErrorCode(error);
  if (code === null) return false;
  if (RATE_LIMIT_ERROR_CODES.has(code)) return true;
  if (extraCodes && extraCodes.includes(code)) return true;
  return false;
}

/**
 * Extracts the numeric error code from various error shapes.
 * Mirrors the same parsing patterns used by parseAndFormatApiError.
 */
function getErrorCode(error: unknown): number | null {
  // ApiError (.error.code) — fall through when the code is not a finite number
  // (e.g. DashScope `"code":"Throttling.AllocationQuota"`) so later handlers
  // can still recover a status from `.status` or the message.
  if (isApiError(error)) {
    const n = Number(error.error.code);
    if (Number.isFinite(n) && n > 0) return n;
  }

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
        if (isApiError(p)) {
          const n = Number(p.error.code);
          if (Number.isFinite(n) && n > 0) return n;
        }
      } catch {
        /* not valid JSON */
      }
    }
  }

  // StructuredError (.status) — plain objects from Gemini SDK.
  // Fall through when .status is missing so the getErrorStatus fallback
  // below can still recover a status from streamed SSE error frames.
  if (isStructuredError(error) && typeof error.status === 'number') {
    return error.status;
  }

  // HttpError (.status on Error)
  if (error instanceof Error && 'status' in error) {
    const s = (error as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }

  // Final fallback: delegate to getErrorStatus which also parses
  // `HTTP_STATUS/NNN` out of streamed SSE error frames (e.g. DashScope
  // `Throttling.AllocationQuota` where the SDK never surfaces a real HTTP
  // status because the stream opened with 200 OK).
  return getErrorStatus(error) ?? null;
}
