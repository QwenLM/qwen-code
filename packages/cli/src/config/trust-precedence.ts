/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWithinRoot } from './path-comparison.js';

/**
 * Trust precedence, in one place.
 *
 * This module deliberately depends on nothing but `path-comparison.js` so the
 * `qwen serve` fast path can share it without pulling the settings stack into
 * startup.
 *
 * The policy is **most-specific-rule-wins**: of every rule whose path contains
 * the location, the one with the deepest path decides. Distrust wins exact
 * ties, so a `DO_NOT_TRUST` rule always beats a `TRUST_PARENT` rule that
 * resolves to the same directory.
 *
 * Both directions matter, and a plain check-order swap only gets one of them:
 *
 * - `/projects` trusted + `/projects/evil` distrusted → `/projects/evil` and
 *   everything under it is untrusted. Ordering distrust first only covers
 *   `/projects/evil` itself, leaving `/projects/evil/pkg/foo` trusted.
 * - `/projects` distrusted + `/projects/good` trusted → `/projects/good` is
 *   trusted. Matching distrust by containment first would break this
 *   blanket-distrust-with-exceptions setup.
 *
 * Resolving by depth also makes the outcome independent of rule iteration
 * order, which previously depended on key order in `trustedFolders.json`.
 */

export type TrustRuleLevel = 'trusted' | 'untrusted';

/**
 * A trust rule reduced to the form precedence cares about.
 *
 * `variants` holds the comparison forms of the rule's path (lexical and
 * realpath) as produced by `getPathComparisonVariants`. Callers pass them in
 * pre-computed because the fast path caches them across lookups to avoid
 * repeated `realpathSync` calls during startup.
 *
 * `TRUST_PARENT` is expected to be reduced to a `trusted` rule on the parent
 * directory before it gets here.
 *
 * `payload` carries whatever the caller needs back from the winning rule (for
 * example the original `TrustLevel`), and is ignored by resolution.
 */
export interface TrustPrecedenceRule<TPayload = undefined> {
  readonly level: TrustRuleLevel;
  readonly variants: ReadonlySet<string>;
  readonly payload?: TPayload;
}

/**
 * Depth of a normalized absolute path, used as the specificity score.
 * The filesystem root scores 0, `/a/b` scores 2, `C:\a` scores 2.
 */
function pathDepth(normalizedPath: string): number {
  let depth = 0;
  for (const segment of normalizedPath.split(/[\\/]+/)) {
    if (segment !== '') depth++;
  }
  return depth;
}

/**
 * Returns the rule that decides `location`, or `undefined` when no rule
 * covers it. See the module comment for the precedence policy.
 */
export function resolveTrustRule<TPayload>(
  rules: Iterable<TrustPrecedenceRule<TPayload>>,
  locationVariants: ReadonlySet<string>,
): TrustPrecedenceRule<TPayload> | undefined {
  let winner: TrustPrecedenceRule<TPayload> | undefined;
  let winningDepth = -1;

  for (const rule of rules) {
    // A rule may carry several comparison variants; score it by the deepest
    // one that actually contains the location, which is the most precise
    // claim that rule has on this path.
    let ruleDepth = -1;
    for (const ruleVariant of rule.variants) {
      for (const locationVariant of locationVariants) {
        if (isWithinRoot(locationVariant, ruleVariant)) {
          const depth = pathDepth(ruleVariant);
          if (depth > ruleDepth) ruleDepth = depth;
          break;
        }
      }
    }
    if (ruleDepth < 0) continue;

    if (
      ruleDepth > winningDepth ||
      // Distrust wins ties, regardless of the order rules arrive in.
      (ruleDepth === winningDepth && rule.level === 'untrusted')
    ) {
      winner = rule;
      winningDepth = ruleDepth;
    }
  }

  return winner;
}

/**
 * Resolves `location` to a trust decision, or `undefined` when no rule
 * covers it.
 */
export function resolveTrustDecision(
  rules: Iterable<TrustPrecedenceRule<unknown>>,
  locationVariants: ReadonlySet<string>,
): boolean | undefined {
  const winner = resolveTrustRule(rules, locationVariants);
  if (winner === undefined) return undefined;
  return winner.level === 'trusted';
}
