/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  QWEN_CODE_DESKTOP_ENV,
  QWEN_CODE_SERVE_ENV,
} from './acp-channel-fallback.js';

import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

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
  // Runtime attribution markers are stamped by trusted launchers. A project
  // `.env` must not spoof client channel telemetry.
  QWEN_CODE_SERVE_ENV,
  QWEN_CODE_DESKTOP_ENV,
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
  // NODE_EXTRA_CA_CERTS reaches the same outcome by adding a TLS trust
  // anchor instead of disabling verification.
  'NODE_EXTRA_CA_CERTS',
  // QWEN_CLI_ENTRY is the script path daemon-spawned session processes run.
  // A project `.env` or settings.env fixing it turns
  // `cd <untrusted repo> && qwen serve` into code execution as the daemon
  // via an attacker-chosen ACP entrypoint, for every workspace's sessions.
  'QWEN_CLI_ENTRY',
  // DEV gates the daemon's inherited-loader-env scrub (run-qwen-serve.ts);
  // only the dev harness (scripts/dev.js) stamps it into the launch env. A
  // project file setting it would silently keep loader vars in the base env
  // distributed to every workspace's session children — reopening the #8653
  // vector for any repo whose .env happens to carry DEV=true.
  'DEV',
];

// Windows env lookup is case-insensitive, so exact-case membership would let
// case variants (e.g. `node_extra_ca_certs`) slip past every application
// gate. All gates go through this predicate instead of Array.includes on the
// list above, mirroring the loader-key predicate.
const HARDCODED_PROJECT_ENV_EXCLUSIONS: ReadonlySet<string> = new Set(
  PROJECT_ENV_HARDCODED_EXCLUSIONS.map((key) => key.toLowerCase()),
);

export function isHardcodedProjectEnvExclusion(key: string): boolean {
  return HARDCODED_PROJECT_ENV_EXCLUSIONS.has(key.toLowerCase());
}

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
//
// Scope is deliberate: code-injection vectors only — variables that make a
// spawned interpreter or OS loader execute an attacker-chosen file.
// LD_LIBRARY_PATH/DYLD_LIBRARY_PATH (library *search* paths) and ENV
// (sourced only by interactive sh, while the shell tool spawns
// non-interactive `bash -c`) are not here: scrubbing them breaks mainstream
// toolchains (conda/CUDA library dirs, `ENV=production` app conventions)
// for every session subprocess, and their hijack residue is the same class
// as the PATH-prefix follow-up tracked out of #8653. They stay reload-only
// in RELOAD_EXCLUDED_KEYS. Runtime-specific search paths for other
// interpreters (PYTHONPATH, JAVA_TOOL_OPTIONS, …) are the same tradeoff and
// are deferred with it.
//
// This denylist intentionally does NOT move into core `sanitizeChildEnv`:
// per-server `mcpServers[].env` and per-hook `hooks[].env` are explicit,
// trust-gated overrides that must keep working, and a blanket child-env
// strip would silently null them everywhere. The choke points that need the
// denylist are config-driven, and each applies it at its own surface:
// .env/settings.env loading (environment.ts), serve fast-path boot
// (fast-path-settings.ts), and inherited launch-env scrubbing (daemon and
// ACP child boot).
//
// Known adjacent surface: LSP `.lsp.json` env overrides carry their own
// narrower denylist (`SECURITY_SENSITIVE_ENV_KEYS` in
// core/lsp/LspServerManager.ts — missing BASH_ENV/ENV/npm_config_node_options).
// Unifying the two lists is deferred: the LSP surface is experimental
// (behind --experimental-lsp) and its keys were chosen independently.
export const INHERITED_LOADER_ENV_KEYS = [
  'NODE_OPTIONS',
  // npm maps its `node-options` config onto npm_config_node_options in the
  // environment, and `npm run` lifecycle scripts apply it like NODE_OPTIONS —
  // the same hijack through an adjacent key. The config-file keys are the
  // same hijack one level up: they point npm at an attacker-chosen .npmrc
  // that can itself set node-options/script-shell/ignore-scripts, and `npm
  // run` itself exports them into the script environment.
  'npm_config_node_options',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'npm_config_script_shell',
  'npm_config_prefix',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'BASH_ENV',
  // zsh sources $ZDOTDIR/.zshenv on every invocation, including
  // non-interactive `zsh -c` — the zsh analogue of BASH_ENV.
  'ZDOTDIR',
  // BASH_FUNC_* exported-function definitions are bash's other env-driven
  // code-import channel (non-interactive `bash -c` still imports them);
  // matched by prefix in isLoaderEnvKey, not listed here.
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

// Exported bash function definitions (`BASH_FUNC_<name>%%=() { ... }`) are
// imported by every bash child, non-interactive `bash -c` included — env key
// names cannot be arrayed above since the function name is embedded in the
// key. bash compares the prefix case-sensitively, but Windows env lookup
// does not, so match the canonical (case-folded) spelling.
export function isLoaderEnvKey(key: string): boolean {
  const canonical = canonicalLoaderKey(key);
  return canonical.startsWith('bash-func-') || LOADER_ENV_KEYS.has(canonical);
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
    writeStderrLineSafe(
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

// The daemon re-runs per-workspace .env loads long after boot stderr is
// gone; a sink lets the daemon mirror fresh rejections into its durable
// log. Interleaving is impossible: reportRejectedLoaderKeys is synchronous
// and the sink is only swapped at boot.
export type LoaderKeyRejectionReporter = (
  source: string,
  freshKeys: readonly string[],
) => void;

let loaderKeyRejectionReporter: LoaderKeyRejectionReporter | undefined;

export function setLoaderKeyRejectionReporter(
  reporter: LoaderKeyRejectionReporter | undefined,
): void {
  loaderKeyRejectionReporter = reporter;
}

// candidateKeys is the raw key list of a parsed source (e.g.
// Object.keys(parsedEnv)); the intersection with the loader denylist happens
// here so every application site reports with identical matching semantics.
export function reportRejectedLoaderKeys(
  source: string,
  candidateKeys: readonly string[],
): string[] {
  const rejectedKeys = candidateKeys.filter(isLoaderEnvKey);
  const warnedKeys =
    reportedLoaderKeyRejections.get(source) ?? new Set<string>();
  const freshKeys = rejectedKeys.filter((key) => !warnedKeys.has(key));
  if (freshKeys.length === 0) return rejectedKeys;
  for (const key of freshKeys) warnedKeys.add(key);
  reportedLoaderKeyRejections.set(source, warnedKeys);
  if (loaderKeyRejectionReporter) {
    loaderKeyRejectionReporter(source, freshKeys);
  } else {
    writeStderrLineSafe(
      `qwen: ${source} cannot set loader-affecting env vars; ignored: ` +
        freshKeys.join(', '),
    );
  }
  return rejectedKeys;
}

/** Test-only: forget already-reported loader-key rejections. */
export function resetLoaderKeyRejectionReportingForTesting(): void {
  reportedLoaderKeyRejections.clear();
}
