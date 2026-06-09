/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { searchTranscripts, resolveChatsDir } from './transcripts.js';

interface Rec {
  uuid: string;
  parentUuid?: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  cwd?: string;
  message?: { role?: string; parts?: Array<{ text?: string }> };
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

describe('resolveChatsDir', () => {
  it('encodes the whole cwd into one dir segment (slashes → dashes)', () => {
    expect(resolveChatsDir('/home/u/proj')).toBe(
      join(homedir(), '.qwen', 'projects', '-home-u-proj', 'chats'),
    );
  });

  it('encodes dots as dashes too (the /. → -- case)', () => {
    expect(resolveChatsDir('/home/u/.x')).toBe(
      join(homedir(), '.qwen', 'projects', '-home-u--x', 'chats'),
    );
  });
});

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
});
