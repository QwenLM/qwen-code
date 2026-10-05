/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MISSING_SESSION_HTTP_STATUSES = [404, 410] as const;

const MISSING_SESSION_HTTP_STATUS_SET = new Set<number>(
  MISSING_SESSION_HTTP_STATUSES,
);

export function isMissingSessionHttpStatus(
  status: number | undefined,
): boolean {
  return status !== undefined && MISSING_SESSION_HTTP_STATUS_SET.has(status);
}

/**
 * Preserve 404/410 after heartbeat detects a missing session so a later
 * status-less transport retry cannot hide the missing-session empty state.
 */
export function resolveConnectionErrorStatus(
  nextStatus: number | undefined,
  currentStatus: number | undefined,
): number | undefined {
  if (
    isMissingSessionHttpStatus(currentStatus) &&
    !isMissingSessionHttpStatus(nextStatus)
  ) {
    return currentStatus;
  }
  return nextStatus;
}
