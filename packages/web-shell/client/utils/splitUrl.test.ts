/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSplitUrl, parseSplitSessionIds } from './splitUrl';

describe('buildSplitUrl', () => {
  it('opens the split for the given sessions on the same origin', () => {
    expect(
      buildSplitUrl(['a', 'b'], 'https://host:7777/session/other?x=1'),
    ).toBe('https://host:7777/?x=1&split=a%2Cb');
  });

  it('preserves the daemon/token query a dev deployment relies on', () => {
    const url = buildSplitUrl(
      ['s1', 's2'],
      'http://localhost:5173/?daemon=http://localhost:9000&token=secret',
    );
    expect(url).toContain('daemon=http');
    expect(url).toContain('token=secret');
    expect(url).toContain('split=s1%2Cs2');
  });

  it('resets the path so no single-session deep-link competes', () => {
    expect(new URL(buildSplitUrl(['a'], 'https://host/session/x')).pathname).toBe(
      '/',
    );
  });

  it('carries the daemon token in the fragment when provided', () => {
    const url = new URL(buildSplitUrl(['a', 'b'], 'https://host/', 'secret-tok'));
    expect(url.searchParams.get('split')).toBe('a,b');
    // In the hash, not the query — never sent to the server / logs.
    expect(url.search).not.toContain('secret-tok');
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe('secret-tok');
  });

  it('adds no fragment when no token is given', () => {
    expect(buildSplitUrl(['a'], 'https://host/')).not.toContain('#');
  });
});

describe('parseSplitSessionIds', () => {
  it('reads the comma-separated ids', () => {
    expect(parseSplitSessionIds('?split=a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('round-trips with buildSplitUrl', () => {
    const url = new URL(buildSplitUrl(['s1', 's2'], 'https://host/'));
    expect(parseSplitSessionIds(url.search)).toEqual(['s1', 's2']);
  });

  it('returns an empty array when the param is absent or empty', () => {
    expect(parseSplitSessionIds('')).toEqual([]);
    expect(parseSplitSessionIds('?split=')).toEqual([]);
    expect(parseSplitSessionIds('?other=1')).toEqual([]);
  });

  it('trims and drops blank ids', () => {
    expect(parseSplitSessionIds('?split=a,,%20b%20,')).toEqual(['a', 'b']);
  });
});
