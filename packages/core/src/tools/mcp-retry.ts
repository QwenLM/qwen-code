/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MCP_RETRY');

/** Default max retry attempts for transient network errors. */
const DEFAULT_MAX_RETRIES = 2;

/** Base delay in ms for exponential backoff (doubles each attempt). */
const DEFAULT_BASE_DELAY_MS = 200;

/**
 * Node.js network error codes that indicate a transient failure worth
 * retrying. Permanent errors (auth, invalid config) are excluded.
 */
const TRANSIENT_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

/**
 * HTTP status patterns that indicate a temporary server-side failure.
 * Requires HTTP context (status text, "status code" prefix, or HTTP
 * response line) to avoid false positives on arbitrary numbers.
 */
const TRANSIENT_HTTP_STATUS_PATTERNS: RegExp[] = [
  /\b(502|503|504)\s+(Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /\bstatus\s*(?:code)?\s*[:=]?\s*(502|503|504)\b/i,
  /\bHTTP\/\S+\s+(502|503|504)\b/i,
];

/**
 * Determine whether an error is a transient network error that is
 * worth retrying. Permanent errors (auth failure, invalid config,
 * method-not-found) are NOT considered transient.
 *
 * Transient error codes / patterns:
 * - Node.js network error codes: ECONNRESET, ETIMEDOUT, ENOTFOUND,
 *   ECONNREFUSED, EAI_AGAIN, EPIPE, EHOSTUNREACH, ENETUNREACH
 * - MCP / JSON-RPC transport-level errors that embed those codes
 * - HTTP status codes that indicate temporary server-side failures:
 *   502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
 *
 * Non-transient (not retried):
 * - 401 (Unauthorized) / 403 (Forbidden) — auth / permission errors
 * - -32601 (Method not found) — server doesn't implement the method
 * - -32600 (Invalid request) / -32602 (Invalid params) — client bugs
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error == null) return false;

  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601 || code === -32600 || code === -32602) return false;

  const message = getErrorMessage(error);

  if (message.includes('401') || message.includes('403')) return false;

  for (const transientCode of TRANSIENT_ERROR_CODES) {
    if (message.includes(transientCode)) return true;
  }

  if (TRANSIENT_HTTP_STATUS_PATTERNS.some((re) => re.test(message))) {
    return true;
  }

  if (
    message.includes('Connection closed') ||
    message.includes('transport error') ||
    message.includes('Streamable HTTP connection')
  ) {
    return true;
  }

  return false;
}

/**
 * Retry a fallible async operation with short exponential backoff on
 * transient network errors. Permanent errors (auth, invalid config,
 * method-not-found) propagate immediately without retry.
 *
 * @param fn        The async operation to attempt.
 * @param label     A human-readable label for debug logging.
 * @param opts      Optional overrides for maxRetries, baseDelayMs, and signal.
 * @returns         The result of `fn()` on success.
 * @throws          The last error if all retries are exhausted, the
 *                  original error if it is not transient, or an
 *                  AbortError if the signal fires during backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const signal = opts?.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTransientNetworkError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      debugLogger.info(
        `Transient error on '${label}' (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${delayMs}ms: ${getErrorMessage(error)}`,
      );
      await delayWithAbort(delayMs, signal);
    }
  }
  throw lastError;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Retry aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Retry aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
