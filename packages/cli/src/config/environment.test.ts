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
  loadEnvironment,
  reloadEnvironment,
  resetEnvironmentTrackingForTesting,
  SETTINGS_DIRECTORY_NAME,
} from './environment.js';
import type { Settings } from './settingsSchema.js';

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
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'npm_config_node_options',
  'npm_config_node-options',
  'NPM_CONFIG_NODE_OPTIONS',
  'Node_Options',
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'QWEN_HOME',
  'QWEN_CODE_PENDING_COMPILE_CACHE',
  'QWEN_RUNTIME_DIR',
  'QWEN_SERVER_TOKEN',
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
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
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
        },
      }),
      workspace,
    );

    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
    expect(process.env['BASH_ENV']).toBeUndefined();
    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
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

    const warnings = stderrWrites.filter((chunk) =>
      chunk.includes('cannot set loader-affecting env vars'),
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

    const warnings = stderrWrites.filter((chunk) =>
      chunk.includes('cannot set loader-affecting env vars'),
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

    const warnings = stderrWrites.filter((chunk) =>
      chunk.includes('cannot set loader-affecting env vars'),
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
    const warnings = stderrWrites.filter((chunk) =>
      chunk.includes('cannot set loader-affecting env vars'),
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
});
