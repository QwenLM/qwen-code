/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Return the first non-empty string from the provided candidates.
 *
 * @param {...(string | undefined)} values
 * @returns {string | undefined}
 */
function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Resolve auth env for VS Code integration/E2E runners.
 * Prefers dedicated `QWEN_TEST_*` overrides, then falls back to `OPENAI_*`.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveIntegrationAuthEnv(env = process.env) {
  const qwenOauth = firstNonEmpty(env.QWEN_OAUTH);
  const openAiApiKey = firstNonEmpty(env.QWEN_TEST_API_KEY, env.OPENAI_API_KEY);
  const openAiBaseUrl = firstNonEmpty(
    env.QWEN_TEST_BASE_URL,
    env.OPENAI_BASE_URL,
  );
  const openAiModel = firstNonEmpty(env.QWEN_TEST_MODEL, env.OPENAI_MODEL);

  return {
    hasQwenOauth: Boolean(qwenOauth),
    hasModelAuth: Boolean(openAiApiKey && openAiBaseUrl && openAiModel),
    openAiApiKey,
    openAiBaseUrl,
    openAiModel,
    qwenOauth,
  };
}

/**
 * Whether integration auth is available through OAuth or API credentials.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function hasIntegrationAuthEnv(env = process.env) {
  const resolved = resolveIntegrationAuthEnv(env);
  return resolved.hasQwenOauth || resolved.hasModelAuth;
}

/**
 * Build the env shape expected by the CLI-backed VS Code runners.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string | undefined>}
 */
export function buildIntegrationRunnerEnv(env = process.env) {
  const resolved = resolveIntegrationAuthEnv(env);
  const runnerEnv = {};

  if (resolved.openAiApiKey) {
    runnerEnv.OPENAI_API_KEY = resolved.openAiApiKey;
  }
  if (resolved.openAiBaseUrl) {
    runnerEnv.OPENAI_BASE_URL = resolved.openAiBaseUrl;
  }
  if (resolved.openAiModel) {
    runnerEnv.OPENAI_MODEL = resolved.openAiModel;
  }
  if (resolved.qwenOauth) {
    runnerEnv.QWEN_OAUTH = resolved.qwenOauth;
  }

  return runnerEnv;
}
