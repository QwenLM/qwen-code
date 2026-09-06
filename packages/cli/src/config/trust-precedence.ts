/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { getPathComparisonVariants, isWithinRoot } from './path-comparison.js';

export type TrustRuleLevel = 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST';

export interface TrustPrecedenceRule<TPayload = undefined> {
  readonly level: 'trusted' | 'untrusted';
  readonly variants: ReadonlySet<string>;
  readonly payload?: TPayload;
}

function pathDepth(value: string): number {
  const root = path.parse(value).root;
  const relative = path.relative(root, value);
  return relative === '' ? 0 : relative.split(path.sep).filter(Boolean).length;
}

function matchingDepth<TPayload>(
  rule: TrustPrecedenceRule<TPayload>,
  locationVariants: ReadonlySet<string>,
): number {
  let deepestMatch = -1;
  for (const locationVariant of locationVariants) {
    for (const ruleVariant of rule.variants) {
      if (isWithinRoot(locationVariant, ruleVariant)) {
        deepestMatch = Math.max(deepestMatch, pathDepth(ruleVariant));
      }
    }
  }
  return deepestMatch;
}

/**
 * Convert persisted folder-trust rules into the shared precedence shape.
 * TRUST_PARENT is resolved to the containing directory before matching.
 */
export function buildTrustPrecedenceRules<T extends string>(
  rules: Iterable<{ path: string; trustLevel: T }>,
): Array<TrustPrecedenceRule<T>> {
  const result: Array<TrustPrecedenceRule<T>> = [];
  for (const rule of rules) {
    let level: TrustPrecedenceRule['level'];
    let rulePath = rule.path;
    switch (rule.trustLevel) {
      case 'TRUST_FOLDER':
        level = 'trusted';
        break;
      case 'TRUST_PARENT':
        level = 'trusted';
        rulePath = path.dirname(rule.path);
        break;
      case 'DO_NOT_TRUST':
        level = 'untrusted';
        break;
      default:
        continue;
    }
    result.push({
      level,
      variants: getPathComparisonVariants(rulePath),
      payload: rule.trustLevel,
    });
  }
  return result;
}

/**
 * Resolve the most-specific rule that contains the requested location.
 * An untrusted rule wins when trusted and untrusted rules match at the same
 * depth. The result is independent of persisted rule insertion order.
 */
export function resolveTrustRule<TPayload>(
  rules: Iterable<TrustPrecedenceRule<TPayload>>,
  locationVariants: ReadonlySet<string>,
): TrustPrecedenceRule<TPayload> | undefined {
  let winner: TrustPrecedenceRule<TPayload> | undefined;
  let winnerDepth = -1;

  for (const rule of rules) {
    const depth = matchingDepth(rule, locationVariants);
    if (depth < 0) continue;

    if (
      depth > winnerDepth ||
      (depth === winnerDepth &&
        rule.level === 'untrusted' &&
        winner?.level !== 'untrusted')
    ) {
      winner = rule;
      winnerDepth = depth;
    }
  }

  return winner;
}

export function resolveTrustDecision<TPayload>(
  rules: Iterable<TrustPrecedenceRule<TPayload>>,
  locationVariants: ReadonlySet<string>,
): boolean | undefined {
  const winner = resolveTrustRule<TPayload>(rules, locationVariants);
  return winner?.level === 'trusted'
    ? true
    : winner?.level === 'untrusted'
      ? false
      : undefined;
}
