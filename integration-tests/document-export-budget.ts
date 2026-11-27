/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wall-clock budget for the maximum transcript-document browser gate.
 *
 * The 7M-character document renders well inside a minute on a dev machine, but
 * shared self-hosted pools have measured it past that ceiling under
 * contention: 73s on the x64 pool (ci.yml's web_shell_e2e_smoke history,
 * marked x64-specific there), 68.4s (#17158), 60.9s (#17203) and 64.5s
 * (#17884). Those hosts get the same 3x
 * multiplier the interactive harness uses in `interactive/wait.ts`; GitHub-
 * hosted CI and local runs keep the tight 60s ceiling so a real regression
 * still fails fast. RUNNER_ENVIRONMENT is a runner default, so both gate steps
 * read it without an `env:` mapping; ci.yml's web_shell_e2e_smoke shard 1 gets
 * the tier only on the ARM64 pool, and e2e.yml's nightly browser-regression
 * step is ubuntu-latest. The gate sets its per-case ceiling 30s above this
 * budget, under the integration suite's 5-minute testTimeout, so the budget
 * assertion is always observed before a case timeout.
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
