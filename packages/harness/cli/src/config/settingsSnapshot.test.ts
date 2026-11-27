/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeLegacyThemeNames,
  migrateDeprecatedSettings,
} from './settings.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import { LoadedSettings, SettingScope, mergeSettings } from './settings.js';
import { getSettingsSchema } from './settingsSchema.js';
import { getSettingsZodSchema } from './settings-validation.js';

let root: string;
let userDir: string;
let projectPath: string;
let userPath: string;
let projectFile: string;
let service: SettingsService;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agents-settings-中文 空格-'));
  userDir = join(root, 'user');
  projectPath = join(root, 'project');
  mkdirSync(userDir);
  mkdirSync(join(projectPath, '.qwen'), { recursive: true });
  userPath = join(userDir, 'settings.json');
  projectFile = join(projectPath, '.qwen/settings.json');
  service = new SettingsService(
    { schema: getSettingsSchema(), validation: getSettingsZodSchema() },
    {
      headless: false,
      hideUntrustedProject: true,
      recomputeTrust: false,
      mergeSettings,
      normalizeDisplaySettings: normalizeLegacyThemeNames,
      onResolved: (settings) => {
        migrateDeprecatedSettings(settings);
      },
      homeDir: root,
      environment: { AGENT_MODEL: 'test-model' },
    },
  );
});
afterEach(async () => {
  await service.dispose();
  rmSync(root, { recursive: true, force: true });
});
function load(
  options: Omit<Parameters<SettingsService['resolve']>[0], 'projectPath'> = {},
) {
  service.initialize({ userConfigDir: userDir });
  return service.resolve({ projectPath, ...options });
}

it('retains unexpanded originals and JSONC while preserving unrelated fields on write', () => {
  const raw =
    '\uFEFF{ // keep comment\n"model":{"name":"${AGENT_MODEL}"},"ui":{"theme":"VS"}}';
  writeFileSync(userPath, raw);
  const settings = load();
  expect(settings.user.rawJson).toBe(raw);
  expect(settings.user.originalSettings.model?.name).toBe('${AGENT_MODEL}');
  expect(settings.merged.model.name).toBe('test-model');
  expect(settings.merged.ui.theme).toBe('Default Light');
  expect(
    settings.setValue(SettingScope.User, 'ui.showLineNumbers', false),
  ).toBe(true);
  expect(readFileSync(userPath, 'utf8')).toContain('${AGENT_MODEL}');
  expect(readFileSync(userPath, 'utf8')).toContain('keep comment');
});

it('keeps disabled sources read-only and excludes them on refresh', () => {
  writeFileSync(userPath, JSON.stringify({ model: { name: 'user-model' } }));
  writeFileSync(
    projectFile,
    JSON.stringify({ model: { name: 'project-model' } }),
  );
  const settings = load({ sources: ['user'] });
  expect(settings.project.readOnly).toBe(true);
  expect(settings.local.readOnly).toBe(true);
  expect(settings.setValue(SettingScope.Project, 'model.name', 'changed')).toBe(
    true,
  );
  expect(JSON.parse(readFileSync(projectFile, 'utf8')).model.name).toBe(
    'project-model',
  );
  settings.reload();
  expect(settings.merged.model.name).toBe('user-model');
});

it('preserves legacy untrusted scoped reads while excluding project and local from merged', () => {
  writeFileSync(
    userPath,
    JSON.stringify({
      security: { folderTrust: { enabled: true } },
      model: { name: 'user-model' },
    }),
  );
  writeFileSync(
    projectFile,
    JSON.stringify({ model: { name: 'project-model' } }),
  );
  writeFileSync(
    join(projectPath, '.qwen/settings.local.json'),
    JSON.stringify({ model: { name: 'local-model' } }),
  );
  const settings = load();
  expect(settings.isTrusted).toBe(false);
  expect(settings.forScope(SettingScope.Project).settings).toEqual({});
  expect(settings.forScope(SettingScope.Local).settings.model?.name).toBe(
    'local-model',
  );
  expect(settings.merged.model.name).toBe('user-model');
  settings.setTrusted(true);
  expect(settings.forScope(SettingScope.Project).settings.model?.name).toBe(
    'project-model',
  );
  expect(settings.merged.model.name).toBe('local-model');
});

it('refreshes disk settings without discarding the flag layer', () => {
  writeFileSync(userPath, JSON.stringify({ model: { name: 'first' } }));
  const settings = load({ flagSettings: { model: { name: 'flag-model' } } });
  writeFileSync(userPath, JSON.stringify({ model: { name: 'second' } }));
  settings.reload();
  expect(settings.user.settings.model?.name).toBe('second');
  expect(settings.flag.originalSettings.model?.name).toBe('flag-model');
  expect(settings.merged.model.name).toBe('flag-model');
});

it('retains rejected user load state and does not replace an invalid file', () => {
  writeFileSync(userPath, '{broken');
  service.initialize({ userConfigDir: userDir });
  const snapshot = service.resolve({ projectPath });
  expect(snapshot.isUserSettingsLoadRejected()).toBe(true);
  const settings = snapshot;
  expect(settings.errors).toHaveLength(1);
  expect(settings.setValue(SettingScope.User, 'model.name', 'changed')).toBe(
    false,
  );
  expect(readFileSync(userPath, 'utf8')).toBe('{broken');
});

it('attaches the adopted snapshot to SettingsService watching and reloads external edits', async () => {
  writeFileSync(
    userPath,
    JSON.stringify({ context: { fileName: 'before.md' } }),
  );
  const settings = load({ sources: ['user'] });
  let stop: (() => void) | undefined;
  try {
    settings.attachSettingsService(service);
    const onChange = vi.fn();
    stop = await settings.watchChanges({
      acceptChange: async () => true,
      onChange,
    });
    writeFileSync(
      userPath,
      JSON.stringify({ context: { fileName: 'after.md' } }),
    );
    await vi.waitFor(
      () => {
        expect(settings.merged.context.fileName).toBe('after.md');
        expect(onChange).toHaveBeenCalledWith('userSettings');
      },
      { timeout: 8000 },
    );
  } finally {
    stop?.();
  }
});

it('adopts Service merged values without a full merge and keeps snapshots isolated', () => {
  service.initialize({ userConfigDir: userDir });
  const snapshot = service.resolve({ projectPath });
  const compute = vi.spyOn(
    LoadedSettings.prototype as unknown as {
      computeMergedSettings: () => unknown;
    },
    'computeMergedSettings',
  );
  try {
    const settings = service.resolve({ projectPath });
    expect(compute).not.toHaveBeenCalled();
    expect(settings.merged).toEqual(snapshot.merged);
    expect(settings.merged).not.toBe(snapshot.merged);
    settings.setValue(SettingScope.User, 'model.name', 'updated');
    expect(compute).toHaveBeenCalled();
    expect(snapshot.merged['model']).not.toEqual(settings.merged.model);
  } finally {
    compute.mockRestore();
  }
});

it.each(['local', 'flag'] as const)(
  'does not normalize a winning %s theme',
  (source) => {
    writeFileSync(
      userPath,
      JSON.stringify({
        ui: { theme: 'VS' },
        permissions: { trustDirectories: [projectPath] },
      }),
    );
    if (source === 'local')
      writeFileSync(
        join(projectPath, '.qwen/settings.local.json'),
        JSON.stringify({ ui: { theme: 'VS2015' } }),
      );
    const settings = load(
      source === 'flag' ? { flagSettings: { ui: { theme: 'VS2015' } } } : {},
    );
    expect(settings.user.settings.ui?.theme).toBe('Default Light');
    expect(settings.merged.ui.theme).toBe('VS2015');
  },
);

it('keeps legacy custom hook replacement while named hook events concatenate', () => {
  const hook = (command: string) => [{ hooks: [{ type: 'command', command }] }];
  writeFileSync(
    userPath,
    JSON.stringify({
      permissions: { trustDirectories: [projectPath] },
      hooks: { CustomEvent: hook('user'), PreToolUse: hook('user') },
    }),
  );
  writeFileSync(
    projectFile,
    JSON.stringify({
      hooks: { CustomEvent: hook('project'), PreToolUse: hook('project') },
    }),
  );
  const settings = load();
  expect(
    (settings.merged.hooks as Record<string, unknown>)['CustomEvent'],
  ).toEqual(hook('project'));
  expect(settings.merged.hooks.PreToolUse).toEqual([
    ...hook('user'),
    ...hook('project'),
  ]);
  expect(settings.merged).toEqual(
    mergeSettings(
      settings.user.settings,
      settings.project.settings,
      settings.isTrusted,
      settings.local.settings,
      settings.flag.settings,
    ),
  );
});

it('re-exports the Resource class without a compatibility subclass', async () => {
  const resource = await import('@qwen-code/resource');
  expect(LoadedSettings).toBe(resource.LoadedSettings);
  expect(Object.getPrototypeOf(load())).toBe(resource.LoadedSettings.prototype);
});
