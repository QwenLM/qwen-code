/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Signals that an internal model request lost or changed the root session ID.
 *
 * This is a client invariant failure, not a tool business failure. Model-backed
 * tools use it to log the detailed cause and return a stable "tool unavailable"
 * result so the main model loop can continue.
 */
export class SessionIdInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionIdInvariantError';
  }
}

export function isSessionIdInvariantError(
  error: unknown,
): error is SessionIdInvariantError {
  return error instanceof SessionIdInvariantError;
}
