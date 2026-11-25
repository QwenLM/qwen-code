/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helper to coerce comma-separated or multiple flag values into a flat array.
 */
export const coerceCommaSeparated = (values: string[]): string[] => {
  if (values.length === 1 && values[0] === '') {
    return [''];
  }
  return values.flatMap((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
};

/**
 * Commander returns `true` for flags declared with optional `[value]` when no
 * value is given. Normalize to `''` so callers can detect "flag present" with
 * `!== undefined`, and trim strings.
 */
export const coerceOptionalStringFlag = (
  value: unknown,
): string | undefined => {
  if (value === true) return '';
  if (typeof value === 'string') return value.trim();
  return undefined;
};
