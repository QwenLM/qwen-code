/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deterministic per-task jitter to spread firing times and prevent
 * thundering-herd effects when many loops share the same interval.
 */

/** Maximum jitter as a fraction of the interval (10%). */
const JITTER_FRACTION = 0.1;

/** Hard cap on jitter regardless of interval (30 seconds). */
const JITTER_CAP_MS = 30_000;

/**
 * FNV-1a 32-bit hash — fast, good distribution, deterministic.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // ensure unsigned
}

/**
 * Compute a deterministic jitter offset for a loop task.
 *
 * The jitter is derived from the loop ID so it is stable across restarts.
 * It is proportional to the interval, capped at JITTER_CAP_MS.
 *
 * @returns jitter in milliseconds (always >= 0)
 */
export function computeJitter(loopId: string, intervalMs: number): number {
  const frac = fnv1a(loopId) / 0x100000000; // [0, 1)
  const maxJitter = Math.min(intervalMs * JITTER_FRACTION, JITTER_CAP_MS);
  return Math.round(frac * maxJitter);
}
