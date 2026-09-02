/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FatalConfigError, Storage } from '@qwen-code/qwen-code-core';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  LoadedSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  SettingScope,
  SETTINGS_VERSION,
  SETTINGS_VERSION_KEY,
  type SettingsFile,
} from './settings.js';

function settingsFile(
  filePath: string,
  settings: SettingsFile['settings'],
): SettingsFile {
  return {
    path: filePath,
    settings,
    originalSettings: structuredClone(settings),
    rawJson: JSON.stringify(settings),
  };
}

describe('project runtime settings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-project-runtime-'));
    vi.stubEnv('QWEN_HOME', path.join(tempDir, 'home'));
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      path.join(tempDir, 'system', 'settings.json'),
    );
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      path.join(tempDir, 'system-defaults', 'settings.json'),
    );
    resetHomeEnvBootstrapForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetHomeEnvBootstrapForTesting();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects invalid target settings without modifying the file', () => {
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ invalid');

    expect(() =>
      loadSettings(workspace, {
        consumeCorruptionEnvVars: false,
        readOnly: true,
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      }),
    ).toThrow(FatalConfigError);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ invalid');
    expect(fs.existsSync(`${settingsPath}.corrupted`)).toBe(false);
  });

  it('does not stamp $version into a readOnly load of an unversioned file', () => {
    // A readOnly (`/cd` prepare) load is observation-only. Stamping the
    // version in memory without writing it made the first hot reload
    // re-parse the un-stamped file into a different shape than the one
    // the session applied — and invited a later write to persist a bump
    // the user never asked for.
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const raw = '{"permissions":{"allow":[]}}';
    fs.writeFileSync(settingsPath, raw);

    const loaded = loadSettings(workspace, {
      consumeCorruptionEnvVars: false,
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });

    expect('$version' in loaded.workspace.settings).toBe(false);
    expect(loaded.workspace.settings.permissions?.allow).toEqual([]);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(raw);
  });

  it('migrates a legacy target in memory without touching the file', () => {
    // The `/cd` reloader loads read-only: the target's settings.json must
    // not be rewritten before the move is committed (rollback restores
    // memory, never disk).
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const legacy = JSON.stringify({ theme: 'dark' });
    fs.writeFileSync(settingsPath, legacy);

    const loaded = loadSettings(workspace, {
      consumeCorruptionEnvVars: false,
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });

    expect(loaded.merged.ui?.theme).toBe('dark');
    expect(loaded.migratedInMemoryScopes.has(SettingScope.Workspace)).toBe(
      true,
    );
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(legacy);
  });

  it('keeps an in-memory migration across a hot reload of the legacy file', () => {
    // After the move the file on disk is still in its legacy layout. The
    // first chokidar event on it re-parses the raw file; without applying
    // the same migration the session silently regresses to the legacy
    // shape until restart.
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    const next = loadSettings(workspace, {
      consumeCorruptionEnvVars: false,
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    const current = new LoadedSettings(
      settingsFile('/system', {}),
      settingsFile('/defaults', {}),
      settingsFile('/user', {}),
      settingsFile('/project-a', {}),
      true,
      new Set(),
    );
    current.replaceWith(next);
    expect(current.merged.ui?.theme).toBe('dark');

    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'light' }));
    current.reloadScopeFromDisk(SettingScope.Workspace);

    expect(current.merged.ui?.theme).toBe('light');
    expect(
      (current.merged as unknown as Record<string, unknown>)['theme'],
    ).toBeUndefined();
  });

  it('reloads settings against the environment captured at load time', () => {
    const workspace = path.join(tempDir, 'workspace');
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    const envKey = 'PROJECT_RUNTIME_CAPTURED_VALUE';
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        [SETTINGS_VERSION_KEY]: SETTINGS_VERSION,
        model: { name: `$${envKey}` },
      }),
    );
    const environment = { ...process.env, [envKey]: 'captured' };
    const loaded = loadSettings(workspace, {
      environment,
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });

    const previousValue = process.env[envKey];
    process.env[envKey] = 'live-after-load';
    try {
      loaded.reloadScopeFromDisk(SettingScope.Workspace);
      expect(loaded.merged.model?.name).toBe('captured');
    } finally {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    }
  });

  it('merges non-workspace hooks independently of workspace trust', () => {
    const hook = (command: string) =>
      ({
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }],
      }) as unknown as NonNullable<SettingsFile['settings']['hooks']>;
    const loaded = new LoadedSettings(
      settingsFile('/system', { hooks: hook('system') }),
      settingsFile('/defaults', { hooks: hook('defaults') }),
      settingsFile('/user', { hooks: hook('user') }),
      settingsFile('/workspace', { hooks: hook('workspace') }),
      true,
      new Set(),
    );

    expect(loaded.getUserHooks()?.['PreToolUse']).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'defaults' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'user' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'system' }] },
    ]);
  });

  it('persists unresolved migrated settings and clears the pending scope', () => {
    const workspace = path.join(tempDir, 'workspace');
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    const envKey = 'PROJECT_RUNTIME_MIGRATION_VALUE';
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: `$${envKey}` }));
    const loaded = loadSettings(workspace, {
      environment: { ...process.env, [envKey]: 'resolved-secret' },
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });

    loaded.persistInMemoryMigrations();

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      ui: { theme: `$${envKey}` },
      [SETTINGS_VERSION_KEY]: SETTINGS_VERSION,
    });
    expect(loaded.migratedInMemoryScopes.size).toBe(0);
  });

  it('does not consume corruption state during a readOnly load', () => {
    const workspace = path.join(tempDir, 'workspace');
    const userSettingsPath = path.join(
      process.env['QWEN_HOME']!,
      'settings.json',
    );
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
    fs.writeFileSync(userSettingsPath, '{}');
    process.env[ENV_CORRUPTED_PATH] = `${userSettingsPath}.corrupted`;
    process.env[ENV_WAS_RECOVERED] = '1';

    try {
      const loaded = loadSettings(workspace, {
        readOnly: true,
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      });

      expect(process.env[ENV_CORRUPTED_PATH]).toBe(
        `${userSettingsPath}.corrupted`,
      );
      expect(process.env[ENV_WAS_RECOVERED]).toBe('1');
      expect(loaded.corruptedPath).toBeUndefined();
      expect(loaded.wasRecovered).toBe(false);
    } finally {
      delete process.env[ENV_CORRUPTED_PATH];
      delete process.env[ENV_WAS_RECOVERED];
    }
  });

  it('does not load a target environment during a readOnly load', () => {
    const workspace = path.join(tempDir, 'workspace');
    const envKey = 'PROJECT_RUNTIME_READ_ONLY_VALUE';
    const previousValue = process.env[envKey];
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.env'), `${envKey}=target-value\n`);
    delete process.env[envKey];

    try {
      loadSettings(workspace, {
        readOnly: true,
        workspaceTrusted: true,
      });

      expect(process.env[envKey]).toBeUndefined();
    } finally {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    }
  });

  it('does not recreate a deleted settings file when persisting a migration', () => {
    const workspace = path.join(tempDir, 'workspace');
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    const loaded = loadSettings(workspace, {
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    fs.rmSync(settingsPath);

    loaded.persistInMemoryMigrations();

    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(loaded.migratedInMemoryScopes.size).toBe(0);
  });

  it('preserves a concurrent settings edit when persisting a migration', () => {
    const workspace = path.join(tempDir, 'workspace');
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    const loaded = loadSettings(workspace, {
      readOnly: true,
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'light', custom: 'keep-me' }),
    );

    loaded.persistInMemoryMigrations();

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      ui: { theme: 'light' },
      custom: 'keep-me',
      [SETTINGS_VERSION_KEY]: SETTINGS_VERSION,
    });
    expect(loaded.migratedInMemoryScopes.size).toBe(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a failed migration persistence queued for a later retry',
    () => {
      const workspace = path.join(tempDir, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
      const loaded = loadSettings(workspace, {
        consumeCorruptionEnvVars: false,
        readOnly: true,
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      });
      const settingsDir = path.dirname(settingsPath);
      fs.chmodSync(settingsDir, 0o500);
      try {
        expect(() => loaded.persistInMemoryMigrations()).not.toThrow();
        expect(loaded.migratedInMemoryScopes.has(SettingScope.Workspace)).toBe(
          true,
        );
      } finally {
        fs.chmodSync(settingsDir, 0o700);
      }
    },
  );

  it('replaces workspace state without changing the LoadedSettings identity', () => {
    const current = new LoadedSettings(
      settingsFile('/system', {}),
      settingsFile('/defaults', {}),
      settingsFile('/user', { general: { language: 'en' } }),
      settingsFile('/project-a', { disableAllHooks: true }),
      true,
      new Set(),
    );
    const next = new LoadedSettings(
      settingsFile('/system', {}),
      settingsFile('/defaults', {}),
      settingsFile('/user', { general: { language: 'en' } }),
      settingsFile('/project-b', { disableAllHooks: false }),
      true,
      new Set(),
    );

    const previous = current.replaceWith(next);

    expect(current.workspace.path).toBe('/project-b');
    expect(current.merged.disableAllHooks).toBe(false);
    current.replaceWith(previous);
    expect(current.workspace.path).toBe('/project-a');
    expect(current.merged.disableAllHooks).toBe(true);
  });
});
