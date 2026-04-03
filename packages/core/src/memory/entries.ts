/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ManagedAutoMemoryEntryStability = 'stable' | 'working';

export interface ManagedAutoMemoryEntry {
  summary: string;
  why?: string;
  howToApply?: string;
  stability?: ManagedAutoMemoryEntryStability;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function getAutoMemoryBodyHeading(body: string): string {
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('# ')) ?? '# Memory'
  );
}

export function parseAutoMemoryEntries(body: string): ManagedAutoMemoryEntry[] {
  const entries: ManagedAutoMemoryEntry[] = [];
  let current: ManagedAutoMemoryEntry | null = null;

  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === '_No entries yet._' || trimmed.startsWith('# ')) {
      continue;
    }

    if (current) {
      const nestedMatch = rawLine.match(
        /^\s{2,}(?:[-*]\s+)?(Why|How to apply|How_to_apply|Stability):\s*(.+)$/i,
      );
      if (nestedMatch) {
        const [, rawKey, rawValue] = nestedMatch;
        const value = normalizeText(rawValue);
        if (!value) {
          continue;
        }

        switch (rawKey.toLowerCase()) {
          case 'why':
            current.why = value;
            break;
          case 'how to apply':
          case 'how_to_apply':
            current.howToApply = value;
            break;
          case 'stability':
            current.stability =
              value.toLowerCase() === 'stable' ? 'stable' : 'working';
            break;
        }
        continue;
      }
    }

    if (/^[-*]\s+/.test(trimmed)) {
      if (current) {
        entries.push(current);
      }
      current = {
        summary: normalizeText(trimmed.replace(/^[-*]\s+/, '')),
      };
      continue;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries.filter((entry) => entry.summary.length > 0);
}

export function renderAutoMemoryBody(
  heading: string,
  entries: ManagedAutoMemoryEntry[],
): string {
  const normalizedHeading = heading.trim().startsWith('# ')
    ? heading.trim()
    : '# Memory';

  if (entries.length === 0) {
    return [normalizedHeading, '', '_No entries yet._'].join('\n');
  }

  const lines = [normalizedHeading, ''];
  for (const entry of entries) {
    lines.push(`- ${normalizeText(entry.summary)}`);
    if (entry.why) {
      lines.push(`  - Why: ${normalizeText(entry.why)}`);
    }
    if (entry.howToApply) {
      lines.push(`  - How to apply: ${normalizeText(entry.howToApply)}`);
    }
    if (entry.stability) {
      lines.push(`  - Stability: ${entry.stability}`);
    }
  }

  return lines.join('\n');
}

export function mergeAutoMemoryEntry(
  current: ManagedAutoMemoryEntry,
  incoming: ManagedAutoMemoryEntry,
): ManagedAutoMemoryEntry {
  return {
    summary: incoming.summary || current.summary,
    why: current.why ?? incoming.why,
    howToApply: current.howToApply ?? incoming.howToApply,
    stability:
      current.stability === 'stable' || incoming.stability === 'stable'
        ? 'stable'
        : (current.stability ?? incoming.stability),
  };
}

export function buildAutoMemoryEntrySearchText(
  entry: ManagedAutoMemoryEntry,
): string {
  return [entry.summary, entry.why, entry.howToApply, entry.stability]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}