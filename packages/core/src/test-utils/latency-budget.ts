/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'vitest';

/** Options for {@link expectWithinLatencyBudget}. */
export interface LatencyBudgetOptions {
  /**
   * Multiple of the budget still asserted on the shared pool. Pass it when the
   * duration *is* the property under test — a complexity bound, a stream that
   * must not go zombie — so the case keeps asserting something there instead of
   * running and checking nothing. Contention on this fleet is ~5x, so a
   * multiple well above that still catches a quadratic regression, which
   * overruns any bound, while tolerating a busy host.
   */
  poolMultiplier?: number;
}

/**
 * Assert that a measured duration fits a millisecond budget, except on the
 * shared ECS pool.
 *
 * A budget written on a developer machine measures the code. On the shared
 * pool it measures the neighbours: the same third of the same suite runs in
 * 6.7 minutes or 36 minutes there depending only on which host it lands on,
 * and at that spread every one of these bounds is a coin flip (#10490). The
 * assertion still runs locally and on the GitHub-hosted lanes, which are the
 * environments where the number means something.
 */
export function expectWithinLatencyBudget(
  elapsedMs: number,
  budgetMs: number,
  options?: LatencyBudgetOptions,
): void {
  if (process.env['QWEN_SKIP_LATENCY_BUDGETS']) {
    const multiplier = options?.poolMultiplier;
    if (multiplier === undefined) {
      return;
    }
    expect(elapsedMs).toBeLessThan(budgetMs * multiplier);
    return;
  }
  expect(elapsedMs).toBeLessThan(budgetMs);
}
