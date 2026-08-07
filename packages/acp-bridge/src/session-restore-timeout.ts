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

export function resolveSessionRestoreTimeoutMs(
  opts: SessionRestoreTimeoutOptions,
): number {
  const timeoutMs =
    opts.sessionRestoreTimeoutMs ??
    opts.initializeTimeoutMs ??
    DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_SESSION_RESTORE_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Invalid sessionRestoreTimeoutMs: ${timeoutMs}. Must be a positive integer no greater than ${MAX_SESSION_RESTORE_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}
