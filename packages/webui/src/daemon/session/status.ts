/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isMissingSessionHttpStatus(
  status: number | undefined,
): boolean {
  return status === 404 || status === 410;
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
  return (
    nextStatus ??
    (isMissingSessionHttpStatus(currentStatus) ? currentStatus : undefined)
  );
}
