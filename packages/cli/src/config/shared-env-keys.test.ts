/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  acquireInheritedLoaderEnvScrub,
  clearLoaderKeyRejectionReporterIfCurrent,
  ENV_ACP_REPEATED_TOOL_FAILURE_GUARD,
  HOME_ENV_BOOTSTRAP_KEYS,
  INHERITED_LOADER_ENV_KEYS,
  isHardcodedProjectEnvExclusion,
  isLoaderEnvKey,
  type LoaderKeyRejectionReporter,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  reportRejectedLoaderKeys,
  resetInheritedLoaderEnvScrubForTesting,
  resetLoaderKeyRejectionReportingForTesting,
  scrubAndReportInheritedLoaderEnv,
  scrubInheritedLoaderEnv,
  setLoaderKeyRejectionReporter,
} from './shared-env-keys.js';

describe('PROJECT_ENV_HARDCODED_EXCLUSIONS', () => {
  // Security guard: a project `.env` must never be able to disable TLS
  // certificate verification. Removing this key would let an untrusted repo
  // silently turn off MITM protection for all API connections.
  it('excludes QWEN_TLS_INSECURE so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_TLS_INSECURE');
  });

  // isTlsVerificationDisabled() also honors NODE_TLS_REJECT_UNAUTHORIZED=0, and
  // the initial .env load only consults this list, so it must be blocked here
  // too — otherwise a project .env could bypass TLS via the Node-native var.
  it('excludes NODE_TLS_REJECT_UNAUTHORIZED so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('keeps ACP repeated-tool-failure rollout policy operator-owned', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      ENV_ACP_REPEATED_TOOL_FAILURE_GUARD,
    );
  });

  it('keeps daemon memory scope operator-owned', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_MEMORY_PROJECT_SCOPE',
    );
  });

  it('excludes attribution markers so a project .env cannot spoof channel', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CODE_SERVE');
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CODE_DESKTOP');
  });

  // QWEN_CLI_ENTRY is the spawned session-process entrypoint; a project file
  // fixing it is arbitrary script execution as the daemon.
  // NODE_EXTRA_CA_CERTS adds a TLS trust anchor — the
  // NODE_TLS_REJECT_UNAUTHORIZED outcome by addition instead of disable.
  it('excludes entrypoint and trust-anchor keys', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CLI_ENTRY');
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('NODE_EXTRA_CA_CERTS');
  });

  // The compile-cache keys stay settable from project files: a
  // project-configured V8 cache dir is a pinned feature (#7594, tests in
  // both loaders), and Node validates cache entries against the source, so
  // a poisoned/shared dir degrades to cache misses.
  it('keeps compile-cache keys out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'NODE_COMPILE_CACHE',
    );
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'QWEN_CODE_PENDING_COMPILE_CACHE',
    );
  });

  // DEV gates the daemon's loader-env scrub; a project file setting it
  // would keep loader vars in the base env distributed to every workspace's
  // session children, reopening the #8653 vector.
  it('excludes DEV so a project .env cannot spoof the dev harness', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('DEV');
  });

  // The non-Node TLS trust-anchor vars reach the same MITM outcome as
  // NODE_EXTRA_CA_CERTS for the curl/git/openssl/python tools a session
  // shells out to; a project .env must not inject an attacker CA.
  it('excludes the non-Node TLS trust-anchor vars', () => {
    for (const key of [
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'GIT_SSL_CAPATH',
      'npm_config_cafile',
      'npm_config_ca',
      'npm_config_strict_ssl',
      'PIP_CERT',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // npm treats underscore/hyphen spellings of a config key as the same key,
  // so the hyphen twin of npm_config_strict_ssl must be excluded too.
  it('excludes both spellings of the npm strict-ssl knob', () => {
    expect(isHardcodedProjectEnvExclusion('npm_config_strict_ssl')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('npm_config_strict-ssl')).toBe(true);
  });

  // CURL_HOME/WGETRC redirect curl/wget at attacker rc files whose proxy/
  // cacert/insecure directives reach the same MITM outcome the TLS-anchor
  // tier blocks — the config-file-redirect class, not a search path.
  it('excludes the curl/wget rc-file redirect vars', () => {
    for (const key of ['CURL_HOME', 'WGETRC']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // git executes these on any session git invocation (SSH command, external
  // diff, config-injected core.hooksPath); a project .env setting them is
  // code execution as the daemon user.
  it('excludes the git command-execution env family', () => {
    for (const key of [
      'GIT_SSH_COMMAND',
      'GIT_SSH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'GIT_ASKPASS',
      'GIT_PROXY_COMMAND',
      'GIT_EDITOR',
      'GIT_EXTERNAL_DIFF',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // node-gyp interpreter selection runs the pointed-at file as the build
  // Python; a project .env must not redirect it.
  it('excludes the node-gyp interpreter-selection and git-binary vars', () => {
    for (const key of [
      'NODE_GYP_FORCE_PYTHON',
      'npm_config_python',
      'PYTHON',
      'npm_config_git',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // PIP_CONFIG_FILE redirects all of pip's configuration (index-url /
  // trusted-host / proxy / cert) at an attacker file; SSH_ASKPASS is the
  // askpass fallback git/ssh execute on an auth challenge; less executes
  // LESSOPEN (and LESSCLOSE when the preprocessor ran) as an input
  // preprocessor. Each is code execution or credential diversion from a
  // project .env.
  it('excludes pip config, ssh askpass, and less preprocessor redirects', () => {
    for (const key of [
      'PIP_CONFIG_FILE',
      'SSH_ASKPASS',
      'LESSOPEN',
      'LESSCLOSE',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // SSH_ASKPASS_REQUIRE only selects *when* the askpass program runs; with
  // SSH_ASKPASS project-blocked it has nothing to execute, so it stays
  // settable from project files.
  it('keeps SSH_ASKPASS_REQUIRE out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'SSH_ASKPASS_REQUIRE',
    );
    expect(isHardcodedProjectEnvExclusion('SSH_ASKPASS_REQUIRE')).toBe(false);
  });

  // git executes GIT_SEQUENCE_EDITOR for the `git rebase -i` todo list like
  // GIT_EDITOR, and merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`
  // — a config-discovery redirect that bypasses the GIT_CONFIG_* blocks.
  it('excludes the git sequence editor and XDG config redirect', () => {
    for (const key of ['GIT_SEQUENCE_EDITOR', 'XDG_CONFIG_HOME']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // git's editor fallback chain ($VISUAL/$EDITOR) and the CLI's own
  // useLaunchEditor spawn these like the blocked GIT_EDITOR; CPython executes
  // PYTHONSTARTUP at interactive startup; the CLI execs $BROWSER via
  // openBrowserSecurely. Each is an exec redirect from a project .env.
  it('excludes the editor, startup, and browser exec-redirect keys', () => {
    for (const key of ['VISUAL', 'EDITOR', 'PYTHONSTARTUP', 'BROWSER']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // QWEN_CDP_MCP_COMMAND is spawned by the daemon as the browser-automation
  // MCP adapter and QWEN_SERVE_CDP_TUNNEL_OVER_WS switches that tunnel
  // surface on — the same daemon-hijack class as QWEN_CLI_ENTRY.
  it('excludes the serve CDP adapter command and tunnel switch', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_CDP_MCP_COMMAND');
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_SERVE_CDP_TUNNEL_OVER_WS',
    );
  });

  // Workspace settings.env QWEN_SERVER_TOKEN is an intentional fast-path
  // feature (fast-path.test.ts loads it without the full settings loader);
  // it stays reload-only rather than hardcoded-excluded.
  it('keeps QWEN_SERVER_TOKEN out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain('QWEN_SERVER_TOKEN');
  });

  it('does not bootstrap attribution markers from a home .env', () => {
    expect(HOME_ENV_BOOTSTRAP_KEYS).not.toContain('QWEN_CODE_SERVE');
    expect(HOME_ENV_BOOTSTRAP_KEYS).not.toContain('QWEN_CODE_DESKTOP');
  });
});

describe('isHardcodedProjectEnvExclusion', () => {
  // Windows env lookup is case-insensitive; exact-case membership would let
  // `node_extra_ca_certs`/`qwen_cli_entry` slip past every application gate.
  it('matches the hardcoded exclusions case-insensitively', () => {
    expect(isHardcodedProjectEnvExclusion('QWEN_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('node_extra_ca_certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('Node_Extra_Ca_Certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_cli_entry')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('DEV')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('dev')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SERVER_TOKEN')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('NODE_OPTIONS')).toBe(false);
  });

  it('matches the newly added hardcoded exclusions case-insensitively', () => {
    expect(isHardcodedProjectEnvExclusion('SSL_CERT_FILE')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('ssl_cert_file')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSH_COMMAND')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_ssh_command')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_ssh')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_PARAMETERS')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_config_parameters')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('PYTHON')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('python')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('npm_config_python')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_EXEC_PATH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_template_dir')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_askpass')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_PROXY_COMMAND')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSL_CAPATH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pip_cert')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('CURL_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('wgetrc')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pip_config_file')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('SSH_ASKPASS')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('ssh_askpass')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('LESSOPEN')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('lessclose')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SEQUENCE_EDITOR')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_sequence_editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('XDG_CONFIG_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('xdg_config_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('VISUAL')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('visual')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('EDITOR')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('PYTHONSTARTUP')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pythonstartup')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('BROWSER')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('browser')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_CDP_MCP_COMMAND')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_cdp_mcp_command')).toBe(true);
    expect(
      isHardcodedProjectEnvExclusion('QWEN_SERVE_CDP_TUNNEL_OVER_WS'),
    ).toBe(true);
    expect(
      isHardcodedProjectEnvExclusion('qwen_serve_cdp_tunnel_over_ws'),
    ).toBe(true);
  });

  // Numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs are an unbounded
  // index, matched by numeric suffix rather than literal membership.
  it('matches numbered GIT_CONFIG_KEY_/VALUE_ pairs by numeric suffix', () => {
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_0')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_VALUE_0')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_config_key_12')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_VALUE_7')).toBe(true);
    // Git only reads decimal-numbered pairs (GIT_CONFIG_KEY_%d), so keys
    // with empty, nonnumeric, or trailing-garbage suffixes are
    // project-defined variables Git never consumes and must stay settable.
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_CACHE')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('git_config_value_cache')).toBe(
      false,
    );
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_0X')).toBe(false);
    // A key that merely starts with GIT_CONFIG but is not a KEY_/VALUE_ pair
    // (and not a listed literal) is not excluded: GIT_CONFIG_NOSYSTEM only
    // skips the system gitconfig read and injects nothing.
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_NOSYSTEM')).toBe(false);
  });
});

describe('isLoaderEnvKey', () => {
  // npm's config reader matches /^npm_config_/i and then replaces
  // non-leading underscores with hyphens, so the hyphen spelling
  // npm_config_node-options maps onto the same node-options config and is
  // injected as NODE_OPTIONS into every `npm run` lifecycle script. Both
  // spellings (in every case variant) must count as the same loader key.
  it('matches npm underscore/hyphen spelling variants case-insensitively', () => {
    expect(isLoaderEnvKey('npm_config_node_options')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node-options')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_NODE-OPTIONS')).toBe(true);
    expect(isLoaderEnvKey('Node_Options')).toBe(true);
    expect(isLoaderEnvKey('ld_preload')).toBe(true);
    expect(isLoaderEnvKey('npm_config_registry')).toBe(false);
    expect(isLoaderEnvKey('PATH')).toBe(false);
    expect(isLoaderEnvKey('NODE_OPTIONS_EXTRA')).toBe(false);
  });

  // The npm config-file keys redirect npm to an attacker-chosen .npmrc —
  // the node-options hijack one level up. Note the underscore/hyphen
  // equivalence only covers npm's real config names: `userconfig` has no
  // hyphen, so npm_config_user-config maps to a different (harmless) key.
  it('matches the npm config-file redirect keys', () => {
    expect(isLoaderEnvKey('npm_config_userconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_globalconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script_shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_prefix')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_USERCONFIG')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script-shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_user-config')).toBe(false);
  });

  // bash imports exported function definitions from the environment even in
  // non-interactive `bash -c`; the function name is embedded in the key, so
  // this is a prefix rule rather than a listed literal.
  it('matches BASH_FUNC_* exported function definitions by prefix', () => {
    expect(isLoaderEnvKey('BASH_FUNC_id%%')).toBe(true);
    expect(isLoaderEnvKey('BASH_FUNC_anything()')).toBe(true);
    expect(isLoaderEnvKey('bash_func_id%%')).toBe(true);
  });

  // Pure code-injection vectors with no benign cross-workspace inheritance:
  // OPENSSL_CONF (dlopen an engine at crypto init), NODE_REPL_EXTERNAL_MODULE
  // (require at REPL start), and the npm node-gyp/init script redirects.
  it('matches the pure-injection loader keys added for the #8653 follow-up', () => {
    expect(isLoaderEnvKey('OPENSSL_CONF')).toBe(true);
    expect(isLoaderEnvKey('openssl_conf')).toBe(true);
    expect(isLoaderEnvKey('NODE_REPL_EXTERNAL_MODULE')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node_gyp')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node-gyp')).toBe(true);
    expect(isLoaderEnvKey('npm_config_init_module')).toBe(true);
    expect(isLoaderEnvKey('npm_config_init-module')).toBe(true);
  });

  // The interpreter-selection vars stay in the reject-only hardcoded tier
  // (they have a legitimate operator-shell use), NOT the scrubbed loader set.
  it('does not scrub interpreter-selection or TLS-anchor keys', () => {
    expect(isLoaderEnvKey('PYTHON')).toBe(false);
    expect(isLoaderEnvKey('npm_config_python')).toBe(false);
    expect(isLoaderEnvKey('NODE_GYP_FORCE_PYTHON')).toBe(false);
    expect(isLoaderEnvKey('SSL_CERT_FILE')).toBe(false);
    expect(isLoaderEnvKey('GIT_SSH_COMMAND')).toBe(false);
    expect(isLoaderEnvKey('GIT_EXEC_PATH')).toBe(false);
    expect(isLoaderEnvKey('GIT_TEMPLATE_DIR')).toBe(false);
    expect(isLoaderEnvKey('npm_config_cafile')).toBe(false);
    expect(isLoaderEnvKey('PIP_CERT')).toBe(false);
    expect(isLoaderEnvKey('CURL_HOME')).toBe(false);
    expect(isLoaderEnvKey('WGETRC')).toBe(false);
    expect(isLoaderEnvKey('PIP_CONFIG_FILE')).toBe(false);
    expect(isLoaderEnvKey('SSH_ASKPASS')).toBe(false);
    expect(isLoaderEnvKey('LESSOPEN')).toBe(false);
    expect(isLoaderEnvKey('LESSCLOSE')).toBe(false);
    expect(isLoaderEnvKey('GIT_SEQUENCE_EDITOR')).toBe(false);
    expect(isLoaderEnvKey('XDG_CONFIG_HOME')).toBe(false);
    expect(isLoaderEnvKey('VISUAL')).toBe(false);
    expect(isLoaderEnvKey('EDITOR')).toBe(false);
    expect(isLoaderEnvKey('PYTHONSTARTUP')).toBe(false);
    expect(isLoaderEnvKey('BROWSER')).toBe(false);
    expect(isLoaderEnvKey('QWEN_CDP_MCP_COMMAND')).toBe(false);
    expect(isLoaderEnvKey('QWEN_SERVE_CDP_TUNNEL_OVER_WS')).toBe(false);
  });

  // Library search paths and the interactive-sh-only ENV are deliberately
  // reload-only: scrubbing them breaks mainstream toolchains.
  it('does not match search paths or the ENV convention', () => {
    expect(isLoaderEnvKey('LD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('DYLD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('ENV')).toBe(false);
    expect(isLoaderEnvKey('env')).toBe(false);
  });
});

describe('scrubInheritedLoaderEnv', () => {
  // Regression for #8653: loader vars inherited from the daemon's launch
  // shell must not reach session subprocesses of other workspaces.
  it('removes every loader-affecting key and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      npm_config_node_options: '--import file:///other-checkout/hook.mjs',
      npm_config_userconfig: '/other-checkout/.npmrc',
      NODE_PATH: '/other-checkout/node_modules',
      OPENSSL_CONF: '/evil.cnf',
      NODE_REPL_EXTERNAL_MODULE: '/evil.mjs',
      npm_config_node_gyp: '/evil-gyp.js',
      npm_config_init_module: '/evil-init.js',
      LD_PRELOAD: '/evil.so',
      LD_AUDIT: '/evil-audit.so',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
      BASH_ENV: '/tmp/hook.sh',
      ZDOTDIR: '/other-checkout/zdot',
      'BASH_FUNC_id%%': '() { echo pwned; }',
      LD_LIBRARY_PATH: '/opt/conda/lib',
      DYLD_LIBRARY_PATH: '/usr/local/cuda/lib64',
      ENV: 'production',
      PATH: '/other-checkout/node_modules/.bin:/usr/bin',
      HOME: '/home/user',
      QWEN_SERVER_TOKEN: 'leave-secret-scrubbing-to-other-layers',
    };

    const removedKeys = scrubInheritedLoaderEnv(env);

    for (const key of INHERITED_LOADER_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // The removed-key list backs the startup breadcrumb and must only name
    // keys that were actually present.
    expect(removedKeys).toEqual([
      'NODE_OPTIONS',
      'npm_config_node_options',
      'npm_config_userconfig',
      'NODE_PATH',
      'OPENSSL_CONF',
      'NODE_REPL_EXTERNAL_MODULE',
      'npm_config_node_gyp',
      'npm_config_init_module',
      'LD_PRELOAD',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ZDOTDIR',
      'BASH_FUNC_id%%',
    ]);
    expect(scrubInheritedLoaderEnv(env)).toEqual([]);
    // PATH/HOME are launch-environment facts the session still needs, and
    // the library search paths / ENV stay for toolchain compatibility; only
    // injection-class keys are scrubbed.
    expect(env['PATH']).toBe('/other-checkout/node_modules/.bin:/usr/bin');
    expect(env['HOME']).toBe('/home/user');
    expect(env['LD_LIBRARY_PATH']).toBe('/opt/conda/lib');
    expect(env['DYLD_LIBRARY_PATH']).toBe('/usr/local/cuda/lib64');
    expect(env['ENV']).toBe('production');
    expect(env['QWEN_SERVER_TOKEN']).toBe(
      'leave-secret-scrubbing-to-other-layers',
    );
  });

  // npm applies npm_config_* env vars case-insensitively, and Windows env
  // lookup is case-insensitive outright, so exact-case scrubbing would leave
  // variants like NPM_CONFIG_NODE_OPTIONS loader-effective after the scrub.
  it('removes case variants of loader-affecting keys', () => {
    const env: NodeJS.ProcessEnv = {
      NPM_CONFIG_NODE_OPTIONS: '--import file:///other-checkout/hook.mjs',
      Node_Options: '--import file:///other-checkout/harness.mjs',
      ld_preload: '/evil.so',
      PATH: '/usr/bin',
    };

    expect(scrubInheritedLoaderEnv(env)).toEqual([
      'NPM_CONFIG_NODE_OPTIONS',
      'Node_Options',
      'ld_preload',
    ]);
    expect(env['PATH']).toBe('/usr/bin');
  });

  // npm treats npm_config_node-options (hyphen) and npm_config_node_options
  // (underscore) as the same config key, so the scrub must remove both
  // spellings or the hyphen variant survives into session subprocesses.
  it('removes npm underscore/hyphen spelling variants', () => {
    const env: NodeJS.ProcessEnv = {
      'npm_config_node-options': '--import file:///other-checkout/hook.mjs',
      'NPM_CONFIG_NODE-OPTIONS': '--import file:///other-checkout/hook.mjs',
      PATH: '/usr/bin',
    };

    expect(scrubInheritedLoaderEnv(env)).toEqual([
      'npm_config_node-options',
      'NPM_CONFIG_NODE-OPTIONS',
    ]);
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('pins the exact loader-key list so silent edits fail', () => {
    expect([...INHERITED_LOADER_ENV_KEYS].sort()).toEqual([
      'BASH_ENV',
      'DYLD_INSERT_LIBRARIES',
      'LD_AUDIT',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_REPL_EXTERNAL_MODULE',
      'OPENSSL_CONF',
      'ZDOTDIR',
      'npm_config_globalconfig',
      'npm_config_init_module',
      'npm_config_node_gyp',
      'npm_config_node_options',
      'npm_config_prefix',
      'npm_config_script_shell',
      'npm_config_userconfig',
    ]);
  });
});

describe('reportRejectedLoaderKeys', () => {
  it('returns every rejected key while warning only once per source and key', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'PATH',
          'LD_PRELOAD',
        ]),
      ).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'DYLD_INSERT_LIBRARIES',
        ]),
      ).toEqual(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']);
    } finally {
      write.mockRestore();
    }

    expect(writes.join('').match(/NODE_OPTIONS/gu)).toHaveLength(1);
    expect(writes.join('')).toContain('LD_PRELOAD');
    expect(writes.join('')).toContain('DYLD_INSERT_LIBRARIES');
  });

  // Without the reset the dedup map survives across boots/reloads in one
  // process and silently swallows a repeat rejection for the same source.
  it('warns again for an already-reported source and key after the reset', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      resetLoaderKeyRejectionReportingForTesting();
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
    } finally {
      write.mockRestore();
    }

    expect(writes).toHaveLength(2);
  });
});

describe('scrubAndReportInheritedLoaderEnv', () => {
  function captureStderr(run: () => void): string {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      run();
    } finally {
      write.mockRestore();
    }
    return writes.join('');
  }

  it('scrubs and reports the removed keys with the boundary labels', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      LD_PRELOAD: '/evil.so',
      HOME: '/home/user',
    };

    let removedKeys: string[] = [];
    const breadcrumb = captureStderr(() => {
      removedKeys = scrubAndReportInheritedLoaderEnv(
        env,
        'qwen serve',
        'daemon',
      );
    });

    expect(removedKeys).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
    expect(env['HOME']).toBe('/home/user');
    expect(breadcrumb).toContain(
      'qwen serve: scrubbed inherited loader env vars from the daemon ' +
        'process; session subprocesses will not inherit them: ' +
        'NODE_OPTIONS, LD_PRELOAD',
    );
  });

  it('stays silent when there is nothing to scrub', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' };

    const breadcrumb = captureStderr(() => {
      expect(
        scrubAndReportInheritedLoaderEnv(env, 'qwen', 'ACP child'),
      ).toEqual([]);
    });

    expect(breadcrumb).toBe('');
  });
});

// #8663 follow-up (concurrency): overlapping embedded daemons in one process
// share process.env; a per-daemon scrub+restore races and re-poisons the
// survivor. acquireInheritedLoaderEnvScrub reference-counts so only the last
// release restores.
describe('acquireInheritedLoaderEnvScrub', () => {
  afterEach(() => {
    resetInheritedLoaderEnvScrubForTesting();
    delete process.env['NODE_OPTIONS'];
    delete process.env['LD_PRELOAD'];
  });

  it('does not restore loader vars while a second holder is still active', () => {
    resetInheritedLoaderEnvScrubForTesting();
    const poison = '--import file:///workspace-a/register.mjs';
    process.env['NODE_OPTIONS'] = poison;

    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // Daemon A boots and scrubs the shared env.
      const daemonA = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(daemonA.removedKeys).toContain('NODE_OPTIONS');
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // Daemon B boots into the already-scrubbed env: nothing left to remove.
      const daemonB = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(daemonB.removedKeys).toEqual([]);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // A closes first. Its restore must NOT re-poison B's still-live
      // session subprocesses — the regression this guard closes.
      daemonA.release();
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // Only when the last holder releases is the original value restored.
      daemonB.release();
      expect(process.env['NODE_OPTIONS']).toBe(poison);
    } finally {
      write.mockRestore();
    }
  });

  it('release is idempotent and a later assignment wins over the restore', () => {
    resetInheritedLoaderEnvScrubForTesting();
    process.env['LD_PRELOAD'] = '/evil.so';
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const handle = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(process.env['LD_PRELOAD']).toBeUndefined();
      // A legitimate re-assignment before release must survive the restore.
      process.env['LD_PRELOAD'] = '/legit.so';
      handle.release();
      handle.release(); // idempotent
      expect(process.env['LD_PRELOAD']).toBe('/legit.so');
    } finally {
      write.mockRestore();
    }
  });

  // Regression: the embedding host can assign loader keys between two
  // acquires. The nested scrub deletes that assignment, and only the
  // snapshot taken at the nested acquire lets the final release bring it
  // back — without it the host's value is silently lost, corrupting the
  // shared env of the embedding process.
  it('restores a host assignment made between acquires (A -> assign -> B -> release)', () => {
    resetInheritedLoaderEnvScrubForTesting();
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // Daemon A boots and scrubs the shared env.
      const daemonA = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // The embedding host assigns a loader key while A holds the scrub.
      process.env['NODE_OPTIONS'] = '--max-old-space-size=4096';

      // Daemon B boots and its scrub removes the host assignment.
      const daemonB = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(daemonB.removedKeys).toContain('NODE_OPTIONS');
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // B closes first; A still holds the scrub, so nothing restores yet.
      daemonB.release();
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      // The final release brings the host assignment back.
      daemonA.release();
      expect(process.env['NODE_OPTIONS']).toBe('--max-old-space-size=4096');
    } finally {
      write.mockRestore();
    }
  });

  // The snapshot must track the NEWEST value observed at any acquire
  // boundary: restoring the first acquire's stale value instead would
  // overwrite a host re-assignment the same way losing it would.
  it('restores the newest host assignment, not the stale first-acquire snapshot', () => {
    resetInheritedLoaderEnvScrubForTesting();
    process.env['NODE_OPTIONS'] = '--stale';
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const daemonA = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      process.env['NODE_OPTIONS'] = '--current';
      const daemonB = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(daemonB.removedKeys).toContain('NODE_OPTIONS');
      expect(process.env['NODE_OPTIONS']).toBeUndefined();

      daemonA.release();
      daemonB.release();
      expect(process.env['NODE_OPTIONS']).toBe('--current');
    } finally {
      write.mockRestore();
    }
  });

  // The release that drops the refcount back to zero clears the snapshot;
  // without that clear, the next cycle's final release would restore a key
  // the host removed between cycles, re-injecting a stale loader value into
  // the shared env.
  it('does not restore a prior cycle snapshot for a key the host removed', () => {
    resetInheritedLoaderEnvScrubForTesting();
    process.env['NODE_OPTIONS'] = '--cycle-one';
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const firstCycle = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      firstCycle.release();
      expect(process.env['NODE_OPTIONS']).toBe('--cycle-one');

      // The host removes the key entirely between cycles.
      delete process.env['NODE_OPTIONS'];

      const secondCycle = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(secondCycle.removedKeys).not.toContain('NODE_OPTIONS');
      secondCycle.release();
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  // The test-only reset must drop a leaked cycle's snapshot along with the
  // refcount, or the next test's first release would re-inject the leaked
  // value into process.env.
  it('reset drops a leaked snapshot before the next acquire', () => {
    resetInheritedLoaderEnvScrubForTesting();
    process.env['LD_PRELOAD'] = '/leaked.so';
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // Simulate a holder that never releases before the reset runs.
      acquireInheritedLoaderEnvScrub(process.env, 'qwen serve', 'daemon');
      resetInheritedLoaderEnvScrubForTesting();
      delete process.env['LD_PRELOAD'];

      const handle = acquireInheritedLoaderEnvScrub(
        process.env,
        'qwen serve',
        'daemon',
      );
      expect(handle.removedKeys).toEqual([]);
      handle.release();
      expect(process.env['LD_PRELOAD']).toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  // A loader key present with an undefined value is scrubbed but has
  // nothing to restore; snapshotting it would let the final release write
  // `undefined` back into the env.
  it('does not snapshot loader keys whose value is undefined', () => {
    resetInheritedLoaderEnvScrubForTesting();
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: undefined,
      PATH: '/usr/bin',
    };
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const handle = acquireInheritedLoaderEnvScrub(
        env,
        'qwen serve',
        'daemon',
      );
      expect(handle.removedKeys).toEqual(['NODE_OPTIONS']);
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      handle.release();
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(env['PATH']).toBe('/usr/bin');
    } finally {
      write.mockRestore();
    }
  });
});

describe('clearLoaderKeyRejectionReporterIfCurrent', () => {
  afterEach(() => {
    setLoaderKeyRejectionReporter(undefined);
    resetLoaderKeyRejectionReportingForTesting();
  });

  it('clears only when the given reporter is still the active one', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const calls: string[] = [];
    const reporterA: LoaderKeyRejectionReporter = () => calls.push('A');
    const reporterB: LoaderKeyRejectionReporter = () => calls.push('B');

    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // Two co-resident daemons install their reporters in turn.
      setLoaderKeyRejectionReporter(reporterA);
      setLoaderKeyRejectionReporter(reporterB);

      // Daemon A's close must not drop daemon B's reporter.
      clearLoaderKeyRejectionReporterIfCurrent(reporterA);
      reportRejectedLoaderKeys('/ws-b/.env', ['NODE_OPTIONS']);
      expect(calls).toEqual(['B']);

      // Daemon B's close clears it; further rejections fall back to stderr.
      clearLoaderKeyRejectionReporterIfCurrent(reporterB);
      resetLoaderKeyRejectionReportingForTesting();
      reportRejectedLoaderKeys('/ws-b/.env', ['LD_PRELOAD']);
      expect(calls).toEqual(['B']);
    } finally {
      write.mockRestore();
    }
  });
});
