/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { globMatch, matchesAny } from './glob.js';

describe('globMatch', () => {
  it('matches a prefix glob: "npm test*" matches "npm test -- --watch"', () => {
    expect(globMatch('npm test*', 'npm test -- --watch')).toBe(true);
  });

  it('is anchored (full match): "npm test*" does NOT match "pnpm test"', () => {
    expect(globMatch('npm test*', 'pnpm test')).toBe(false);
  });

  it('matches every character literally: "a.b" does not match "axb"', () => {
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('a.b', 'a.b')).toBe(true);
  });

  it('treats * as matching empty', () => {
    expect(globMatch('npm*', 'npm')).toBe(true);
  });

  it('"src/auth/**" matches "src/auth/login.ts"', () => {
    expect(globMatch('src/auth/**', 'src/auth/login.ts')).toBe(true);
  });

  it('does not allow regex injection via metacharacters', () => {
    // '+' is literal, not a quantifier.
    expect(globMatch('a+b', 'aaab')).toBe(false);
    expect(globMatch('a+b', 'a+b')).toBe(true);
    // Parens/brackets literal.
    expect(globMatch('(x)', 'x')).toBe(false);
    expect(globMatch('(x)', '(x)')).toBe(true);
  });

  it('handles a star in the middle', () => {
    expect(globMatch('git*force', 'git push --force')).toBe(true);
    expect(globMatch('git*force', 'git push --soft')).toBe(false);
  });

  it('is NOT vulnerable to ReDoS on interleaved-star globs', () => {
    // A regex `^.*a.*a.*…$` backtracks catastrophically on a long non-matching
    // tail; the linear matcher completes effectively instantly. Guard with a
    // wall-clock bound so a regression (reintroducing a backtracking regex)
    // fails loudly instead of hanging the suite.
    const glob = '*a'.repeat(30); // 30 interleaved stars
    const value = 'a'.repeat(5000) + '!'; // long, ends non-matching
    const start = Date.now();
    expect(globMatch(glob, value)).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('matchesAny', () => {
  it('returns true for an undefined glob field (absent does not constrain)', () => {
    expect(matchesAny(undefined, 'anything')).toBe(true);
  });

  it('matches a single string glob', () => {
    expect(matchesAny('npm test*', 'npm test x')).toBe(true);
    expect(matchesAny('npm test*', 'yarn test')).toBe(false);
  });

  it('OR-matches an array of globs', () => {
    expect(matchesAny(['git push*', 'npm test*'], 'npm test x')).toBe(true);
    expect(matchesAny(['git push*', 'npm test*'], 'rm -rf /')).toBe(false);
  });
});
