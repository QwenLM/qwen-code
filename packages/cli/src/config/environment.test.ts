/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeEnvironment,
  getHomeEnvFallbackVars,
  loadEnvironment,
  reloadEnvironment,
  resetEnvironmentTrackingForTesting,
  SETTINGS_DIRECTORY_NAME,
} from './environment.js';
import { ENV_ACP_REPEATED_TOOL_FAILURE_GUARD } from './shared-env-keys.js';
import type { Settings } from './settingsSchema.js';
import { TrustLevel } from './trustedFolders.js';

const TRACKED_ENV = [
  'CLOUD_SHELL',
  'GOOGLE_CLOUD_PROJECT',
  'RUNTIME_DOTENV',
  'RUNTIME_EMPTY',
  'RUNTIME_EXCLUDED',
  'RUNTIME_PARENT',
  'RUNTIME_SETTINGS',
  'RUNTIME_SETTINGS_ONLY',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'npm_config_node_options',
  'npm_config_node-options',
  'npm_config_userconfig',
  'NPM_CONFIG_NODE_OPTIONS',
  'Node_Options',
  'ZDOTDIR',
  'BASH_FUNC_id%%',
  'OPENSSL_CONF',
  'NODE_REPL_EXTERNAL_MODULE',
  'npm_config_node_gyp',
  'npm_config_init_module',
  'SSL_CERT_FILE',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR',
  'GIT_SSL_CAPATH',
  'npm_config_cafile',
  'npm_config_ca',
  'npm_config_strict_ssl',
  'PIP_CERT',
  'PIP_CONFIG_FILE',
  'SSH_ASKPASS',
  'LESSOPEN',
  'LESSCLOSE',
  'CURL_HOME',
  'WGETRC',
  'PYTHON',
  'GIT_SEQUENCE_EDITOR',
  'XDG_CONFIG_HOME',
  'VISUAL',
  'EDITOR',
  'PYTHONSTARTUP',
  'BROWSER',
  'QWEN_CDP_MCP_COMMAND',
  'QWEN_SERVE_CDP_TUNNEL_OVER_WS',
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'node_extra_ca_certs',
  'Node_Extra_Ca_Certs',
  'QWEN_CLI_ENTRY',
  'qwen_cli_entry',
  'Qwen_Cli_Entry',
  'QWEN_HOME',
  ENV_ACP_REPEATED_TOOL_FAILURE_GUARD,
  'QWEN_CODE_PENDING_COMPILE_CACHE',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  'QWEN_RUNTIME_DIR',
  'QWEN_SERVER_TOKEN',
  'qwen_server_token',
  'tmpdir',
] as const;

let tmpDirs: string[] = [];
const previousEnv = new Map<string, string | undefined>();

function makeWorkspace(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-env-')),
  );
  tmpDirs.push(dir);
  return dir;
}

function testSettings(partial: Partial<Settings>): Settings {
  return partial as Settings;
}

beforeEach(() => {
  previousEnv.clear();
  for (const key of TRACKED_ENV) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // Hermetic against the runner's real user-level .env files: findEnvFiles()
  // always discovers ~/.env and ~/.qwen/.env, and home scope deliberately
  // bypasses the hardcoded exclusions — so a dev machine with
  // QWEN_CLI_ENTRY/NODE_OPTIONS in its home .env would both add warnings the
  // source-scoped counts never expect and apply keys the process.env
  // assertions require unset (CI runners have no home .env, so it ships
  // green and bites locally). Redirect HOME (USERPROFILE for Windows) to an
  // empty dir.
  previousEnv.set('HOME', process.env['HOME']);
  previousEnv.set('USERPROFILE', process.env['USERPROFILE']);
  const fakeHome = makeWorkspace();
  process.env['HOME'] = fakeHome;
  process.env['USERPROFILE'] = fakeHome;
});

afterEach(() => {
  for (const key of [...TRACKED_ENV, 'HOME', 'USERPROFILE']) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('buildRuntimeEnvironment', () => {
  it('computes a runtime overlay without mutating process.env or base env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'RUNTIME_DOTENV=from-dotenv',
        'RUNTIME_PARENT=dotenv-loses',
        'RUNTIME_EMPTY=from-dotenv-empty',
        'RUNTIME_SETTINGS=dotenv-wins',
        'RUNTIME_EXCLUDED=excluded',
        'NODE_OPTIONS=--require ./bad.js',
        'NPM_CONFIG_NODE_OPTIONS=--require ./bad.js',
        'QWEN_SERVER_TOKEN=dotenv-token',
        'QWEN_HOME=/tmp/ignored-qwen-home',
        `${ENV_ACP_REPEATED_TOOL_FAILURE_GUARD}=enforce`,
        '',
      ].join('\n'),
    );
    const baseEnv: NodeJS.ProcessEnv = {
      RUNTIME_PARENT: 'from-parent',
      RUNTIME_EMPTY: '',
    };

    const snapshot = buildRuntimeEnvironment(
      testSettings({
        advanced: {
          excludedEnvVars: ['RUNTIME_EXCLUDED', 'RUNTIME_SETTINGS_EXCLUDED'],
        },
        env: {
          RUNTIME_SETTINGS: 'settings-loses',
          RUNTIME_SETTINGS_ONLY: 'from-settings',
          RUNTIME_SETTINGS_EXCLUDED: 'settings-excluded',
          BASH_ENV: '/tmp/bad-profile',
          // Case variant: only the isLoaderEnvKey gate rejects it, so this
          // line pins the settings.env gate in buildRuntimeEnvironment.
          NPM_CONFIG_NODE_OPTIONS: '--require ./bad.js',
          QWEN_RUNTIME_DIR: '/tmp/ignored-runtime-dir',
          [ENV_ACP_REPEATED_TOOL_FAILURE_GUARD]: 'warn',
        },
      }),
      workspace,
      baseEnv,
    );

    expect(snapshot.effectiveEnv['RUNTIME_DOTENV']).toBe('from-dotenv');
    expect(snapshot.effectiveEnv['RUNTIME_PARENT']).toBe('from-parent');
    expect(snapshot.effectiveEnv['RUNTIME_EMPTY']).toBe('from-dotenv-empty');
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS']).toBe('dotenv-wins');
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_ONLY']).toBe(
      'from-settings',
    );
    expect(snapshot.effectiveEnv['RUNTIME_EXCLUDED']).toBeUndefined();
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_EXCLUDED']).toBeUndefined();
    expect(snapshot.effectiveEnv['NODE_OPTIONS']).toBeUndefined();
    expect(snapshot.effectiveEnv['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
    expect(snapshot.effectiveEnv['BASH_ENV']).toBeUndefined();
    expect(snapshot.effectiveEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(snapshot.effectiveEnv['QWEN_HOME']).toBeUndefined();
    expect(snapshot.effectiveEnv['QWEN_RUNTIME_DIR']).toBeUndefined();
    expect(
      snapshot.effectiveEnv[ENV_ACP_REPEATED_TOOL_FAILURE_GUARD],
    ).toBeUndefined();
    expect(snapshot.overlayKeys).toEqual([
      'RUNTIME_DOTENV',
      'RUNTIME_EMPTY',
      'RUNTIME_SETTINGS',
      'RUNTIME_SETTINGS_ONLY',
    ]);
    expect(snapshot.envFilePaths).toContain(path.join(workspace, '.env'));
    expect(snapshot.envFileReadFailed).toBe(false);
    expect(snapshot.envFileReadFailures).toEqual([]);

    expect(baseEnv).toEqual({
      RUNTIME_PARENT: 'from-parent',
      RUNTIME_EMPTY: '',
    });
    expect(process.env['RUNTIME_DOTENV']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBeUndefined();
  });

  it('applies Cloud Shell project defaults to the runtime env only', () => {
    const workspace = makeWorkspace();
    const snapshot = buildRuntimeEnvironment(testSettings({}), workspace, {
      CLOUD_SHELL: 'true',
    });

    expect(snapshot.effectiveEnv['GOOGLE_CLOUD_PROJECT']).toBe(
      'cloudshell-gca',
    );
    expect(snapshot.overlayKeys).toContain('GOOGLE_CLOUD_PROJECT');
    expect(process.env['GOOGLE_CLOUD_PROJECT']).toBeUndefined();
  });

  it('surfaces env file read failures in the runtime snapshot', () => {
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.mkdirSync(envPath);

    const snapshot = buildRuntimeEnvironment(testSettings({}), workspace, {});

    expect(snapshot.envFilePaths).toContain(envPath);
    expect(snapshot.envFileReadFailed).toBe(true);
    expect(snapshot.envFileReadFailures).toEqual([
      expect.objectContaining({
        path: envPath,
        error: expect.any(String),
      }),
    ]);
    expect(snapshot.effectiveEnv['RUNTIME_DOTENV']).toBeUndefined();
  });

  it('can fail closed without mutating process.env when an env file is unreadable', () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, '.env'));
    process.env['RUNTIME_SETTINGS_ONLY'] = 'old';

    const result = reloadEnvironment(
      testSettings({
        env: { RUNTIME_SETTINGS_ONLY: 'new' },
      }),
      workspace,
      true,
      { failClosedOnEnvFileReadError: true },
    );

    expect(result).toEqual({
      updatedKeys: [],
      removedKeys: [],
      envFileReadFailed: true,
    });
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('old');
  });

  it('does not load a distrusted parent .env for a trusted child workspace', () => {
    const parent = makeWorkspace();
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    fs.writeFileSync(
      path.join(parent, '.env'),
      'QWEN_SERVER_TOKEN=from-distrusted-parent-env\n',
    );
    const trustedFoldersPath = path.join(parent, 'trustedFolders.json');
    fs.writeFileSync(
      trustedFoldersPath,
      JSON.stringify({
        [parent]: TrustLevel.DO_NOT_TRUST,
        [child]: TrustLevel.TRUST_FOLDER,
      }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = trustedFoldersPath;

    const snapshot = buildRuntimeEnvironment(
      testSettings({ security: { folderTrust: { enabled: true } } }),
      child,
      {},
    );

    expect(snapshot.envFilePaths).not.toContain(path.join(parent, '.env'));
    expect(snapshot.effectiveEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
  });
});

describe('getHomeEnvFallbackVars', () => {
  it('preserves case-insensitive lookup in captured Windows environments', () => {
    const home = process.env['HOME']!;
    const qwenDir = path.join(home, SETTINGS_DIRECTORY_NAME);
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(path.join(qwenDir, '.env'), 'PATH=from-home-env');
    fs.writeFileSync(path.join(home, '.env'), 'PARENT_ONLY=from-parent-env');
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');

    try {
      expect(
        getHomeEnvFallbackVars(undefined, {
          Path: 'from-system',
          qwen_home: 'C:\\qwen',
        }),
      ).toEqual({});
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe('loadEnvironment', () => {
  it('preserves settings.env compile cache over the pending default', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(
      testSettings({
        env: {
          NODE_COMPILE_CACHE: '/tmp/operator-cache',
        },
      }),
      workspace,
    );

    expect(process.env['NODE_COMPILE_CACHE']).toBe('/tmp/operator-cache');
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('publishes the pending compile cache after environment loading', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_COMPILE_CACHE']).toBe('/tmp/generated-cache');
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('does not publish the pending compile cache when disabled by settings.env', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(
      testSettings({
        env: {
          NODE_DISABLE_COMPILE_CACHE: '1',
        },
      }),
      workspace,
    );

    expect(process.env['NODE_COMPILE_CACHE']).toBeUndefined();
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('filters reload-excluded keys from settings.env on initial load', () => {
    const workspace = makeWorkspace();

    loadEnvironment(
      testSettings({
        env: {
          RUNTIME_SETTINGS_ONLY: 'from-settings',
          BASH_ENV: '/tmp/bad-profile',
          NODE_OPTIONS: '--require ./bad.js',
          QWEN_SERVER_TOKEN: 'bad-token',
          [ENV_ACP_REPEATED_TOOL_FAILURE_GUARD]: 'enforce',
        },
      }),
      workspace,
    );

    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
    expect(process.env['BASH_ENV']).toBeUndefined();
    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(process.env[ENV_ACP_REPEATED_TOOL_FAILURE_GUARD]).toBeUndefined();
  });

  // Regression for #8653: the daemon scrubs loader vars from process.env,
  // but daemon-side loadSettings() calls for trusted workspaces re-run the
  // initial .env load afterwards. That load must not refill the scrubbed
  // slots, or one workspace's .env loader hook reaches every other
  // workspace's session subprocesses through the shared daemon env.
  it('never applies loader-affecting keys from .env files, even on initial load', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'npm_config_node_options=--import file:///workspace-a/hook.mjs',
        'NODE_PATH=/workspace-a/node_modules',
        'LD_PRELOAD=/workspace-a/hijack.so',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['npm_config_node_options']).toBeUndefined();
    expect(process.env['NODE_PATH']).toBeUndefined();
    expect(process.env['LD_PRELOAD']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 follow-up: pure-injection loader keys (dlopen/require/exec redirects)
  // join the scrubbed loader set and are rejected from every .env scope.
  it('never applies the follow-up code-injection loader keys from .env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'OPENSSL_CONF=/workspace-a/evil.cnf',
        'NODE_REPL_EXTERNAL_MODULE=/workspace-a/hook.js',
        'npm_config_node_gyp=/workspace-a/evil-gyp.js',
        'npm_config_init_module=/workspace-a/evil-init.js',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['OPENSSL_CONF']).toBeUndefined();
    expect(process.env['NODE_REPL_EXTERNAL_MODULE']).toBeUndefined();
    expect(process.env['npm_config_node_gyp']).toBeUndefined();
    expect(process.env['npm_config_init_module']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 follow-up: TLS trust anchors, the git command-exec family (incl.
  // numbered GIT_CONFIG_KEY_/VALUE_ pairs), and node-gyp interpreter selection
  // join the hardcoded reject-from-project-.env tier.
  it('never applies the follow-up TLS/git/interpreter keys from a project .env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'SSL_CERT_FILE=/workspace-a/evil-ca.pem',
        'GIT_SSH_COMMAND=/workspace-a/evil-ssh.sh',
        'GIT_SSH=/workspace-a/evil-legacy-ssh.sh',
        'GIT_CONFIG_COUNT=1',
        'GIT_CONFIG_PARAMETERS=core.hooksPath=/workspace-a/evil-hooks',
        'GIT_CONFIG_KEY_0=core.hooksPath',
        'GIT_CONFIG_VALUE_0=/workspace-a/evil-hooks',
        'GIT_EXEC_PATH=/workspace-a/evil-exec',
        'GIT_TEMPLATE_DIR=/workspace-a/evil-templates',
        'GIT_ASKPASS=/workspace-a/evil-askpass',
        'GIT_PROXY_COMMAND=/workspace-a/evil-proxy.sh',
        'GIT_EDITOR=/workspace-a/evil-editor.sh',
        'GIT_SSL_CAPATH=/workspace-a/evil-capath',
        'npm_config_cafile=/workspace-a/evil-ca.pem',
        'npm_config_ca=/workspace-a/evil-ca-inline',
        'npm_config_strict_ssl=false',
        'PIP_CERT=/workspace-a/evil-ca.pem',
        'CURL_HOME=/workspace-a',
        'WGETRC=/workspace-a/evil-wgetrc',
        'PYTHON=/workspace-a/evil-python',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['SSL_CERT_FILE']).toBeUndefined();
    expect(process.env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(process.env['GIT_SSH']).toBeUndefined();
    expect(process.env['GIT_CONFIG_COUNT']).toBeUndefined();
    expect(process.env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
    expect(process.env['GIT_CONFIG_KEY_0']).toBeUndefined();
    expect(process.env['GIT_CONFIG_VALUE_0']).toBeUndefined();
    expect(process.env['GIT_EXEC_PATH']).toBeUndefined();
    expect(process.env['GIT_TEMPLATE_DIR']).toBeUndefined();
    expect(process.env['GIT_ASKPASS']).toBeUndefined();
    expect(process.env['GIT_PROXY_COMMAND']).toBeUndefined();
    expect(process.env['GIT_EDITOR']).toBeUndefined();
    expect(process.env['GIT_SSL_CAPATH']).toBeUndefined();
    expect(process.env['npm_config_cafile']).toBeUndefined();
    expect(process.env['npm_config_ca']).toBeUndefined();
    expect(process.env['npm_config_strict_ssl']).toBeUndefined();
    expect(process.env['PIP_CERT']).toBeUndefined();
    expect(process.env['CURL_HOME']).toBeUndefined();
    expect(process.env['WGETRC']).toBeUndefined();
    expect(process.env['PYTHON']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 review round: PIP_CONFIG_FILE redirects all of pip's configuration
  // (index-url / trusted-host / proxy / cert) at an attacker file, SSH_ASKPASS
  // is the askpass program git/ssh execute on an auth challenge, and LESSOPEN/
  // LESSCLOSE are run by `less` as input preprocessors. Each must be rejected
  // on every application boundary — initial load and reload alike.
  it('never applies pip config / ssh askpass / less preprocessor keys from a project .env, including reload', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      [
        'PIP_CONFIG_FILE=/workspace-a/pip.conf',
        'SSH_ASKPASS=/workspace-a/evil-askpass',
        'LESSOPEN=| /workspace-a/evil-lessopen.sh %s',
        'LESSCLOSE=/workspace-a/evil-lessclose.sh %s %s',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['LESSCLOSE']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');

    // A mid-session reload must not apply them either.
    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['LESSCLOSE']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // The settings.env application (load and reload) and the daemon's
  // per-workspace runtime env build consult the same hardcoded predicate.
  it('rejects pip config / ssh askpass / less preprocessor keys from settings.env and the runtime env build', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const settings = testSettings({
      env: {
        PIP_CONFIG_FILE: '/workspace-a/pip.conf',
        SSH_ASKPASS: '/workspace-a/evil-askpass',
        LESSOPEN: '| /workspace-a/evil-lessopen.sh %s',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });

    loadEnvironment(settings, workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');

    // Reload force-writes settings.env keys; the hardcoded gate must keep
    // rejecting them there too.
    reloadEnvironment(settings, workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');

    const snapshot = buildRuntimeEnvironment(settings, workspace, {});
    expect(snapshot.effectiveEnv['PIP_CONFIG_FILE']).toBeUndefined();
    expect(snapshot.effectiveEnv['SSH_ASKPASS']).toBeUndefined();
    expect(snapshot.effectiveEnv['LESSOPEN']).toBeUndefined();
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_ONLY']).toBe(
      'from-settings',
    );
  });

  // #8663 round-4: git executes GIT_SEQUENCE_EDITOR on `git rebase -i` and
  // merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig` (bypassing the
  // GIT_CONFIG_* blocks); $VISUAL/$EDITOR are git's editor fallback and the
  // CLI's own editor launch; CPython executes PYTHONSTARTUP at interactive
  // startup; the CLI execs $BROWSER via openBrowserSecurely; the daemon
  // spawns QWEN_CDP_MCP_COMMAND as the browser-automation MCP adapter and
  // QWEN_SERVE_CDP_TUNNEL_OVER_WS switches that tunnel surface on.
  it('never applies the round-4 exec-redirect keys from project .env or settings.env, including reload', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'GIT_SEQUENCE_EDITOR=/workspace-a/evil-sequence.sh',
        'VISUAL=/workspace-a/evil-visual.sh',
        'EDITOR=/workspace-a/evil-editor.sh',
        'PYTHONSTARTUP=/workspace-a/evil-startup.py',
        'XDG_CONFIG_HOME=/workspace-a/.xdg',
        'BROWSER=/workspace-a/evil-browser.sh',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );
    const settings = testSettings({
      env: {
        QWEN_CDP_MCP_COMMAND: '/workspace-a/evil-adapter',
        QWEN_SERVE_CDP_TUNNEL_OVER_WS: '1',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });

    const expectRound4Rejected = (env: Readonly<NodeJS.ProcessEnv>) => {
      expect(env['GIT_SEQUENCE_EDITOR']).toBeUndefined();
      expect(env['VISUAL']).toBeUndefined();
      expect(env['EDITOR']).toBeUndefined();
      expect(env['PYTHONSTARTUP']).toBeUndefined();
      expect(env['XDG_CONFIG_HOME']).toBeUndefined();
      expect(env['BROWSER']).toBeUndefined();
      expect(env['QWEN_CDP_MCP_COMMAND']).toBeUndefined();
      expect(env['QWEN_SERVE_CDP_TUNNEL_OVER_WS']).toBeUndefined();
    };

    loadEnvironment(settings, workspace);
    expectRound4Rejected(process.env);
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');

    // A mid-session reload must not apply them either.
    reloadEnvironment(settings, workspace);
    expectRound4Rejected(process.env);
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');

    // The daemon's per-workspace runtime env build consults the same gate.
    const snapshot = buildRuntimeEnvironment(settings, workspace, {});
    expectRound4Rejected(snapshot.effectiveEnv);
    expect(snapshot.effectiveEnv['RUNTIME_DOTENV']).toBe('allowed');
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_ONLY']).toBe(
      'from-settings',
    );
  });

  // The privileged <workspace>/.qwen/.env scope deliberately bypasses
  // excludedEnvVars and is discovered before the plain .env, so exempting it
  // from the loader denylist must not ship green.
  it('never applies loader-affecting keys from the .qwen/.env scope either', () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, SETTINGS_DIRECTORY_NAME));
    fs.writeFileSync(
      path.join(workspace, SETTINGS_DIRECTORY_NAME, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'NODE_PATH=/workspace-a/node_modules',
        'LD_PRELOAD=/workspace-a/hijack.so',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['NODE_PATH']).toBeUndefined();
    expect(process.env['LD_PRELOAD']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('warns once per file+key when loader-affecting keys are rejected from .env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      [
        'NODE_OPTIONS=--max-old-space-size=8192',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(testSettings({}), workspace);
      // Daemon-side loadSettings() re-runs loadEnvironment() for every
      // session; the warning must not repeat for the same file and key.
      loadEnvironment(testSettings({}), workspace);
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(envPath);
    expect(warnings[0]).toContain('NODE_OPTIONS');
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('warns again only for new loader-affecting keys added to an already-warned file', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      ['NODE_OPTIONS=--max-old-space-size=8192', ''].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(testSettings({}), workspace);
      fs.writeFileSync(
        envPath,
        [
          'NODE_OPTIONS=--max-old-space-size=8192',
          'LD_PRELOAD=/workspace-a/hijack.so',
          '',
        ].join('\n'),
      );
      loadEnvironment(testSettings({}), workspace);
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('NODE_OPTIONS');
    // The second warning must cover only the delta — the already-warned key
    // stays rejected but is not reported again.
    expect(warnings[1]).toContain('LD_PRELOAD');
    expect(warnings[1]).not.toContain('NODE_OPTIONS');
  });

  it('warns when a mid-session .env edit adds a loader-affecting key', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(envPath, ['RUNTIME_DOTENV=allowed', ''].join('\n'));
    loadEnvironment(testSettings({}), workspace);

    fs.writeFileSync(
      envPath,
      [
        'RUNTIME_DOTENV=allowed',
        'NODE_OPTIONS=--max-old-space-size=8192',
        '',
      ].join('\n'),
    );

    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    try {
      reloadEnvironment(testSettings({}), workspace);
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(envPath);
    expect(warnings[0]).toContain('NODE_OPTIONS');
    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // The loader gate runs before any scope check, and home-scoped files are
  // already exempt from PROJECT_ENV_HARDCODED_EXCLUSIONS — pin that a
  // home-scoped exemption mutant for loader keys cannot ship green.
  it('never applies loader-affecting keys from user-level .env files either', () => {
    const workspace = makeWorkspace();
    const qwenHome = makeWorkspace();
    process.env['QWEN_HOME'] = qwenHome;
    fs.writeFileSync(
      path.join(qwenHome, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'npm_config_node_options=--import file:///workspace-a/hook.mjs',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['npm_config_node_options']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('never applies loader-affecting keys from settings.env, including reload', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const settings = testSettings({
      env: {
        NODE_OPTIONS: '--import file:///workspace-a/harness.mjs',
        npm_config_node_options: '--import file:///workspace-a/hook.mjs',
        NPM_CONFIG_NODE_OPTIONS: '--import file:///workspace-a/upper.mjs',
        'npm_config_node-options': '--import file:///workspace-a/hyphen.mjs',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(settings, workspace);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node_options']).toBeUndefined();
      expect(process.env['npm_config_node-options']).toBeUndefined();
      expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
      expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');

      // Reload force-writes settings.env keys into process.env; the loader
      // gate must keep rejecting them there too.
      reloadEnvironment(settings, workspace);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node_options']).toBeUndefined();
      expect(process.env['npm_config_node-options']).toBeUndefined();
      expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
      expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
    } finally {
      stderrWrite.mockRestore();
    }

    // The settings.env application paths warn like the serve fast path.
    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(workspace),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('settings.env');
    expect(warnings[0]).toContain('NODE_OPTIONS');
    expect(warnings[0]).toContain('npm_config_node_options');
    expect(warnings[0]).toContain('npm_config_node-options');
    expect(warnings[0]).toContain('NPM_CONFIG_NODE_OPTIONS');
  });

  // npm applies npm_config_* env vars case-insensitively and Windows env
  // lookup is case-insensitive outright, so exact-case gates would let
  // variants like NPM_CONFIG_NODE_OPTIONS through on load and reload.
  it('rejects loader-affecting .env keys regardless of case, including reload', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'NPM_CONFIG_NODE_OPTIONS=--import file:///workspace-a/hook.mjs',
        'Node_Options=--import file:///workspace-a/harness.mjs',
        'npm_config_node-options=--import file:///workspace-a/hyphen.mjs',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
    expect(process.env['Node_Options']).toBeUndefined();
    expect(process.env['npm_config_node-options']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');

    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
    expect(process.env['Node_Options']).toBeUndefined();
    expect(process.env['npm_config_node-options']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // ENV is sourced only by interactive sh, while the shell tool spawns
  // non-interactive `bash -c`, and `ENV=production` is a mainstream
  // application convention — so ENV stays reload-only (its pre-denylist
  // tier), not loader-class. The initial .env load applies it; reload and
  // the daemon's per-workspace runtime env build must still reject it.
  it('applies ENV from a project .env on the initial load only', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      ['ENV=production', 'RUNTIME_DOTENV=allowed', ''].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['ENV']).toBe('production');
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');

    // A reload does not re-apply or delete the initially-loaded value.
    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['ENV']).toBe('production');

    // The daemon's per-workspace runtime env never picks it up (explicit
    // empty base: the default baseEnv is process.env, which legitimately
    // carries the initially-loaded value by now).
    const snapshot = buildRuntimeEnvironment(testSettings({}), workspace, {});
    expect(snapshot.effectiveEnv['ENV']).toBeUndefined();
    expect(snapshot.effectiveEnv['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('rejects ENV added by a mid-session .env edit', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(envPath, ['RUNTIME_DOTENV=allowed', ''].join('\n'));

    loadEnvironment(testSettings({}), workspace);

    fs.writeFileSync(
      envPath,
      ['RUNTIME_DOTENV=allowed', 'ENV=production', ''].join('\n'),
    );
    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['ENV']).toBeUndefined();
  });

  // The npm config-file keys redirect npm to an attacker-chosen .npmrc, and
  // ZDOTDIR points zsh at an attacker-chosen startup directory — both must
  // die on the initial .env load like NODE_OPTIONS.
  it('never applies npm config-file redirects or ZDOTDIR from .env files', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'npm_config_userconfig=/workspace-a/.npmrc',
        'ZDOTDIR=/workspace-a/zdot',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['npm_config_userconfig']).toBeUndefined();
    expect(process.env['ZDOTDIR']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // dotenv refuses to parse `%%` keys, so settings.json env is the
  // BASH_FUNC_* entry point; the prefix rule must reject it there.
  it('never applies BASH_FUNC_* exported function definitions from settings.env', () => {
    const workspace = makeWorkspace();

    loadEnvironment(
      testSettings({
        env: { 'BASH_FUNC_id%%': '() { echo pwned; }' },
      }),
      workspace,
    );

    expect(process.env['BASH_FUNC_id%%']).toBeUndefined();
  });

  // A project .env pointing the session-process entrypoint or a TLS trust
  // anchor at attacker-chosen files is the #8653 shape; user-level files
  // stay exempt (operator opt-in).
  it('never applies entrypoint or trust-anchor keys from project .env files', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'QWEN_CLI_ENTRY=/workspace-a/evil-entry.js',
        'NODE_EXTRA_CA_CERTS=/workspace-a/ca.pem',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['QWEN_CLI_ENTRY']).toBeUndefined();
    expect(process.env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  });

  // Windows env lookup is case-insensitive, so exact-case membership would
  // let case variants through every application gate on that platform.
  it('rejects entrypoint and trust-anchor keys regardless of case', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'qwen_cli_entry=/workspace-a/evil-entry.js',
        'node_extra_ca_certs=/workspace-a/ca.pem',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['qwen_cli_entry']).toBeUndefined();
    expect(process.env['node_extra_ca_certs']).toBeUndefined();

    reloadEnvironment(
      testSettings({
        env: {
          Qwen_Cli_Entry: '/workspace-a/evil-entry.js',
          Node_Extra_Ca_Certs: '/workspace-a/ca.pem',
          RUNTIME_SETTINGS_ONLY: 'from-settings',
        },
      }),
      workspace,
    );
    expect(process.env['Qwen_Cli_Entry']).toBeUndefined();
    expect(process.env['Node_Extra_Ca_Certs']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
  });

  // The reload-only tier (QWEN_SERVER_TOKEN, PATH, HOME, TMPDIR, …) must
  // match case-folded for the same reason: on Windows a lowercase twin
  // names the same OS variable, so an exact-case gate would let a
  // mid-session settings.env/.env edit rotate the daemon token or rewrite
  // PATH.
  it('rejects case variants of reload-only excluded keys', () => {
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(envPath, 'tmpdir=/workspace-a/first\n');

    loadEnvironment(
      testSettings({ env: { qwen_server_token: 'spoofed-token' } }),
      workspace,
    );
    // The full loader never takes the daemon token from settings.env — the
    // case variant must not slip the gate either.
    expect(process.env['qwen_server_token']).toBeUndefined();
    // The initial .env load predates the reload tier, so the lowercase twin
    // applies as a distinct POSIX variable; the reload tier is what must
    // keep a mid-session edit from moving it (on Windows the twin IS the
    // uppercase variable).
    expect(process.env['tmpdir']).toBe('/workspace-a/first');

    fs.writeFileSync(envPath, 'tmpdir=/workspace-a/second\n');
    reloadEnvironment(
      testSettings({ env: { qwen_server_token: 'spoofed-token' } }),
      workspace,
    );
    expect(process.env['qwen_server_token']).toBeUndefined();
    expect(process.env['tmpdir']).toBe('/workspace-a/first');
  });

  // The numbered GIT_CONFIG_KEY_/VALUE_ pairs are hardcoded exclusions via
  // prefix matching; the reload gate must freeze them exactly like their
  // literal sibling GIT_CONFIG_COUNT, or a home `.env` edit rotates one half
  // of the mechanism mid-session while the other half stays at the boot
  // value. Home-scoped files are exempt from the reject-only tier at boot,
  // so the boot value applies — and then freezes, edits and removals alike.
  it('freezes the numbered GIT_CONFIG pairs on reload like GIT_CONFIG_COUNT', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const homeEnvPath = path.join(process.env['HOME']!, '.env');
    fs.writeFileSync(
      homeEnvPath,
      [
        'GIT_CONFIG_COUNT=1',
        'GIT_CONFIG_KEY_0=core.hooksPath',
        'GIT_CONFIG_VALUE_0=/home-a/hooks',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['GIT_CONFIG_COUNT']).toBe('1');
    expect(process.env['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    expect(process.env['GIT_CONFIG_VALUE_0']).toBe('/home-a/hooks');
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');

    fs.writeFileSync(
      homeEnvPath,
      [
        'GIT_CONFIG_COUNT=2',
        'GIT_CONFIG_KEY_0=core.fsmonitor',
        'GIT_CONFIG_VALUE_0=/home-a/fsmonitor',
        'RUNTIME_DOTENV=rotated',
        '',
      ].join('\n'),
    );
    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['GIT_CONFIG_COUNT']).toBe('1');
    expect(process.env['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    expect(process.env['GIT_CONFIG_VALUE_0']).toBe('/home-a/hooks');
    // An ordinary key next to them still rotates — the freeze is key-scoped.
    // The fixture value must actually change between reloads, or this check
    // passes even when reload freezes every key.
    expect(process.env['RUNTIME_DOTENV']).toBe('rotated');

    // Removal is frozen too (symmetric with GIT_CONFIG_COUNT, documented in
    // the settings.md upgrade note): a home `.env` deletion does not
    // propagate on reload.
    fs.writeFileSync(homeEnvPath, ['RUNTIME_DOTENV=allowed', ''].join('\n'));
    reloadEnvironment(testSettings({}), workspace);
    expect(process.env['GIT_CONFIG_COUNT']).toBe('1');
    expect(process.env['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    expect(process.env['GIT_CONFIG_VALUE_0']).toBe('/home-a/hooks');
  });

  // The daemon reaches per-workspace .env files only through
  // buildRuntimeEnvironment (its loadSettings calls pass
  // skipLoadEnvironment), so the rejection report must fire from this loop
  // or it vanishes for exactly the workspaces the daemon hosts.
  it('reports loader-key rejections from the buildRuntimeEnvironment .env loop', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      ['NODE_OPTIONS=--import file:///workspace-a/hook.mjs', ''].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      const snapshot = buildRuntimeEnvironment(testSettings({}), workspace);
      expect(snapshot.effectiveEnv['NODE_OPTIONS']).toBeUndefined();
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(envPath);
    expect(warnings[0]).toContain('NODE_OPTIONS');
  });
});
