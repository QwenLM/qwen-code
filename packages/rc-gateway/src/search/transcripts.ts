/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseQuery, matchesQuery } from './query.js';

/**
 * A search result set plus whether more matches existed than were returned.
 * `truncated` is true when the full match count exceeded the (clamped) limit, so
 * `hits` is a recency-sorted prefix.
 */
export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

/**
 * UTF-8 byte offset pair for a highlight range within `snippet`.
 * `start` is inclusive, `end` is exclusive (like Buffer.slice semantics).
 * NO HTML markup is emitted — clients apply styling from these offsets.
 */
export interface HighlightRange {
  start: number;
  end: number;
}

/** One search result: a matched transcript record. */
export interface SearchHit {
  sessionId: string;
  /** The record uuid. */
  eventId: string;
  /** The record type (e.g. 'user' | 'assistant' | 'tool_result'). */
  kind: string;
  /** ISO timestamp of the record. */
  ts: string;
  /** A single-line snippet (<=200 chars) centered on the first matched term. */
  snippet: string;
  /**
   * UTF-8 byte offsets of matched terms in `snippet`. Empty when the scanner
   * mode can't cheaply produce them (the scan already reports them via the
   * plan's seed; the BM25 ranked path will populate these).
   */
  highlights?: HighlightRange[];
}

export interface SearchOptions {
  /** One of {user,assistant,tool,all}; 'tool' maps to record type tool_result. */
  kind?: string;
  /** Restrict to a single session. */
  sessionId?: string;
  /**
   * When present, restrict hits to the fork lineage of the given session id.
   * Computed in-process by the search handler; the scanner ignores it (lineage
   * filtering requires session records unavailable to the transcript scanner).
   */
  lineage?: string;
  /**
   * Explicit visible-session set for non-owner callers (permission filtering).
   * `undefined` = owner scope = no restriction applied.
   * An empty Set = caller can see nothing = 0 hits.
   */
  visibleSessionIds?: ReadonlySet<string>;
  /** Max hits (default 50, clamped to 1..200). */
  limit?: number;
  /**
   * Inclusive lower/upper time bounds (epoch ms) on a record's `timestamp`.
   * When either is set, a record whose `timestamp` is missing/unparseable or
   * falls outside the bound is skipped. Absent → no time filter (byte-identical
   * to before). The route parses ISO-8601 `?since`/`?until` into these.
   */
  since?: number;
  until?: number;
  /**
   * Per-query scan-time budget in ms. When set (finite and > 0), the scan
   * throws {@link SearchTimeoutError} once the wall clock passes the deadline.
   * Absent / non-finite / ≤ 0 → NO deadline (the scan never throws on time —
   * the default for every pre-cycle-34 caller). The route supplies 2000.
   */
  timeoutMs?: number;
  /** Injectable clock (ms epoch), default `Date.now` — lets tests drive the deadline. */
  now?: () => number;
}

/**
 * Thrown by {@link searchTranscripts} ONLY when an opted-in `timeoutMs` budget
 * is exceeded mid-scan. The search route maps it to `503 search_timeout`. It is
 * a deliberate control-flow signal — the scanner still swallows all I/O/parse
 * errors and never throws those.
 */
export class SearchTimeoutError extends Error {
  constructor() {
    super('search scan exceeded its time budget');
    this.name = 'SearchTimeoutError';
  }
}

/**
 * Maps the route-facing kind enum to the on-disk record type. Exported so the
 * BM25 index (`./searchIndex.ts`) maps `kind` IDENTICALLY to this live scanner.
 */
export const KIND_MAP: Record<string, string> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool_result',
};

/** Shape of a single JSONL transcript record (only the fields we read). */
export interface TranscriptRecord {
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  message?: {
    parts?: Array<{ text?: unknown; functionResponse?: unknown } | null>;
  };
}

/**
 * Recursively collect string leaves from an arbitrary JSON value, bounded so a
 * giant tool payload can't blow up memory. Used to make `tool_result` content
 * searchable — those records carry their output under `functionResponse`, NOT
 * `parts[].text`, so a naive text-only read leaves tool output unsearchable.
 */
function collectStrings(value: unknown, out: string[], budget = 200): void {
  if (out.length >= budget) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, budget);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, budget);
  }
}

const SNIPPET_MAX = 200;

// The on-disk chats dir for a workspace cwd is derived by `resolveChatsDir` in
// `../sessions/chatsPath.ts` (the exact, daemon-byte-identical resolver, proven
// against the real daemon by the fork e2e). `searchTranscripts` below takes the
// already-resolved dir; it never derives a path itself.

/**
 * Concatenated searchable text of a record's message parts. Exported so the
 * BM25 index (`./searchIndex.ts`) indexes the EXACT text this scanner searches
 * — the two then differ only by token-vs-substring matching and ranking, never
 * by which content is searchable.
 */
export function recordText(rec: TranscriptRecord): string {
  const parts = rec.message?.parts ?? [];
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p.text === 'string') out.push(p.text);
    // tool_result parts carry their output under functionResponse, not text.
    if (p.functionResponse !== undefined)
      collectStrings(p.functionResponse, out);
  }
  return out.join(' ');
}

/**
 * A single-line snippet centered on the first matched term. Collapses
 * whitespace, takes a ~160-char window around the term, adds leading/trailing
 * ellipses when truncated, and hard-caps the result at 200 chars (the cap is
 * applied LAST so the ellipses can never push it over).
 */
function snippet(text: string, term: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const idx = collapsed.toLowerCase().indexOf(term);
  if (idx < 0) {
    return collapsed.slice(0, SNIPPET_MAX);
  }
  const start = Math.max(0, idx - 70);
  const end = Math.min(collapsed.length, start + 160);
  let out = collapsed.slice(start, end);
  if (start > 0) out = '…' + out;
  if (end < collapsed.length) out = out + '…';
  return out.slice(0, SNIPPET_MAX);
}

/**
 * Scan the on-disk JSONL transcripts under `chatsDir` for records whose
 * searchable text satisfies the compiled query (phrase quoting, boolean
 * `OR`/`NOT`, and `term*` prefix wildcard — see `./query.ts`; a plain
 * space-separated query is a case-insensitive AND of substrings). Returns
 * recency-sorted hits (newest first). Never throws on I/O/parse errors: a
 * missing dir, an unreadable file, or a corrupt JSONL line is treated as
 * empty/skipped. The ONLY throw is {@link SearchTimeoutError}, and only when an
 * opted-in `opts.timeoutMs` budget is exceeded (the deadline bounds scan/match
 * work, not a single file's `readFile`).
 *
 * Returns the recency-sorted hit prefix together with `truncated` (true when the
 * full match count exceeded the clamped limit). {@link searchTranscripts} is the
 * thin `SearchHit[]`-returning delegate kept for every pre-cycle-37 caller.
 */
export async function searchTranscriptsDetailed(
  chatsDir: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const plan = parseQuery(query);
  if (plan.node === null) return { hits: [], truncated: false };

  const wantType =
    opts.kind && opts.kind !== 'all' ? KIND_MAP[opts.kind] : undefined;

  // Scan deadline (cycle 34): active only when timeoutMs is finite and > 0, so
  // a caller that doesn't opt in (every pre-cycle-34 caller) never throws and
  // the clock is never read. The check fires at each file boundary and every
  // 1024 scanned lines (bounds a single large file's inner loop too).
  const clock = opts.now ?? Date.now;
  const hasDeadline =
    typeof opts.timeoutMs === 'number' &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0;
  const deadline = hasDeadline ? clock() + (opts.timeoutMs as number) : 0;
  let scanned = 0;

  let files: string[];
  try {
    files = await readdir(chatsDir);
  } catch {
    // missing dir (ENOENT) or unreadable → no results.
    return { hits: [], truncated: false };
  }

  const hits: SearchHit[] = [];
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    if (hasDeadline && clock() > deadline) throw new SearchTimeoutError();
    let text: string;
    try {
      text = await readFile(join(chatsDir, name), 'utf8');
    } catch {
      continue; // unreadable file → skip.
    }
    for (const line of text.split('\n')) {
      if (hasDeadline && (++scanned & 1023) === 0 && clock() > deadline)
        throw new SearchTimeoutError();
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: TranscriptRecord;
      try {
        rec = JSON.parse(trimmed) as TranscriptRecord;
      } catch {
        continue; // corrupt / non-JSON line → skip.
      }
      if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
      if (wantType !== undefined && rec.type !== wantType) continue;
      // Inclusive time-range filter (cycle 79). A record without a usable
      // timestamp cannot be placed in the range, so it is excluded when a bound
      // is active. With no bound this block is skipped (byte-identical to before).
      if (opts.since !== undefined || opts.until !== undefined) {
        const t = Date.parse(rec.timestamp ?? '');
        if (Number.isNaN(t)) continue;
        if (opts.since !== undefined && t < opts.since) continue;
        if (opts.until !== undefined && t > opts.until) continue;
      }

      const recText = recordText(rec);
      const hay = recText.toLowerCase();
      if (!matchesQuery(plan, hay)) continue;

      hits.push({
        sessionId: rec.sessionId ?? '',
        eventId: rec.uuid ?? '',
        kind: rec.type ?? '',
        ts: rec.timestamp ?? '',
        snippet: snippet(recText, plan.seed),
      });
    }
  }

  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  // `truncated` compares the FULL match count against the clamped limit, so the
  // caller learns the result set was capped (not whether the scan timed out —
  // that is the separate SearchTimeoutError → 503 path).
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}

/**
 * Recency-sorted hits for a query — the thin, back-compat delegate over
 * {@link searchTranscriptsDetailed}. Returns only `SearchHit[]` and preserves
 * the exact signature, return shape, and `SearchTimeoutError` propagation every
 * pre-cycle-37 caller relies on.
 */
export async function searchTranscripts(
  chatsDir: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  return (await searchTranscriptsDetailed(chatsDir, query, opts)).hits;
}
