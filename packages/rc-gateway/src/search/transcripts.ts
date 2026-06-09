/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
}

export interface SearchOptions {
  /** One of {user,assistant,tool,all}; 'tool' maps to record type tool_result. */
  kind?: string;
  /** Restrict to a single session. */
  sessionId?: string;
  /** Max hits (default 50, clamped to 1..200). */
  limit?: number;
}

/** Maps the route-facing kind enum to the on-disk record type. */
const KIND_MAP: Record<string, string> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool_result',
};

/** Shape of a single JSONL transcript record (only the fields we read). */
interface TranscriptRecord {
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

/**
 * The on-disk chats dir for a workspace cwd. The daemon encodes the whole cwd
 * into ONE directory segment by replacing every '/' and '.' with '-'. This is
 * the ONLY place a filesystem path is derived, and only from the trusted
 * daemon-reported workspaceCwd (never from user query input).
 */
export function resolveChatsDir(workspaceCwd: string): string {
  return join(
    homedir(),
    '.qwen',
    'projects',
    workspaceCwd.replace(/[/.]/g, '-'),
    'chats',
  );
}

/** Concatenated searchable text of a record's message parts. */
function recordText(rec: TranscriptRecord): string {
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
 * searchable text contains EVERY whitespace-separated term (case-insensitive
 * AND). Returns recency-sorted hits (newest first). Never throws: a missing
 * dir, an unreadable file, or a corrupt JSONL line is treated as empty/skipped.
 */
export async function searchTranscripts(
  chatsDir: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const wantType =
    opts.kind && opts.kind !== 'all' ? KIND_MAP[opts.kind] : undefined;

  let files: string[];
  try {
    files = await readdir(chatsDir);
  } catch {
    return []; // missing dir (ENOENT) or unreadable → no results.
  }

  const hits: SearchHit[] = [];
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    let text: string;
    try {
      text = await readFile(join(chatsDir, name), 'utf8');
    } catch {
      continue; // unreadable file → skip.
    }
    for (const line of text.split('\n')) {
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

      const recText = recordText(rec);
      const hay = recText.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;

      hits.push({
        sessionId: rec.sessionId ?? '',
        eventId: rec.uuid ?? '',
        kind: rec.type ?? '',
        ts: rec.timestamp ?? '',
        snippet: snippet(recText, terms[0]),
      });
    }
  }

  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  return hits.slice(0, limit);
}
