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
export const INDEX_SCAN_CAP_NOTICE_START =
  '\n\n> WARNING: MEMORY.md does not list every topic file.';
export const INDEX_TRUNCATION_WARNING = `${INDEX_TRUNCATION_NOTICE_START.trimStart()} Keep index entries concise and move detail into topic files.`;
export const INDEX_TRUNCATION_NOTICE = `\n\n${INDEX_TRUNCATION_WARNING}`;

export const MAX_NAMED_DROPPED_ENTRIES = 3;
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

/** `droppedCount` includes omissions beyond a caller's preformatted sample. */
export function describeDroppedIndexEntries(
  dropped: readonly string[],
  total: number,
  unit: 'entries' | 'topic files' = 'entries',
  droppedCount?: number,
): string {
  const removed = dropped.filter((line) => line.trim().length > 0);
  if (removed.length === 0) {
    return '';
  }
  const names = removed
    .slice(0, MAX_NAMED_DROPPED_ENTRIES)
    .map((line) => `"${droppedEntryName(line)}"`)
    .join(', ');
  const count = droppedCount ?? removed.length;
  const rest = count - Math.min(removed.length, MAX_NAMED_DROPPED_ENTRIES);
  return ` Dropped ${count} of ${total} ${unit}: ${names}${
    rest > 0 ? `, +${rest} more` : ''
  }.`;
}

export const INDEX_HOOK_SEPARATOR = ' — ';
export const INDEX_ALSO_OPEN = ' (also: ';

interface IndexEntry {
  link: string;
  description: string | undefined;
  suffix: string;
}

export function formatIndexEntry({
  link,
  description,
  suffix,
}: IndexEntry): string {
  return `${link}${description === undefined ? '' : `${INDEX_HOOK_SEPARATOR}${description}`}${suffix}`;
}

export function parseIndexEntry(line: string): IndexEntry | undefined {
  const trimmed = line.trimEnd();
  const link = /^-\s+\[(?:(?!\]\().)+\]\([^()\s]+\)/.exec(trimmed)?.[0];
  if (!link) {
    return undefined;
  }
  const rest = trimmed.slice(link.length);
  const suffix =
    / \(also: [^()\s,]+\.md(?:, [^()\s,]+\.md)*\)[.!?]*$/i.exec(rest)?.[0] ??
    '';
  const hook = rest.slice(0, rest.length - suffix.length);
  if (hook.includes(INDEX_ALSO_OPEN)) {
    return undefined;
  }
  if (hook === '') {
    return { link, description: undefined, suffix };
  }
  if (hook === INDEX_HOOK_SEPARATOR.trimEnd()) {
    return { link, description: '', suffix };
  }
  if (!hook.startsWith(INDEX_HOOK_SEPARATOR)) {
    return undefined;
  }
  return { link, description: hook.slice(INDEX_HOOK_SEPARATOR.length), suffix };
}

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
