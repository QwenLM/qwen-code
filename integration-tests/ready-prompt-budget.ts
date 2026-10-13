/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ready-prompt startup budget for the interactive E2E harnesses.
 *
 * The sandbox:docker e2e leg boots a fresh container per attempt, and shared
 * self-hosted ECS hosts have stalled that boot past 30s — #13552 died there
 * on all three retries, before the CLI printed its prompt. Self-hosted
 * runners therefore get the /about loop's 90s stall budget; everywhere else
 * the tight 30s keeps a genuinely broken boot failing fast. Any budget here
 * must stay under the suite's testTimeout (TB_TIMEOUT_MINUTES, default 5min).
 *
 * Only InteractiveSession.start was observed to stall; the TestRig readiness
 * waits keep their own budgets and are tracked separately.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time (scripts/tests/ready-prompt-budget.test.ts).
 */
export function readyPromptBudgetMs(env: NodeJS.ProcessEnv): number {
  return env['RUNNER_ENVIRONMENT'] === 'self-hosted' ? 90_000 : 30_000;
}
