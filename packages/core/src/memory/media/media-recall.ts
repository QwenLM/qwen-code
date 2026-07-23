/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { MediaMemory, StoredMediaRecord } from './media-memory-store.js';

/**
 * P2/P4 · Media recall — the low-cost fast path.
 *
 * Recall is A-class (the interface). The scoring heuristic is B-class. v1 scores
 * by keyword overlap between the query and each record's summary/body, optionally
 * restricted to files in play in the current turn (`contextFiles`). Recall is a
 * cheap hint; the original bytes remain the source of truth (回原件是真相来源).
 */

export interface MediaRecallHit {
  record: StoredMediaRecord;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function scoreRecord(record: StoredMediaRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(`${record.summary} ${record.body}`));
  let hits = 0;
  for (const q of queryTokens) {
    if (haystack.has(q)) hits += 1;
  }
  return hits / queryTokens.length;
}

/**
 * Recall understandings relevant to `query`. When `contextFiles` is provided,
 * records whose source path matches one of them are always included (they are
 * "in play") and get a relevance boost.
 */
export async function recallMedia(
  memory: MediaMemory,
  query: string,
  options: { contextFiles?: string[]; limit?: number } = {},
): Promise<MediaRecallHit[]> {
  const records = await memory.list();
  const queryTokens = tokenize(query);
  const contextSet = new Set(
    (options.contextFiles ?? []).map((f) => path.resolve(f)),
  );

  const hits: MediaRecallHit[] = records.map((record) => {
    const inPlay = record.path && contextSet.has(path.resolve(record.path));
    const base = scoreRecord(record, queryTokens);
    return { record, score: inPlay ? base + 1 : base };
  });

  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);
}
