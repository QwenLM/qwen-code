/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default model output limit when no valid positive value is available. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** Preserve a positive safe-integer limit; otherwise use the shared default. */
export function resolveMaxOutputTokens(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OUTPUT_TOKENS;
}
