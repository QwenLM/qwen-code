/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wall-clock budget for the maximum transcript-document export gate.
 *
 * The same 7M-character document that renders well inside a minute on a dev
 * machine took 68.4s on a contended self-hosted CI host (#17158). The shared
 * self-hosted pool gets the same 3x multiplier the interactive harness uses in
 * `interactive/wait.ts`; GitHub-hosted CI and local runs keep the tight 60s
 * ceiling, because the overrun has only been measured on that pool. The
 * per-case timeout derives from the budget so the two cannot drift.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time
 * (scripts/tests/document-export-budget.test.ts).
 */

const LOCAL_BUDGET_MS = 60_000;
const SELF_HOSTED_MULTIPLIER = 3;
const TEST_TIMEOUT_SLACK_MS = 30_000;

export function documentExportBudgetMs(env: NodeJS.ProcessEnv): number {
  return env['RUNNER_ENVIRONMENT'] === 'self-hosted'
    ? LOCAL_BUDGET_MS * SELF_HOSTED_MULTIPLIER
    : LOCAL_BUDGET_MS;
}

export function documentExportTestTimeoutMs(env: NodeJS.ProcessEnv): number {
  return documentExportBudgetMs(env) + TEST_TIMEOUT_SLACK_MS;
}
