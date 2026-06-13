/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchIndex, toFtsMatch } from './searchIndex.js';

const ID = (n: number) => String(n).padStart(32, '0');

/** Build a JSONL transcript record line. */
function rec(o: {
  uuid?: string;
  sessionId?: string;
  ts?: string;
  type?: string;
  text?: string;
  functionResponse?: unknown;
}): string {
  const parts: Array<Record<string, unknown>> = [];
  if (o.text !== undefined) parts.push({ text: o.text });
  if (o.functionResponse !== undefined)
    parts.push({ functionResponse: o.functionResponse });
  return JSON.stringify({
    uuid: o.uuid ?? 'u0',
    sessionId: o.sessionId ?? ID(1),
    timestamp: o.ts ?? '2026-06-01T12:00:00.000Z',
    type: o.type ?? 'user',
    message: { parts },
  });
}

describe('toFtsMatch (pure, injection guard)', () => {
  it('quotes each term so FTS5 operators/syntax are inert', () => {
    expect(toFtsMatch('oauth token')).toBe('"oauth" "token"');
    // Bare OR/NOT would be FTS5 operators if unquoted — they must be literal.
    expect(toFtsMatch('cats OR dogs')).toBe('"cats" "OR" "dogs"');
    // A stray double-quote can't break out of the wrapping quote.
    expect(toFtsMatch('a"b" c')).toBe('"ab" "c"');
    // A lone `*` / punctuation token (no alphanumerics) is dropped.
    expect(toFtsMatch('oauth ***')).toBe('"oauth"');
  });

  it('keeps non-ASCII (CJK/Cyrillic) terms — any-script letters/numbers', () => {
    // A Qwen product is CJK-heavy; an ASCII-only keep-predicate would drop these.
    expect(toFtsMatch('令牌')).toBe('"令牌"');
    expect(toFtsMatch('刷新 令牌')).toBe('"刷新" "令牌"');
    expect(toFtsMatch('токен')).toBe('"токен"');
  });

  it('returns null for an all-empty / punctuation-only query', () => {
    expect(toFtsMatch('   ')).toBeNull();
    expect(toFtsMatch('"" *** ()')).toBeNull();
  });
});

describe('SearchIndex', () => {
  let chatsDir: string;
  let dbPath: string;
  let idx: SearchIndex | undefined;

  beforeEach(async () => {
    chatsDir = await mkdtemp(join(tmpdir(), 'rc-idx-chats-'));
    const dbDir = await mkdtemp(join(tmpdir(), 'rc-idx-db-'));
    dbPath = join(dbDir, 'sub', 'index.db'); // a nested path open() must create.
  });
  afterEach(async () => {
    idx?.close();
    idx = undefined;
    await rm(chatsDir, { recursive: true, force: true });
  });

  it('ranks a denser match first (BM25)', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({
        sessionId: ID(1),
        uuid: 'a',
        text: 'a passing mention of oauth and one token',
      }) +
        '\n' +
        rec({
          sessionId: ID(1),
          uuid: 'b',
          text: 'oauth oauth oauth token token refresh',
        }) +
        '\n',
    );
    idx = SearchIndex.open(dbPath);
    const { files, records } = idx.reindex(chatsDir);
    expect(files).toBe(1);
    expect(records).toBe(2);
    const { hits } = idx.query('oauth token');
    expect(hits.map((h) => h.eventId)).toEqual(['b', 'a']);
    expect(hits[0].snippet).toContain('oauth');
  });

  it('creates the db dir 0700 and the db file 0600', async () => {
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    const fileMode = (await stat(dbPath)).mode & 0o777;
    const dirMode = (await stat(join(dbPath, '..'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('filters by kind (tool→tool_result) identically to the scanner map', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({ uuid: 'usr', type: 'user', text: 'run the migration please' }) +
        '\n' +
        rec({
          uuid: 'tr',
          type: 'tool_result',
          functionResponse: { output: 'migration applied successfully' },
        }) +
        '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    expect(
      idx.query('migration', { kind: 'tool' }).hits.map((h) => h.eventId),
    ).toEqual(['tr']);
    expect(
      idx.query('migration', { kind: 'user' }).hits.map((h) => h.eventId),
    ).toEqual(['usr']);
    // tool_result content (under functionResponse) is searchable.
    expect(idx.query('applied').hits.map((h) => h.eventId)).toEqual(['tr']);
  });

  it('filters by sessionId', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({ sessionId: ID(1), uuid: 'one', text: 'shared keyword here' }) +
        '\n',
    );
    await writeFile(
      join(chatsDir, `${ID(2)}.jsonl`),
      rec({ sessionId: ID(2), uuid: 'two', text: 'shared keyword here' }) +
        '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    expect(idx.query('keyword').hits).toHaveLength(2);
    expect(
      idx.query('keyword', { sessionId: ID(2) }).hits.map((h) => h.eventId),
    ).toEqual(['two']);
  });

  it('filters by an inclusive since/until range; excludes unparseable ts under a bound', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({
        uuid: 'jan',
        ts: '2026-01-15T00:00:00.000Z',
        text: 'alpha event',
      }) +
        '\n' +
        rec({
          uuid: 'jun',
          ts: '2026-06-15T00:00:00.000Z',
          text: 'alpha event',
        }) +
        '\n' +
        rec({ uuid: 'bad', ts: 'not-a-date', text: 'alpha event' }) +
        '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    const since = Date.parse('2026-03-01T00:00:00.000Z');
    const until = Date.parse('2026-09-01T00:00:00.000Z');
    // Only the June record is in [Mar, Sep]; the unparseable-ts record is
    // excluded because a bound is active (matches the scanner).
    expect(
      idx.query('alpha', { since, until }).hits.map((h) => h.eventId),
    ).toEqual(['jun']);
    // With NO bound, all three (incl. the unparseable ts) are searchable.
    expect(idx.query('alpha').hits).toHaveLength(3);
  });

  it('reports truncated and a recency-independent ranked prefix under a limit', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      rec({ uuid: 'r' + i, text: 'common term ' + 'common '.repeat(i) }),
    ).join('\n');
    await writeFile(join(chatsDir, `${ID(1)}.jsonl`), lines + '\n');
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    const res = idx.query('common', { limit: 3 });
    expect(res.hits).toHaveLength(3);
    expect(res.truncated).toBe(true);
  });

  it('reindex is a full rebuild: it picks up a changed file and drops removed rows', async () => {
    const file = join(chatsDir, `${ID(1)}.jsonl`);
    await writeFile(
      file,
      rec({ uuid: 'v1', text: 'original content widget' }) + '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    expect(idx.query('widget').hits).toHaveLength(1);
    expect(idx.query('replaced').hits).toHaveLength(0);

    // Rewrite the file; a fresh reindex reflects the new content and the old
    // row is gone (full drop+rebuild).
    await writeFile(
      file,
      rec({ uuid: 'v2', text: 'replaced content gadget' }) + '\n',
    );
    idx.reindex(chatsDir);
    expect(idx.query('widget').hits).toHaveLength(0);
    expect(idx.query('gadget').hits.map((h) => h.eventId)).toEqual(['v2']);
  });

  it('incremental: re-indexes only changed/new files, skips unchanged, prunes removed', async () => {
    const fileA = join(chatsDir, `${ID(1)}.jsonl`);
    const fileB = join(chatsDir, `${ID(2)}.jsonl`);
    await writeFile(
      fileA,
      rec({ uuid: 'a1', text: 'alpha widget content' }) + '\n',
    );
    await writeFile(
      fileB,
      rec({ uuid: 'b1', text: 'beta gadget content' }) + '\n',
    );
    idx = SearchIndex.open(dbPath);
    const first = idx.reindexIncremental(chatsDir);
    expect(first.updated).toBe(2);
    expect(first.scanned).toBe(2);
    expect(idx.query('widget').hits.map((h) => h.eventId)).toEqual(['a1']);

    // A no-op pass (nothing changed) re-indexes nothing.
    const noop = idx.reindexIncremental(chatsDir);
    expect({ updated: noop.updated, removed: noop.removed }).toEqual({
      updated: 0,
      removed: 0,
    });

    // Change ONLY fileA (force a newer mtime so the change is observable even on
    // a coarse-resolution clock), then incrementally reindex.
    await writeFile(
      fileA,
      rec({ uuid: 'a2', text: 'alpha sprocket content' }) + '\n',
    );
    const future = new Date(Date.now() + 10_000);
    await utimes(fileA, future, future);
    const second = idx.reindexIncremental(chatsDir);
    expect(second.updated).toBe(1); // only fileA
    expect(idx.query('widget').hits).toHaveLength(0); // old content gone
    expect(idx.query('sprocket').hits.map((h) => h.eventId)).toEqual(['a2']);
    expect(idx.query('gadget').hits.map((h) => h.eventId)).toEqual(['b1']); // B untouched

    // Remove fileB → its rows are pruned.
    await rm(fileB);
    const third = idx.reindexIncremental(chatsDir);
    expect(third.removed).toBe(1);
    expect(third.updated).toBe(0);
    expect(idx.query('gadget').hits).toHaveLength(0);
  });

  it('incremental after a full reindex does no work (full build seeds file_meta)', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({ uuid: 'x', text: 'seeded content here' }) + '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir); // full build now also seeds file_meta
    const inc = idx.reindexIncremental(chatsDir);
    expect({ updated: inc.updated, removed: inc.removed }).toEqual({
      updated: 0,
      removed: 0,
    });
    expect(idx.query('seeded').hits).toHaveLength(1);
  });

  it('indexes and finds CJK content (substring, ≥3 chars via trigram)', async () => {
    await writeFile(
      join(chatsDir, `${ID(1)}.jsonl`),
      rec({ uuid: 'zh', text: '请刷新 OAuth 令牌然后重试' }) +
        '\n' +
        rec({ uuid: 'en', text: 'unrelated english content' }) +
        '\n',
    );
    idx = SearchIndex.open(dbPath);
    idx.reindex(chatsDir);
    // A ≥3-char CJK substring matches inside the space-less run 令牌然后重试.
    expect(idx.query('令牌然').hits.map((h) => h.eventId)).toEqual(['zh']);
    // Case-insensitive substring on a mid-word ASCII match (OAuth).
    expect(idx.query('auth').hits.map((h) => h.eventId)).toEqual(['zh']);
    // The trigram floor is uniform across scripts: a <3-char term (incl. the
    // 2-char word 令牌) can't match via the index — documented, hinted by the CLI.
    expect(idx.query('令牌').hits).toHaveLength(0);
    expect(idx.query('ok').hits).toHaveLength(0);
  });

  it('a missing chats dir yields an empty index, not an error', async () => {
    idx = SearchIndex.open(dbPath);
    const { files, records } = idx.reindex(join(chatsDir, 'does-not-exist'));
    expect({ files, records }).toEqual({ files: 0, records: 0 });
    expect(idx.query('anything').hits).toHaveLength(0);
  });
});
