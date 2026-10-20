/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_INDEX_LINE_CHARS = 150;
export const MAX_INDEX_LINES = 200;
// Keep the existing UTF-16 code-unit budget; the warning is appended separately.
export const MAX_INDEX_CHARS = 25_000;
export const INDEX_TRUNCATION_NOTICE_START =
  '\n\n> WARNING: MEMORY.md is too large; only part of it was written.';
export const INDEX_TRUNCATION_WARNING =
  '> WARNING: MEMORY.md is too large; only part of it was written. Keep index entries concise and move detail into topic files.';
export const INDEX_TRUNCATION_NOTICE = `\n\n${INDEX_TRUNCATION_WARNING}`;

const MAX_NAMED_DROPPED_ENTRIES = 3;
const MAX_DROPPED_ENTRY_NAME_CHARS = 60;
const INDEX_ENTRY_TITLE = /^\s*-\s*\[([^\]]+)\]/;

function droppedEntryName(line: string): string {
  const title = INDEX_ENTRY_TITLE.exec(line)?.[1]?.trim();
  const text = title || line.trim();
  if (text.length <= MAX_DROPPED_ENTRY_NAME_CHARS) {
    return text;
  }
  let head = text.slice(0, MAX_DROPPED_ENTRY_NAME_CHARS - 1);
  // Do not split an astral character at the diagnostic's name limit.
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}…`;
}

export function describeDroppedIndexEntries(
  dropped: readonly string[],
  total: number,
  unit: 'entries' | 'topic files' = 'entries',
): string {
  const removed = dropped.filter((line) => line.trim().length > 0);
  if (removed.length === 0) {
    return '';
  }
  const names = removed
    .slice(0, MAX_NAMED_DROPPED_ENTRIES)
    .map((line) => `"${droppedEntryName(line)}"`)
    .join(', ');
  const rest = removed.length - MAX_NAMED_DROPPED_ENTRIES;
  return ` Dropped ${removed.length} of ${total} ${unit}: ${names}${
    rest > 0 ? `, +${rest} more` : ''
  }.`;
}

export interface IndexTrimResult {
  /** Surviving entries, in index order. */
  content: string;
  /** Entries removed by the line cap or the character budget, in index order. */
  dropped: readonly string[];
}

export function trimIndexToBudgetDetailed(
  lines: readonly string[],
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

export function trimIndexToBudget(lines: readonly string[]): string {
  return trimIndexToBudgetDetailed(lines).content;
}
