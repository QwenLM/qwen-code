/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the effective per-prompt wallclock from the server flag +
 * an optional request body override. Returns `undefined` when no
 * deadline applies. The request override may SHORTEN the deadline but
 * never EXTEND it — operators stay the upper bound.
 */
export function resolvePromptDeadlineMs(
  serverMs: number | undefined,
  requestMs: number | undefined,
): number | undefined {
  if (serverMs === undefined || !Number.isFinite(serverMs) || serverMs <= 0) {
    return undefined;
  }
  if (
    requestMs === undefined ||
    !Number.isFinite(requestMs) ||
    requestMs <= 0
  ) {
    return serverMs;
  }
  return Math.min(serverMs, requestMs);
}
