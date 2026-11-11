/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Staleness helpers for auto-memory files.
 *
 * Models are poor at date arithmetic — a raw ISO timestamp doesn't trigger
 * staleness reasoning the way "47 days ago" does. When an old memory file is
 * surfaced (e.g. via the Read tool), wrapping its content with a human-readable
 * age note prompts the model to verify against current code rather than
 * asserting the memory as fact.
 */

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday,
 * 2+ for older. Negative inputs (future mtime, clock skew) clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns '' for fresh
 * (today/yesterday) memories — a warning there is noise.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return '';
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}

/**
 * Per-memory staleness note wrapped in <system-reminder> tags, with a trailing
 * newline so callers can concatenate directly with file content. Returns ''
 * for memories ≤1 day old.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return '';
  return `<system-reminder>${text}</system-reminder>\n`;
}
