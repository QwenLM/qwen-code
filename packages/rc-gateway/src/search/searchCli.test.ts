/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSearchArgs, formatSearchResults } from './searchCli.js';
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
