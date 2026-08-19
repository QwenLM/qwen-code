/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseSearchArgs,
  formatSearchResults,
  formatSearchResultsJson,
  buildSearchApiQuery,
  searchFromApiResponse,
} from './searchCli.js';
import type { SearchResult } from './transcripts.js';

describe('parseSearchArgs', () => {
  it('joins the positional query and defaults the opts', () => {
    const r = parseSearchArgs(['oauth', 'flow']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.query).toBe('oauth flow');
    expect(r.value.cwd).toBeUndefined();
    expect(r.value.opts).toEqual({});
  });

  it('usage error when no query is given', () => {
    const r = parseSearchArgs(['--kind=user']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('usage:');
  });

  it('parses kind/session/limit/cwd/since/until flags', () => {
    const r = parseSearchArgs([
      'oauth',
      '--kind=assistant',
      '--session=s1',
      '--limit=10',
      '--cwd=/w',
      '--since=2026-06-01T00:00:00.000Z',
      '--until=2026-06-10T00:00:00.000Z',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe('/w');
    expect(r.value.opts).toEqual({
      kind: 'assistant',
      sessionId: 's1',
      limit: 10,
      since: Date.parse('2026-06-01T00:00:00.000Z'),
      until: Date.parse('2026-06-10T00:00:00.000Z'),
    });
  });

  it('defaults json/rank false and reads the bare --json / --rank flags', () => {
    const off = parseSearchArgs(['oauth']);
    expect(off.ok && off.value.json).toBe(false);
    expect(off.ok && off.value.rank).toBe(false);
    const on = parseSearchArgs(['oauth', '--json', '--rank']);
    expect(on.ok && on.value.json).toBe(true);
    expect(on.ok && on.value.rank).toBe(true);
    // The flags must not leak into the positional query.
    expect(on.ok && on.value.query).toBe('oauth');
  });

  it('rejects an invalid kind', () => {
    const r = parseSearchArgs(['q', '--kind=bogus']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('invalid --kind');
  });

  it('rejects a non-numeric / non-positive limit', () => {
    expect(parseSearchArgs(['q', '--limit=abc']).ok).toBe(false);
    expect(parseSearchArgs(['q', '--limit=0']).ok).toBe(false);
  });

  it('rejects an unparseable since/until', () => {
    const s = parseSearchArgs(['q', '--since=not-a-date']);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toContain('invalid --since');
    const u = parseSearchArgs(['q', '--until=nope']);
    expect(u.ok).toBe(false);
  });
});

describe('formatSearchResults', () => {
  const mk = (hits: SearchResult['hits'], truncated = false): SearchResult => ({
    hits,
    truncated,
  });

  it('(no hits) when empty', () => {
    expect(formatSearchResults(mk([]))).toBe('(no hits)');
  });

  it('renders a header + indented snippet per hit and a count footer', () => {
    const out = formatSearchResults(
      mk([
        {
          sessionId: 's1',
          eventId: 'e1',
          kind: 'assistant',
          ts: '2026-06-01T00:00:00.000Z',
          snippet: 'the oauth flow',
        },
      ]),
    );
    expect(out).toContain('2026-06-01T00:00:00.000Z  [assistant]  s1');
    expect(out).toContain('\n  the oauth flow');
    expect(out).toContain('1 hit(s)');
    expect(out).not.toContain('(truncated)');
  });

  it('marks a truncated result set', () => {
    const out = formatSearchResults(
      mk(
        [
          {
            sessionId: 's',
            eventId: 'e',
            kind: 'user',
            ts: 't',
            snippet: '',
          },
        ],
        true,
      ),
    );
    expect(out).toContain('1 hit(s) (truncated)');
  });
});

describe('formatSearchResultsJson', () => {
  it('emits a stable {hits, truncated} JSON object with the SearchHit fields', () => {
    const result: SearchResult = {
      hits: [
        {
          sessionId: 's1',
          eventId: 'e1',
          kind: 'assistant',
          ts: '2026-06-01T00:00:00.000Z',
          snippet: 'the oauth flow',
        },
      ],
      truncated: true,
    };
    const parsed = JSON.parse(formatSearchResultsJson(result));
    expect(parsed).toEqual(result);
  });

  it('emits an empty hits array (not "(no hits)") for no matches', () => {
    expect(
      JSON.parse(formatSearchResultsJson({ hits: [], truncated: false })),
    ).toEqual({ hits: [], truncated: false });
  });
});

describe('buildSearchApiQuery', () => {
  it('always carries q; omits unset opts', () => {
    const parsed = parseSearchArgs(['oauth', 'flow']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const params = new URLSearchParams(buildSearchApiQuery(parsed.value));
    expect(params.get('q')).toBe('oauth flow');
    expect([...params.keys()]).toEqual(['q']);
  });

  it('sends kind/session/limit and converts since/until to ISO-8601', () => {
    const parsed = parseSearchArgs([
      'oauth',
      '--kind=assistant',
      '--session=s1',
      '--limit=10',
      '--since=2026-06-01T00:00:00.000Z',
      '--until=2026-06-10T00:00:00.000Z',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const params = new URLSearchParams(buildSearchApiQuery(parsed.value));
    expect(params.get('q')).toBe('oauth');
    expect(params.get('kind')).toBe('assistant');
    expect(params.get('sessionId')).toBe('s1');
    expect(params.get('limit')).toBe('10');
    expect(params.get('since')).toBe('2026-06-01T00:00:00.000Z');
    expect(params.get('until')).toBe('2026-06-10T00:00:00.000Z');
    expect(params.get('rank')).toBeNull();
  });

  it('maps --rank to rank=bm25 and never sends --cwd', () => {
    const parsed = parseSearchArgs(['oauth', '--rank', '--cwd=/local-only']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const qs = buildSearchApiQuery(parsed.value);
    expect(new URLSearchParams(qs).get('rank')).toBe('bm25');
    expect(qs).not.toContain('cwd');
  });
});

describe('searchFromApiResponse', () => {
  it('passes a well-formed body through, dropping the route extras', () => {
    const body = {
      hits: [
        {
          sessionId: 's1',
          eventId: 'e1',
          kind: 'assistant',
          ts: '2026-06-01T00:00:00.000Z',
          snippet: 'the oauth flow',
        },
      ],
      truncated: true,
      elapsedMs: 12,
      mode: 'bm25',
    };
    expect(searchFromApiResponse(body)).toEqual({
      hits: body.hits,
      truncated: true,
    });
  });

  it('drops hits without a string sessionId', () => {
    const r = searchFromApiResponse({
      hits: [
        { sessionId: 7, eventId: 'e', kind: 'user', ts: 't', snippet: '' },
        null,
      ],
    });
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('yields an empty result for a malformed body', () => {
    expect(searchFromApiResponse(undefined)).toEqual({
      hits: [],
      truncated: false,
    });
    expect(searchFromApiResponse({ hits: 'x' })).toEqual({
      hits: [],
      truncated: false,
    });
  });
});
