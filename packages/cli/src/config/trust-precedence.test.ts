/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type {
  TrustPrecedenceRule,
  TrustRuleLevel,
} from './trust-precedence.js';
import { resolveTrustDecision, resolveTrustRule } from './trust-precedence.js';

/**
 * Builds a rule without touching the filesystem, so these cases stay pure and
 * run identically on every platform.
 */
function rule<T>(
  level: TrustRuleLevel,
  rulePath: string,
  payload?: T,
): TrustPrecedenceRule<T> {
  return {
    level,
    variants: new Set([path.normalize(path.resolve(rulePath))]),
    ...(payload === undefined ? {} : { payload }),
  };
}

function variantsOf(location: string): ReadonlySet<string> {
  return new Set([path.normalize(path.resolve(location))]);
}

function decide(
  rules: Array<TrustPrecedenceRule<unknown>>,
  location: string,
): boolean | undefined {
  return resolveTrustDecision(rules, variantsOf(location));
}

describe('resolveTrustDecision', () => {
  it('returns undefined when no rule covers the location', () => {
    const rules = [rule('trusted', '/projects/a')];
    expect(decide(rules, '/elsewhere')).toBeUndefined();
  });

  it('applies a rule to the folder itself and to its descendants', () => {
    const rules = [rule('trusted', '/projects')];
    expect(decide(rules, '/projects')).toBe(true);
    expect(decide(rules, '/projects/deeply/nested/pkg')).toBe(true);
  });

  it('lets a nested distrust rule override a trusted ancestor', () => {
    const rules = [
      rule('trusted', '/projects'),
      rule('untrusted', '/projects/evil'),
    ];
    expect(decide(rules, '/projects/safe')).toBe(true);
    expect(decide(rules, '/projects/evil')).toBe(false);
  });

  it('extends nested distrust to the distrusted folder descendants', () => {
    // The #8627 bypass: an exact-match-only distrust rule leaves every
    // subdirectory of the distrusted repo inheriting the ancestor trust.
    const rules = [
      rule('trusted', '/projects'),
      rule('untrusted', '/projects/evil'),
    ];
    expect(decide(rules, '/projects/evil/packages/foo')).toBe(false);
  });

  it('lets a nested trust rule override a distrusted ancestor', () => {
    // Blanket distrust with an explicit opt-in must keep working, which is why
    // distrust cannot simply be matched by containment first.
    const rules = [
      rule('untrusted', '/projects'),
      rule('trusted', '/projects/good'),
    ];
    expect(decide(rules, '/projects/good')).toBe(true);
    expect(decide(rules, '/projects/good/src')).toBe(true);
    expect(decide(rules, '/projects/other')).toBe(false);
  });

  it('resolves alternating rules by the deepest match', () => {
    const rules = [
      rule('trusted', '/a'),
      rule('untrusted', '/a/b'),
      rule('trusted', '/a/b/c'),
      rule('untrusted', '/a/b/c/d'),
    ];
    expect(decide(rules, '/a/x')).toBe(true);
    expect(decide(rules, '/a/b/x')).toBe(false);
    expect(decide(rules, '/a/b/c/x')).toBe(true);
    expect(decide(rules, '/a/b/c/d/x')).toBe(false);
  });

  it('is independent of the order rules are supplied in', () => {
    const rules = [
      rule('trusted', '/projects'),
      rule('untrusted', '/projects/evil'),
      rule('trusted', '/projects/evil/allowed'),
    ];
    const reversed = [...rules].reverse();
    for (const location of [
      '/projects/x',
      '/projects/evil/x',
      '/projects/evil/allowed/x',
    ]) {
      expect(decide(rules, location)).toBe(decide(reversed, location));
    }
  });

  it('lets distrust win when two rules target the same folder', () => {
    const trustedFirst = [
      rule('trusted', '/projects/a'),
      rule('untrusted', '/projects/a'),
    ];
    expect(decide(trustedFirst, '/projects/a')).toBe(false);
    expect(decide([...trustedFirst].reverse(), '/projects/a')).toBe(false);
  });
});

describe('resolveTrustRule', () => {
  it('returns the payload of the deciding rule', () => {
    const rules = [
      rule('trusted', '/projects', 'TRUST_FOLDER'),
      rule('untrusted', '/projects/evil', 'DO_NOT_TRUST'),
    ];
    expect(
      resolveTrustRule(rules, variantsOf('/projects/evil/pkg'))?.payload,
    ).toBe('DO_NOT_TRUST');
    expect(resolveTrustRule(rules, variantsOf('/projects/pkg'))?.payload).toBe(
      'TRUST_FOLDER',
    );
  });

  it('returns undefined when nothing matches', () => {
    expect(
      resolveTrustRule([rule('trusted', '/a', 'x')], variantsOf('/b')),
    ).toBeUndefined();
  });
});
