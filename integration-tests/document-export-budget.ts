/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wall-clock budget for the maximum transcript-document browser gate.
 *
 * The 7M-character document renders well inside a minute on a dev machine, but
 * CI has measured it past that ceiling under contention: 73s (recorded in
 * ci.yml's web_shell_e2e_smoke history), 68.4s (#17158) and 60.9s (#17203) on
 * the shared self-hosted ARM64 pool, and 64.5s (#17884). CI therefore gets the
 * same 3x multiplier the interactive harness uses in `interactive/wait.ts`,
 * keyed on the same marker rather than on runner class, so github-hosted lanes
 * share the widened ceiling. A per-class tier needs RUNNER_ENVIRONMENT, which
 * neither lane that runs the gate maps into the step — ci.yml's smoke step
 * sets only TMPDIR and e2e.yml's browser-regression step sets no env at all —
 * so the first attempt at this budget keyed on it and was unreachable in CI,
 * leaving every overrun above on the tight ceiling. Local runs keep that tight
 * 60s so a real regression still fails fast. The gate sets its per-case ceiling
 * 30s above this budget, under the integration suite's 5-minute testTimeout,
 * so the budget assertion is always observed before a case timeout.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time
 * (scripts/tests/document-export-budget.test.ts).
 */

const LOCAL_BUDGET_MS = 60_000;
const CI_MULTIPLIER = 3;

export function documentExportBudgetMs(env: NodeJS.ProcessEnv): number {
  return env['CI'] === 'true'
    ? LOCAL_BUDGET_MS * CI_MULTIPLIER
    : LOCAL_BUDGET_MS;
}
