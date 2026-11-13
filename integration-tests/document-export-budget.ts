/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wall-clock budget for the maximum transcript-document browser gate.
 *
 * The 7M-character document renders well inside a minute on a dev machine, but
 * the shared self-hosted ARM64 pool has measured it past that ceiling under
 * contention: 73s (recorded in ci.yml's web_shell_e2e_smoke history), 68.4s
 * (#17158), and 60.9s (#17203). Those hosts get the same 3x
 * multiplier the interactive harness uses in `interactive/wait.ts`; GitHub-
 * hosted CI and local runs keep the tight 60s ceiling so a real regression
 * still fails fast. The gate inherits the integration suite's 5-minute
 * testTimeout, so the widened budget is always observed before a case timeout.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time
 * (scripts/tests/document-export-budget.test.ts).
 */

const LOCAL_BUDGET_MS = 60_000;
const SELF_HOSTED_MULTIPLIER = 3;

export function documentExportBudgetMs(env: NodeJS.ProcessEnv): number {
  return env['RUNNER_ENVIRONMENT'] === 'self-hosted'
    ? LOCAL_BUDGET_MS * SELF_HOSTED_MULTIPLIER
    : LOCAL_BUDGET_MS;
}
