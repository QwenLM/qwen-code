/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'vitest';
import { getPtyBudgetStats } from './bun-pty.js';

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
): Promise<void> {
  for (const pty of live.splice(0)) pty.kill();
  expect(
    await waitFor(() => {
      const stats = getPtyBudgetStats();
      return (
        stats.activePtys === 0 &&
        stats.pausedHoldBytes === 0 &&
        stats.writeQueueBytes === 0
      );
    }, 5_000),
    'PTY budgets did not drain after cleanup',
  ).toBe(true);
}
