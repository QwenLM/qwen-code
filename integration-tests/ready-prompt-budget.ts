/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ready-prompt startup budget for the interactive E2E harnesses.
 *
 * The sandbox:docker e2e leg boots a fresh container per attempt, and shared
 * self-hosted ECS hosts have stalled that boot past both budgets this leg
 * has run with: #13552 died at 30s on all three retries before the CLI
 * printed its prompt, and #14191 died at 90s the same way — in run
 * 38524609091 job 115744720088 all three attempts burned the whole budget
 * waiting for the "Type your message" prompt with the sandbox image already
 * local. The self-hosted docker boot therefore gets 180s, other self-hosted
 * boots keep the 90s stall budget, and everywhere else the tight 30s keeps
 * a genuinely broken boot failing fast. Any budget here must stay under the
 * suite's testTimeout (TB_TIMEOUT_MINUTES, default 5min).
 *
 * Only InteractiveSession.start was observed to stall; the TestRig readiness
 * waits keep their own budgets and are tracked separately.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time (scripts/tests/ready-prompt-budget.test.ts).
 */
export function readyPromptBudgetMs(env: NodeJS.ProcessEnv): number {
  if (env['RUNNER_ENVIRONMENT'] !== 'self-hosted') return 30_000;
  return env['QWEN_SANDBOX'] === 'docker' ? 180_000 : 90_000;
}
