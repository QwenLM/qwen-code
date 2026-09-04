/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getPathComparisonVariants } from './path-comparison.js';
import {
  buildTrustPrecedenceRules,
  resolveTrustDecision,
  resolveTrustRule,
} from './trust-precedence.js';

function decision(
  config: Record<string, 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST'>,
  location: string,
): boolean | undefined {
  return resolveTrustDecision(
    buildTrustPrecedenceRules(
      Object.entries(config).map(([path, trustLevel]) => ({
        path,
        trustLevel,
      })),
    ),
    getPathComparisonVariants(location),
  );
}

describe('trust precedence', () => {
  it('uses the deepest matching rule in either direction', () => {
    const config = {
      '/projects': 'TRUST_FOLDER' as const,
      '/projects/evil': 'DO_NOT_TRUST' as const,
      '/projects/good': 'TRUST_FOLDER' as const,
    };

    expect(decision(config, '/projects/evil/packages/foo')).toBe(false);
    expect(decision(config, '/projects/good/src')).toBe(true);
  });

  it('is independent of persisted rule insertion order', () => {
    const forward = {
      '/projects': 'TRUST_FOLDER' as const,
      '/projects/evil': 'DO_NOT_TRUST' as const,
    };
    const reversed = {
      '/projects/evil': 'DO_NOT_TRUST' as const,
      '/projects': 'TRUST_FOLDER' as const,
    };

    expect(decision(forward, '/projects/evil/src')).toBe(false);
    expect(decision(reversed, '/projects/evil/src')).toBe(false);
  });

  it('lets distrust win an exact-depth tie', () => {
    const winner = resolveTrustRule(
      [
        {
          level: 'trusted' as const,
          variants: getPathComparisonVariants('/projects/evil'),
        },
        {
          level: 'untrusted' as const,
          variants: getPathComparisonVariants('/projects/evil'),
        },
      ],
      getPathComparisonVariants('/projects/evil/src'),
    );

    expect(winner?.level).toBe('untrusted');
  });

  it('collapses TRUST_PARENT before applying specificity', () => {
    const config = {
      '/projects': 'DO_NOT_TRUST' as const,
      '/projects/good/marker': 'TRUST_PARENT' as const,
    };

    expect(decision(config, '/projects/good/src')).toBe(true);
    expect(decision(config, '/projects/other/src')).toBe(false);
  });

  it('returns undefined when no rule contains the location', () => {
    expect(
      decision({ '/projects': 'TRUST_FOLDER' }, '/other/project'),
    ).toBeUndefined();
  });
});
