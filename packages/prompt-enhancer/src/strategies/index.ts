/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

export { BaseStrategy } from './base.js';
export { CodeCreationStrategy } from './code-creation.js';
export { BugFixStrategy } from './bug-fix.js';
export { ReviewStrategy } from './review.js';
export { AskStrategy } from './ask.js';

import type { EnhancementStrategy, IntentType } from '../types.js';
import { CodeCreationStrategy } from './code-creation.js';
import { BugFixStrategy } from './bug-fix.js';
import { ReviewStrategy } from './review.js';
import { AskStrategy } from './ask.js';

/**
 * Registry of all enhancement strategies
 */
export const STRATEGY_REGISTRY: Record<
  IntentType,
  new () => EnhancementStrategy
> = {
  'code-creation': CodeCreationStrategy,
  'bug-fix': BugFixStrategy,
  review: ReviewStrategy,
  refactor: CodeCreationStrategy, // Use code creation as fallback
  ask: AskStrategy,
  debug: BugFixStrategy, // Use bug fix as fallback
  test: CodeCreationStrategy, // Use code creation as fallback
  documentation: CodeCreationStrategy, // Use code creation as fallback
  unknown: CodeCreationStrategy, // Default fallback
};

/**
 * Get strategy by intent
 */
export function getStrategy(intent: IntentType): EnhancementStrategy {
  const StrategyClass =
    STRATEGY_REGISTRY[intent] || STRATEGY_REGISTRY['code-creation'];
  return new StrategyClass();
}

/**
 * Get all available strategies
 */
export function getAllStrategies(): EnhancementStrategy[] {
  return Object.entries(STRATEGY_REGISTRY).map(([intent]) => {
    const StrategyClass = STRATEGY_REGISTRY[intent as IntentType];
    return new StrategyClass();
  });
}
