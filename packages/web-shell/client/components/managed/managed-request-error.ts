/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether the service answered a request in a way a retry cannot change.
 *
 * A 4xx other than a timeout (408) or a rate limit (429) is an answer, not a
 * hiccup: a deleted Session or an unknown Action replies the same way however
 * often it is asked, so retrying only burns requests. Timeouts and rate limits
 * are worth another attempt.
 */
export function isNonRetryableClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * A 401/403. This client re-derives its credentials on every request, so an
 * expired short-lived token gets a fresh answer on the very next attempt
 * once the host refreshes — never a terminal condition.
 */
export function isAuthFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
