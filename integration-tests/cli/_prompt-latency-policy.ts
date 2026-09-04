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
  // The pool runners share one ECS host with ~30 concurrent jobs, so the
  // slowest of the probe's real model round-trips measures that contention
  // rather than the daemon: `promptP99MaxMs` becomes a coin flip, and every
  // one of vitest's attempts re-issues all the prompts inside the harness's
  // 10-minute budget. `integration-tests/vitest.config.ts` exempts the same
  // runners from the analogous pressure class. The dedicated macOS legs still
  // record the baseline, and QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 still
  // force-runs it there.
  return (
    env['QWEN_BASELINE_SKIP_PROMPT_LATENCY'] === '1' ||
    (env['QWEN_BASELINE_ENABLE_PROMPT_LATENCY'] !== '1' &&
      env['RUNNER_ENVIRONMENT'] === 'self-hosted') ||
    !hasCredential(env)
  );
}

export function promptLatencySkipReason(
  env: NodeJS.ProcessEnv,
  promptIterations: number,
): string {
  // The credential is tested before the pool even though the predicate above
  // tests them the other way round: `hasCredential` counts ENABLE=1 as
  // present, so reaching the pool branch means the skip flag is unset and a
  // real credential exists — leaving the self-hosted disjunct as the only one
  // that can have fired.
  if (env['QWEN_BASELINE_SKIP_PROMPT_LATENCY'] === '1') {
    return 'Prompt latency skipped via QWEN_BASELINE_SKIP_PROMPT_LATENCY=1.';
  }
  if (!hasCredential(env)) {
    return 'No recognized model credential env var is set; prompt latency requires real model access. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run with non-env auth.';
  }
  return `Shared self-hosted pool: ${promptIterations} real model round-trips would measure host contention, not the daemon. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run.`;
}
