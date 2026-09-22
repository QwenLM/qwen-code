// Force strict mode and setup for ESM
"use strict";
import {
  PRIVATE_CONVERSATIONS_RUNTIME_ENV
} from "./chunk-32CM56LO.js";
import {
  writeStderrLineSafe
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/acp-channel-fallback.ts
init_esbuild_shims();
var QWEN_CODE_SERVE_ENV = "QWEN_CODE_SERVE";
var QWEN_CODE_DESKTOP_ENV = "QWEN_CODE_DESKTOP";
function resolveAcpChannelFallback(env = process.env) {
  if (env[QWEN_CODE_DESKTOP_ENV] === "1") {
    return "desktop";
  }
  if (env[QWEN_CODE_SERVE_ENV] === "1") {
    return "daemon";
  }
  return "ACP";
}
__name(resolveAcpChannelFallback, "resolveAcpChannelFallback");

// packages/cli/src/config/shared-env-keys.ts
init_esbuild_shims();
var DEFAULT_EXCLUDED_ENV_VARS = ["DEBUG", "DEBUG_MODE"];
var ENV_CORRUPTED_PATH = "QWEN_CODE_SETTINGS_CORRUPTED_PATH";
var ENV_WAS_RECOVERED = "QWEN_CODE_SETTINGS_WAS_RECOVERED";
var ENV_ACP_REPEATED_TOOL_FAILURE_GUARD = "QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD";
var PROJECT_ENV_HARDCODED_EXCLUSIONS = [
  "QWEN_HOME",
  "QWEN_RUNTIME_DIR",
  "QWEN_CODE_MCP_APPROVALS_PATH",
  "QWEN_CODE_TRUSTED_FOLDERS_PATH",
  // These two select which file becomes the System / SystemDefaults settings
  // layer. A project `.env` must never redirect them: the System layer
  // outranks the operator's own User settings, so a repository could promote
  // its own file into the highest-precedence layer — renaming the product in
  // every connected browser via `ui.brand`, among other operator-only
  // settings that read only the operator scopes.
  "QWEN_CODE_SYSTEM_SETTINGS_PATH",
  "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
  // Downloaded updates execute as the user; a project must not select them.
  "QWEN_UPDATE_BASE_URL",
  // This points to a host temp file that carries build warnings. A project
  // `.env` must not redirect it to an arbitrary file to read or delete.
  "QWEN_CODE_WARNINGS_FILE",
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
  "QWEN_CODE_MEMORY_PROJECT_SCOPE",
  // Workflow execution is an explicit user opt-in. A project must not enable
  // it or override a user opt-in through settings.env or a project .env.
  "QWEN_CODE_ENABLE_WORKFLOWS",
  "QWEN_CODE_DISABLE_WORKFLOWS",
  // The name-only lock is a deployment policy. A project that wants it sets
  // tools.workflowNameOnly, which a workspace may only turn on; a project
  // .env must not be able to unset the operator's exported value.
  "QWEN_CODE_WORKFLOW_NAME_ONLY",
  // The review prebuild (commands/review/lib/prebuild.ts) is an operator
  // decision: CI welds it as real step env, a local operator exports it. A
  // project `.env` must not opt its own review into the blocking
  // install+build prefix — and the read-time provenance check there cannot
  // see file-sourcing across a process boundary (a child inherits the value
  // with an empty registry), so the key must never enter the environment
  // from repository content at all. prebuild.test.ts pins the membership
  // with both real symbols.
  "QWEN_REVIEW_PREBUILD",
  // The automatic-review marker (commands/review/lib/docs-nav-profile.ts
  // `automaticReviewRequested`) is an operator decision in the same class:
  // it selects the reduced docs-nav profile, so a repository must not
  // declare its own — possibly manual — review automatic and shrink the
  // review of its own change to one reviewer with no reverse audit. CI
  // welds it as a real step env, never a file.
  "QWEN_REVIEW_AUTOMATIC",
  // QWEN_TLS_INSECURE (and NODE_TLS_REJECT_UNAUTHORIZED, which it mirrors)
  // disable TLS certificate verification for all outbound API connections. A
  // project `.env` must never enable either — that would let an untrusted repo
  // silently turn off MITM protection. Opt-in stays with the user via the
  // `--insecure` flag, the shell environment, or a home `.env`. The initial
  // `.env` load only consults this list, so both keys must be here (not just
  // RELOAD_EXCLUDED_KEYS, which only applies on reload).
  "QWEN_TLS_INSECURE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // NODE_EXTRA_CA_CERTS reaches the same outcome by adding a TLS trust
  // anchor instead of disabling verification.
  "NODE_EXTRA_CA_CERTS",
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
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "npm_config_cafile",
  "npm_config_ca",
  // npm treats underscore/hyphen spellings of a config key as the same key
  // (see canonicalLoaderKey below), so both forms of strict-ssl are listed.
  "npm_config_strict_ssl",
  "npm_config_strict-ssl",
  "PIP_CERT",
  // CURL_HOME / WGETRC redirect curl/wget at attacker rc files
  // (`$CURL_HOME/.curlrc`, the file WGETRC names) whose `proxy`, `cacert`, or
  // `insecure` directives intercept or downgrade the same token-bearing
  // traffic — the config-file-redirect class this list already blocks for npm
  // (`npm_config_userconfig`), git (`GIT_CONFIG_GLOBAL`), and OpenSSL
  // (`OPENSSL_CONF`).
  "CURL_HOME",
  "WGETRC",
  // PIP_CONFIG_FILE redirects all of pip's configuration at the file it
  // names — index-url, trusted-host, proxy, cert, or client-cert in an
  // attacker file sends session pip traffic or credentials to attacker
  // infrastructure — the same config-file-redirect class as
  // npm_config_userconfig and GIT_CONFIG_GLOBAL.
  "PIP_CONFIG_FILE",
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
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  // git merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`, so a
  // project `.env` redirecting XDG_CONFIG_HOME plants the same config
  // injection (`core.hooksPath`, …) the GIT_CONFIG_* keys block — without
  // naming a git config file at all.
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  // The sandbox backend selection and network mode are confinement decisions.
  // QWEN_SANDBOX decides whether confinement runs at all and which backend
  // (an untrusted repo could cancel it with `QWEN_SANDBOX=false`, or force a
  // backend over the operator's choice), and QWEN_SANDBOX_IMAGE selects the
  // container image the agent runs inside. `resolveSandboxNetworkMode` flips
  // to `proxied` purely on the presence of QWEN_SANDBOX_PROXY_COMMAND, and
  // the bwrap branch then executes that value through `bash -c` on the host,
  // outside the confinement, before the agent starts. A project `.env` or
  // settings.env supplying any of them is repository content deciding the
  // confinement — the same class as GIT_PROXY_COMMAND. The operator's launch
  // environment or a home `.env` remains the only trusted source.
  "QWEN_SANDBOX",
  "QWEN_SANDBOX_IMAGE",
  "QWEN_SANDBOX_PROXY_COMMAND",
  "QWEN_SANDBOX_NET",
  // Runtime markers come from the launcher, never from configuration files.
  // They also belong to the all-scope provenance gate below.
  "SANDBOX",
  "SANDBOX_ENFORCEMENT",
  // The bwrap writable-root derivation reads XDG_CACHE_HOME and, via
  // os.tmpdir(), TMPDIR/TMP/TEMP (its POSIX fallback order). A project `.env`
  // pointing one inside the home directory ($HOME/.ssh, $HOME/.aws, …) would
  // make the confinement bind that directory read-write. Values from the
  // launch environment or a home `.env` are the operator's own choice and
  // stay honored.
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  // git falls back to executing $SSH_ASKPASS for passphrase prompts (its
  // askpass order is GIT_ASKPASS > core.askPass > SSH_ASKPASS, and ssh runs
  // it whenever SSH_ASKPASS_REQUIRE=force or no terminal is available), so a
  // project `.env` pointing it at an attacker script is code execution on
  // any git/ssh auth challenge. SSH_ASKPASS_REQUIRE stays settable: it only
  // selects *when* the askpass program runs, and with SSH_ASKPASS
  // project-blocked it has no program to execute.
  "SSH_ASKPASS",
  // less executes $LESSOPEN as an input preprocessor on every file a session
  // views (and $LESSCLOSE on exit whenever the preprocessor ran), so a
  // project `.env` setting either is attacker command execution the first
  // time a session runs `less`.
  "LESSOPEN",
  "LESSCLOSE",
  // node-gyp interpreter selection: node-gyp's find-python.js executes
  // NODE_GYP_FORCE_PYTHON / npm_config_python / PYTHON as the build Python,
  // so a project `.env` pointing them at an attacker script is code execution
  // during any native-addon `npm install` in another workspace's session.
  // Unlike the pure-injection loader keys these have a legitimate
  // operator-shell use (selecting a real interpreter), so they are
  // reject-from-project-`.env` only, not scrubbed from the launch env.
  "NODE_GYP_FORCE_PYTHON",
  "npm_config_python",
  "PYTHON",
  // CPython executes $PYTHONSTARTUP at interactive startup — the Python
  // analogue of NODE_REPL_EXTERNAL_MODULE. It stays reject-only (like
  // PYTHON) because operators legitimately set it in their own shells.
  "PYTHONSTARTUP",
  // git's documented editor fallback chain (GIT_EDITOR → core.editor →
  // $VISUAL → $EDITOR) executes these exactly like the blocked GIT_EDITOR,
  // and the CLI's own useLaunchEditor spawns them from ordinary interactive
  // flows.
  "VISUAL",
  "EDITOR",
  // npm runs `$npm_config_git` as the git binary for install-from-git and
  // similar flows, so a project `.env` pointing it at an attacker script is
  // the same exec redirect as the interpreter keys above.
  "npm_config_git",
  // The CLI itself execs $BROWSER via openBrowserSecurely (core/utils/
  // secure-browser-launcher.ts) before any CI/DISPLAY gate, so a project
  // `.env` pointing it at an attacker script runs on any browser-launch
  // flow.
  "BROWSER",
  // QWEN_CLI_ENTRY is the script path daemon-spawned session processes run.
  // A project `.env` or settings.env fixing it turns
  // `cd <untrusted repo> && qwen serve` into code execution as the daemon
  // via an attacker-chosen ACP entrypoint, for every workspace's sessions.
  "QWEN_CLI_ENTRY",
  // QWEN_CDP_MCP_COMMAND is the command the daemon spawns as the
  // browser-automation MCP adapter, and QWEN_SERVE_CDP_TUNNEL_OVER_WS
  // switches that tunnel surface on. A project `.env` or settings.env fixing
  // either hijacks the daemon the same way QWEN_CLI_ENTRY does; values the
  // operator set in the daemon's launch env still apply.
  "QWEN_CDP_MCP_COMMAND",
  "QWEN_SERVE_CDP_TUNNEL_OVER_WS",
  // QWEN_SERVE_NEW_FILE_MODE decides the creation mode of every agent-written
  // NEW file (owner-only 0600 vs umask-derived). A project `.env` flipping it
  // to `system` would silently widen file visibility daemon-wide — including
  // files written for OTHER workspaces — with no warning, since `system` is a
  // valid value. The fail-closed 0600 posture is an operator decision
  // (documented as a per-daemon opt-in), so only the daemon's launch
  // environment or a home `.env` may set it.
  "QWEN_SERVE_NEW_FILE_MODE",
  "QWEN_SERVE_MAX_WORKSPACES",
  // QWEN_SERVE_SESSION_ATTACHMENTS_ROOT decides where the daemon stores
  // every workspace's session attachments. A project `.env` redirecting it
  // would capture uploads for ALL workspaces the daemon serves — and reads
  // consult the configured root first, so attacker-modified bytes would be
  // served back — with no recovery after unsetting the variable. The
  // location is an operator decision (documented as a per-daemon opt-in), so
  // only the daemon's launch environment or a home `.env` may set it.
  "QWEN_SERVE_SESSION_ATTACHMENTS_ROOT",
  // DEV gates the daemon's inherited-loader-env scrub (run-qwen-serve.ts);
  // only the dev harness (scripts/dev.js) stamps it into the launch env. A
  // project file setting it would silently keep loader vars in the base env
  // distributed to every workspace's session children — reopening the #8653
  // vector for any repo whose .env happens to carry DEV=true.
  "DEV",
  // The Conversations provenance marker is a private daemon-to-child signal:
  // a project `.env` or settings.env must never mark an ordinary workspace
  // child as Conversations-hosted (it would force the writer lease and the
  // unbound-durable-task skip onto sessions the contract does not cover).
  PRIVATE_CONVERSATIONS_RUNTIME_ENV
];
var HARDCODED_PROJECT_ENV_EXCLUSIONS = new Set(
  PROJECT_ENV_HARDCODED_EXCLUSIONS.map((key) => key.toLowerCase())
);
var HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS = [
  /^git_config_key_\d+$/u,
  /^git_config_value_\d+$/u
];
function isHardcodedProjectEnvExclusion(key) {
  const lowerKey = key.toLowerCase();
  return HARDCODED_PROJECT_ENV_EXCLUSIONS.has(lowerKey) || HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS.some(
    (pattern) => pattern.test(lowerKey)
  );
}
__name(isHardcodedProjectEnvExclusion, "isHardcodedProjectEnvExclusion");
var PRIVATE_PROVENANCE_ENV_KEYS = /* @__PURE__ */ new Set([
  PRIVATE_CONVERSATIONS_RUNTIME_ENV.toLowerCase(),
  "sandbox",
  "sandbox_enforcement"
]);
function isPrivateProvenanceEnvKey(key) {
  return PRIVATE_PROVENANCE_ENV_KEYS.has(key.toLowerCase());
}
__name(isPrivateProvenanceEnvKey, "isPrivateProvenanceEnvKey");
var HOME_ENV_BOOTSTRAP_KEYS = [
  "QWEN_HOME",
  "QWEN_RUNTIME_DIR",
  "QWEN_CODE_MCP_APPROVALS_PATH",
  "QWEN_CODE_TRUSTED_FOLDERS_PATH"
];
var INHERITED_LOADER_ENV_KEYS = [
  "NODE_OPTIONS",
  // npm maps its `node-options` config onto npm_config_node_options in the
  // environment, and `npm run` lifecycle scripts apply it like NODE_OPTIONS —
  // the same hijack through an adjacent key. The config-file keys are the
  // same hijack one level up: they point npm at an attacker-chosen .npmrc
  // that can itself set node-options/script-shell/ignore-scripts, and `npm
  // run` itself exports them into the script environment.
  "npm_config_node_options",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "npm_config_script_shell",
  "npm_config_prefix",
  "NODE_PATH",
  // OPENSSL_CONF points Node's startup crypto init at an attacker `.cnf`
  // whose `nodejs_conf` section can dlopen an arbitrary engine/provider `.so`
  // before any user code runs — a pure code-injection vector with no benign
  // cross-workspace inheritance, so it is scrubbed like NODE_OPTIONS.
  "OPENSSL_CONF",
  // NODE_REPL_EXTERNAL_MODULE makes a spawned `node` REPL require() an
  // attacker file at startup. npm_config_node_gyp overrides the node-gyp
  // *script* npm's shim runs verbatim (`"$npm_config_node_gyp" "$@"`), and
  // npm_config_init_module is require()d by `npm init` (even `-y`). All three
  // are executable/module redirects with no legitimate login-shell use, so
  // they join the scrubbed loader set rather than the reject-only tier.
  "NODE_REPL_EXTERNAL_MODULE",
  "npm_config_node_gyp",
  "npm_config_init_module",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "BASH_ENV",
  // zsh sources $ZDOTDIR/.zshenv on every invocation, including
  // non-interactive `zsh -c` — the zsh analogue of BASH_ENV.
  "ZDOTDIR"
  // BASH_FUNC_* exported-function definitions are bash's other env-driven
  // code-import channel (non-interactive `bash -c` still imports them);
  // matched by prefix in isLoaderEnvKey, not listed here.
];
var canonicalLoaderKey = /* @__PURE__ */ __name((key) => key.toLowerCase().replace(/_/gu, "-"), "canonicalLoaderKey");
var LOADER_ENV_KEYS = new Set(
  INHERITED_LOADER_ENV_KEYS.map(canonicalLoaderKey)
);
function isLoaderEnvKey(key) {
  const canonical = canonicalLoaderKey(key);
  return canonical.startsWith("bash-func-") || LOADER_ENV_KEYS.has(canonical);
}
__name(isLoaderEnvKey, "isLoaderEnvKey");
function scrubInheritedLoaderEnv(env, snapshotInto) {
  const removedKeys = [];
  for (const key of Object.keys(env)) {
    if (isLoaderEnvKey(key)) {
      const value = env[key];
      if (snapshotInto && value !== void 0) snapshotInto.set(key, value);
      delete env[key];
      removedKeys.push(key);
    }
  }
  return removedKeys;
}
__name(scrubInheritedLoaderEnv, "scrubInheritedLoaderEnv");
function scrubAndReportInheritedLoaderEnv(env, commandLabel, processLabel, snapshotInto) {
  const removedKeys = scrubInheritedLoaderEnv(env, snapshotInto);
  if (removedKeys.length > 0) {
    writeStderrLineSafe(
      `${commandLabel}: scrubbed inherited loader env vars from the ${processLabel} process; session subprocesses will not inherit them: ${removedKeys.join(", ")}`
    );
  }
  return removedKeys;
}
__name(scrubAndReportInheritedLoaderEnv, "scrubAndReportInheritedLoaderEnv");
var sharedProcessEnvScrubDepth = 0;
var sharedProcessEnvScrubOriginals = /* @__PURE__ */ new Map();
function acquireInheritedLoaderEnvScrub(env, commandLabel, processLabel) {
  sharedProcessEnvScrubDepth++;
  const removedKeys = scrubAndReportInheritedLoaderEnv(
    env,
    commandLabel,
    processLabel,
    sharedProcessEnvScrubOriginals
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
        if (!Object.hasOwn(env, key)) env[key] = value;
      }
      sharedProcessEnvScrubOriginals.clear();
    }
  };
}
__name(acquireInheritedLoaderEnvScrub, "acquireInheritedLoaderEnvScrub");
var reportedLoaderKeyRejections = /* @__PURE__ */ new Map();
var loaderKeyRejectionReporter;
function setLoaderKeyRejectionReporter(reporter) {
  loaderKeyRejectionReporter = reporter;
}
__name(setLoaderKeyRejectionReporter, "setLoaderKeyRejectionReporter");
function clearLoaderKeyRejectionReporterIfCurrent(reporter) {
  if (loaderKeyRejectionReporter === reporter) {
    loaderKeyRejectionReporter = void 0;
  }
}
__name(clearLoaderKeyRejectionReporterIfCurrent, "clearLoaderKeyRejectionReporterIfCurrent");
function reportRejectedLoaderKeys(source, candidateKeys) {
  const rejectedKeys = candidateKeys.filter(isLoaderEnvKey);
  const warnedKeys = reportedLoaderKeyRejections.get(source) ?? /* @__PURE__ */ new Set();
  const freshKeys = rejectedKeys.filter((key) => !warnedKeys.has(key));
  if (freshKeys.length === 0) return rejectedKeys;
  for (const key of freshKeys) warnedKeys.add(key);
  reportedLoaderKeyRejections.set(source, warnedKeys);
  if (loaderKeyRejectionReporter) {
    loaderKeyRejectionReporter(source, freshKeys);
  } else {
    writeStderrLineSafe(
      `qwen: ${source} cannot set loader-affecting env vars; ignored: ` + freshKeys.join(", ")
    );
  }
  return rejectedKeys;
}
__name(reportRejectedLoaderKeys, "reportRejectedLoaderKeys");
function resetLoaderKeyRejectionReportingForTesting() {
  reportedLoaderKeyRejections.clear();
}
__name(resetLoaderKeyRejectionReportingForTesting, "resetLoaderKeyRejectionReportingForTesting");

// packages/cli/src/config/compile-cache.ts
init_esbuild_shims();
var PENDING_COMPILE_CACHE_ENV = "QWEN_CODE_PENDING_COMPILE_CACHE";
function publishPendingCompileCache(env = process.env) {
  const pendingDirectory = env[PENDING_COMPILE_CACHE_ENV];
  delete env[PENDING_COMPILE_CACHE_ENV];
  if (pendingDirectory && !env["NODE_COMPILE_CACHE"] && env["NODE_DISABLE_COMPILE_CACHE"] !== "1") {
    env["NODE_COMPILE_CACHE"] = pendingDirectory;
  }
}
__name(publishPendingCompileCache, "publishPendingCompileCache");

// packages/cli/src/config/environment-snapshot.ts
init_esbuild_shims();
var environmentBeforeLoad;
function captureEnvironmentBeforeLoad() {
  environmentBeforeLoad ??= Object.freeze({ ...process.env });
}
__name(captureEnvironmentBeforeLoad, "captureEnvironmentBeforeLoad");
function getEnvironmentBeforeLoad() {
  return environmentBeforeLoad;
}
__name(getEnvironmentBeforeLoad, "getEnvironmentBeforeLoad");
function resetEnvironmentSnapshotForTesting() {
  environmentBeforeLoad = void 0;
}
__name(resetEnvironmentSnapshotForTesting, "resetEnvironmentSnapshotForTesting");

export {
  QWEN_CODE_SERVE_ENV,
  QWEN_CODE_DESKTOP_ENV,
  resolveAcpChannelFallback,
  DEFAULT_EXCLUDED_ENV_VARS,
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  ENV_ACP_REPEATED_TOOL_FAILURE_GUARD,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  isHardcodedProjectEnvExclusion,
  isPrivateProvenanceEnvKey,
  HOME_ENV_BOOTSTRAP_KEYS,
  isLoaderEnvKey,
  scrubInheritedLoaderEnv,
  scrubAndReportInheritedLoaderEnv,
  acquireInheritedLoaderEnvScrub,
  setLoaderKeyRejectionReporter,
  clearLoaderKeyRejectionReporterIfCurrent,
  reportRejectedLoaderKeys,
  resetLoaderKeyRejectionReportingForTesting,
  publishPendingCompileCache,
  captureEnvironmentBeforeLoad,
  getEnvironmentBeforeLoad,
  resetEnvironmentSnapshotForTesting
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
