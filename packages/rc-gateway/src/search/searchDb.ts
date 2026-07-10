/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// NOTE ON ISOLATION: this is the ONLY module that imports the NATIVE
// `better-sqlite3`. It is imported solely from the gateway's search subsystem
// and never from the barrel (`index.ts`) or tests that run without native deps.

const SCHEMA_VERSION = 1;

/**
 * A match highlight: UTF-8 byte offsets into the `snippet` string.
 * `start` is inclusive, `end` is exclusive (like Buffer.slice semantics).
 * No HTML markup is ever emitted — clients apply styling from these offsets.
 */
export interface Highlight {
  start: number;
  end: number;
}

/** One search result from the gateway-integrated FTS5 index. */
export interface DbSearchHit {
  sessionId: string;
  sessionName: string | null;
  eventId: string;
  ts: string;
  kind: string;
  snippet: string;
  highlights: Highlight[];
  score: number;
}

export interface DbSearchResult {
  hits: DbSearchHit[];
  truncated: boolean;
}

export interface DbSearchOptions {
  kind?: string;
  sessionId?: string;
  /** When present, restrict to the lineage set (ancestors + descendants + self) of this session id. */
  lineage?: string;
  since?: number;
  until?: number;
  limit?: number;
  /** Set of session ids visible to the caller (undefined = owner = all sessions). */
  visibleSessionIds?: ReadonlySet<string>;
}

/**
 * Compute UTF-8 byte offsets (start inclusive, end exclusive) for every
 * occurrence of the search terms in the plain-text snippet. This produces the
 * `highlights` array that clients use to style matched terms without any
 * daemon-generated HTML markup.
 *
 * We locate terms by simple case-insensitive substring search in the
 * utf8 byte space. Multi-byte characters are handled correctly because
 * Buffer.indexOf on UTF-8 encoded buffers respects byte boundaries.
 */
export function computeHighlights(
  snippet: string,
  terms: string[],
): Highlight[] {
  if (!terms.length || !snippet) return [];
  const snippetBuf = Buffer.from(snippet, 'utf8');
  const snippetLower = snippet.toLowerCase();
  const hits: Highlight[] = [];

  for (const term of terms) {
    if (!term) continue;
    const termLower = term.toLowerCase();
    const termBuf = Buffer.from(termLower, 'utf8');
    // Search in the lowercased string to find char positions, then convert to
    // byte positions using the original UTF-8 buffer.
    let charPos = 0;
    while (charPos < snippetLower.length) {
      const found = snippetLower.indexOf(termLower, charPos);
      if (found < 0) break;
      // Convert char positions to byte positions
      const startByte = Buffer.from(snippet.slice(0, found), 'utf8').length;
      const endByte = startByte + termBuf.length;
      // Verify the byte range within the actual (mixed-case) buffer
      if (endByte <= snippetBuf.length) {
        hits.push({ start: startByte, end: endByte });
      }
      charPos = found + termLower.length;
    }
  }

  // Sort by start offset for stable output
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/**
 * Extract the literal search terms from a raw FTS5 query string. Returns the
 * array of term strings that should be highlighted (de-duped, lowercased).
 * Handles phrase quotes: `"foo bar"` → `['foo bar']`. Drops operator keywords
 * (AND, OR, NOT) and empty strings.
 */
export function extractTerms(rawQuery: string): string[] {
  const terms: string[] = [];
  let i = 0;
  while (i < rawQuery.length) {
    if (/\s/.test(rawQuery[i])) {
      i++;
      continue;
    }
    if (rawQuery[i] === '"') {
      // Phrase: collect until closing quote
      const close = rawQuery.indexOf('"', i + 1);
      const phrase =
        close < 0 ? rawQuery.slice(i + 1) : rawQuery.slice(i + 1, close);
      const cleaned = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
      if (cleaned) terms.push(cleaned);
      i = close < 0 ? rawQuery.length : close + 1;
    } else {
      // Word token
      let j = i;
      while (j < rawQuery.length && !/[\s"()]/.test(rawQuery[j])) j++;
      const word = rawQuery.slice(i, j).replace(/\*$/, '').toLowerCase();
      // Drop FTS5 operator keywords
      if (word && !['and', 'or', 'not', '-'].includes(word)) {
        terms.push(word);
      }
      i = j;
    }
  }
  // De-duplicate preserving first occurrence
  return [...new Set(terms)];
}

const SNIPPET_WINDOW = 160;
const SNIPPET_MAX = 200;

/**
 * Build a plain-text snippet centered on the first matched term from the
 * candidate text. Returns { snippet, terms } where terms is the lowercased
 * list of terms to pass to computeHighlights.
 */
function buildSnippet(text: string, terms: string[]): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const lower = collapsed.toLowerCase();
  // Find the first matching term position
  let firstIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
  }
  if (firstIdx < 0) return collapsed.slice(0, SNIPPET_MAX);
  const start = Math.max(0, firstIdx - 70);
  const end = Math.min(collapsed.length, start + SNIPPET_WINDOW);
  let out = collapsed.slice(start, end);
  if (start > 0) out = '…' + out;
  if (end < collapsed.length) out += '…';
  return out.slice(0, SNIPPET_MAX);
}

interface RawHit {
  sessionId: string;
  eventId: string;
  ts: string;
  kind: string;
  body: string;
  score: number;
  sessionName: string | null;
}

interface MetaRow {
  schema_version: number;
}
// SessionMetaRow intentionally omitted — session name is joined directly in the query SQL

/**
 * A SQLite-backed FTS5 search index for the gateway, with:
 *   - `documents` table with `UNIQUE (session_id, event_id)` constraint
 *   - `fts` FTS5 virtual table using `unicode61 remove_diacritics 2` tokeniser
 *   - `token_session_history` for permission-filtered search
 *   - `session_meta` for session names, eviction tracking
 *   - `meta` for schema versioning
 *
 * Uses WAL mode for concurrent reads during writes.
 */
export class SearchDb {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): SearchDb {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }

    const db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        rowid       INTEGER PRIMARY KEY,
        session_id  TEXT NOT NULL,
        event_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        ts          TEXT NOT NULL,
        body        TEXT NOT NULL,
        UNIQUE (session_id, event_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        body,
        content='documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO fts(rowid, body) VALUES (new.rowid, new.body);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO fts(fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO fts(fts, rowid, body) VALUES ('delete', old.rowid, old.body);
        INSERT INTO fts(rowid, body) VALUES (new.rowid, new.body);
      END;

      CREATE TABLE IF NOT EXISTS token_session_history (
        token_id    TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        PRIMARY KEY (token_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id  TEXT PRIMARY KEY,
        name        TEXT,
        ended       INTEGER NOT NULL DEFAULT 0,
        first_ts    TEXT,
        last_ts     TEXT,
        evicted_at  TEXT
      );
    `);

    // Ensure meta row exists
    const version = (
      db.prepare('SELECT schema_version FROM meta LIMIT 1').get() as
        | MetaRow
        | undefined
    )?.schema_version;
    if (version === undefined) {
      db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(
        SCHEMA_VERSION,
      );
    }

    return new SearchDb(db);
  }

  /**
   * Upsert a document (idempotent on session_id + event_id). The FTS5 triggers
   * handle keeping the fts virtual table in sync.
   */
  upsertDocument(doc: {
    sessionId: string;
    eventId: string;
    kind: string;
    ts: string;
    body: string;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO documents (session_id, event_id, kind, ts, body)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, event_id) DO NOTHING
    `,
      )
      .run(doc.sessionId, doc.eventId, doc.kind, doc.ts, doc.body);
  }

  /**
   * Record that a token has accessed a session (for permission filtering).
   * Idempotent: subsequent calls for the same (token_id, session_id) are no-ops.
   */
  recordTokenSession(
    tokenId: string,
    sessionId: string,
    now = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO token_session_history (token_id, session_id, first_seen)
      VALUES (?, ?, ?)
      ON CONFLICT (token_id, session_id) DO NOTHING
    `,
      )
      .run(tokenId, sessionId, now);
  }

  /**
   * Upsert session metadata (name, timestamps). Used when indexing to keep
   * `session_meta` current; absent rows are created, existing rows updated.
   */
  upsertSessionMeta(meta: {
    sessionId: string;
    name?: string | null;
    ended?: boolean;
    firstTs?: string | null;
    lastTs?: string | null;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO session_meta (session_id, name, ended, first_ts, last_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        name     = coalesce(excluded.name, name),
        ended    = excluded.ended,
        first_ts = coalesce(excluded.first_ts, first_ts),
        last_ts  = coalesce(excluded.last_ts, last_ts)
    `,
      )
      .run(
        meta.sessionId,
        meta.name ?? null,
        meta.ended ? 1 : 0,
        meta.firstTs ?? null,
        meta.lastTs ?? null,
      );
  }

  /**
   * Compute the visible-session set for a non-owner token.
   * Returns the set of session ids in `token_session_history` for the given token.
   */
  visibleSessionsForToken(tokenId: string): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT session_id FROM token_session_history WHERE token_id = ?',
      )
      .all(tokenId) as Array<{ session_id: string }>;
    return new Set(rows.map((r) => r.session_id));
  }

  /**
   * BM25-ranked full-text search. Applies visibility filtering, kind filter,
   * session filter, time bounds, and the lineage filter.
   *
   * `opts.visibleSessionIds` = undefined → owner (no session filter applied);
   * `opts.visibleSessionIds` = Set → hard SQL filter against those ids only.
   *
   * `opts.lineage` → restrict to the given lineage set (must be pre-computed
   * by the caller from walkLineage and provided as `lineageSet`).
   *
   * Returns hits with plain-text snippets and `highlights` byte offsets.
   */
  query(
    rawQuery: string,
    opts: DbSearchOptions & { lineageSet?: ReadonlySet<string> } = {},
  ): DbSearchResult {
    if (!rawQuery.trim()) return { hits: [], truncated: false };

    const terms = extractTerms(rawQuery);
    if (!terms.length) return { hits: [], truncated: false };

    // Build the FTS5 MATCH string (quote each term to prevent injection)
    const ftsMatch = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');

    const where: string[] = ['fts MATCH ?'];
    const params: Array<string | number> = [ftsMatch];

    // Kind filter
    if (opts.kind && opts.kind !== 'all') {
      where.push('d.kind = ?');
      params.push(opts.kind);
    }

    // Session filter (exact match, may be narrowed by lineage below)
    if (opts.sessionId) {
      where.push('d.session_id = ?');
      params.push(opts.sessionId);
    }

    // Time bounds
    if (opts.since !== undefined) {
      where.push('d.ts >= ?');
      params.push(new Date(opts.since).toISOString());
    }
    if (opts.until !== undefined) {
      where.push('d.ts <= ?');
      params.push(new Date(opts.until).toISOString());
    }

    // Compute effective session set = intersection of visibleSessionIds ∩ lineageSet
    let effectiveSet: ReadonlySet<string> | undefined;
    if (opts.visibleSessionIds !== undefined || opts.lineageSet !== undefined) {
      if (
        opts.visibleSessionIds !== undefined &&
        opts.lineageSet !== undefined
      ) {
        // Intersect
        const inter = new Set<string>();
        for (const id of opts.lineageSet) {
          if (opts.visibleSessionIds.has(id)) inter.add(id);
        }
        effectiveSet = inter;
      } else {
        effectiveSet = opts.visibleSessionIds ?? opts.lineageSet;
      }
    }

    if (effectiveSet !== undefined) {
      if (effectiveSet.size === 0) return { hits: [], truncated: false };
      // Build IN clause — parameterized
      const placeholders = [...effectiveSet].map(() => '?').join(',');
      where.push(`d.session_id IN (${placeholders})`);
      params.push(...effectiveSet);
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    params.push(limit + 1);

    const sql = `
      SELECT d.session_id AS sessionId,
             d.event_id   AS eventId,
             d.ts         AS ts,
             d.kind       AS kind,
             d.body       AS body,
             bm25(fts)    AS score,
             sm.name      AS sessionName
      FROM fts
      JOIN documents d ON d.rowid = fts.rowid
      LEFT JOIN session_meta sm ON sm.session_id = d.session_id
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(fts)
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as RawHit[];
    const truncated = rows.length > limit;

    const hits: DbSearchHit[] = rows.slice(0, limit).map((r) => {
      const snip = buildSnippet(r.body, terms);
      return {
        sessionId: r.sessionId,
        sessionName: r.sessionName ?? null,
        eventId: r.eventId,
        ts: r.ts,
        kind: r.kind,
        snippet: snip,
        highlights: computeHighlights(snip, terms),
        score: r.score,
      };
    });

    return { hits, truncated };
  }

  /** Total indexed document count. */
  count(): number {
    return (
      this.db.prepare('SELECT count(*) AS n FROM documents').get() as {
        n: number;
      }
    ).n;
  }

  /**
   * Delete all documents for a session and rebuild from the provided rows.
   * FTS5 triggers handle index sync. Idempotent.
   */
  reindexSession(
    sessionId: string,
    docs: Array<{
      eventId: string;
      kind: string;
      ts: string;
      body: string;
    }>,
  ): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM documents WHERE session_id = ?')
        .run(sessionId);
      const ins = this.db.prepare(`
        INSERT INTO documents (session_id, event_id, kind, ts, body)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (session_id, event_id) DO NOTHING
      `);
      for (const doc of docs) {
        ins.run(sessionId, doc.eventId, doc.kind, doc.ts, doc.body);
      }
    });
    run();
  }

  /** Get the schema version currently stored. */
  schemaVersion(): number {
    return (
      (
        this.db.prepare('SELECT schema_version FROM meta LIMIT 1').get() as
          | MetaRow
          | undefined
      )?.schema_version ?? 0
    );
  }

  close(): void {
    this.db.close();
  }
}
