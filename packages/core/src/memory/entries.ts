/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ManagedAutoMemoryEntry {
  summary: string;
  why?: string;
  howToApply?: string;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Returns the `# Heading` line from a body, or a default.
 * Used when reading old-format multi-entry topic files.
 */
export function getAutoMemoryBodyHeading(body: string): string {
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('# ')) ?? '# Memory'
  );
}

/**
 * Parses memory entries from a body string.
 *
 * Supports two formats:
 *
 * **New (per-entry file) format** — the body starts with the plain-text summary,
 * followed by optional top-level `Why:` / `How to apply:` lines:
 * ```
 * Use short responses when debugging
 *
 * Why: The user prefers brevity in debug sessions.
 * How to apply: Keep replies to 3 sentences max.
 * ```
 *
 * **Legacy (multi-entry topic file) format** — each entry begins with a `- bullet`
 * prefix; nested fields use 2-space indent:
 * ```
 * # Feedback Memory
 *
 * - Use short responses when debugging
 *   - Why: The user prefers brevity in debug sessions.
 * - Always use TypeScript strict mode
 *   - Why: Catches bugs early.
 * ```
 */
export function parseAutoMemoryEntries(body: string): ManagedAutoMemoryEntry[] {
  const entries: ManagedAutoMemoryEntry[] = [];
  let current: ManagedAutoMemoryEntry | null = null;

  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === '_No entries yet._' || trimmed.startsWith('# ')) {
      continue;
    }

    // Indented nested field — legacy format: `  - Why: ...` or `  Why: ...`
    if (current) {
      const indentedMatch = rawLine.match(
        /^\s{2,}(?:[-*]\s+)?(Why|How to apply|How_to_apply):\s*(.+)$/i,
      );
      if (indentedMatch) {
        const [, rawKey, rawValue] = indentedMatch;
        const value = normalizeText(rawValue);
        if (value) {
          switch (rawKey.toLowerCase()) {
            case 'why':
              current.why = value;
              break;
            case 'how to apply':
            case 'how_to_apply':
              current.howToApply = value;
              break;
          }
        }
        continue;
      }
    }

    // Top-level named field — new format: `Why: ...` or `**How to apply**: ...`
    const topLevelMatch = trimmed.match(
      /^(?:\*\*)?(Why|How to apply|How_to_apply)(?:\*\*)?:\s*(.+)$/i,
    );
    if (topLevelMatch) {
      const [, rawKey, rawValue] = topLevelMatch;
      const value = normalizeText(rawValue);
      if (value && current) {
        switch (rawKey.toLowerCase()) {
          case 'why':
            current.why = value;
            break;
          case 'how to apply':
          case 'how_to_apply':
            current.howToApply = value;
            break;
        }
      }
      continue;
    }

    // Bullet prefix — legacy format: `- Summary text`
    if (/^[-*]\s+/.test(trimmed)) {
      if (current) {
        entries.push(current);
      }
      current = {
        summary: normalizeText(trimmed.replace(/^[-*]\s+/, '')),
      };
      continue;
    }

    // Plain text — new per-entry format: first non-special line is the summary
    if (!current) {
      current = { summary: normalizeText(trimmed) };
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

export function renderAutoMemoryBody(
  _heading: string,
  entries: ManagedAutoMemoryEntry[],
): string {
  if (entries.length === 0) {
    return '_No entries yet._';
  }

  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(normalizeText(entry.summary));
    if (entry.why) {
      lines.push('', `Why: ${normalizeText(entry.why)}`);
    }
    if (entry.howToApply) {
      lines.push('', `How to apply: ${normalizeText(entry.howToApply)}`);
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
  };
}

export function buildAutoMemoryEntrySearchText(
  entry: ManagedAutoMemoryEntry,
): string {
  return [entry.summary, entry.why, entry.howToApply]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}