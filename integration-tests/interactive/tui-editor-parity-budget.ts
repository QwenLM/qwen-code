/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readyPromptBudgetMs } from '../ready-prompt-budget.js';
import { createUntil, scaledWait } from './wait.js';

// The suite's timing policy, split out so a PR-gated pin can import the
// executed values instead of matching the suite's text.

// Widening this cannot fix #17544: both failing waits poll a client-side
// transition with no server term left to arrive, so a bigger budget only
// moves the deadline.
export const WAIT_LOCAL_MS = 12_000;

export const until = createUntil(WAIT_LOCAL_MS);

// The /permissions cases pin their own ceiling to fail fast on a wedged
// dialog. It must outrank the boot window plus a few repaints that each burn
// a full wait budget and still pass — these cases poll a dozen times — or
// vitest's bare "Test timed out" pre-empts the wait's own label (#17544).
// retry: 0 because a wedged dialog repeats in a fresh worker, so the suite's
// two retries would only triple the cost.
//
// Every input comes from env, like readyPromptBudgetMs, so every runner tier
// is pinned with a plain object (scripts/tests/tui-editor-parity-wait-budget.test.ts).
export function permissionsCaseOptions(env: NodeJS.ProcessEnv) {
  return {
    timeout:
      readyPromptBudgetMs(env) + 3 * scaledWait(WAIT_LOCAL_MS, env) + 60_000,
    retry: 0,
  };
}
