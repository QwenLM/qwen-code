/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  searchTranscripts,
  searchTranscriptsDetailed,
  SearchTimeoutError,
} from './transcripts.js';

interface Rec {
  uuid: string;
  parentUuid?: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  cwd?: string;
  message?: {
    role?: string;
    parts?: Array<{ text?: string; functionResponse?: unknown }>;
  };
}

function rec(
  partial: Partial<Rec> & Pick<Rec, 'uuid' | 'sessionId' | 'type'>,
): Rec {
  return {
    timestamp: '2026-06-01T00:00:00.000Z',
    cwd: '/w',
    ...partial,
  } as Rec;
}

function textRec(
  partial: Partial<Rec> & Pick<Rec, 'uuid' | 'sessionId' | 'type'>,
  text: string,
): Rec {
  return rec({ ...partial, message: { role: 'x', parts: [{ text }] } });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-search-'));
});

function writeJsonl(name: string, recs: Array<Rec | string>): void {
  const lines = recs
    .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    .join('\n');
  writeFileSync(join(dir, name), lines + '\n');
}

describe('searchTranscripts', () => {
  it('AND-matches all whitespace terms (case-insensitive)', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        { uuid: 'a', sessionId: 's1', type: 'assistant' },
        'The OAuth Flow worked fine',
      ),
    ]);
    const hit = await searchTranscripts(dir, 'oauth flow');
    expect(hit).toHaveLength(1);
    expect(hit[0].eventId).toBe('a');
    expect(hit[0].snippet.toLowerCase()).toContain('oauth');

    // A term that is absent → no hit (AND semantics).
    const miss = await searchTranscripts(dir, 'oauth missing');
    expect(miss).toHaveLength(0);
  });

  it('returns [] for an empty / whitespace-only query', async () => {
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'a', sessionId: 's1', type: 'user' }, 'hello'),
    ]);
    expect(await searchTranscripts(dir, '')).toHaveLength(0);
    expect(await searchTranscripts(dir, '   ')).toHaveLength(0);
  });

  it('filters by kind (user only)', async () => {
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'u', sessionId: 's1', type: 'user' }, 'token here'),
      textRec({ uuid: 'a', sessionId: 's1', type: 'assistant' }, 'token here'),
    ]);
    const hits = await searchTranscripts(dir, 'token', { kind: 'user' });
    expect(hits.map((h) => h.eventId)).toEqual(['u']);
  });

  it('maps kind=tool to record type tool_result', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        { uuid: 't', sessionId: 's1', type: 'tool_result' },
        'token here',
      ),
      textRec({ uuid: 'a', sessionId: 's1', type: 'assistant' }, 'token here'),
    ]);
    const hits = await searchTranscripts(dir, 'token', { kind: 'tool' });
    expect(hits.map((h) => h.eventId)).toEqual(['t']);
    expect(hits[0].kind).toBe('tool_result');
  });

  it('searches tool_result content carried under functionResponse (not parts[].text)', async () => {
    // Real tool_result records store their output under functionResponse, not
    // text — search must reach into it or tool output is invisible.
    writeJsonl('s1.jsonl', [
      rec({
        uuid: 'tr',
        sessionId: 's1',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'run_shell_command',
                response: { output: 'Compiled FILTER_HIPASS successfully' },
              },
            },
          ],
        },
      }),
    ]);
    const hits = await searchTranscripts(dir, 'filter_hipass', {
      kind: 'tool',
    });
    expect(hits.map((h) => h.eventId)).toEqual(['tr']);
    expect(hits[0].snippet.toLowerCase()).toContain('filter_hipass');
  });

  it('filters by sessionId', async () => {
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'a', sessionId: 's1', type: 'user' }, 'shared term'),
    ]);
    writeJsonl('s2.jsonl', [
      textRec({ uuid: 'b', sessionId: 's2', type: 'user' }, 'shared term'),
    ]);
    const hits = await searchTranscripts(dir, 'shared', { sessionId: 's2' });
    expect(hits.map((h) => h.eventId)).toEqual(['b']);
  });

  it('skips corrupt / non-JSON lines', async () => {
    writeJsonl('s1.jsonl', [
      'not json at all {',
      textRec({ uuid: 'a', sessionId: 's1', type: 'user' }, 'good token'),
      '{ partial',
    ]);
    const hits = await searchTranscripts(dir, 'token');
    expect(hits.map((h) => h.eventId)).toEqual(['a']);
  });

  it('returns [] when the chats dir is missing (ENOENT)', async () => {
    const hits = await searchTranscripts(join(dir, 'does-not-exist'), 'x');
    expect(hits).toEqual([]);
  });

  it('clamps the limit to 1..200 and defaults to 50', async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 60; i++) {
      recs.push(
        textRec(
          {
            uuid: `u${i}`,
            sessionId: 's1',
            type: 'user',
            timestamp: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          },
          'common',
        ),
      );
    }
    writeJsonl('s1.jsonl', recs);
    expect(await searchTranscripts(dir, 'common')).toHaveLength(50);
    expect(await searchTranscripts(dir, 'common', { limit: 5 })).toHaveLength(
      5,
    );
    // Below-range clamps up to 1.
    expect(await searchTranscripts(dir, 'common', { limit: 0 })).toHaveLength(
      1,
    );
    // Above-range clamps to 200 (only 60 records here).
    expect(
      await searchTranscripts(dir, 'common', { limit: 9999 }),
    ).toHaveLength(60);
  });

  it('sorts by recency (newest timestamp first)', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        {
          uuid: 'old',
          sessionId: 's1',
          type: 'user',
          timestamp: '2026-06-01T00:00:00.000Z',
        },
        'common',
      ),
      textRec(
        {
          uuid: 'new',
          sessionId: 's1',
          type: 'user',
          timestamp: '2026-06-05T00:00:00.000Z',
        },
        'common',
      ),
      textRec(
        {
          uuid: 'mid',
          sessionId: 's1',
          type: 'user',
          timestamp: '2026-06-03T00:00:00.000Z',
        },
        'common',
      ),
    ]);
    const hits = await searchTranscripts(dir, 'common');
    expect(hits.map((h) => h.eventId)).toEqual(['new', 'mid', 'old']);
  });

  it('produces a single-line snippet of at most 200 chars', async () => {
    const long =
      'prefix '.repeat(40) + 'NEEDLE\nwith\nnewlines ' + 'suffix '.repeat(40);
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'a', sessionId: 's1', type: 'assistant' }, long),
    ]);
    const hits = await searchTranscripts(dir, 'needle');
    expect(hits).toHaveLength(1);
    const snip = hits[0].snippet;
    expect(snip.length).toBeLessThanOrEqual(200);
    expect(snip).not.toContain('\n');
    expect(snip.toLowerCase()).toContain('needle');
  });

  it('honors a quoted phrase (contiguous, not just both words)', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        { uuid: 'a', sessionId: 's1', type: 'assistant' },
        'we hit an oauth refresh error',
      ),
      textRec(
        { uuid: 'b', sessionId: 's1', type: 'assistant' },
        'oauth worked but later a refresh failed',
      ),
    ]);
    const hits = await searchTranscripts(dir, '"oauth refresh"');
    expect(hits.map((h) => h.eventId)).toEqual(['a']);
  });

  it('honors OR across groups', async () => {
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'a', sessionId: 's1', type: 'assistant' }, 'about cats'),
      textRec({ uuid: 'b', sessionId: 's1', type: 'assistant' }, 'about dogs'),
      textRec({ uuid: 'c', sessionId: 's1', type: 'assistant' }, 'about fish'),
    ]);
    const hits = await searchTranscripts(dir, 'cats OR dogs');
    expect(hits.map((h) => h.eventId).sort()).toEqual(['a', 'b']);
  });

  it('honors NOT / - exclusion', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        { uuid: 'a', sessionId: 's1', type: 'assistant' },
        'an error happened',
      ),
      textRec(
        { uuid: 'b', sessionId: 's1', type: 'assistant' },
        'an error and a warning',
      ),
    ]);
    const hits = await searchTranscripts(dir, 'error -warning');
    expect(hits.map((h) => h.eventId)).toEqual(['a']);
  });

  it('honors a prefix wildcard at a word boundary', async () => {
    writeJsonl('s1.jsonl', [
      textRec(
        { uuid: 'a', sessionId: 's1', type: 'assistant' },
        'init the oauthClient now',
      ),
      textRec(
        { uuid: 'b', sessionId: 's1', type: 'assistant' },
        'this is a reoauth retry',
      ),
    ]);
    const hits = await searchTranscripts(dir, 'oauth*');
    // matches 'oauthClient' (token start) but NOT 'reoauth' (mid-token).
    expect(hits.map((h) => h.eventId)).toEqual(['a']);
  });
});

describe('searchTranscripts — per-query scan timeout (cycle 34)', () => {
  beforeEach(() => {
    writeJsonl('s1.jsonl', [
      textRec({ uuid: 'a', sessionId: 's1', type: 'assistant' }, 'oauth here'),
    ]);
    writeJsonl('s2.jsonl', [
      textRec({ uuid: 'b', sessionId: 's2', type: 'assistant' }, 'oauth there'),
    ]);
  });

  it('throws SearchTimeoutError when the injected clock passes the deadline', async () => {
    // start=0 → deadline=2000; every later read is far past it → the
    // file-loop-top check throws before completing the scan.
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 1_000_000);
    await expect(
      searchTranscripts(dir, 'oauth', { timeoutMs: 2000, now }),
    ).rejects.toBeInstanceOf(SearchTimeoutError);
  });

  it('INERT: timeoutMs unset → never throws even with a huge clock', async () => {
    // Proves commit 2 cannot throw into the still-uncatching route: with no
    // timeoutMs there is no deadline and the clock is never consulted.
    const now = () => 1_000_000;
    const hits = await searchTranscripts(dir, 'oauth', { now });
    expect(hits.map((h) => h.eventId).sort()).toEqual(['a', 'b']);
  });

  it('within budget (clock never passes the deadline) → completes normally', async () => {
    const now = () => 0; // always 0 → never > deadline (2000)
    const hits = await searchTranscripts(dir, 'oauth', {
      timeoutMs: 2000,
      now,
    });
    expect(hits.map((h) => h.eventId).sort()).toEqual(['a', 'b']);
  });

  it('a non-finite/zero/negative timeoutMs disables the timeout (no throw)', async () => {
    const now = () => 1_000_000;
    for (const timeoutMs of [Number.NaN, 0, -1, Infinity]) {
      const hits = await searchTranscripts(dir, 'oauth', { timeoutMs, now });
      expect(hits).toHaveLength(2);
    }
  });

  it('trips the per-1024-line inner check on a single large file', async () => {
    // Fresh dir with ONLY this file so readdir order can't let a file-loop-top
    // check trip first: with one file the clock reads are #1 start, #2
    // file-top (within budget), #3 the inner (every-1024-lines) check — which
    // jumps past the deadline, exercising that specific throw site.
    const bigDir = mkdtempSync(join(tmpdir(), 'rc-search-big-'));
    const lines: string[] = [];
    for (let i = 0; i < 1100; i++) {
      lines.push(
        JSON.stringify(
          textRec(
            { uuid: `u${i}`, sessionId: 'big', type: 'user' },
            'oauth row',
          ),
        ),
      );
    }
    writeFileSync(join(bigDir, 'big.jsonl'), lines.join('\n') + '\n');
    let calls = 0;
    const now = () => (calls++ < 2 ? 0 : 1_000_000);
    await expect(
      searchTranscripts(bigDir, 'oauth', { timeoutMs: 2000, now }),
    ).rejects.toBeInstanceOf(SearchTimeoutError);
  });
});

describe('searchTranscriptsDetailed — truncated (cycle 37)', () => {
  /** Write `n` distinct assistant records all matching `oauth`. */
  function writeMatches(n: number): void {
    const recs = Array.from({ length: n }, (_, i) =>
      textRec(
        {
          uuid: `u${i}`,
          sessionId: 's1',
          type: 'assistant',
          timestamp: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        },
        `oauth token ${i}`,
      ),
    );
    writeJsonl('s1.jsonl', recs);
  }

  it('truncated:false when the match count equals the clamped limit', async () => {
    writeMatches(2);
    const r = await searchTranscriptsDetailed(dir, 'oauth', { limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it('truncated:true when one more match exists than the clamped limit', async () => {
    writeMatches(3);
    const r = await searchTranscriptsDetailed(dir, 'oauth', { limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('a no-match query yields {hits:[], truncated:false}', async () => {
    writeMatches(2);
    const r = await searchTranscriptsDetailed(dir, 'nonesuch', { limit: 2 });
    expect(r).toEqual({ hits: [], truncated: false });
  });

  it('searchTranscripts returns exactly the detailed hits (delegation)', async () => {
    writeMatches(3);
    const detailed = await searchTranscriptsDetailed(dir, 'oauth', {
      limit: 2,
    });
    const delegated = await searchTranscripts(dir, 'oauth', { limit: 2 });
    expect(delegated).toEqual(detailed.hits);
  });
});

describe('searchTranscripts since/until time filter (cycle 79)', () => {
  const T = (iso: string) => Date.parse(iso);
  beforeEach(() => {
    writeJsonl('s.jsonl', [
      textRec(
        {
          uuid: 'old',
          sessionId: 's',
          type: 'assistant',
          timestamp: '2026-06-01T00:00:00.000Z',
        },
        'oauth one',
      ),
      textRec(
        {
          uuid: 'mid',
          sessionId: 's',
          type: 'assistant',
          timestamp: '2026-06-05T00:00:00.000Z',
        },
        'oauth two',
      ),
      textRec(
        {
          uuid: 'new',
          sessionId: 's',
          type: 'assistant',
          timestamp: '2026-06-10T00:00:00.000Z',
        },
        'oauth three',
      ),
    ]);
  });

  it('since excludes records older than the bound (inclusive)', async () => {
    const ids = (
      await searchTranscripts(dir, 'oauth', {
        since: T('2026-06-05T00:00:00.000Z'),
      })
    ).map((h) => h.eventId);
    expect(ids.sort()).toEqual(['mid', 'new']); // 'old' excluded; 'mid' inclusive
  });

  it('until excludes records newer than the bound (inclusive)', async () => {
    const ids = (
      await searchTranscripts(dir, 'oauth', {
        until: T('2026-06-05T00:00:00.000Z'),
      })
    ).map((h) => h.eventId);
    expect(ids.sort()).toEqual(['mid', 'old']);
  });

  it('since+until windows to the middle record', async () => {
    const ids = (
      await searchTranscripts(dir, 'oauth', {
        since: T('2026-06-03T00:00:00.000Z'),
        until: T('2026-06-07T00:00:00.000Z'),
      })
    ).map((h) => h.eventId);
    expect(ids).toEqual(['mid']);
  });

  it('excludes a record with an unparseable timestamp when filtering', async () => {
    writeJsonl('bad.jsonl', [
      textRec(
        {
          uuid: 'notime',
          sessionId: 's2',
          type: 'assistant',
          timestamp: 'not-a-date',
        },
        'oauth four',
      ),
    ]);
    const filtered = (
      await searchTranscripts(dir, 'oauth', {
        since: T('2026-06-01T00:00:00.000Z'),
      })
    ).map((h) => h.eventId);
    expect(filtered).not.toContain('notime');
    // With NO filter, the same record IS returned (byte-identical to before).
    const unfiltered = (await searchTranscripts(dir, 'oauth')).map(
      (h) => h.eventId,
    );
    expect(unfiltered).toContain('notime');
  });
});
