/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from './settings.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lockSync } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'comment-json';
import {
  deleteCommentJsonProperty,
  setCommentJsonProperty,
  toPlainJsonValue,
} from '../utils/commentJson.js';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  actualFs: undefined as typeof import('node:fs') | undefined,
  writeFileSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.actualFs = actual;
  return {
    ...actual,
    writeFileSync: mocks.writeFileSync,
    fsyncSync: mocks.fsyncSync,
    closeSync: mocks.closeSync,
    renameSync: mocks.renameSync,
    lstatSync: mocks.lstatSync,
  };
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    runLogger: { ...actual.runLogger, warn: mocks.warn },
  };
});

import { mutateSettingsFile } from './settingsPersistence.js';
import { createPluginSettingsAccessor } from '@qwen-code/core/plugin-management';
import { disableSkill } from '../utils/skillSettings.js';
import { removeHook } from '../utils/hookSettings.js';
import { ConfigSource, type HookRegistryEntry } from '@qwen-code/core';
import type {
  LoadedSettings} from './settings.js';
import {
  SettingScope,
  type Settings,
  type SettingsFile,
} from './settings.js';

function resetFsMocks(): void {
  const actual = mocks.actualFs!;
  mocks.writeFileSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.writeFileSync, actual, args),
  );
  mocks.fsyncSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.fsyncSync, actual, args),
  );
  mocks.closeSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.closeSync, actual, args),
  );
  mocks.renameSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.renameSync, actual, args),
  );
  mocks.lstatSync.mockReset().mockImplementation((...args) =>
    Reflect.apply(actual.lstatSync, actual, args),
  );
}

function makeLoadedSettings(
  userPath: string,
  userSettings: Settings,
): LoadedSettings {
  const emptyFile = (): SettingsFile => ({
    path: '',
    settings: {},
    originalSettings: {},
    readOnly: true,
  });
  return createLoadedSettings(
    {
      path: userPath,
      settings: structuredClone(userSettings),
      originalSettings: structuredClone(userSettings),
      rawJson: `${JSON.stringify(userSettings, null, 2)}\n`,
    },
    emptyFile(),
    emptyFile(),
    true,
  );
}

describe('settingsPersistence', () => {
  let tempDir: string;
  let settingsPath: string;
  let releaseExternalLock: (() => void) | undefined;

  beforeEach(() => {
    resetFsMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-write-'));
    settingsPath = path.join(tempDir, 'settings.json');
    mocks.warn.mockReset();
  });

  afterEach(() => {
    releaseExternalLock?.();
    releaseExternalLock = undefined;
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('mutates only the requested path and preserves comments and unknown fields', () => {
    fs.writeFileSync(
      settingsPath,
      `{
  // Keep this comment
  "mcpServers": { "existing": { "command": "old" } },
  "unknown": { "keep": true }
}\n`,
    );

    const result = mutateSettingsFile(settingsPath, (latest) =>
      setCommentJsonProperty(latest, ['ui', 'theme'], 'dark'),
    );

    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = toPlainJsonValue<Record<string, unknown>>(parse(raw));
    expect(result.changed).toBe(true);
    expect(raw).toContain('// Keep this comment');
    expect(parsed).toMatchObject({
      mcpServers: { existing: { command: 'old' } },
      unknown: { keep: true },
      ui: { theme: 'dark' },
    });
  });

  it('supports explicit deletion without treating omission as deletion', () => {
    fs.writeFileSync(
      settingsPath,
      '{ "remove": true, "mcpServers": { "keep": { "command": "x" } } }\n',
    );

    mutateSettingsFile(settingsPath, (latest) =>
      deleteCommentJsonProperty(latest, 'remove'),
    );

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      mcpServers: { keep: { command: 'x' } },
    });
  });

  it('does not rewrite a no-op mutation', () => {
    const original = '{ "value": 1 }\n';
    fs.writeFileSync(settingsPath, original);

    const result = mutateSettingsFile(settingsPath, () => false);

    expect(result).toMatchObject({ changed: false, rawJson: original });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('leaves the original file intact when parsing or mutation fails', () => {
    const invalid = '{ "apiKey": "private-value", invalid';
    fs.writeFileSync(settingsPath, invalid);
    expect(() => mutateSettingsFile(settingsPath, () => true)).toThrow(
      'Settings file contains invalid JSON.',
    );
    try {
      mutateSettingsFile(settingsPath, () => true);
    } catch (error) {
      expect(String(error)).not.toContain('private-value');
    }
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(invalid);

    const valid = '{ "value": 1 }\n';
    fs.writeFileSync(settingsPath, valid);
    expect(() =>
      mutateSettingsFile(settingsPath, () => {
        throw new Error('mutation failed');
      }),
    ).toThrow('mutation failed');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(valid);
    expect(fs.readdirSync(tempDir).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('preserves an existing mode and applies a private mode to a new user file', () => {
    fs.writeFileSync(settingsPath, '{}\n', { mode: 0o640 });
    mutateSettingsFile(settingsPath, (latest) =>
      setCommentJsonProperty(latest, 'value', 1),
    );
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);

    const privatePath = path.join(tempDir, 'private.json');
    mutateSettingsFile(
      privatePath,
      (latest) => setCommentJsonProperty(latest, 'value', 1),
      { newFileMode: 0o600 },
    );
    expect(fs.statSync(privatePath).mode & 0o777).toBe(0o600);
  });

  it('updates a relative symlink target without replacing the symlink', () => {
    const targetDir = path.join(tempDir, 'target');
    fs.mkdirSync(targetDir);
    const targetPath = path.join(targetDir, 'actual.json');
    fs.writeFileSync(targetPath, '{ "existing": true }\n');
    fs.symlinkSync(path.join('target', 'actual.json'), settingsPath);

    mutateSettingsFile(settingsPath, (latest) =>
      setCommentJsonProperty(latest, 'added', true),
    );

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({
      existing: true,
      added: true,
    });
  });

  it.each([false, true])(
    'writes through a directory symlink (existing file: %s)',
    (exists) => {
      const targetDir = path.join(tempDir, 'target');
      const linkedDir = path.join(tempDir, 'linked');
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkedDir, 'junction');
      const targetPath = path.join(targetDir, 'settings.json');
      if (exists) fs.writeFileSync(targetPath, '{ "existing": true }\n');

      mutateSettingsFile(path.join(linkedDir, 'settings.json'), (latest) =>
        setCommentJsonProperty(latest, 'added', true),
      );

      expect(fs.lstatSync(linkedDir).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({
        ...(exists ? { existing: true } : {}),
        added: true,
      });
    },
  );

  it('creates a dangling symlink target while preserving the link', () => {
    const targetDir = path.join(tempDir, 'target');
    fs.mkdirSync(targetDir);
    const targetPath = path.join(targetDir, 'actual.json');
    fs.symlinkSync(path.join('target', 'actual.json'), settingsPath);

    mutateSettingsFile(settingsPath, (latest) =>
      setCommentJsonProperty(latest, 'created', true),
    );

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({
      created: true,
    });
  });

  it('does not replace a dangling symlink when its target directory is missing', () => {
    const targetPath = path.join(tempDir, 'missing', 'actual.json');
    fs.symlinkSync(path.join('missing', 'actual.json'), settingsPath);

    expect(() =>
      mutateSettingsFile(settingsPath, (latest) =>
        setCommentJsonProperty(latest, 'created', true),
      ),
    ).toThrow();

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('rejects same-path reentrancy immediately and recovers for the next write', () => {
    fs.writeFileSync(settingsPath, '{}\n');
    expect(() =>
      mutateSettingsFile(settingsPath, () => {
        mutateSettingsFile(settingsPath, () => true);
        return true;
      }),
    ).toThrow(/Reentrant/);

    expect(
      mutateSettingsFile(settingsPath, (latest) =>
        setCommentJsonProperty(latest, 'recovered', true),
      ).changed,
    ).toBe(true);
  });

  it('allows a nested mutation for a different settings file', () => {
    const otherPath = path.join(tempDir, 'other.json');
    fs.writeFileSync(settingsPath, '{}\n');
    fs.writeFileSync(otherPath, '{}\n');

    mutateSettingsFile(settingsPath, (latest) => {
      mutateSettingsFile(otherPath, (other) =>
        setCommentJsonProperty(other, 'other', true),
      );
      return setCommentJsonProperty(latest, 'first', true);
    });

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      first: true,
    });
    expect(JSON.parse(fs.readFileSync(otherPath, 'utf8'))).toEqual({
      other: true,
    });
  });

  it('treats unlock failures as post-commit diagnostics', () => {
    fs.writeFileSync(settingsPath, '{}\n');

    const result = mutateSettingsFile(settingsPath, (latest) => {
      fs.rmSync(`${settingsPath}.lock`, { recursive: true, force: true });
      fs.writeFileSync(`${settingsPath}.lock`, 'block release');
      return setCommentJsonProperty(latest, 'committed', true);
    });

    expect(result.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      committed: true,
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('unlock (settings.json, ENOTDIR)'),
    );
  });

  it(
    'times out under external lock contention without changing the file',
    () => {
      const original = '{ "value": 1 }\n';
      fs.writeFileSync(settingsPath, original);
      releaseExternalLock = lockSync(settingsPath, {
        realpath: false,
        retries: 0,
        stale: 10_000,
        update: 5_000,
      });

      const startedAt = performance.now();
      expect(() => mutateSettingsFile(settingsPath, () => true)).toThrow();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_900);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
    },
    6_000,
  );
});

describe('LoadedSettings transactional updates', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    resetFsMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-loaded-settings-'));
    settingsPath = path.join(tempDir, 'settings.json');
    mocks.warn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves external MCP and unrelated entries when plugin, skill and hook edits use a stale snapshot', () => {
    const hook = { type: 'command' as const, command: 'echo remove' };
    const initial: Settings = {
      enabledPlugins: { 'remove.v1@market': true },
      skills: { disabled: ['existing'] },
      hooks: { PreToolUse: [{ hooks: [hook] }] } as unknown as Settings['hooks'],
    };
    const loaded = makeLoadedSettings(settingsPath, initial);
    const latest = {
      ...initial,
      mcpServers: { external: { command: 'external' } },
      enabledPlugins: { ...initial.enabledPlugins, 'keep@market': true },
      hooks: {
        ...initial.hooks,
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(latest));

    expect(
      createPluginSettingsAccessor(loaded).patchScopedEnabledPlugins('user', {
        'remove.v1@market': undefined,
        'add.v2@market': true,
      }),
    ).toBe(true);
    expect(disableSkill(loaded, 'new', SettingScope.User).status).toBe('success');
    expect(
      removeHook(loaded, {
        source: ConfigSource.User,
        eventName: 'PreToolUse',
        config: hook,
      } as HookRegistryEntry).status,
    ).toBe('success');

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(saved.mcpServers).toEqual(latest.mcpServers);
    expect(saved.enabledPlugins).toEqual({
      'keep@market': true,
      'add.v2@market': true,
    });
    expect(saved.skills.disabled).toEqual(['existing', 'new']);
    expect(saved.hooks).toEqual({ PostToolUse: latest.hooks.PostToolUse });
  });

  it('does not delete MCP servers added after the settings snapshot was loaded', () => {
    const initial: Settings = { ui: { theme: 'default' } };
    fs.writeFileSync(settingsPath, `${JSON.stringify(initial, null, 2)}\n`);
    const loaded = makeLoadedSettings(settingsPath, initial);
    const externalServers = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `server-${index}`,
        { command: `command-${index}` },
      ]),
    );
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...initial, mcpServers: externalServers }, null, 2)}\n`,
    );

    expect(
      loaded.setValue(SettingScope.User, 'ui.theme', 'ANSI Light'),
    ).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(persisted.mcpServers).toEqual(externalServers);
    expect(persisted.ui.theme).toBe('ANSI Light');
    expect(loaded.user.originalSettings.mcpServers).toEqual(externalServers);
    expect(loaded.user.settings.mcpServers).toBeUndefined();
  });

  it('refreshes the disk baseline on a no-op without hot-loading other fields', () => {
    const initial: Settings = { ui: { theme: 'dark' } };
    fs.writeFileSync(settingsPath, `${JSON.stringify(initial)}\n`);
    const loaded = makeLoadedSettings(settingsPath, initial);
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({
        ...initial,
        mcpServers: { external: { command: 'external' } },
      })}\n`,
    );

    expect(loaded.setValue(SettingScope.User, 'ui.theme', 'dark')).toBe(true);

    expect(loaded.user.originalSettings.mcpServers).toEqual({
      external: { command: 'external' },
    });
    expect(loaded.user.rawJson).toContain('external');
    expect(loaded.user.settings.mcpServers).toBeUndefined();
  });

  it('tracks batch edits automatically and refreshes touched no-op values only', () => {
    const initial: Settings = { ui: { theme: 'default' } };
    const loaded = makeLoadedSettings(settingsPath, initial);
    const latest = {
      ui: { theme: 'ANSI Light' },
      mcpServers: { external: { command: 'external' } },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(latest));
    const mutablePath = ['ui', 'theme'];

    expect(
      loaded.mutateScope(SettingScope.User, (editor) => {
        editor.set(mutablePath, 'ANSI Light');
        mutablePath[1] = 'unrelated';
        editor.update('general.preferredEditor', () => 'vim');
        editor.delete('ui.showLineNumbers');
      }),
    ).toBe(true);

    expect(loaded.user.settings.ui?.theme).toBe('ANSI Light');
    expect(loaded.user.settings.general?.preferredEditor).toBe('vim');
    expect(loaded.user.settings.mcpServers).toBeUndefined();
    expect(loaded.user.originalSettings.mcpServers).toEqual(latest.mcpServers);
  });

  it('keeps runtime state unchanged when the latest file cannot be parsed', () => {
    const initial: Settings = { ui: { theme: 'default' } };
    const loaded = makeLoadedSettings(settingsPath, initial);
    fs.writeFileSync(settingsPath, '{ invalid');

    expect(loaded.setValue(SettingScope.User, 'ui.theme', 'dark')).toBe(false);
    expect(loaded.user.settings.ui?.theme).toBe('default');
    expect(loaded.user.originalSettings).toEqual(initial);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ invalid');
  });

  it('uses explicit segments for model IDs containing dots and slashes', () => {
    const initial: Settings = { model: { preferences: {} } };
    fs.writeFileSync(settingsPath, `${JSON.stringify(initial)}\n`);
    const loaded = makeLoadedSettings(settingsPath, initial);

    expect(
      loaded.updateValue(
        SettingScope.User,
        ['model', 'preferences', 'model.v2/fast'],
        () => ({ contextWindow: 64_000 }),
      ),
    ).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(persisted.model.preferences['model.v2/fast']).toEqual({
      contextWindow: 64_000,
    });
    expect(persisted.model.preferences.model).toBeUndefined();
  });
});
