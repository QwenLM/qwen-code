/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutoMemoryScope } from './types.js';
import {
  normalizeAutoMemoryKeyword,
  type ScannedAutoMemoryDocument,
} from './scan.js';

const DEFAULT_MAX_CHARS = 8_000;
const HIGH_FREQUENCY_BUDGET_RATIO = 0.7;

const SCOPE_ORDER: readonly AutoMemoryScope[] = ['project', 'user', 'team'];

interface KeywordStats {
  value: string;
  normalized: string;
  documentFrequency: number;
  recencyMs: number;
}

interface WriterKeywordVocabularyOptions {
  scopes?: readonly AutoMemoryScope[];
  maxChars?: number;
}

function isReusableKeyword(keyword: string): boolean {
  const normalized = keyword.trim();
  if (!normalized) return false;
  if (/https?:\/\//i.test(normalized)) return false;
  if (/[\\/]/.test(normalized)) return false;
  if (/(?:^|\b)(?:issue|pr|pull request)\s*#?\d+\b/i.test(normalized)) {
    return false;
  }
  if (/^#\d+$/.test(normalized)) return false;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(normalized)) return false;
  if (/[().]|::/.test(normalized)) return false;
  if (/\.[a-z0-9]{1,8}$/i.test(normalized)) return false;
  return true;
}

function collectKeywordStats(
  docs: readonly ScannedAutoMemoryDocument[],
): KeywordStats[] {
  const stats = new Map<string, KeywordStats>();

  for (const doc of docs) {
    const seenInDoc = new Set<string>();
    for (const rawKeyword of doc.keywords) {
      const keyword = normalizeAutoMemoryKeyword(rawKeyword);
      const normalized = keyword.toLocaleLowerCase('en-US');
      if (!isReusableKeyword(keyword) || seenInDoc.has(normalized)) {
        continue;
      }
      seenInDoc.add(normalized);
      const existing = stats.get(normalized);
      if (existing) {
        existing.documentFrequency += 1;
        existing.recencyMs = Math.max(existing.recencyMs, doc.mtimeMs);
      } else {
        stats.set(normalized, {
          value: keyword,
          normalized,
          documentFrequency: 1,
          recencyMs: doc.mtimeMs,
        });
      }
    }
  }

  return [...stats.values()];
}

function sortHighFrequency(a: KeywordStats, b: KeywordStats): number {
  return (
    b.documentFrequency - a.documentFrequency ||
    b.recencyMs - a.recencyMs ||
    a.normalized.localeCompare(b.normalized)
  );
}

function sortRecentLowFrequency(a: KeywordStats, b: KeywordStats): number {
  return b.recencyMs - a.recencyMs || a.normalized.localeCompare(b.normalized);
}

function takeWithinBudget(
  candidates: readonly KeywordStats[],
  maxChars: number,
  used: Set<string>,
): KeywordStats[] {
  const selected: KeywordStats[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (used.has(candidate.normalized)) continue;
    const rendered = `${candidate.value} (${candidate.documentFrequency})`;
    const nextChars = chars + rendered.length + (selected.length > 0 ? 2 : 0);
    if (nextChars > maxChars) break;
    selected.push(candidate);
    used.add(candidate.normalized);
    chars = nextChars;
  }
  return selected;
}

function renderKeywords(keywords: readonly KeywordStats[]): string {
  return keywords
    .map((keyword) => `${keyword.value} (${keyword.documentFrequency})`)
    .join(', ');
}

export function renderWriterKeywordVocabularySnapshot(
  docs: readonly ScannedAutoMemoryDocument[],
  options: WriterKeywordVocabularyOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const requestedScopes = options.scopes ?? SCOPE_ORDER;
  const scopes = SCOPE_ORDER.filter((scope) => requestedScopes.includes(scope));
  const lines = [
    '## Existing keyword vocabulary',
    '',
    'Prefer reusing these canonical retrieval terms or short phrases when they match the memory meaning. Create a new discriminative term or phrase when none fits.',
  ];

  for (const scope of scopes) {
    const scopeDocs = docs.filter((doc) => doc.scope === scope);
    if (scopeDocs.length === 0) continue;
    const stats = collectKeywordStats(scopeDocs);
    if (stats.length === 0) continue;

    const highBudget = Math.floor(maxChars * HIGH_FREQUENCY_BUDGET_RATIO);
    const lowBudget = maxChars - highBudget;
    const used = new Set<string>();
    const high = takeWithinBudget(
      stats
        .filter((keyword) => keyword.documentFrequency >= 2)
        .sort(sortHighFrequency),
      highBudget,
      used,
    );
    const low = takeWithinBudget(
      stats
        .filter((keyword) => keyword.documentFrequency <= 2)
        .sort(sortRecentLowFrequency),
      lowBudget,
      used,
    );

    lines.push('', `${scope} scope:`);
    if (high.length > 0) {
      lines.push(`stable: ${renderKeywords(high)}`);
    }
    if (low.length > 0) {
      lines.push(`recent: ${renderKeywords(low)}`);
    }
    const omitted = stats.length - high.length - low.length;
    if (omitted > 0) {
      lines.push(`omitted: ${omitted} keywords due to budget`);
    }
  }

  const rendered = lines.join('\n').trim();
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, maxChars).trimEnd()}\n\n> WARNING: Keyword vocabulary snapshot was truncated.`;
}
