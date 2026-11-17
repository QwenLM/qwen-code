/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A shared ECS host runs several Actions runners beside each other, and a
// hosted macOS VM is slower still, so a budget that is generous on a dev
// machine can expire mid-repaint in CI. Scaling keeps the local signal tight
// and gives the pool room without turning a stuck UI into a pass: every
// caller still fails on the same assertion, only later.
const CI_MULTIPLIER = process.env['CI'] === 'true' ? 3 : 1;

export function scaledWait(localMs: number): number {
  return localMs * CI_MULTIPLIER;
}

/**
 * Builds the polling helper each interactive suite used to declare for
 * itself, so the whole family shares one wait policy. `localBudget` is what a
 * dev machine needs; CI multiplies it.
 */
export function createUntil(localBudget: number) {
  return async function until(
    check: () => boolean | Promise<boolean>,
    label: string,
    budget = scaledWait(localBudget),
  ): Promise<void> {
    const deadline = Date.now() + budget;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(label);
      await sleep(50);
    }
  };
}
