/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { globToRegExp, matchesAny } from './glob.js';

describe('globToRegExp', () => {
  it('matches a prefix glob: "npm test*" matches "npm test -- --watch"', () => {
    expect(globToRegExp('npm test*').test('npm test -- --watch')).toBe(true);
  });

  it('is anchored: "npm test*" does NOT match "pnpm test"', () => {
    expect(globToRegExp('npm test*').test('pnpm test')).toBe(false);
  });

  it('escapes regex metacharacters: "a.b" does not match "axb"', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });

  it('treats * as matching empty', () => {
    expect(globToRegExp('npm*').test('npm')).toBe(true);
  });

  it('"src/auth/**" matches "src/auth/login.ts"', () => {
    expect(globToRegExp('src/auth/**').test('src/auth/login.ts')).toBe(true);
  });

  it('does not allow regex injection via metacharacters', () => {
    // The '+' must be literal, not a quantifier.
    expect(globToRegExp('a+b').test('aaab')).toBe(false);
    expect(globToRegExp('a+b').test('a+b')).toBe(true);
    // Parens/brackets literal.
    expect(globToRegExp('(x)').test('x')).toBe(false);
    expect(globToRegExp('(x)').test('(x)')).toBe(true);
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
