/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseQuery, matchesQuery } from './query.js';

/** Convenience: does `q` match `hay` (hay lowercased as searchTranscripts does)? */
function m(q: string, hay: string): boolean {
  return matchesQuery(parseQuery(q), hay.toLowerCase());
}

describe('parseQuery', () => {
  it('plain space-separated words → one AND group of plain terms (back-compat)', () => {
    const plan = parseQuery('oauth Flow');
    expect(plan.orGroups).toEqual([
      [
        { kind: 'plain', value: 'oauth', negated: false },
        { kind: 'plain', value: 'flow', negated: false },
      ],
    ]);
    expect(plan.seed).toBe('oauth');
  });

  it('empty / whitespace / lone * / OR-only → no groups', () => {
    expect(parseQuery('').orGroups).toEqual([]);
    expect(parseQuery('   ').orGroups).toEqual([]);
    expect(parseQuery('*').orGroups).toEqual([]);
    expect(parseQuery('OR').orGroups).toEqual([]);
    expect(parseQuery('OR OR').orGroups).toEqual([]);
  });

  it('uppercase-only operators: lowercase or/not/and are plain terms', () => {
    const plan = parseQuery('error or warning');
    expect(plan.orGroups).toEqual([
      [
        { kind: 'plain', value: 'error', negated: false },
        { kind: 'plain', value: 'or', negated: false },
        { kind: 'plain', value: 'warning', negated: false },
      ],
    ]);
    // `not found` stays a 2-term AND, NOT a negation.
    expect(parseQuery('not found').orGroups[0]).toEqual([
      { kind: 'plain', value: 'not', negated: false },
      { kind: 'plain', value: 'found', negated: false },
    ]);
  });

  it('OR splits groups; AND is a no-op keyword', () => {
    expect(parseQuery('a b OR c d').orGroups).toEqual([
      [
        { kind: 'plain', value: 'a', negated: false },
        { kind: 'plain', value: 'b', negated: false },
      ],
      [
        { kind: 'plain', value: 'c', negated: false },
        { kind: 'plain', value: 'd', negated: false },
      ],
    ]);
    expect(parseQuery('a AND b').orGroups).toEqual([
      [
        { kind: 'plain', value: 'a', negated: false },
        { kind: 'plain', value: 'b', negated: false },
      ],
    ]);
  });

  it('negation via -term and NOT term', () => {
    expect(parseQuery('-foo').orGroups[0]).toEqual([
      { kind: 'plain', value: 'foo', negated: true },
    ]);
    expect(parseQuery('NOT foo').orGroups[0]).toEqual([
      { kind: 'plain', value: 'foo', negated: true },
    ]);
  });

  it('negated phrase via NOT "..." and -"..."', () => {
    expect(parseQuery('NOT "foo bar"').orGroups[0]).toEqual([
      { kind: 'phrase', value: 'foo bar', negated: true },
    ]);
    expect(parseQuery('-"foo bar"').orGroups[0]).toEqual([
      { kind: 'phrase', value: 'foo bar', negated: true },
    ]);
  });

  it('phrase normalizes internal whitespace; unclosed quote runs to end', () => {
    expect(parseQuery('"foo   bar"').orGroups[0]).toEqual([
      { kind: 'phrase', value: 'foo bar', negated: false },
    ]);
    expect(parseQuery('"unclosed phrase').orGroups[0]).toEqual([
      { kind: 'phrase', value: 'unclosed phrase', negated: false },
    ]);
  });

  it('prefix term strips the trailing *; empty stem is dropped', () => {
    expect(parseQuery('oauth*').orGroups[0]).toEqual([
      { kind: 'prefix', value: 'oauth', negated: false },
    ]);
    // a bare `*` produced no term, so this is an all-empty parse.
    expect(parseQuery('*').orGroups).toEqual([]);
  });

  it('seed is the first non-negated term; all-negation → empty seed', () => {
    expect(parseQuery('-a b').seed).toBe('b');
    expect(parseQuery('NOT a NOT b').seed).toBe('');
  });

  it('treats interior exotic/Unicode whitespace as a separator (no infinite loop)', () => {
    // Regression: the tokenizer once skipped only [ \t\n\r] but stopped words on
    // /\s/, so an interior NBSP/\v/\f/Unicode space wedged the event loop. A
    // hang would blow the per-test timeout; reaching the assertion proves it.
    for (const ws of ['\u00a0', '\v', '\f', '\u2003']) {
      expect(parseQuery(`a${ws}b`).orGroups).toEqual([
        [
          { kind: 'plain', value: 'a', negated: false },
          { kind: 'plain', value: 'b', negated: false },
        ],
      ]);
    }
  });
});

describe('matchesQuery', () => {
  it('plain AND requires every term as a substring', () => {
    expect(m('oauth flow', 'the oauth flow works')).toBe(true);
    expect(m('oauth flow', 'the oauth works')).toBe(false);
    // substring (not word-boundary) for plain terms — back-compat.
    expect(m('oauth', 'reoauthxyz')).toBe(true);
  });

  it('phrase requires the contiguous (whitespace-normalized) phrase', () => {
    expect(m('"oauth refresh"', 'an oauth refresh token')).toBe(true);
    expect(m('"oauth refresh"', 'oauth then refresh')).toBe(false);
  });

  it('prefix matches a token start, not mid-token', () => {
    expect(m('oauth*', 'an oauthToken here')).toBe(true);
    expect(m('oauth*', 'reoauth here')).toBe(false);
    expect(m('oauth*', 'plain oauth here')).toBe(true);
  });

  it('OR matches when ANY group matches', () => {
    expect(m('a b OR c', 'only c present')).toBe(true);
    expect(m('a b OR c', 'a and b present')).toBe(true);
    expect(m('a b OR c', 'none here')).toBe(false);
  });

  it('NOT / - exclude records containing the term', () => {
    expect(m('error -warning', 'an error occurred')).toBe(true);
    expect(m('error -warning', 'an error and a warning')).toBe(false);
    expect(m('NOT secret', 'public text')).toBe(true);
    expect(m('NOT secret', 'this is secret')).toBe(false);
  });

  it('combinations: a "b c" OR -d', () => {
    const plan = parseQuery('a "b c" OR -d');
    // group1: contains "a" AND phrase "b c"; group2: does NOT contain "d".
    expect(matchesQuery(plan, 'a then b c'.toLowerCase())).toBe(true); // group1 hits
    expect(matchesQuery(plan, 'has d only'.toLowerCase())).toBe(false); // g1 misses "b c"; g2 has "d"
    expect(matchesQuery(plan, 'fresh text'.toLowerCase())).toBe(true); // g2: contains no "d"
  });

  it('prefix inside an OR group: oauth* OR token', () => {
    expect(m('oauth* OR token', 'a token appears')).toBe(true);
    expect(m('oauth* OR token', 'oauthClient init')).toBe(true);
    expect(m('oauth* OR token', 'nothing relevant')).toBe(false);
  });

  it('an empty plan matches nothing', () => {
    expect(matchesQuery(parseQuery(''), 'anything')).toBe(false);
  });
});
