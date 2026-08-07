/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from '../utils/stdioHelpers.js';

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
  // QWEN_TLS_INSECURE (and NODE_TLS_REJECT_UNAUTHORIZED, which it mirrors)
  // disable TLS certificate verification for all outbound API connections. A
  // project `.env` must never enable either — that would let an untrusted repo
  // silently turn off MITM protection. Opt-in stays with the user via the
  // `--insecure` flag, the shell environment, or a home `.env`. The initial
  // `.env` load only consults this list, so both keys must be here (not just
  // RELOAD_EXCLUDED_KEYS, which only applies on reload).
  'QWEN_TLS_INSECURE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

export const HOME_ENV_BOOTSTRAP_KEYS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
] as const;

// Loader-affecting variables inherited from the launching shell. A daemon or
// ACP child needs them only for its own boot (e.g. the dev harness tsx
// loader); left in process.env they propagate into session subprocesses whose
// cwd is another workspace and hijack module resolution there. This is the
// loader subset of RELOAD_EXCLUDED_KEYS (environment.ts), which guards
// .env/settings.env application — not the inherited launch environment.
export const INHERITED_LOADER_ENV_KEYS = [
  'NODE_OPTIONS',
  // npm maps its `node-options` config onto npm_config_node_options in the
  // environment, and `npm run` lifecycle scripts apply it like NODE_OPTIONS —
  // the same hijack through an adjacent key.
  'npm_config_node_options',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
] as const;

// Loader-key matching is case-insensitive and treats npm config-key
// underscore/hyphen spellings as equivalent: npm applies npm_config_* env
// vars regardless of case (it matches the prefix case-insensitively and
// lowercases the rest) and maps non-leading underscores onto hyphens, so
// npm_config_node-options injects NODE_OPTIONS into `npm run` lifecycle
// scripts exactly like npm_config_node_options. Windows env lookup is
// case-insensitive outright. Exact-case or exact-spelling gates would leave
// such variants loader-effective while slipping past the denylist and the
// scrubs. Every gate and scrub must go through this predicate instead of
// re-deriving set membership.
const canonicalLoaderKey = (key: string): string =>
  key.toLowerCase().replace(/_/gu, '-');

const LOADER_ENV_KEYS: ReadonlySet<string> = new Set(
  INHERITED_LOADER_ENV_KEYS.map(canonicalLoaderKey),
);

export function isLoaderEnvKey(key: string): boolean {
  return LOADER_ENV_KEYS.has(canonicalLoaderKey(key));
}

export function scrubInheritedLoaderEnv(env: NodeJS.ProcessEnv): string[] {
  const removedKeys: string[] = [];
  for (const key of Object.keys(env)) {
    if (isLoaderEnvKey(key)) {
      delete env[key];
      removedKeys.push(key);
    }
  }
  return removedKeys;
}

// Runs the scrub and leaves a stderr breadcrumb naming the removed keys, so a
// session subprocess missing an inherited var can be traced back to the
// boundary that dropped it. Shared by every scrub boundary so the message
// wording cannot desync between them.
export function scrubAndReportInheritedLoaderEnv(
  env: NodeJS.ProcessEnv,
  commandLabel: string,
  processLabel: string,
): string[] {
  const removedKeys = scrubInheritedLoaderEnv(env);
  if (removedKeys.length > 0) {
    writeStderrLine(
      `${commandLabel}: scrubbed inherited loader env vars from the ` +
        `${processLabel} process; session subprocesses will not inherit ` +
        `them: ${removedKeys.join(', ')}`,
    );
  }
  return removedKeys;
}

// Loader keys rejected from .env/settings.env used to apply on some
// application paths before the denylist existed; dropping them silently
// would send upgrade investigations everywhere except here. Report once per
// source+key per process: daemon-side loadSettings() re-runs the .env load
// for every session, and repeating the same warning per session would be
// noise, not diagnostics. A fresh process (one ACP child per session)
// starts with an empty map and warns once for itself.
const reportedLoaderKeyRejections = new Map<string, Set<string>>();

// candidateKeys is the raw key list of a parsed source (e.g.
// Object.keys(parsedEnv)); the intersection with the loader denylist happens
// here so every application site reports with identical matching semantics.
export function reportRejectedLoaderKeys(
  source: string,
  candidateKeys: readonly string[],
): void {
  const warnedKeys =
    reportedLoaderKeyRejections.get(source) ?? new Set<string>();
  const freshKeys = candidateKeys.filter(
    (key) => isLoaderEnvKey(key) && !warnedKeys.has(key),
  );
  if (freshKeys.length === 0) return;
  for (const key of freshKeys) warnedKeys.add(key);
  reportedLoaderKeyRejections.set(source, warnedKeys);
  writeStderrLine(
    `qwen: ${source} cannot set loader-affecting env vars; ignored: ` +
      freshKeys.join(', '),
  );
}

/** Test-only: forget already-reported loader-key rejections. */
export function resetLoaderKeyRejectionReportingForTesting(): void {
  reportedLoaderKeyRejections.clear();
}
