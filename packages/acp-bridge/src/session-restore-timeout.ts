/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_SESSION_RESTORE_TIMEOUT_MS = 60_000;
export const MAX_SESSION_RESTORE_TIMEOUT_MS = 2_147_483_647;

export interface SessionRestoreTimeoutOptions {
  sessionRestoreTimeoutMs?: number;
  initializeTimeoutMs?: number;
}

function assertValidTimeoutMs(field: string, timeoutMs: number): void {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_SESSION_RESTORE_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Invalid ${field}: ${timeoutMs}. Must be a positive integer no greater than ${MAX_SESSION_RESTORE_TIMEOUT_MS}.`,
    );
  }
}

export function resolveSessionRestoreTimeoutMs(
  opts: SessionRestoreTimeoutOptions,
): number {
  if (opts.sessionRestoreTimeoutMs !== undefined) {
    assertValidTimeoutMs(
      'sessionRestoreTimeoutMs',
      opts.sessionRestoreTimeoutMs,
    );
    return opts.sessionRestoreTimeoutMs;
  }
  if (opts.initializeTimeoutMs !== undefined) {
    assertValidTimeoutMs('initializeTimeoutMs', opts.initializeTimeoutMs);
    // A startup budget may RAISE the restore budget but never lower it. The
    // two measure different work — a strict child-initialize check must not
    // silently reimpose the sub-default restore deadline that #8678 was
    // filed against.
    return Math.max(
      opts.initializeTimeoutMs,
      DEFAULT_SESSION_RESTORE_TIMEOUT_MS,
    );
  }
  return DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
}
