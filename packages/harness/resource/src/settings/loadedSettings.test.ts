/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LoadedSettings,
  SettingScope,
  type LoadedSettingsHost,
} from './loadedSettings.js';

import type { Settings, MergedSettings } from './settingsSchema.js';
const host: LoadedSettingsHost = {
  // This host tests adoption/persistence only; schema defaults are covered separately.
  merge: (user, project, trusted, local, flag) =>
    ({
      ...user,
      ...(trusted ? project : {}),
      ...(trusted ? local : {}),
      ...flag,
    }) as MergedSettings,
  runtimeValues: structuredClone,
  normalizeOriginal: () => {},
  resolveEnvironment: (value) => value,
  normalizeDisplaySettings: () => {},
  readFile: (path) => {
    const settings = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    return { settings, originalSettings: structuredClone(settings) };
  },
};
const file = (settings: Settings = {}, path = '') => ({
  path,
  settings: structuredClone(settings),
  originalSettings: structuredClone(settings),
});
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('isolates notifications and snapshots between contexts without Core events', () => {
  const first = new LoadedSettings(host, file(), file(), file(), true);
  const second = new LoadedSettings(host, file(), file(), file(), true);
  const before = first.getSnapshot();
  const changed = vi.fn(() =>
    expect(first.getSnapshot().merged.ui?.theme).toBe('dark'),
  );
  const other = vi.fn();
  const stop = first.subscribe(changed);
  second.subscribe(other);
  first.setValue(SettingScope.User, 'ui.theme', 'dark');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  expect(before.merged.ui?.theme).toBeUndefined();
  stop();
  stop();
  first.setTrusted(false);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('writes against latest disk contents without adopting unrelated external values, and preserves flags on reload', () => {
  root = mkdtempSync(join(tmpdir(), 'loaded-settings-中文 空格-'));
  const path = join(root, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({ ui: { theme: 'light' }, blockedMarketplaces: ['new'] }),
  );
  const settings = new LoadedSettings(
    host,
    file({ ui: { theme: 'light' }, blockedMarketplaces: ['old'] }, path),
    file(),
    file(),
    true,
    [],
    file({ model: { name: 'flag' } }),
  );
  expect(settings.setValue(SettingScope.User, 'ui.theme', 'dark')).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    ui: { theme: 'dark' },
    blockedMarketplaces: ['new'],
  });
  expect(settings.merged.blockedMarketplaces).toEqual(['old']);
  settings.reload();
  expect(settings.merged.blockedMarketplaces).toEqual(['new']);
  expect(settings.merged.model.name).toBe('flag');
});

it.each([{ settingPath: 'mcpServers' }, { settingPath: ['mcpServers'] }])(
  'rejects malformed MCP maps without changing disk, snapshots or subscribers: %s',
  ({ settingPath }) => {
    root = mkdtempSync(join(tmpdir(), 'loaded-settings-invalid-mcp-'));
    const path = join(root, 'settings.json');
    const initial = { mcpServers: { valid: { command: 'echo' } } };
    const raw = JSON.stringify(initial);
    writeFileSync(path, raw);
    const settings = new LoadedSettings(
      host,
      file(initial, path),
      file(),
      file(),
      true,
    );
    const before = settings.getSnapshot();
    const changed = vi.fn();
    settings.subscribe(changed);
    for (const invalid of [null, undefined, 'bad', 1, false, [], () => {}]) {
      expect(
        settings.setValue(SettingScope.User, settingPath, {
          valid: { command: 'new', scope: 'user' },
          bad: invalid,
        }),
      ).toBe(false);
    }
    for (const invalidMap of [null, 'bad', 1, false, []]) {
      expect(
        settings.setValue(SettingScope.User, settingPath, invalidMap),
      ).toBe(false);
    }
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(settings.getSnapshot()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    const value = { valid: { command: 'new', scope: 'user' } };
    expect(settings.setValue(SettingScope.User, settingPath, value)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { valid: { command: 'new' } },
    });
    expect(value.valid.scope).toBe('user');
    expect(settings.setValue(SettingScope.User, settingPath, undefined)).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  },
);

it('explicit reload updates the same instance, preserving excluded sources, flags and trust', () => {
  root = mkdtempSync(join(tmpdir(), 'settings-reload-中文 空格-'));
  const userPath = join(root, 'user.json');
  const projectPath = join(root, 'project.json');
  writeFileSync(userPath, JSON.stringify({ ui: { theme: 'new' } }));
  writeFileSync(projectPath, JSON.stringify({ model: { name: 'new-project' } }));
  const onReload = vi.fn();
  const settings = new LoadedSettings(
    { ...host, onReload },
    file({ ui: { theme: 'old' } }, userPath),
    file({ model: { name: 'old-project' } }, projectPath),
    { ...file({ model: { name: 'excluded' } }, join(root, 'unreadable.json')), readOnly: true },
    false,
    [],
    file({ model: { name: 'flag' } }),
  );
  const changed = vi.fn();
  settings.subscribe(changed);
  settings.reload();
  expect(onReload).toHaveBeenCalledOnce();
  expect(settings.user.settings.ui?.theme).toBe('new');
  expect(settings.project.settings).toEqual({});
  expect(settings.local.settings.model?.name).toBe('excluded');
  expect(settings.merged.model.name).toBe('flag');
  expect(settings.isTrusted).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
});

it('refreshes existing load diagnostics and clears them after a successful reload', () => {
  let rejected = true;
  const settings = new LoadedSettings(
    {
      ...host,
      readFile: (path, errors) => {
        if (rejected)
          errors.push({ path, severity: 'warning', message: 'Invalid JSON' });
        return { settings: {}, originalSettings: {}, loadRejected: rejected };
      },
    },
    file({}, '/settings.json'),
    file(),
    file(),
    true,
  );
  settings.reload();
  expect(settings.getSnapshot().user.loadRejected).toBe(true);
  expect(settings.errors).toHaveLength(1);
  rejected = false;
  settings.reload();
  expect(settings.getSnapshot().user.loadRejected).toBe(false);
  expect(settings.errors).toEqual([]);
});
