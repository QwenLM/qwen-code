/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  KIND_MAP,
  recordText,
  type TranscriptRecord,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from './transcripts.js';

// NOTE ON ISOLATION: this is the ONLY module that imports the NATIVE
// `better-sqlite3`. It is imported solely from the `reindex` / `search --rank`
// CLI branches — never from the barrel (`index.ts`), the gateway app, or the
// e2e — so `qwen serve`, the running gateway, and the test suite never load the
// native addon, and a native-load failure can never take down the gateway.

/**
 * Turn a raw user query into a SAFE FTS5 MATCH string. Each whitespace-separated
 * term is stripped of `"` and double-quoted, so it is matched as a literal
 * string (FTS5 operators like `OR`/`NOT`/`NEAR`, and syntax chars like `*`/`(`,
 * are inert inside quotes) — this is the injection guard: a raw user string is
 * NEVER passed to MATCH. Terms with no LETTER-OR-NUMBER content (any script —
 * the `trigram` tokenizer that indexes the body handles CJK/Cyrillic/etc., so
 * the keep-predicate must too) are dropped; an all-empty query yields `null`
 * (→ no results, never an FTS5 syntax error).
 *
 * With the `trigram` tokenizer each quoted term matches as a case-insensitive
 * SUBSTRING (like the live scanner), AND-ed across terms — but the `--rank` mode
 * drops the scanner's boolean/phrase/prefix operators, and a term shorter than 3
 * chars can't match via the index (a trigram floor, uniform across scripts). So
 * it is a complementary BM25-ranked mode, not a reproduction of `parseQuery`.
 */
export function toFtsMatch(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' ');
}

/** Fixed-width epoch-ms key so a since/until range compares lexically on an
 * (affinity-less) FTS5 UNINDEXED text column exactly as a numeric compare would.
 * Transcript timestamps are always positive (post-2020), well within 16 digits. */
function tsKeyOf(ms: number): string {
  return String(ms).padStart(16, '0');
}

interface IndexRow {
  sessionId: string | null;
  eventId: string | null;
  kind: string | null;
  ts: string | null;
  snip: string | null;
}

const SNIPPET_MAX = 200;

/**
 * A BM25-ranked, on-disk full-text index over a workspace's JSONL transcripts,
 * backed by SQLite FTS5 (via the native `better-sqlite3`). Built/queried
 * daemon-free by the `reindex` / `search --rank` CLI. The index is a new at-rest
 * copy of raw transcript content, so {@link open} creates the containing dir
 * `0700` and the db `0600` (any transient SQLite journal sibling lives in the
 * `0700` dir, so it is unreachable by other users).
 */
export class SearchIndex {
  private constructor(private readonly db: Database.Database) {}

  /**
   * Open (creating if needed) the index db at `dbPath`. The parent dir is made
   * `0700` and the db file `0600`. The schema is a single FTS5 table: `body` is
   * tokenized/searchable; `file`/`sessionId`/`eventId`/`kind`/`ts`/`tsKey` are
   * UNINDEXED metadata returned with hits and used as WHERE filters.
   */
  static open(dbPath: string): SearchIndex {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask; enforce 0700 explicitly. Best-effort.
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* a perms tighten failing must not break indexing */
    }
    const db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }
    // The `trigram` tokenizer gives case-insensitive SUBSTRING matching (like
    // the live scanner) AND indexes any script incl. CJK — unlike the default
    // `unicode61`, which treats a space-less CJK run as one token so a substring
    // like 令牌 inside 令牌然后重试 would never match. Trigram's one limitation:
    // a query TERM shorter than 3 chars cannot match via the index (it has no
    // trigram), uniform across scripts — the CLI hints to use the default scan.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS records USING fts5(
         body,
         file UNINDEXED,
         sessionId UNINDEXED,
         eventId UNINDEXED,
         kind UNINDEXED,
         ts UNINDEXED,
         tsKey UNINDEXED,
         tokenize='trigram'
       )`,
    );
    return new SearchIndex(db);
  }

  /**
   * Rebuild the index from the JSONL transcripts under `chatsDir` (full
   * drop+rebuild in a single transaction — incremental mtime reindex is a
   * deferred follow-up). Indexes the EXACT text the live scanner searches via
   * the shared {@link recordText}; records with empty searchable text (e.g.
   * `custom_title` system records) are skipped (they can never match). Missing
   * dir / unreadable file / corrupt line are skipped, never thrown. Returns the
   * counts of files read and records indexed.
   */
  reindex(chatsDir: string): { files: number; records: number } {
    let names: string[];
    try {
      names = readdirSync(chatsDir);
    } catch {
      names = []; // missing/unreadable dir → an empty index, not an error.
    }
    const insert = this.db.prepare(
      `INSERT INTO records (body, file, sessionId, eventId, kind, ts, tsKey)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let files = 0;
    let records = 0;
    const rebuild = this.db.transaction(() => {
      this.db.exec('DELETE FROM records');
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        let text: string;
        try {
          text = readFileSync(join(chatsDir, name), 'utf8');
        } catch {
          continue; // unreadable file → skip.
        }
        files++;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec: TranscriptRecord;
          try {
            rec = JSON.parse(trimmed) as TranscriptRecord;
          } catch {
            continue; // corrupt / non-JSON line → skip.
          }
          const body = recordText(rec);
          if (!body) continue; // no searchable text → can never be a hit.
          const ms = Date.parse(rec.timestamp ?? '');
          const tsKey = Number.isNaN(ms) ? '' : tsKeyOf(ms);
          insert.run(
            body,
            name,
            rec.sessionId ?? '',
            rec.uuid ?? '',
            rec.type ?? '',
            rec.timestamp ?? '',
            tsKey,
          );
          records++;
        }
      }
    });
    rebuild();
    return { files, records };
  }

  /**
   * BM25-ranked search (most relevant first). `kind`/`sessionId`/`since`/`until`
   * filter through the index as WHERE clauses beside the MATCH, IDENTICALLY to
   * the live scanner's filters (`kind` via the shared {@link KIND_MAP}; a record
   * with an unparseable timestamp is excluded whenever a since/until bound is
   * active). `truncated` is reported by over-fetching one row past the clamped
   * limit, so no separate COUNT is needed. An all-empty query → no hits.
   */
  query(rawQuery: string, opts: SearchOptions = {}): SearchResult {
    const match = toFtsMatch(rawQuery);
    if (match === null) return { hits: [], truncated: false };

    const where = ['records MATCH ?'];
    const params: Array<string | number> = [match];

    const wantType =
      opts.kind && opts.kind !== 'all' ? KIND_MAP[opts.kind] : undefined;
    if (wantType !== undefined) {
      where.push('kind = ?');
      params.push(wantType);
    }
    if (opts.sessionId) {
      where.push('sessionId = ?');
      params.push(opts.sessionId);
    }
    if (opts.since !== undefined || opts.until !== undefined) {
      // A record with no usable timestamp can't be placed in the range, so it
      // is excluded when a bound is active (mirrors the scanner).
      where.push("tsKey != ''");
      if (opts.since !== undefined) {
        where.push('tsKey >= ?');
        params.push(tsKeyOf(opts.since));
      }
      if (opts.until !== undefined) {
        where.push('tsKey <= ?');
        params.push(tsKeyOf(opts.until));
      }
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const sql =
      `SELECT sessionId, eventId, kind, ts, ` +
      `snippet(records, 0, '', '', '…', 24) AS snip ` +
      `FROM records WHERE ${where.join(' AND ')} ` +
      `ORDER BY bm25(records) LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as IndexRow[];
    const truncated = rows.length > limit;
    const hits: SearchHit[] = rows.slice(0, limit).map((r) => ({
      sessionId: r.sessionId ?? '',
      eventId: r.eventId ?? '',
      kind: r.kind ?? '',
      ts: r.ts ?? '',
      snippet: (r.snip ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
    }));
    return { hits, truncated };
  }

  /** Number of indexed records — lets the CLI hint when `--rank` runs against
   * an index that was never built (0 rows) vs. a genuine no-match. */
  count(): number {
    return (
      this.db.prepare('SELECT count(*) AS n FROM records').get() as {
        n: number;
      }
    ).n;
  }

  close(): void {
    this.db.close();
  }
}
