/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A routing error that must not be swallowed by fallback routing.
 *
 * Use this for hard constraints such as invalid model keys or repository
 * security restrictions. The original domain error is kept in `cause` so
 * callers can surface the more specific error type.
 */
export class FatalRoutingError extends Error {
  readonly isFatalRoutingError = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FatalRoutingError';
  }
}

export function isFatalRoutingError(
  error: unknown,
): error is FatalRoutingError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'isFatalRoutingError' in error &&
    (error as { isFatalRoutingError?: unknown }).isFatalRoutingError === true
  );
}
