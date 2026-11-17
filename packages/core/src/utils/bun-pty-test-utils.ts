/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'vitest';
import { getPtyBudgetStats, type PtyBudgetStats } from './bun-pty.js';

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

export async function cleanupPtys(
  live: Array<{ kill(): void }>,
  baseline: PtyBudgetStats = {
    activePtys: 0,
    pausedHoldBytes: 0,
    writeQueueBytes: 0,
  },
): Promise<void> {
  const errors: unknown[] = [];
  for (const pty of live.splice(0)) {
    try {
      pty.kill();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    expect(
      await waitFor(() => {
        const stats = getPtyBudgetStats();
        return (
          stats.activePtys === baseline.activePtys &&
          stats.pausedHoldBytes === baseline.pausedHoldBytes &&
          stats.writeQueueBytes === baseline.writeQueueBytes
        );
      }, 5_000),
      'PTY budgets did not drain after cleanup',
    ).toBe(true);
    expect(getPtyBudgetStats()).toEqual(baseline);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'PTY cleanup failed');
}
