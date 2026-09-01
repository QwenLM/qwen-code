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
export const ENV_ACP_REPEATED_TOOL_FAILURE_GUARD =
  'QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD';

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
  // This points to a host temp file that carries build warnings. A project
  // `.env` must not redirect it to an arbitrary file to read or delete.
  'QWEN_CODE_WARNINGS_FILE',
  // Runtime attribution markers are stamped by trusted launchers. A project
  // `.env` must not spoof client channel telemetry.
  QWEN_CODE_SERVE_ENV,
  QWEN_CODE_DESKTOP_ENV,
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  // This is an operator rollout policy. A project must not be able to promote
  // itself from the default shadow cohort into warning or enforcement.
  ENV_ACP_REPEATED_TOOL_FAILURE_GUARD,
  // Project memory routing is frozen daemon-wide before workspace env files
  // load, so only the operator's launch environment or CLI flag may set it.
  'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  // Workflow execution is an explicit user opt-in. A project must not enable
  // it or override a user opt-in through settings.env or a project .env.
  'QWEN_CODE_ENABLE_WORKFLOWS',
  'QWEN_CODE_DISABLE_WORKFLOWS',
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
  // The non-Node TLS trust-anchor vars reach the SAME MITM outcome for the
  // curl/git/openssl/python tools a session subprocess routinely shells out
  // to: they are honored unconditionally as a CA bundle/dir, and npm/pip
  // honor their own equivalents (npm_config_cafile / npm_config_ca / PIP_CERT
  // as attacker CAs, npm_config_strict_ssl=false disables verification with
  // no CA at all; GIT_SSL_CAPATH is git's directory-form twin of
  // GIT_SSL_CAINFO). A project `.env` pointing any of them at an attacker CA
  // lets an untrusted repo silently intercept token-bearing traffic
  // (git/npm/pip fetches) for every workspace's sessions — the exact outcome
  // NODE_EXTRA_CA_CERTS is blocked for. Like NODE_EXTRA_CA_CERTS these stay
  // reject-from-project-`.env` only: a value the operator set in their own
  // login shell or home `.env` is their trusted choice and is preserved.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'npm_config_cafile',
  'npm_config_ca',
  // npm treats underscore/hyphen spellings of a config key as the same key
  // (see canonicalLoaderKey below), so both forms of strict-ssl are listed.
  'npm_config_strict_ssl',
  'npm_config_strict-ssl',
  'PIP_CERT',
  // CURL_HOME / WGETRC redirect curl/wget at attacker rc files
  // (`$CURL_HOME/.curlrc`, the file WGETRC names) whose `proxy`, `cacert`, or
  // `insecure` directives intercept or downgrade the same token-bearing
  // traffic — the config-file-redirect class this list already blocks for npm
  // (`npm_config_userconfig`), git (`GIT_CONFIG_GLOBAL`), and OpenSSL
  // (`OPENSSL_CONF`).
  'CURL_HOME',
  'WGETRC',
  // PIP_CONFIG_FILE redirects all of pip's configuration at the file it
  // names — index-url, trusted-host, proxy, cert, or client-cert in an
  // attacker file sends session pip traffic or credentials to attacker
  // infrastructure — the same config-file-redirect class as
  // npm_config_userconfig and GIT_CONFIG_GLOBAL.
  'PIP_CONFIG_FILE',
  // The git command-execution env family: git runs these on any invocation in
  // a session subprocess. GIT_SSH_COMMAND / GIT_SSH (its documented legacy
  // counterpart, still exec'd by git for SSH transports) / GIT_EXTERNAL_DIFF
  // execute a command directly; GIT_ASKPASS / GIT_PROXY_COMMAND / GIT_EDITOR
  // / GIT_SEQUENCE_EDITOR are exec'd conditionally (credential prompt, proxy
  // transport, editor, `git rebase -i` todo-list edit);
  // GIT_EXEC_PATH redirects git's own remote-helper/subcommand lookup at an
  // attacker directory and GIT_TEMPLATE_DIR plants hooks that run after the
  // next clone/init; GIT_CONFIG_* injects arbitrary config (`core.hooksPath`,
  // `core.fsmonitor`, …) that turns a routine `git commit` into
  // attacker-code execution as the daemon user — GIT_CONFIG_PARAMETERS
  // carries the same injection as one quoted string, so it is blocked with
  // GIT_CONFIG_COUNT and the numbered pairs. core/utils/git-branches.ts
  // scrubs the config-injection subset from the repo's own git invocations,
  // so a project `.env` setting this family contradicts that model. Numbered
  // GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs are matched by numeric
  // suffix below.
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  // git merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`, so a
  // project `.env` redirecting XDG_CONFIG_HOME plants the same config
  // injection (`core.hooksPath`, …) the GIT_CONFIG_* keys block — without
  // naming a git config file at all.
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  // git falls back to executing $SSH_ASKPASS for passphrase prompts (its
  // askpass order is GIT_ASKPASS > core.askPass > SSH_ASKPASS, and ssh runs
  // it whenever SSH_ASKPASS_REQUIRE=force or no terminal is available), so a
  // project `.env` pointing it at an attacker script is code execution on
  // any git/ssh auth challenge. SSH_ASKPASS_REQUIRE stays settable: it only
  // selects *when* the askpass program runs, and with SSH_ASKPASS
  // project-blocked it has no program to execute.
  'SSH_ASKPASS',
  // less executes $LESSOPEN as an input preprocessor on every file a session
  // views (and $LESSCLOSE on exit whenever the preprocessor ran), so a
  // project `.env` setting either is attacker command execution the first
  // time a session runs `less`.
  'LESSOPEN',
  'LESSCLOSE',
  // node-gyp interpreter selection: node-gyp's find-python.js executes
  // NODE_GYP_FORCE_PYTHON / npm_config_python / PYTHON as the build Python,
  // so a project `.env` pointing them at an attacker script is code execution
  // during any native-addon `npm install` in another workspace's session.
  // Unlike the pure-injection loader keys these have a legitimate
  // operator-shell use (selecting a real interpreter), so they are
  // reject-from-project-`.env` only, not scrubbed from the launch env.
  'NODE_GYP_FORCE_PYTHON',
  'npm_config_python',
  'PYTHON',
  // CPython executes $PYTHONSTARTUP at interactive startup — the Python
  // analogue of NODE_REPL_EXTERNAL_MODULE. It stays reject-only (like
  // PYTHON) because operators legitimately set it in their own shells.
  'PYTHONSTARTUP',
  // git's documented editor fallback chain (GIT_EDITOR → core.editor →
  // $VISUAL → $EDITOR) executes these exactly like the blocked GIT_EDITOR,
  // and the CLI's own useLaunchEditor spawns them from ordinary interactive
  // flows.
  'VISUAL',
  'EDITOR',
  // npm runs `$npm_config_git` as the git binary for install-from-git and
  // similar flows, so a project `.env` pointing it at an attacker script is
  // the same exec redirect as the interpreter keys above.
  'npm_config_git',
  // The CLI itself execs $BROWSER via openBrowserSecurely (core/utils/
  // secure-browser-launcher.ts) before any CI/DISPLAY gate, so a project
  // `.env` pointing it at an attacker script runs on any browser-launch
  // flow.
  'BROWSER',
  // QWEN_CLI_ENTRY is the script path daemon-spawned session processes run.
  // A project `.env` or settings.env fixing it turns
  // `cd <untrusted repo> && qwen serve` into code execution as the daemon
  // via an attacker-chosen ACP entrypoint, for every workspace's sessions.
  'QWEN_CLI_ENTRY',
  // QWEN_CDP_MCP_COMMAND is the command the daemon spawns as the
  // browser-automation MCP adapter, and QWEN_SERVE_CDP_TUNNEL_OVER_WS
  // switches that tunnel surface on. A project `.env` or settings.env fixing
  // either hijacks the daemon the same way QWEN_CLI_ENTRY does; values the
  // operator set in the daemon's launch env still apply.
  'QWEN_CDP_MCP_COMMAND',
  'QWEN_SERVE_CDP_TUNNEL_OVER_WS',
  // QWEN_SERVE_NEW_FILE_MODE decides the creation mode of every agent-written
  // NEW file (owner-only 0600 vs umask-derived). A project `.env` flipping it
  // to `system` would silently widen file visibility daemon-wide — including
  // files written for OTHER workspaces — with no warning, since `system` is a
  // valid value. The fail-closed 0600 posture is an operator decision
  // (documented as a per-daemon opt-in), so only the daemon's launch
  // environment or a home `.env` may set it.
  'QWEN_SERVE_NEW_FILE_MODE',
  // QWEN_SERVE_SESSION_ATTACHMENTS_ROOT decides where the daemon stores
  // every workspace's session attachments. A project `.env` redirecting it
  // would capture uploads for ALL workspaces the daemon serves — and reads
  // consult the configured root first, so attacker-modified bytes would be
  // served back — with no recovery after unsetting the variable. The
  // location is an operator decision (documented as a per-daemon opt-in), so
  // only the daemon's launch environment or a home `.env` may set it.
  'QWEN_SERVE_SESSION_ATTACHMENTS_ROOT',
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

// Command-scope git config injection uses numbered GIT_CONFIG_KEY_<n> /
// GIT_CONFIG_VALUE_<n> pairs read up to GIT_CONFIG_COUNT — an unbounded index,
// so match them by numeric suffix rather than listing literals. Git only
// reads decimal-numbered pairs (GIT_CONFIG_KEY_%d up to the count), so a key
// with an empty or nonnumeric suffix (e.g. GIT_CONFIG_KEY_CACHE) is a
// project-defined variable Git never consumes and it must stay settable.
// (core/utils/git-branches.ts scrubs the same family by bare prefix; that
// over-scrub is harmless, but a denylist rejection freezes the key, so this
// gate matches precisely.) GIT_CONFIG_COUNT alone already neutralizes the
// pairs, but rejecting the pairs too matches the repo's existing git scrub.
const HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS = [
  /^git_config_key_\d+$/u,
  /^git_config_value_\d+$/u,
] as const;

export function isHardcodedProjectEnvExclusion(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return (
    HARDCODED_PROJECT_ENV_EXCLUSIONS.has(lowerKey) ||
    HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS.some((pattern) =>
      pattern.test(lowerKey),
    )
  );
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
  // OPENSSL_CONF points Node's startup crypto init at an attacker `.cnf`
  // whose `nodejs_conf` section can dlopen an arbitrary engine/provider `.so`
  // before any user code runs — a pure code-injection vector with no benign
  // cross-workspace inheritance, so it is scrubbed like NODE_OPTIONS.
  'OPENSSL_CONF',
  // NODE_REPL_EXTERNAL_MODULE makes a spawned `node` REPL require() an
  // attacker file at startup. npm_config_node_gyp overrides the node-gyp
  // *script* npm's shim runs verbatim (`"$npm_config_node_gyp" "$@"`), and
  // npm_config_init_module is require()d by `npm init` (even `-y`). All three
  // are executable/module redirects with no legitimate login-shell use, so
  // they join the scrubbed loader set rather than the reject-only tier.
  'NODE_REPL_EXTERNAL_MODULE',
  'npm_config_node_gyp',
  'npm_config_init_module',
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

export function scrubInheritedLoaderEnv(
  env: NodeJS.ProcessEnv,
  snapshotInto?: Map<string, string>,
): string[] {
  const removedKeys: string[] = [];
  for (const key of Object.keys(env)) {
    if (isLoaderEnvKey(key)) {
      const value = env[key];
      if (snapshotInto && value !== undefined) snapshotInto.set(key, value);
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
  snapshotInto?: Map<string, string>,
): string[] {
  const removedKeys = scrubInheritedLoaderEnv(env, snapshotInto);
  if (removedKeys.length > 0) {
    writeStderrLineSafe(
      `${commandLabel}: scrubbed inherited loader env vars from the ` +
        `${processLabel} process; session subprocesses will not inherit ` +
        `them: ${removedKeys.join(', ')}`,
    );
  }
  return removedKeys;
}

// Concurrent embedded daemons in one process (a documented supported config —
// see acp-bridge/src/bridgeOptions.ts `childEnvOverrides`) share this
// process's `process.env`. A per-daemon scrub+restore over that shared object
// races: the second daemon boots into an already-scrubbed env (nothing to
// scrub, nothing to restore), then the first daemon's close() restores the
// loader vars into the shared env and re-poisons the survivor's session
// subprocesses — reopening #8653 for the still-live daemon. Coordinate the
// scrub of `process.env` process-globally: each acquire snapshots the loader
// values present at that boundary, and only the last release (refcount back
// to zero) restores them.
let sharedProcessEnvScrubDepth = 0;
const sharedProcessEnvScrubOriginals = new Map<string, string>();

export interface InheritedLoaderEnvScrubHandle {
  /** Loader keys this acquire removed from the shared env (empty for a nested acquire whose env was already scrubbed). */
  readonly removedKeys: readonly string[];
  /** Idempotent; restores the snapshotted originals only when the last holder releases. */
  release(): void;
}

// Scrubs loader vars from a shared, live env (the daemon passes its own
// `process.env`), reference-counted so it is safe to call from overlapping
// daemon instances in one process. The caller owns the `process.env`
// reference so the serve-surface process.env guard still sees the access;
// one-shot scrubs of a private env object (ACP child / channel worker boot)
// use the same reporting scrub without a snapshot. Concurrent callers must
// pass the same shared env object for the snapshot/restore refcount to be
// correct.
export function acquireInheritedLoaderEnvScrub(
  env: NodeJS.ProcessEnv,
  commandLabel: string,
  processLabel: string,
): InheritedLoaderEnvScrubHandle {
  sharedProcessEnvScrubDepth++;
  // Snapshot on every acquire, not just the first: the embedding host can
  // assign loader keys between acquires, and the scrub below deletes them
  // with no record — the final release would then leave the assignment
  // absent or restore a stale pre-scrub value, corrupting the shared env.
  // The newest value observed at any acquire boundary is the one the final
  // restore must bring back. The snapshot is recorded inside the scrub's
  // single pass over the shared env below.
  const removedKeys = scrubAndReportInheritedLoaderEnv(
    env,
    commandLabel,
    processLabel,
    sharedProcessEnvScrubOriginals,
  );
  let released = false;
  return {
    removedKeys,
    release() {
      if (released) return;
      released = true;
      sharedProcessEnvScrubDepth--;
      if (sharedProcessEnvScrubDepth > 0) return;
      for (const [key, value] of sharedProcessEnvScrubOriginals) {
        // A later legitimate assignment wins over the restore.
        if (!Object.hasOwn(env, key)) env[key] = value;
      }
      sharedProcessEnvScrubOriginals.clear();
    },
  };
}

/** Test-only: reset the shared process-env scrub refcount/snapshot. */
export function resetInheritedLoaderEnvScrubForTesting(): void {
  sharedProcessEnvScrubDepth = 0;
  sharedProcessEnvScrubOriginals.clear();
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

// Overlapping daemons in one process each install their own reporter at boot
// and clear it on close. An unconditional clear lets the first daemon's
// close() drop the survivor's reporter, silently routing its fresh rejections
// to the stderr fallback. Clear only when we are still the active reporter, so
// a co-resident daemon that installed after us keeps its own.
export function clearLoaderKeyRejectionReporterIfCurrent(
  reporter: LoaderKeyRejectionReporter,
): void {
  if (loaderKeyRejectionReporter === reporter) {
    loaderKeyRejectionReporter = undefined;
  }
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
