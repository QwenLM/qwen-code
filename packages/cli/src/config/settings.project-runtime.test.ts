/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FatalConfigError, Storage } from '@qwen-code/qwen-code-core';
import {
  LoadedSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  SettingScope,
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
  let previousQwenHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-project-runtime-'));
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tempDir, 'home');
    resetHomeEnvBootstrapForTesting();
  });

  afterEach(() => {
    if (previousQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = previousQwenHome;
    }
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
