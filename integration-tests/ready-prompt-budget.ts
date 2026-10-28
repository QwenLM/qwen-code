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
 * a genuinely broken boot failing fast. The one hosted host that has since
 * outgrown that default is GitHub's intel macOS image: #15677 recorded the
 * tui-parity installed-distribution darwin-x64 leg (macos-15-intel) stalling
 * past 30s on 5 of its first 6 runs — banner rendered, prompt never
 * arriving — so hosted macOS x64 joins the 90s stall tier. Any budget here
 * must stay under the suite's testTimeout (TB_TIMEOUT_MINUTES, default 5min;
 * the distribution suite pins 120s per case).
 *
 * InteractiveSession.start and the skill-hooks invocation-parity suite's
 * TestRig readiness wait use this budget; other TestRig readiness waits keep
 * their own budgets and are tracked separately.
 *
 * Pure and read at call time so the decision is pinned state-by-state with a
 * plain object instead of real time (scripts/tests/ready-prompt-budget.test.ts).
 */

const TIERS = {
  default: 30_000,
  githubHostedMacOsX64: 90_000,
  selfHosted: 90_000,
  selfHostedDocker: 180_000,
} as const;

/** The widest branch, so a suite ceiling can be derived instead of copied. */
export const MAX_READY_PROMPT_BUDGET_MS = Math.max(...Object.values(TIERS));

export function readyPromptBudgetMs(env: NodeJS.ProcessEnv): number {
  if (env['RUNNER_ENVIRONMENT'] === 'self-hosted') {
    return env['QWEN_SANDBOX'] === 'docker'
      ? TIERS.selfHostedDocker
      : TIERS.selfHosted;
  }
  if (env['RUNNER_OS'] === 'macOS' && env['RUNNER_ARCH'] === 'X64') {
    return TIERS.githubHostedMacOsX64;
  }
  return TIERS.default;
}
