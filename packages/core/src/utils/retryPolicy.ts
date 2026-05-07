/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type RetryAfterMode = 'ignore' | 'minimum' | 'prefer';

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
 *     exponential delay (with optional jitter).
 *   - `'minimum'`: use Retry-After as a floor on the exponential delay.
 *   - `'prefer'`: if Retry-After is present, use it directly.
 *
 * When Retry-After is honored (`'minimum'` or `'prefer'` with a present
 * header), `jitterRatio` is intentionally not applied — the server's wait is
 * treated as exact.
 *
 * `retryAfterMaxDelayMs` caps the Retry-After-derived delay; defaults to
 * `maxDelayMs`.
 */
export function getRetryDelayMs(options: RetryDelayPolicyOptions): number {
  const normalizedAttempt = Math.max(1, options.attempt);
  const cappedExponentialDelayMs = Math.min(
    options.initialDelayMs * Math.pow(2, normalizedAttempt - 1),
    options.maxDelayMs,
  );
  const retryAfterMode = options.retryAfterMode ?? 'ignore';
  const retryAfterMs =
    retryAfterMode === 'ignore' ? null : getRetryAfterDelayMs(options.error);

  if (retryAfterMs !== null && retryAfterMs > 0) {
    const retryAfterCapMs = options.retryAfterMaxDelayMs ?? options.maxDelayMs;
    const cappedRetryAfterMs = Math.min(retryAfterMs, retryAfterCapMs);
    const baseDelayMs =
      retryAfterMode === 'minimum'
        ? Math.max(cappedExponentialDelayMs, cappedRetryAfterMs)
        : cappedRetryAfterMs;
    return baseDelayMs;
  }

  const jitterRatio = options.jitterRatio ?? 0;
  if (jitterRatio <= 0) return cappedExponentialDelayMs;

  const random = options.random ?? Math.random;
  const jitter = cappedExponentialDelayMs * jitterRatio * (random() * 2 - 1);
  return Math.min(
    Math.max(0, cappedExponentialDelayMs + jitter),
    options.maxDelayMs,
  );
}

/**
 * Extracts Retry-After from common SDK error header shapes.
 */
export function getRetryAfterDelayMs(error: unknown): number | null {
  const value =
    getHeaderValue(error, 'retry-after') ??
    getResponseHeaderValue(error, 'retry-after');
  if (value === null) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return null;

  const delayMs = retryAtMs - Date.now();
  return delayMs > 0 ? delayMs : 0;
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
