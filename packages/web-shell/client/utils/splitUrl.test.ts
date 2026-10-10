// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSplitUrl,
  clearSplitSessions,
  loadSplitSessions,
  parseSplitSessionIds,
  saveSplitSessions,
} from './splitUrl';

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

  it('strips the session deep-link so no single session competes', () => {
    expect(
      new URL(buildSplitUrl(['a'], 'https://host/session/x')).pathname,
    ).toBe('/');
  });

  it('preserves the deployment base path while stripping the session', () => {
    expect(
      new URL(buildSplitUrl(['a'], 'https://host/app/session/x')).pathname,
    ).toBe('/app');
  });

  it('carries the daemon token in the fragment when provided', () => {
    const url = new URL(
      buildSplitUrl(['a', 'b'], 'https://host/', 'secret-tok'),
    );
    expect(url.searchParams.get('split')).toBe('a,b');
    // In the hash, not the query — never sent to the server / logs.
    expect(url.search).not.toContain('secret-tok');
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(
      'secret-tok',
    );
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

describe('split session persistence (sessionStorage)', () => {
  // Move the daemon target the way a real navigation does — same tab, same PAGE
  // origin, only the query changes (history Back/Forward, a bookmark, an
  // address-bar edit). None of those go through navigateToDaemon.
  function setDaemonParam(value: string | null) {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete('daemon');
    else url.searchParams.set('daemon', value);
    window.history.replaceState({}, '', url.toString());
  }

  beforeEach(() => {
    sessionStorage.clear();
    setDaemonParam(null);
  });

  it('round-trips the saved session set', () => {
    saveSplitSessions(['s1', 's2', 's3']);
    expect(loadSplitSessions()).toEqual(['s1', 's2', 's3']);
  });

  it('returns an empty array when nothing is saved', () => {
    expect(loadSplitSessions()).toEqual([]);
  });

  it('dedupes, drops blanks, and caps at MAX_SPLIT_PANES (6)', () => {
    saveSplitSessions(['a', 'a', '', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(loadSplitSessions()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('clears the saved set', () => {
    saveSplitSessions(['s1', 's2']);
    clearSplitSessions();
    expect(loadSplitSessions()).toEqual([]);
  });

  it('drops the owner tag along with the set on clear', () => {
    saveSplitSessions(['s1']);
    clearSplitSessions();
    expect(
      sessionStorage.getItem('qwen-webshell-split-sessions-for'),
    ).toBeNull();
  });

  it('falls back to [] on malformed stored JSON', () => {
    // Seed the owner tag through the real save path, then corrupt only the ids:
    // without it the owner guard — not the malformed JSON — is what returns [].
    saveSplitSessions(['s1']);
    sessionStorage.setItem('qwen-webshell-split-sessions', '{not json');
    expect(loadSplitSessions()).toEqual([]);
  });

  it('falls back to [] when the stored value is not an array', () => {
    saveSplitSessions(['s1']);
    sessionStorage.setItem('qwen-webshell-split-sessions', '"s1"');
    expect(loadSplitSessions()).toEqual([]);
  });

  // sessionStorage is partitioned by the PAGE origin, which a `?daemon=` switch
  // does not change, so one storage is shared by every target this tab visited.
  it('ignores a set saved for a different daemon target', () => {
    setDaemonParam('http://dev-box:4170');
    saveSplitSessions(['d1', 'd2']);
    expect(loadSplitSessions()).toEqual(['d1', 'd2']);
    // The operator pressed Back: the target is the page origin again, and these
    // ids belong to a daemon that 404s on them and then re-saves the survivors.
    setDaemonParam(null);
    expect(loadSplitSessions()).toEqual([]);
  });

  it('does not apply the page-origin set to a remote target either', () => {
    saveSplitSessions(['p1']);
    expect(loadSplitSessions()).toEqual(['p1']);
    setDaemonParam('http://dev-box:4170');
    expect(loadSplitSessions()).toEqual([]);
  });
});
