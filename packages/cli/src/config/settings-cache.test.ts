/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock os.homedir before anything else imports it. The holder is mutable so
// individual tests can relocate "home" (the homeDir fingerprint component).
const mockHome = vi.hoisted(() => ({ dir: '/uninitialized-mock-home' }));

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof import('node:os')>();
  return { ...actualOs, homedir: vi.fn(() => mockHome.dir) };
});
vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof import('node:os')>();
  return { ...actualOs, homedir: vi.fn(() => mockHome.dir) };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ideContextStore } from '@qwen-code/qwen-code-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSettingsCacheForTesting,
  loadSettingsCached,
} from './settings-cache.js';
import {
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
  SettingScope,
  SETTINGS_VERSION,
  SETTINGS_VERSION_KEY,
} from './settings.js';
import { resetTrustedFoldersForTesting } from './trustedFolders.js';

// Keys written to fixture .env files leak into process.env via
// loadEnvironment (by design); use a unique prefix and clean them up.
const TEST_ENV_PREFIX = 'SETTINGS_CACHE_TEST_';

describe('loadSettingsCached', () => {
  let tmpRoot: string;
  let homeDir: string;
  let qwenHome: string;
  let workspaceDir: string;

  const userSettingsPath = () => path.join(qwenHome, 'settings.json');
  const workspaceSettingsPath = (ws = workspaceDir) =>
    path.join(ws, '.qwen', 'settings.json');

  const writeJson = (filePath: string, value: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
  };

  // All fixtures carry the current settings version so loadSettings never
  // rewrites them (a migration self-write would turn the second call into a
  // legitimate miss and hide what these tests assert).
  const versioned = (settings: Record<string, unknown>) => ({
    [SETTINGS_VERSION_KEY]: SETTINGS_VERSION,
    ...settings,
  });

  const resetModuleState = () => {
    clearSettingsCacheForTesting();
    resetHomeEnvBootstrapForTesting();
    resetEnvironmentTrackingForTesting();
    resetTrustedFoldersForTesting();
    // IDE trust feeds the ideTrust fingerprint component; clear it so state
    // never leaks between tests.
    ideContextStore.clear();
  };

  beforeEach(() => {
    tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'settings-cache-test-')),
    );
    homeDir = path.join(tmpRoot, 'home');
    qwenHome = path.join(tmpRoot, 'qwen-home');
    workspaceDir = path.join(tmpRoot, 'project', 'app');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(qwenHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    mockHome.dir = homeDir;

    // Sandbox every settings path inside tmpRoot: user/workspace via
    // QWEN_HOME + cwd, system/system-defaults via their test overrides.
    vi.stubEnv('QWEN_HOME', qwenHome);
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      path.join(tmpRoot, 'system', 'settings.json'),
    );
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      path.join(tmpRoot, 'system', 'system-defaults.json'),
    );
    resetModuleState();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(TEST_ENV_PREFIX)) {
        delete process.env[key];
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('serves the same instance while nothing changed', () => {
    writeJson(userSettingsPath(), versioned({ model: { name: 'cached' } }));

    const first = loadSettingsCached(workspaceDir);
    const second = loadSettingsCached(workspaceDir);

    // Identity is the strongest possible assertion: loadSettings() always
    // constructs a new LoadedSettings, so same instance ⇒ no reload ran.
    expect(second).toBe(first);
    expect(second.merged.model?.name).toBe('cached');
  });

  it('reloads when the user settings file changes', () => {
    writeJson(userSettingsPath(), versioned({ model: { name: 'before' } }));
    const first = loadSettingsCached(workspaceDir);

    writeJson(
      userSettingsPath(),
      versioned({ model: { name: 'after-edit-longer' } }),
    );
    const second = loadSettingsCached(workspaceDir);

    expect(second).not.toBe(first);
    expect(second.merged.model?.name).toBe('after-edit-longer');
  });

  it('reloads when a workspace settings file appears and again when it is deleted', () => {
    const first = loadSettingsCached(workspaceDir);

    writeJson(
      workspaceSettingsPath(),
      versioned({ model: { name: 'from-workspace' } }),
    );
    const second = loadSettingsCached(workspaceDir);
    expect(second).not.toBe(first);
    expect(second.merged.model?.name).toBe('from-workspace');

    fs.rmSync(workspaceSettingsPath());
    const third = loadSettingsCached(workspaceDir);
    expect(third).not.toBe(second);
    expect(third.merged.model?.name).toBeUndefined();
  });

  it('reloads when a .env file appears closer to the workspace', () => {
    const first = loadSettingsCached(workspaceDir);
    expect(process.env[`${TEST_ENV_PREFIX}CLOSER`]).toBeUndefined();

    fs.writeFileSync(
      path.join(workspaceDir, '.env'),
      `${TEST_ENV_PREFIX}CLOSER=yes\n`,
    );
    const second = loadSettingsCached(workspaceDir);

    expect(second).not.toBe(first);
    expect(process.env[`${TEST_ENV_PREFIX}CLOSER`]).toBe('yes');
  });

  it('reloads when a discovered home .env file changes', () => {
    const homeEnvPath = path.join(qwenHome, '.env');
    fs.writeFileSync(homeEnvPath, `${TEST_ENV_PREFIX}A=1\n`);

    const first = loadSettingsCached(workspaceDir);
    expect(process.env[`${TEST_ENV_PREFIX}A`]).toBe('1');
    expect(loadSettingsCached(workspaceDir)).toBe(first);

    fs.writeFileSync(
      homeEnvPath,
      `${TEST_ENV_PREFIX}A=1\n${TEST_ENV_PREFIX}B=2\n`,
    );
    const second = loadSettingsCached(workspaceDir);

    expect(second).not.toBe(first);
    expect(process.env[`${TEST_ENV_PREFIX}B`]).toBe('2');
  });

  it('reloads when QWEN_HOME points at a different directory', () => {
    writeJson(userSettingsPath(), versioned({ model: { name: 'home-one' } }));
    const first = loadSettingsCached(workspaceDir);
    expect(first.merged.model?.name).toBe('home-one');

    const otherQwenHome = path.join(tmpRoot, 'qwen-home-2');
    writeJson(
      path.join(otherQwenHome, 'settings.json'),
      versioned({ model: { name: 'home-two' } }),
    );
    vi.stubEnv('QWEN_HOME', otherQwenHome);

    const second = loadSettingsCached(workspaceDir);
    expect(second).not.toBe(first);
    expect(second.merged.model?.name).toBe('home-two');
  });

  it('reloads when os.homedir() changes even if no settings path moves', () => {
    // The R2 corner: QWEN_HOME pins the user/system paths and no .env exists
    // anywhere, so only the homeDir fingerprint component can catch this.
    const first = loadSettingsCached(workspaceDir);

    const otherHome = path.join(tmpRoot, 'home-2');
    fs.mkdirSync(otherHome, { recursive: true });
    mockHome.dir = otherHome;

    const second = loadSettingsCached(workspaceDir);
    expect(second).not.toBe(first);
  });

  it('reloads when IDE trust state flips', () => {
    // The ideTrust fingerprint component guards against a stale trust/merge
    // result: IDE trust is the one trust input that can change within a live
    // process (trustedFolders.json is a permanent singleton, folder-trust
    // toggles live in the settings files themselves).
    const first = loadSettingsCached(workspaceDir);

    ideContextStore.set({ workspaceState: { isTrusted: true } });

    const second = loadSettingsCached(workspaceDir);
    expect(second).not.toBe(first);
  });

  it('returns a fresh instance after setValue persisted a change', () => {
    writeJson(userSettingsPath(), versioned({ model: { name: 'initial' } }));
    const first = loadSettingsCached(workspaceDir);

    first.setValue(SettingScope.User, 'model.name', 'persisted-by-setvalue');

    const second = loadSettingsCached(workspaceDir);
    expect(second).not.toBe(first);
    expect(second.merged.model?.name).toBe('persisted-by-setvalue');
  });

  it('does not cache a load failure and recovers once the file is fixed', () => {
    // Valid JSON that is not an object bypasses corruption recovery and
    // makes loadSettings throw FatalConfigError.
    fs.writeFileSync(userSettingsPath(), '[1]');

    expect(() => loadSettingsCached(workspaceDir)).toThrow(
      /not a valid JSON object/,
    );

    writeJson(userSettingsPath(), versioned({ model: { name: 'fixed' } }));
    const recovered = loadSettingsCached(workspaceDir);
    expect(recovered.merged.model?.name).toBe('fixed');
    expect(loadSettingsCached(workspaceDir)).toBe(recovered);
  });

  it('keeps independent entries per workspace directory', () => {
    const otherWorkspace = path.join(tmpRoot, 'project', 'other');
    fs.mkdirSync(otherWorkspace, { recursive: true });
    writeJson(
      workspaceSettingsPath(),
      versioned({ model: { name: 'ws-app' } }),
    );
    writeJson(
      workspaceSettingsPath(otherWorkspace),
      versioned({ model: { name: 'ws-other' } }),
    );

    const first = loadSettingsCached(workspaceDir);
    const other = loadSettingsCached(otherWorkspace);

    expect(other).not.toBe(first);
    expect(first.merged.model?.name).toBe('ws-app');
    expect(other.merged.model?.name).toBe('ws-other');
    expect(loadSettingsCached(workspaceDir)).toBe(first);
    expect(loadSettingsCached(otherWorkspace)).toBe(other);
  });

  it('evicts the least recently used entry beyond the cache limit', () => {
    const first = loadSettingsCached(workspaceDir);

    for (let i = 0; i < 64; i++) {
      const ws = path.join(tmpRoot, 'fleet', `ws-${i}`);
      fs.mkdirSync(ws, { recursive: true });
      loadSettingsCached(ws);
    }

    // 64 newer entries pushed the first workspace out of the LRU map.
    expect(loadSettingsCached(workspaceDir)).not.toBe(first);
  });
});
