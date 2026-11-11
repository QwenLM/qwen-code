/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parse the standard Retry-After header into milliseconds.
 * Supports both RFC delta-seconds and HTTP-date forms.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds)
      ? milliseconds
      : undefined;
  }

  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return undefined;
  return Math.max(0, retryAtMs - nowMs);
}

export function readRetryAfterHeaderMs(
  headers: Headers,
  nowMs = Date.now(),
): number | undefined {
  return parseRetryAfterMs(headers.get('retry-after'), nowMs);
}
