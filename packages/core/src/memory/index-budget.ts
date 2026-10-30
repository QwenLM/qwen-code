/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_INDEX_LINE_CHARS = 150;
// Floor for the title after it is budgeted against the link. The title yields
// to MAX_INDEX_LINE_CHARS whenever the path leaves room, but a path long enough
// to starve the title is kept whole (a resolving long link beats a short dead
// one), so the title is clamped here instead of collapsing to nothing.
export const MIN_INDEX_TITLE_CHARS = 24;
export const MAX_INDEX_LINES = 200;
// Keep the existing UTF-16 code-unit budget; the warning is appended separately.
export const MAX_INDEX_CHARS = 25_000;
export const INDEX_TRUNCATION_WARNING =
  '> WARNING: MEMORY.md is too large; only part of it was written. Keep index entries concise and move detail into topic files.';
export const INDEX_TRUNCATION_NOTICE = `\n\n${INDEX_TRUNCATION_WARNING}`;

export interface IndexTrimResult {
  /** Surviving entries, in index order. */
  content: string;
  /** Entries removed by the line cap or the character budget, in index order. */
  dropped: readonly string[];
}

export function trimIndexToBudgetDetailed(
  lines: readonly string[],
  priorityPrefixLength = 0,
): IndexTrimResult {
  const entries = lines.slice(0, MAX_INDEX_LINES);
  const overLineCap = lines.slice(MAX_INDEX_LINES);
  const raw = entries.join('\n');
  if (raw.length <= MAX_INDEX_CHARS) {
    return { content: raw, dropped: overLineCap };
  }

  // Reserve space for ordinary entries before long links, then restore order.
  const kept = new Set<number>();
  let size = 0;
  // Imported user entries may use spare capacity, but must not displace
  // native entries, including long links the ordinary pass reserves last.
  const boundary = Math.min(priorityPrefixLength, entries.length);
  for (const [start, end] of [
    [0, boundary],
    [boundary, entries.length],
  ]) {
    for (const limit of [MAX_INDEX_LINE_CHARS, MAX_INDEX_CHARS]) {
      for (let index = start; index < end; index++) {
        const line = entries[index];
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
  }
  const surviving: string[] = [];
  const dropped: string[] = [];
  for (const [index, line] of entries.entries()) {
    (kept.has(index) ? surviving : dropped).push(line);
  }
  return {
    content: surviving.join('\n'),
    dropped: [...dropped, ...overLineCap],
  };
}

export function trimIndexToBudget(
  lines: readonly string[],
  priorityPrefixLength = 0,
): string {
  return trimIndexToBudgetDetailed(lines, priorityPrefixLength).content;
}
