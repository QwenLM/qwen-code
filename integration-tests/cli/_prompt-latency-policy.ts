/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt-latency probe policy for `qwen-serve-baseline.test.ts`: whether the
 * probe runs, and what the snapshot records when it does not. Both halves take
 * `env` explicitly so `_prompt-latency-policy.test.ts` can pin the decision
 * under a controlled environment instead of the ambient one.
 */

const CREDENTIAL_ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'QWEN_API_KEY',
];

// QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 counts as credential-present: it is
// the force-run switch for auth that does not come from an env var.
function hasCredential(env: NodeJS.ProcessEnv): boolean {
  return (
    env['QWEN_BASELINE_ENABLE_PROMPT_LATENCY'] === '1' ||
    CREDENTIAL_ENV_KEYS.some((key) => Boolean(env[key])) ||
    Object.entries(env).some(
      ([key, value]) =>
        key.startsWith('QWEN_CUSTOM_API_KEY_') && Boolean(value),
    )
  );
}

export function shouldSkipPromptLatency(env: NodeJS.ProcessEnv): boolean {
  // Real model round-trips in CI measure shared-gateway contention, not the
  // daemon: the gateway queues and retries under load, so one queued prompt
  // in twenty pushes p99 past `promptP99MaxMs`, and each vitest retry
  // re-issues every prompt into the same degraded window — a single slow
  // window fails all attempts. That failure class ran the macOS leg — the
  // only E2E leg left running the probe once the pool skip landed — red on
  // two unrelated commits within six hours (#11271). The self-hosted pool
  // disjunct predates the CI-wide one and stays so a pool-shaped shell
  // outside CI keeps its specific skip reason. Off CI the probe still runs
  // on a credential, and QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 force-runs
  // it anywhere.
  return (
    env['QWEN_BASELINE_SKIP_PROMPT_LATENCY'] === '1' ||
    (env['QWEN_BASELINE_ENABLE_PROMPT_LATENCY'] !== '1' &&
      (env['RUNNER_ENVIRONMENT'] === 'self-hosted' || Boolean(env['CI']))) ||
    !hasCredential(env)
  );
}

export function promptLatencySkipReason(
  env: NodeJS.ProcessEnv,
  promptIterations: number,
): string {
  // The credential is tested before the environment clauses even though the
  // predicate above tests them the other way round: `hasCredential` counts
  // ENABLE=1 as present, so reaching an environment branch means the skip
  // flag is unset and a real credential exists — leaving an environment
  // disjunct as the only one that can have fired. The pool branch precedes
  // the CI branch so a self-hosted CI runner keeps the more specific reason.
  if (env['QWEN_BASELINE_SKIP_PROMPT_LATENCY'] === '1') {
    return 'Prompt latency skipped via QWEN_BASELINE_SKIP_PROMPT_LATENCY=1.';
  }
  if (!hasCredential(env)) {
    return 'No recognized model credential env var is set; prompt latency requires real model access. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run with non-env auth.';
  }
  if (env['RUNNER_ENVIRONMENT'] === 'self-hosted') {
    return `Shared self-hosted pool: ${promptIterations} real model round-trips would measure host contention, not the daemon. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run.`;
  }
  return `CI: ${promptIterations} real model round-trips against the shared gateway would measure gateway contention, not the daemon. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run.`;
}
