/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

const DAY_MS = 86_400_000;

/**
 * Format a timestamp as a human-readable age string.
 */
export function formatAge(mtimeMs: number): string {
  const ageMs = Date.now() - mtimeMs;
  const days = Math.floor(ageMs / DAY_MS);

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return '1 week ago';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return '1 month ago';
  return `${Math.floor(days / 30)} months ago`;
}

/**
 * Check if a memory is stale (older than threshold).
 */
export function isStale(mtimeMs: number, thresholdDays = 30): boolean {
  return Date.now() - mtimeMs > thresholdDays * DAY_MS;
}

/**
 * Get a staleness warning for old memories. Returns null for fresh ones.
 */
export function getStaleWarning(mtimeMs: number): string | null {
  if (!isStale(mtimeMs)) return null;
  return `(${formatAge(mtimeMs)} — may be outdated, verify before acting)`;
}
