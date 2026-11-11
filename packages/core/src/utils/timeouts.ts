/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function normalizePositiveTimeoutMs(
  value: unknown,
  options: { roundUp?: boolean } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return options.roundUp ? Math.max(1, Math.ceil(value)) : value;
}
