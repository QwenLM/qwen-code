/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type RetryAfterMode = 'ignore' | 'minimum';

/**
 * Largest delay Node.js `setTimeout` can represent. Values above the signed
 * 32-bit limit overflow and fire immediately, which would turn a long
 * server-directed wait into a 0ms tight retry loop. Every computed delay is
 * clamped to this ceiling.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface RetryDelayPolicyOptions {
  attempt: number;
  initialDelayMs: number;
  maxDelayMs: number;
  error?: unknown;
  retryAfterMode?: RetryAfterMode;
  retryAfterMaxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

/**
 * Calculates a retry delay using a shared exponential-backoff policy.
 *
 * Retry-After handling depends on `retryAfterMode`:
 *   - `'ignore'` (default): do not parse Retry-After; always return the
 *     exponential delay (with optional jitter). Passing `error` alone does not
 *     enable Retry-After handling.
 *   - `'minimum'`: use Retry-After as a floor on the exponential delay.
 *
 * When Retry-After is honored, `jitterRatio` is intentionally not applied —
 * the server's wait is treated as exact.
 *
 * `retryAfterMaxDelayMs` caps the Retry-After-derived delay; defaults to
 * `maxDelayMs`.
 */
export function getRetryDelayMs(options: RetryDelayPolicyOptions): number {
  const normalizedAttempt = Math.max(1, options.attempt);
  // Bound every cap by the setTimeout ceiling, including the caller-supplied
  // maxDelayMs itself — otherwise an oversized maxDelayMs could let the
  // exponential or jittered delay overflow the timer and fire immediately.
  const delayCeilingMs = Math.min(options.maxDelayMs, MAX_TIMEOUT_MS);
  // Cap the exponent so a large attempt count in persistent mode cannot push
  // `Math.pow(2, n)` to Infinity. `2^31` already exceeds any realistic
  // maxDelayMs, so the subsequent Math.min still clamps correctly.
  const exponent = Math.min(normalizedAttempt - 1, 31);
  const cappedExponentialDelayMs = Math.min(
    options.initialDelayMs * Math.pow(2, exponent),
    delayCeilingMs,
  );
  const retryAfterMode = options.retryAfterMode ?? 'ignore';
  const retryAfterMs =
    retryAfterMode === 'ignore' ? null : getRetryAfterDelayMs(options.error);

  if (retryAfterMs !== null && retryAfterMs > 0) {
    const retryAfterCapMs = Math.min(
      options.retryAfterMaxDelayMs ?? options.maxDelayMs,
      MAX_TIMEOUT_MS,
    );
    const cappedRetryAfterMs = Math.min(retryAfterMs, retryAfterCapMs);
    return Math.max(cappedExponentialDelayMs, cappedRetryAfterMs);
  }

  const jitterRatio = options.jitterRatio ?? 0;
  if (jitterRatio <= 0) return cappedExponentialDelayMs;

  const random = options.random ?? Math.random;
  const jitter = cappedExponentialDelayMs * jitterRatio * (random() * 2 - 1);
  return Math.min(
    Math.max(0, cappedExponentialDelayMs + jitter),
    delayCeilingMs,
  );
}

/**
 * Extracts Retry-After from common SDK error header shapes.
 *
 * This intentionally checks both direct `error.headers` and
 * `error.response.headers`. Some SDKs surface response headers directly on the
 * thrown error, and those 429s should honor the provider-specified wait.
 */
export function getRetryAfterDelayMs(error: unknown): number | null {
  const value =
    getHeaderValue(error, 'retry-after') ??
    getResponseHeaderValue(error, 'retry-after');
  if (value === null) return null;

  const trimmed = value.trim();
  // RFC 7231 delay-seconds is decimal digits only. Restrict parsing to a plain
  // (optionally fractional) decimal so non-RFC shapes Number() would otherwise
  // accept (e.g. "0x10", "1e3") fall through to the HTTP-date branch instead of
  // silently producing a wrong delay.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_TIMEOUT_MS);
    }
  }

  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return null;

  const delayMs = retryAtMs - Date.now();
  return delayMs > 0 ? Math.min(delayMs, MAX_TIMEOUT_MS) : 0;
}

function getHeaderValue(error: unknown, headerName: string): string | null {
  if (!hasHeaders(error)) return null;

  const { headers } = error;
  if (typeof headers.get === 'function') {
    const value = headers.get(headerName);
    return typeof value === 'string' ? value : null;
  }

  if (typeof headers !== 'object' || headers === null) return null;

  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) continue;
    return typeof value === 'string' ? value : null;
  }

  return null;
}

function getResponseHeaderValue(
  error: unknown,
  headerName: string,
): string | null {
  if (!hasResponseHeaders(error)) return null;
  return getHeaderValue(error.response, headerName);
}

function hasHeaders(error: unknown): error is {
  headers: { get?: (name: string) => unknown } | Record<string, unknown>;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'headers' in error &&
    error.headers != null
  );
}

function hasResponseHeaders(error: unknown): error is {
  response: {
    headers: { get?: (name: string) => unknown } | Record<string, unknown>;
  };
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'headers' in error.response &&
    error.response.headers != null
  );
}
