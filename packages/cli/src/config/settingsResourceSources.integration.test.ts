/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCliSettingsService } from './createCliSettingsService.js';
import { loadSettingsWithService } from '../test-utils/resolveSettings.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shared-user-settings-中文 空格-'),
  );
  return {
    ...actual,
    Storage: class extends actual.Storage {
      static override getGlobalConfigDir(): string {
        return paths.root;
      }
      static override getGlobalSettingsPath(): string {
        return path.join(paths.root, 'settings.json');
      }
    },
  };
});

import { CONFIG_DIR } from '@qwen-code/core';
import { UserSettingsSource } from '@qwen-code/resource';
import { mutateSettingsFile } from './settingsPersistence.js';
import {
  USER_SETTINGS_PATH,
  setFlagSettingsPath,
  clearSettingsCache,
  SettingScope,
} from './settings.js';

afterAll(() => {
  vi.unstubAllEnvs();
  setFlagSettingsPath(undefined);
  rmSync(paths.root, { recursive: true, force: true });
});

it('keeps an explicit user-only load from acquiring project sources', async () => {
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const projectDir = join(paths.root, 'user-only-project');
  mkdirSync(join(projectDir, CONFIG_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, CONFIG_DIR, 'settings.json'),
    JSON.stringify({ context: { fileName: 'project.md' } }),
  );
  const getProject = vi.spyOn(service, 'getProjectSettingsSources');
  const userOnly = loadSettingsWithService(projectDir, service, ['user']);
  expect(getProject).not.toHaveBeenCalled();
  expect(userOnly.project.readOnly).toBe(true);
  expect(userOnly.merged.context.fileName).not.toBe('project.md');
  const complete = loadSettingsWithService(projectDir, service);
  expect(getProject).toHaveBeenCalledOnce();
  expect(complete.merged.context.fileName).toBe('project.md');
  await service.dispose();
});

it('shares raw user text across projects while each load produces an independent session snapshot', async () => {
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const aDir = join(paths.root, '项目 A');
  const bDir = join(paths.root, '项目 B');
  for (const [dir, name] of [
    [aDir, 'A.md'],
    [bDir, 'B.md'],
  ]) {
    mkdirSync(join(dir, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(dir, CONFIG_DIR, 'settings.json'),
      JSON.stringify({ context: { fileName: name } }),
    );
  }
  writeFileSync(
    join(aDir, CONFIG_DIR, 'settings.local.json'),
    JSON.stringify({ context: { discoveryMaxDirs: 11 } }),
  );
  writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify({
      security: { folderTrust: { enabled: false } },
      ui: { theme: '${SHARED_TEST_THEME}' },
    }),
  );
  vi.stubEnv('SHARED_TEST_THEME', 'dark');
  service.invalidateAll();
  const a = loadSettingsWithService(aDir, service);
  // Physical changes stay behind the shared raw snapshots until invalidation.
  writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify({ ui: { theme: 'physically-changed' } }),
  );
  writeFileSync(
    join(aDir, CONFIG_DIR, 'settings.json'),
    JSON.stringify({ context: { fileName: 'project-physically-changed.md' } }),
  );
  writeFileSync(
    join(aDir, CONFIG_DIR, 'settings.local.json'),
    JSON.stringify({ context: { discoveryMaxDirs: 22 } }),
  );
  vi.stubEnv('SHARED_TEST_THEME', 'light');
  const b = loadSettingsWithService(bDir, service);
  const sameProject = loadSettingsWithService(aDir, service);
  expect(a).not.toBe(sameProject);
  expect(a.user.settings).not.toBe(b.user.settings);
  expect(a.user.settings.ui?.theme).toBe('dark');
  expect(b.user.settings.ui?.theme).toBe('light');
  expect(a.merged.context.fileName).toBe('A.md');
  expect(b.merged.context.fileName).toBe('B.md');
  expect(sameProject.merged.context.fileName).toBe('A.md');
  expect(sameProject.merged.context.discoveryMaxDirs).toBe(11);
  a.setTrusted(false);
  expect(a.project.settings).toEqual({});
  expect(sameProject.merged.context.fileName).toBe('A.md');
  a.user.settings.ui!.theme = 'private';
  expect(b.user.settings.ui?.theme).toBe('light');
  const flag = join(paths.root, 'flag.json');
  writeFileSync(flag, JSON.stringify({ context: { fileName: 'FLAG.md' } }));
  setFlagSettingsPath(flag);
  const flagged = loadSettingsWithService(aDir, service);
  expect(flagged.merged.context.fileName).toBe('FLAG.md');
  expect(sameProject.merged.context.fileName).toBe('A.md');
  // An explicit per-session flag path wins over the process-level one and
  // leaves sibling projections on the process-level layer untouched.
  const sessionFlag = join(paths.root, 'session-flag.json');
  writeFileSync(
    sessionFlag,
    JSON.stringify({ context: { fileName: 'SESSION-FLAG.md' } }),
  );
  const sessionFlagged = loadSettingsWithService(
    aDir,
    service,
    undefined,
    sessionFlag,
  );
  expect(sessionFlagged.flag.path).toBe(sessionFlag);
  expect(sessionFlagged.merged.context.fileName).toBe('SESSION-FLAG.md');
  expect(loadSettingsWithService(aDir, service).merged.context.fileName).toBe(
    'FLAG.md',
  );
  setFlagSettingsPath(undefined);
  clearSettingsCache();
  const cleared = loadSettingsWithService(aDir, service);
  expect(cleared.user.settings.ui?.theme).toBe('physically-changed');
  expect(cleared.merged.context.fileName).toBe('project-physically-changed.md');
  expect(cleared.merged.context.discoveryMaxDirs).toBe(22);
  writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify({ ui: { theme: 'manually-reloaded' } }),
  );
  writeFileSync(
    join(aDir, CONFIG_DIR, 'settings.json'),
    JSON.stringify({ context: { fileName: 'project-manually-reloaded.md' } }),
  );
  writeFileSync(
    join(aDir, CONFIG_DIR, 'settings.local.json'),
    JSON.stringify({ context: { discoveryMaxDirs: 33 } }),
  );
  b.reload();
  expect(b.user.settings.ui?.theme).toBe('manually-reloaded');
  sameProject.reload();
  expect(sameProject.merged.context.fileName).toBe(
    'project-manually-reloaded.md',
  );
  expect(sameProject.merged.context.discoveryMaxDirs).toBe(33);
  await service.dispose();
});

it('watches shared user settings across projects while isolating project and local edits', async () => {
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const aDir = join(paths.root, '监听项目 A');
  const bDir = join(paths.root, '监听项目 B');
  const aProject = join(aDir, CONFIG_DIR, 'settings.json');
  const bLocal = join(bDir, CONFIG_DIR, 'settings.local.json');
  for (const [dir, name, maxDirs] of [
    [aDir, 'A.md', 11],
    [bDir, 'B.md', 22],
  ] as const) {
    mkdirSync(join(dir, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(dir, CONFIG_DIR, 'settings.json'),
      JSON.stringify({ context: { fileName: name } }),
    );
    writeFileSync(
      join(dir, CONFIG_DIR, 'settings.local.json'),
      JSON.stringify({ context: { discoveryMaxDirs: maxDirs } }),
    );
  }
  writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify({
      security: { folderTrust: { enabled: false } },
      ui: { theme: 'Default Dark' },
    }),
  );
  const stops: Array<() => void> = [];
  try {
    // Raw loading and watching need neither initialize() nor Skill resources.
    const a = loadSettingsWithService(aDir, service);
    const sameProject = loadSettingsWithService(aDir, service);
    const b = loadSettingsWithService(bDir, service);
    const aChange = vi.fn();
    const sameProjectChange = vi.fn();
    const bChange = vi.fn();
    const aHook = vi.fn(async () => true);
    const sameProjectHook = vi.fn(async () => true);
    const bHook = vi.fn(async () => true);
    for (const [settings, onChange, acceptChange] of [
      [a, aChange, aHook],
      [sameProject, sameProjectChange, sameProjectHook],
      [b, bChange, bHook],
    ] as const) {
      stops.push(await settings.watchChanges({ acceptChange, onChange }));
    }

    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        security: { folderTrust: { enabled: false } },
        ui: { theme: 'Default Light' },
      }),
    );
    await vi.waitFor(
      () => {
        for (const settings of [a, sameProject, b]) {
          expect(settings.merged.ui.theme).toBe('Default Light');
        }
        for (const onChange of [aChange, sameProjectChange, bChange]) {
          expect(onChange).toHaveBeenCalledExactlyOnceWith('userSettings');
        }
      },
      { timeout: 8000 },
    );
    expect(a.user.settings).not.toBe(b.user.settings);

    writeFileSync(
      aProject,
      JSON.stringify({ context: { fileName: 'A-updated.md' } }),
    );
    await vi.waitFor(
      () => {
        expect(a.merged.context.fileName).toBe('A-updated.md');
        expect(sameProject.merged.context.fileName).toBe('A-updated.md');
      },
      { timeout: 8000 },
    );
    expect(b.merged.context.fileName).toBe('B.md');
    expect(bHook).toHaveBeenCalledExactlyOnceWith(
      'user_settings',
      USER_SETTINGS_PATH,
    );

    writeFileSync(
      bLocal,
      JSON.stringify({ context: { discoveryMaxDirs: 33 } }),
    );
    await vi.waitFor(() => expect(b.merged.context.discoveryMaxDirs).toBe(33), {
      timeout: 8000,
    });
    expect(a.merged.context.discoveryMaxDirs).toBe(11);
    expect(sameProject.merged.context.discoveryMaxDirs).toBe(11);
    expect(aChange.mock.calls).toEqual([['userSettings'], ['projectSettings']]);
    expect(sameProjectChange.mock.calls).toEqual(aChange.mock.calls);
    expect(bChange.mock.calls).toEqual([['userSettings'], ['localSettings']]);

    // A persisted user write crosses project boundaries but never echoes to A.
    expect(a.setValue(SettingScope.User, 'ui.theme', 'Default Dark')).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(sameProject.merged.ui.theme).toBe('Default Dark');
      expect(b.merged.ui.theme).toBe('Default Dark');
      expect(sameProjectChange).toHaveBeenCalledTimes(3);
      expect(bChange).toHaveBeenCalledTimes(3);
    });
    expect(aHook).toHaveBeenCalledTimes(2);
    expect(aChange).toHaveBeenCalledTimes(2);
    expect(sameProjectHook).toHaveBeenLastCalledWith(
      'user_settings',
      USER_SETTINGS_PATH,
    );
    expect(bHook).toHaveBeenLastCalledWith('user_settings', USER_SETTINGS_PATH);
    expect(sameProject.merged.context.fileName).toBe('A-updated.md');
    expect(b.merged.context.fileName).toBe('B.md');
    expect(b.merged.context.discoveryMaxDirs).toBe(33);
  } finally {
    for (const stop of stops) stop();
    await service.dispose();
  }
});

it('legacy writers invalidate user and project readers without migrating the write transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'user-settings-write-中文 空格-'));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  try {
    const file = join(root, 'settings.json');
    writeFileSync(file, '// retained comment\n{"value":1}');
    const a = new UserSettingsSource(file);
    const b = new UserSettingsSource(file);
    expect(a.read()).toContain('"value":1');
    b.read();
    mutateSettingsFile(file, (latest) => {
      latest['value'] = 2;
      return true;
    });
    expect(a.read()).toContain('"value": 2');
    expect(b.read()).toContain('"value": 2');
    expect(a.read()).toContain('// retained comment');
    writeFileSync(file, '{"value":3}');
    mutateSettingsFile(file, () => false);
    expect(a.read()).toContain('"value":3');

    const projectFile = join(root, 'project', CONFIG_DIR, 'settings.json');
    const localFile = join(root, 'project', CONFIG_DIR, 'settings.local.json');
    mkdirSync(join(root, 'project', CONFIG_DIR), { recursive: true });
    writeFileSync(projectFile, '{"value":1}');
    writeFileSync(localFile, '{"value":1}');
    const projectSources = service.getProjectSettingsSources(
      projectFile,
      localFile,
    );
    projectSources.project.read();
    projectSources.local.read();
    mutateSettingsFile(projectFile, (latest) => {
      latest['value'] = 2;
      return true;
    });
    mutateSettingsFile(localFile, (latest) => {
      latest['value'] = 3;
      return true;
    });
    expect(projectSources.project.read()).toContain('"value": 2');
    expect(projectSources.local.read()).toContain('"value": 3');
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
