/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * General string utility functions.
 */

/**
 * Counts occurrences of `char` in `str` using indexOf jumps instead of
 * per-character iteration. Structurally typed so Buffer works too
 * (Buffer.indexOf accepts string needles).
 */
export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function countCharInString(
  str: { indexOf(search: string, start?: number): number },
  char: string,
  start = 0,
): number {
  let count = 0;
  let i = str.indexOf(char, start);
  while (i !== -1) {
    count++;
    i = str.indexOf(char, i + 1);
  }
  return count;
}
