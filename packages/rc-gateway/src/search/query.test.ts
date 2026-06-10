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

describe('parseQuery (behavioral / back-compat)', () => {
  it('plain space-separated words → AND of substrings', () => {
    expect(m('oauth Flow', 'the oauth flow works')).toBe(true);
    expect(m('oauth Flow', 'oauth only')).toBe(false);
    expect(parseQuery('oauth Flow').seed).toBe('oauth');
  });

  it('empty / whitespace / lone * / OR-only → empty plan (matches nothing)', () => {
    for (const q of ['', '   ', '*', 'OR', 'OR OR']) {
      expect(parseQuery(q).node).toBeNull();
      expect(m(q, 'anything at all')).toBe(false);
    }
  });

  it('operators are UPPERCASE-only: lowercase or/not/and are plain terms', () => {
    // `error or warning` is a 3-term AND needing the literal "or" too. (Note
    // "or" is a substring of "err-or", so the false case must drop a term.)
    expect(m('error or warning', 'error or warning here')).toBe(true);
    expect(m('error or warning', 'just a warning')).toBe(false); // no "error"
    // `not found` is a 2-term AND, NOT a negation.
    expect(m('not found', 'not found here')).toBe(true);
    expect(m('not found', 'this found text')).toBe(false); // missing "not"
  });

  it('OR splits alternatives; AND is an accepted no-op keyword', () => {
    expect(m('a b OR c d', 'c d here')).toBe(true);
    expect(m('a b OR c d', 'a b here')).toBe(true);
    expect(m('a b OR c d', 'a only')).toBe(false);
    expect(m('a AND b', 'a b')).toBe(true);
    expect(m('a AND b', 'a only')).toBe(false);
  });

  it('negation via -term and NOT term', () => {
    expect(m('error -warning', 'an error occurred')).toBe(true);
    expect(m('error -warning', 'an error and a warning')).toBe(false);
    expect(m('NOT secret', 'public text')).toBe(true);
    expect(m('NOT secret', 'this is secret')).toBe(false);
  });

  it('negated phrase via NOT "..." and -"..."', () => {
    expect(m('NOT "foo bar"', 'baz qux')).toBe(true);
    expect(m('NOT "foo bar"', 'a foo bar here')).toBe(false);
    expect(m('-"foo bar"', 'a foo bar here')).toBe(false);
  });

  it('phrase normalizes internal whitespace; unclosed quote runs to end', () => {
    expect(m('"foo   bar"', 'x foo bar y')).toBe(true);
    expect(m('"foo   bar"', 'foo then bar')).toBe(false);
    expect(m('"unclosed phrase', 'an unclosed phrase!')).toBe(true);
  });

  it('prefix strips trailing * (token-start match); bare * is dropped', () => {
    expect(m('oauth*', 'an oauthToken here')).toBe(true);
    expect(m('oauth*', 'reoauth here')).toBe(false);
    expect(parseQuery('*').node).toBeNull();
  });

  it('seed is the first effectively non-negated term; all-negation → empty', () => {
    expect(parseQuery('-a b').seed).toBe('b');
    expect(parseQuery('NOT a NOT b').seed).toBe('');
    expect(parseQuery('a b').seed).toBe('a');
    expect(parseQuery('NOT (a b)').seed).toBe(''); // both negated by the group
  });

  it('treats interior exotic/Unicode whitespace as a separator (no infinite loop)', () => {
    for (const ws of ['\u00a0', '\v', '\f', '\u2003']) {
      expect(m(`a${ws}b`, 'has a and b')).toBe(true);
      expect(m(`a${ws}b`, 'only a')).toBe(false);
    }
  });
});

describe('parseQuery — parenthesised grouping (cycle 32)', () => {
  it('(a OR b) AND c distributes the AND over the OR', () => {
    expect(m('(a OR b) AND c', 'a c')).toBe(true);
    expect(m('(a OR b) AND c', 'b c')).toBe(true);
    expect(m('(a OR b) AND c', 'x b c y')).toBe(true);
    expect(m('(a OR b) AND c', 'a only')).toBe(false);
    expect(m('(a OR b) AND c', 'c only')).toBe(false);
  });

  it('grouping changes precedence vs the bare form', () => {
    // bare: a OR (b AND c)  —  grouped: (a OR b) AND c
    expect(m('a OR b AND c', 'a')).toBe(true); // a alone satisfies the OR
    expect(m('(a OR b) AND c', 'a')).toBe(false); // c required
  });

  it('precedence parity: a OR b AND c ≡ a OR (b AND c)', () => {
    for (const hay of ['a', 'b c', 'b', 'c', 'nothing']) {
      expect(m('a OR b AND c', hay)).toBe(m('a OR (b AND c)', hay));
    }
  });

  it('nested groups: ((a OR b) AND c) OR d', () => {
    expect(m('((a OR b) AND c) OR d', 'just d')).toBe(true);
    expect(m('((a OR b) AND c) OR d', 'a c')).toBe(true);
    expect(m('((a OR b) AND c) OR d', 'a only')).toBe(false);
    expect(m('((a OR b) AND c) OR d', 'b only')).toBe(false);
  });

  it('NOT negates a whole group', () => {
    expect(m('NOT (a OR b)', 'c only')).toBe(true);
    expect(m('NOT (a OR b)', 'has a here')).toBe(false);
    expect(m('NOT (a OR b)', 'has b here')).toBe(false);
  });

  it('a literal paren must be phrase-quoted (bare parens are grouping)', () => {
    // bare: getUser( → atom "getuser" (empty group dropped) → substring match.
    expect(m('getUser(', 'call getUser( now')).toBe(true);
    // quoted phrase keeps the paren literally.
    expect(m('"a(b"', 'x a(b y')).toBe(true);
    expect(m('"a(b"', 'x a b y')).toBe(false);
  });

  it('is total on malformed parens/operators (never throws, never loops)', () => {
    const malformed = [
      '(',
      ')',
      '()',
      '((a)',
      'a)',
      '(NOT)',
      'a AND',
      'OR b',
      'NOT',
      '((((',
      '))))',
      '(a OR) b',
      'a ) ( b',
    ];
    for (const q of malformed) {
      expect(() =>
        matchesQuery(parseQuery(q), 'some haystack text'),
      ).not.toThrow();
    }
    // A few that should reduce to a usable query:
    expect(parseQuery('(').node).toBeNull();
    expect(parseQuery('()').node).toBeNull();
    expect(parseQuery('(NOT)').node).toBeNull();
    expect(parseQuery('NOT').node).toBeNull();
    expect(m('((a)', 'has a here')).toBe(true);
    expect(m('a)', 'has a here')).toBe(true);
  });
});

describe('matchesQuery', () => {
  it('plain AND requires every term as a substring', () => {
    expect(m('oauth flow', 'the oauth flow works')).toBe(true);
    expect(m('oauth flow', 'the oauth works')).toBe(false);
    expect(m('oauth', 'reoauthxyz')).toBe(true); // substring, not word-boundary
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

  it('OR matches when ANY alternative matches', () => {
    expect(m('a b OR c', 'only c present')).toBe(true);
    expect(m('a b OR c', 'a and b present')).toBe(true);
    expect(m('a b OR c', 'none here')).toBe(false);
  });

  it('combinations: a "b c" OR -d', () => {
    expect(m('a "b c" OR -d', 'a then b c')).toBe(true); // g1 hits
    expect(m('a "b c" OR -d', 'has d only')).toBe(false); // g1 misses, g2 has d
    expect(m('a "b c" OR -d', 'fresh text')).toBe(true); // g2: no d
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
