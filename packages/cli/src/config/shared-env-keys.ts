/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_EXCLUDED_ENV_VARS = ['DEBUG', 'DEBUG_MODE'];

export const ENV_CORRUPTED_PATH = 'QWEN_CODE_SETTINGS_CORRUPTED_PATH';
export const ENV_WAS_RECOVERED = 'QWEN_CODE_SETTINGS_WAS_RECOVERED';

// QWEN_HOME and QWEN_RUNTIME_DIR control where global state (settings, OAuth
// credentials, installation IDs, etc.) is written. A project `.env` must never
// redirect these — that would split global state between the real home and a
// project-controlled directory. Always excluded from project .env files,
// regardless of user-configurable `advanced.excludedEnvVars`.
export const PROJECT_ENV_HARDCODED_EXCLUSIONS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  // QWEN_TLS_INSECURE disables TLS certificate verification for all outbound
  // API connections. A project `.env` must never enable it — that would let an
  // untrusted repo silently turn off MITM protection. Opt-in stays with the
  // user via the `--insecure` flag, the shell environment, or a home `.env`.
  // (Via RELOAD_EXCLUDED_KEYS below this also blocks it on reload.)
  'QWEN_TLS_INSECURE',
];

export const HOME_ENV_BOOTSTRAP_KEYS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
] as const;
