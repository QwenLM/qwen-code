/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchDb, computeHighlights, extractTerms } from './searchDb.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let db: SearchDb;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rc-searchdb-'));
  dbPath = join(tmpDir, 'search.db');
  db = SearchDb.open(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function doc(o: {
  sessionId?: string;
  eventId?: string;
  kind?: string;
  ts?: string;
  body?: string;
}) {
  return {
    sessionId: o.sessionId ?? 'ses-1',
    eventId: o.eventId ?? 'evt-1',
    kind: o.kind ?? 'assistant',
    ts: o.ts ?? '2026-06-01T12:00:00.000Z',
    body: o.body ?? 'hello world',
  };
}

// ── extractTerms ──────────────────────────────────────────────────────────────

describe('extractTerms', () => {
  it('returns lowercased plain terms', () => {
    expect(extractTerms('OAuth Token')).toEqual(['oauth', 'token']);
  });

  it('extracts phrase content (without quotes)', () => {
    expect(extractTerms('"oauth refresh"')).toEqual(['oauth refresh']);
  });

  it('drops AND/OR/NOT operator keywords', () => {
    expect(extractTerms('oauth AND error NOT migration')).toEqual([
      'oauth',
      'error',
      'migration',
    ]);
  });

  it('strips trailing wildcard from prefix terms', () => {
    expect(extractTerms('oauth*')).toEqual(['oauth']);
  });

  it('de-duplicates terms', () => {
    expect(extractTerms('foo foo bar')).toEqual(['foo', 'bar']);
  });
});

// ── computeHighlights ─────────────────────────────────────────────────────────

describe('computeHighlights', () => {
  it('returns byte offsets for a match in ASCII text', () => {
    const snippet = 'hello world oauth token';
    const hl = computeHighlights(snippet, ['oauth']);
    expect(hl).toHaveLength(1);
    expect(hl[0]).toEqual({ start: 12, end: 17 });
    // Verify: Buffer.from(snippet).slice(12, 17).toString() === 'oauth'
    expect(Buffer.from(snippet, 'utf8').slice(12, 17).toString()).toBe('oauth');
  });

  it('returns multiple highlights for multiple occurrences', () => {
    const snippet = 'oauth oauth';
    const hl = computeHighlights(snippet, ['oauth']);
    expect(hl).toHaveLength(2);
    expect(hl[0].start).toBe(0);
    expect(hl[1].start).toBe(6);
  });

  it('handles multi-byte (UTF-8) characters correctly', () => {
    // '令牌' is a 2-char CJK sequence, each char is 3 bytes in UTF-8
    const snippet = 'result 令牌 end';
    const hl = computeHighlights(snippet, ['令牌']);
    expect(hl).toHaveLength(1);
    // 'result ' = 7 bytes (ASCII), then '令牌' starts
    expect(hl[0].start).toBe(7);
    // Each CJK char is 3 bytes, so 2 chars = 6 bytes
    expect(hl[0].end).toBe(13);
    expect(
      Buffer.from(snippet, 'utf8').slice(hl[0].start, hl[0].end).toString(),
    ).toBe('令牌');
  });

  it('is case-insensitive', () => {
    const snippet = 'Permission OAUTH required';
    const hl = computeHighlights(snippet, ['oauth']);
    expect(hl).toHaveLength(1);
    // 'Permission ' = 11 bytes, then 'OAUTH'
    expect(hl[0].start).toBe(11);
    expect(hl[0].end).toBe(16);
  });

  it('returns empty array when term not found', () => {
    const hl = computeHighlights('hello world', ['nothere']);
    expect(hl).toHaveLength(0);
  });

  it('returns empty array for empty terms array', () => {
    const hl = computeHighlights('hello world', []);
    expect(hl).toHaveLength(0);
  });
});

// ── SearchDb.open ─────────────────────────────────────────────────────────────

describe('SearchDb.open', () => {
  it('creates the schema tables', () => {
    // If open() succeeded without error, schema was created. Verify by counting.
    expect(db.count()).toBe(0);
  });

  it('stores schema version 1', () => {
    expect(db.schemaVersion()).toBe(1);
  });

  it('is idempotent (reopening the same db does not error)', () => {
    db.close();
    db = SearchDb.open(dbPath);
    expect(db.count()).toBe(0);
  });
});

// ── upsertDocument / FTS5 triggers ───────────────────────────────────────────

describe('SearchDb.upsertDocument', () => {
  it('indexes a document and makes it searchable', () => {
    db.upsertDocument(doc({ body: 'oauth refresh token flow' }));
    const { hits } = db.query('oauth');
    expect(hits).toHaveLength(1);
    expect(hits[0].eventId).toBe('evt-1');
  });

  it('is idempotent on (session_id, event_id)', () => {
    db.upsertDocument(doc({ body: 'first body' }));
    db.upsertDocument(doc({ body: 'second body — same key' }));
    expect(db.count()).toBe(1);
    // The first insert wins (ON CONFLICT DO NOTHING)
    const { hits } = db.query('first');
    expect(hits).toHaveLength(1);
  });

  it('indexes multiple documents', () => {
    db.upsertDocument(doc({ eventId: 'e1', body: 'oauth token' }));
    db.upsertDocument(doc({ eventId: 'e2', body: 'refresh token' }));
    expect(db.count()).toBe(2);
  });
});

// ── query / BM25 ranking ──────────────────────────────────────────────────────

describe('SearchDb.query', () => {
  beforeEach(() => {
    db.upsertDocument(
      doc({
        eventId: 'e1',
        sessionId: 'ses-1',
        body: 'oauth oauth oauth token',
      }),
    );
    db.upsertDocument(
      doc({
        eventId: 'e2',
        sessionId: 'ses-1',
        body: 'one passing mention of oauth',
      }),
    );
    db.upsertDocument(
      doc({
        eventId: 'e3',
        sessionId: 'ses-2',
        body: 'unrelated content here',
      }),
    );
  });

  it('returns hits ordered by BM25 score (best first)', () => {
    const { hits } = db.query('oauth');
    // e1 has more occurrences of 'oauth', so higher BM25 relevance
    expect(hits.map((h) => h.eventId)).toEqual(['e1', 'e2']);
  });

  it('returns no hits for a non-matching query', () => {
    const { hits } = db.query('zxqvwyz');
    expect(hits).toHaveLength(0);
  });

  it('filters by kind', () => {
    db.upsertDocument(doc({ eventId: 'e4', kind: 'user', body: 'oauth' }));
    const { hits } = db.query('oauth', { kind: 'user' });
    expect(hits.map((h) => h.eventId)).toEqual(['e4']);
  });

  it('filters by sessionId', () => {
    const { hits } = db.query('oauth', { sessionId: 'ses-2' });
    expect(hits).toHaveLength(0);
    const { hits: h2 } = db.query('oauth', { sessionId: 'ses-1' });
    expect(h2).toHaveLength(2);
  });

  it('respects the limit and reports truncated', () => {
    const { hits, truncated } = db.query('oauth', { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('returns truncated:false when results fit within limit', () => {
    const { hits, truncated } = db.query('oauth', { limit: 10 });
    expect(hits).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it('includes snippet and highlights in each hit', () => {
    const { hits } = db.query('oauth');
    expect(hits[0].snippet).toContain('oauth');
    expect(hits[0].highlights.length).toBeGreaterThan(0);
    // Highlights must be valid byte offsets within the snippet
    const snippetBuf = Buffer.from(hits[0].snippet, 'utf8');
    for (const hl of hits[0].highlights) {
      expect(hl.start).toBeGreaterThanOrEqual(0);
      expect(hl.end).toBeLessThanOrEqual(snippetBuf.length);
      expect(hl.start).toBeLessThan(hl.end);
    }
  });

  it('highlight byte range covers the matched term', () => {
    db.upsertDocument(
      doc({ eventId: 'hl-test', body: 'the oauth callback failed' }),
    );
    const { hits } = db.query('oauth', { sessionId: 'ses-1' });
    const h = hits.find((x) => x.eventId === 'hl-test');
    expect(h).toBeDefined();
    const hl = h!.highlights.find((x) => {
      const slice = Buffer.from(h!.snippet, 'utf8')
        .slice(x.start, x.end)
        .toString();
      return slice.toLowerCase() === 'oauth';
    });
    expect(hl).toBeDefined();
  });

  it('no markup in snippet (no HTML tags)', () => {
    db.upsertDocument(
      doc({ eventId: 'html-test', body: '<img src=x onerror=alert(1)>' }),
    );
    const { hits } = db.query('img');
    if (hits.length > 0) {
      // Snippet must contain the raw text, no additional markup
      expect(hits[0].snippet).toContain('<img src=x onerror=alert(1)>');
      // Should not have any FTS5-generated delimiter markup
      expect(hits[0].snippet).not.toContain('[b]');
      expect(hits[0].snippet).not.toContain('</b>');
    }
  });

  it('filters by visibleSessionIds (non-owner visibility)', () => {
    const visible = new Set(['ses-1']);
    const { hits } = db.query('oauth', { visibleSessionIds: visible });
    expect(hits.every((h) => h.sessionId === 'ses-1')).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns no hits when visibleSessionIds is empty (caller sees nothing)', () => {
    const { hits } = db.query('oauth', { visibleSessionIds: new Set() });
    expect(hits).toHaveLength(0);
  });

  it('intersects visibleSessionIds with lineageSet', () => {
    // visible: ses-1 only; lineageSet: ses-1 + ses-2
    // effective = {ses-1}
    const visible = new Set(['ses-1']);
    const lineageSet = new Set(['ses-1', 'ses-2']);
    const { hits } = db.query('oauth', {
      visibleSessionIds: visible,
      lineageSet,
    });
    expect(hits.every((h) => h.sessionId === 'ses-1')).toBe(true);
  });

  it('returns empty hits when lineageSet is empty', () => {
    const { hits } = db.query('oauth', { lineageSet: new Set() });
    expect(hits).toHaveLength(0);
  });

  it('returns score for each hit', () => {
    const { hits } = db.query('oauth');
    for (const h of hits) {
      expect(typeof h.score).toBe('number');
    }
  });

  it('returns empty for an empty query', () => {
    const { hits } = db.query('');
    expect(hits).toHaveLength(0);
  });
});

// ── token_session_history ─────────────────────────────────────────────────────

describe('SearchDb.recordTokenSession', () => {
  it('records a token→session mapping', () => {
    db.recordTokenSession('tok-1', 'ses-A');
    const visible = db.visibleSessionsForToken('tok-1');
    expect(visible.has('ses-A')).toBe(true);
  });

  it('is idempotent (multiple records do not duplicate)', () => {
    db.recordTokenSession('tok-1', 'ses-A');
    db.recordTokenSession('tok-1', 'ses-A');
    const visible = db.visibleSessionsForToken('tok-1');
    expect(visible.size).toBe(1);
  });

  it('records multiple sessions for the same token', () => {
    db.recordTokenSession('tok-1', 'ses-A');
    db.recordTokenSession('tok-1', 'ses-B');
    const visible = db.visibleSessionsForToken('tok-1');
    expect(visible.has('ses-A')).toBe(true);
    expect(visible.has('ses-B')).toBe(true);
  });

  it('different tokens have separate histories', () => {
    db.recordTokenSession('tok-1', 'ses-A');
    db.recordTokenSession('tok-2', 'ses-B');
    expect(db.visibleSessionsForToken('tok-1').has('ses-B')).toBe(false);
    expect(db.visibleSessionsForToken('tok-2').has('ses-A')).toBe(false);
  });
});

// ── session_meta ──────────────────────────────────────────────────────────────

describe('SearchDb.upsertSessionMeta', () => {
  it('creates a session_meta row', () => {
    db.upsertSessionMeta({ sessionId: 'ses-X', name: 'My Session' });
    // Verify via query result (sessionName comes from the join)
    db.upsertDocument(doc({ sessionId: 'ses-X', body: 'test content' }));
    const { hits } = db.query('test', { sessionId: 'ses-X' });
    expect(hits[0].sessionName).toBe('My Session');
  });

  it('is idempotent and coalesces updates', () => {
    db.upsertSessionMeta({ sessionId: 'ses-Y', name: 'First' });
    db.upsertSessionMeta({ sessionId: 'ses-Y', name: 'Second' });
    db.upsertDocument(doc({ sessionId: 'ses-Y', body: 'hello' }));
    const { hits } = db.query('hello', { sessionId: 'ses-Y' });
    // ON CONFLICT clause: coalesce(excluded.name, name) → keeps original if excluded is null,
    // or updates if excluded is non-null. Second call with 'Second' should update name.
    expect(hits[0].sessionName).toBe('Second');
  });

  it('returns null sessionName when session has no metadata row', () => {
    db.upsertDocument(doc({ sessionId: 'ses-Z', body: 'content' }));
    const { hits } = db.query('content', { sessionId: 'ses-Z' });
    expect(hits[0].sessionName).toBeNull();
  });
});

// ── reindexSession ────────────────────────────────────────────────────────────

describe('SearchDb.reindexSession', () => {
  it('replaces all documents for a session', () => {
    db.upsertDocument(doc({ eventId: 'old', body: 'old content widget' }));
    db.reindexSession('ses-1', [
      {
        eventId: 'new',
        kind: 'user',
        ts: '2026-01-01T00:00:00.000Z',
        body: 'new content gadget',
      },
    ]);
    expect(db.query('widget').hits).toHaveLength(0);
    expect(db.query('gadget').hits).toHaveLength(1);
  });

  it('is idempotent (calling twice keeps the same result)', () => {
    db.reindexSession('ses-1', [
      {
        eventId: 'e1',
        kind: 'user',
        ts: '2026-01-01T00:00:00.000Z',
        body: 'hello world',
      },
    ]);
    db.reindexSession('ses-1', [
      {
        eventId: 'e1',
        kind: 'user',
        ts: '2026-01-01T00:00:00.000Z',
        body: 'hello world',
      },
    ]);
    expect(db.count()).toBe(1);
  });

  it('does not touch other sessions', () => {
    db.upsertDocument(
      doc({ sessionId: 'ses-1', eventId: 'a', body: 'session one content' }),
    );
    db.upsertDocument(
      doc({ sessionId: 'ses-2', eventId: 'b', body: 'session two content' }),
    );
    db.reindexSession('ses-1', [
      {
        eventId: 'c',
        kind: 'user',
        ts: '2026-01-01T00:00:00.000Z',
        body: 'replaced',
      },
    ]);
    expect(db.query('session two').hits).toHaveLength(1);
    expect(db.query('replaced').hits).toHaveLength(1);
    expect(db.count()).toBe(2);
  });
});
