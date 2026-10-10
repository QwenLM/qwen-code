/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_INDEX_LINE_CHARS = 150;
export const MAX_INDEX_LINES = 200;
// Keep the existing UTF-16 code-unit budget; the warning is appended separately.
export const MAX_INDEX_CHARS = 25_000;
export const INDEX_TRUNCATION_WARNING =
  '> WARNING: MEMORY.md is too large; only part of it was written. Keep index entries concise and move detail into topic files.';
export const INDEX_TRUNCATION_NOTICE = `\n\n${INDEX_TRUNCATION_WARNING}`;

export function trimIndexToBudget(lines: readonly string[]): string {
  const entries = lines.slice(0, MAX_INDEX_LINES);
  const raw = entries.join('\n');
  if (raw.length <= MAX_INDEX_CHARS) {
    return raw;
  }

  // Reserve space for ordinary entries before long links, then restore order.
  const kept = new Set<number>();
  let size = 0;
  for (const limit of [MAX_INDEX_LINE_CHARS, MAX_INDEX_CHARS]) {
    for (const [index, line] of entries.entries()) {
      if (kept.has(index) || line.length > limit) {
        continue;
      }
      const next = size + (kept.size > 0 ? 1 : 0) + line.length;
      if (next > MAX_INDEX_CHARS) {
        continue;
      }
      size = next;
      kept.add(index);
    }
  }
  return entries.filter((_, index) => kept.has(index)).join('\n');
}
