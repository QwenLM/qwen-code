/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ghEnv, setGhHost, parseNdjson } from './gh.js';

// Host targeting is code, not prose: the subcommands thread `--host` here,
// and every gh child gets GH_HOST from ghEnv(). These tests pin the pure
// state machine; the spawn itself is exercised by the commands' own runs.
describe('setGhHost / ghEnv', () => {
  afterEach(() => setGhHost(undefined));

  it('defaults to inheriting the parent env untouched (undefined)', () => {
    expect(ghEnv()).toBeUndefined();
  });

  it('with a host set, extends the inherited env with GH_HOST', () => {
    setGhHost('github.example.com');
    const env = ghEnv();
    expect(env).toBeDefined();
    expect(env!['GH_HOST']).toBe('github.example.com');
    // Inherited keys survive — gh still needs PATH, HOME, its auth env.
    expect(env!['PATH']).toBe(process.env['PATH']);
  });

  it('accepts a host:port and resets on undefined or empty string', () => {
    setGhHost('ghe.internal:8443');
    expect(ghEnv()!['GH_HOST']).toBe('ghe.internal:8443');
    setGhHost('');
    expect(ghEnv()).toBeUndefined();
    setGhHost('ghe.internal');
    setGhHost(undefined);
    expect(ghEnv()).toBeUndefined();
  });

  it('rejects non-hostname input (an env value must never smuggle shell or spaces)', () => {
    expect(() => setGhHost('ghe.internal; rm -rf /')).toThrow(/--host/);
    expect(() => setGhHost('bad host')).toThrow(/--host/);
    expect(() => setGhHost('https://ghe.internal')).toThrow(/--host/);
  });
});

describe('parseNdjson (the paginated check-runs decode)', () => {
  it('parses one JSON value per non-blank line', () => {
    // `gh api --paginate <path> --jq '.check_runs[]'` applies the jq per page
    // and emits each element on its own line (NDJSON) — NOT one array, and NOT
    // the raw `{check_runs:[…]}{check_runs:[…]}` that a plain `--paginate` would
    // concatenate and make `JSON.parse` throw on. (`gh api` has no `--slurp`;
    // one real head had 508 check runs, so the first-page-only read missed 478.)
    expect(parseNdjson('{"name":"a"}\n{"name":"b"}\n{"name":"c"}')).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
  });

  it('is strict by default — a non-JSON line throws rather than fail open', () => {
    // A check-runs snapshot feeds CI classification, and silently dropping a
    // malformed line could hide a *failing* run — the fail-open the pagination
    // fix closed, reintroduced by lenient parsing. So the default throws.
    expect(() =>
      parseNdjson('{"name":"a"}\ngh version 2.x available\n{"name":"b"}'),
    ).toThrow();
  });

  it('skips a non-JSON line only when explicitly non-strict', () => {
    // The opt-in for a caller that genuinely expects interleaved notices and
    // can tolerate a lost record — not the check-runs path.
    expect(
      parseNdjson('{"name":"a"}\ngh version 2.x available\n{"name":"b"}', {
        strict: false,
      }),
    ).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('returns [] for an empty response and ignores blank lines', () => {
    expect(parseNdjson('')).toEqual([]);
    expect(parseNdjson('{"name":"a"}\n\n')).toEqual([{ name: 'a' }]);
  });
});
