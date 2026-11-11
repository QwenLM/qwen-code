/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage, FatalConfigError, runLogger, CONFIG_DIR, ENV_GIT_BASH_PATH, ENV_SHELL_PREFIX } from '@qwen-code/core';
import { LoadedSettings, SettingsService } from '@qwen-code/resource';
import { createCliSettingsService } from './createCliSettingsService.js';
import { restoreLoadedEnvironment } from './settings.js';

vi.mock('@qwen-code/core', async (original) => ({
  ...(await original<typeof import('@qwen-code/core')>()),
  isHeadlessMode: () => false,
}));
let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-factory-中文 空格-'));
  project = join(root, 'project');
  mkdirSync(join(root, 'user'));
  mkdirSync(join(project, CONFIG_DIR), { recursive: true });
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(join(root, 'user'));
  writeFileSync(
    join(project, CONFIG_DIR, 'settings.json'),
    JSON.stringify({ model: { name: 'project' } }),
  );
});
afterEach(() => {
  restoreLoadedEnvironment();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('creates initialized standalone and session services returning the same concrete class', async () => {
  for (const environmentPolicy of ['command', 'session'] as const) {
    const service = createCliSettingsService({ environmentPolicy });
    try {
      const first = service.resolve({
        projectPath: project,
        flagSettings: { model: { name: 'first' } },
      });
      const second = service.resolve({
        projectPath: project,
        sources: [],
        flagSettings: { model: { name: 'second' } },
      });
      expect(first).toBeInstanceOf(LoadedSettings);
      expect(second).toBeInstanceOf(LoadedSettings);
      expect(first).not.toBe(second);
      expect(first.merged.model.name).toBe('first');
      expect(second.merged.model.name).toBe('second');
      expect(second.user.readOnly).toBe(true);
      first.reload();
      expect(first.merged.model.name).toBe('first');
    } finally {
      await service.dispose();
    }
  }
});

it('preserves the different command and session policies for an untrusted project env', async () => {
  const key = 'CLI_SETTINGS_FACTORY_TEST';
  const previous = process.env[key];
  delete process.env[key];
  writeFileSync(join(project, CONFIG_DIR, '.env'), `${key}=project-value\n`);
  try {
    const command = createCliSettingsService();
    expect(command.resolve({ projectPath: project }).isTrusted).toBe(false);
    expect(process.env[key]).toBeUndefined();
    await command.dispose();
    const session = createCliSettingsService({ environmentPolicy: 'session' });
    expect(session.resolve({ projectPath: project }).isTrusted).toBe(false);
    expect(process.env[key]).toBe('project-value');
    await session.dispose();
  } finally {
    restoreLoadedEnvironment();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

it('keeps malformed explicit session flags fatal while ordinary files remain warnings', async () => {
  const flag = join(root, 'flag.json');
  writeFileSync(flag, '{broken');
  writeFileSync(join(project, CONFIG_DIR, 'settings.json'), '{broken');
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  try {
    expect(service.resolve({ projectPath: project }).errors).toHaveLength(1);
    expect(() =>
      service.resolve({ projectPath: project, flagSettings: flag }),
    ).toThrow(FatalConfigError);
  } finally {
    await service.dispose();
  }
});


it.each([false, true])('configures a bare injected service with session rules and its exact host-bound user file (initialized=%s)', async (initialized) => {
  const file = join(root, 'user', 'host-settings.custom.json');
  writeFileSync(file, JSON.stringify({ ui: { theme: 'VS2015' } }));
  const service = new SettingsService();
  const source = service.getUserSettingsSource(file);
  if (initialized) service.initialize({ userConfigDir: join(root, 'user'), userSettingsPath: file, projectConfigDirName: CONFIG_DIR });
  try {
    expect(createCliSettingsService({ service, environmentPolicy: 'session' })).toBe(service);
    expect(service.peekUserSettingsSource()).toBe(source);
    const settings = service.resolve({ projectPath: project });
    expect(settings.user.path).toBe(file);
    expect(settings.user.settings.ui?.theme).not.toBe('VS2015');
    expect(settings.merged.model).toBeDefined();
    expect(settings.merged.tools).toBeDefined();
    expect(() => settings.merged.tools.exclude).not.toThrow();
    expect(settings.merged.general).toBeDefined();
    expect(settings.isTrusted).toBe(false);
    expect(settings.project.settings).toEqual({});
    settings.setTrusted(true);
    expect(settings.merged.model.name).toBe('project');
    settings.reload();
    expect(settings.isTrusted).toBe(true);
  } finally {
    await service.dispose();
  }
});

it('does not replace an initialized host service configuration', async () => {
  const service = new SettingsService(undefined, { headless: true });
  service.initialize({ userConfigDir: join(root, 'user'), projectConfigDirName: '.host' });
  try {
    expect(createCliSettingsService({ service, environmentPolicy: 'session' })).toBe(service);
    const settings = service.resolve({ projectPath: project });
    expect(settings.project.path).toBe(join(project, '.host', 'settings.json'));
    expect(settings.isTrusted).toBe(true);
  } finally {
    await service.dispose();
  }
});


it('rejects command-to-session reuse before changing command behavior', async () => {
  const service = createCliSettingsService();
  try {
    expect(() => createCliSettingsService({ service, environmentPolicy: 'session' })).toThrow('CLI policy is incompatible');
    expect(createCliSettingsService({ service })).toBe(service);
    const settings = service.resolve({ projectPath: project });
    expect(settings.isTrusted).toBe(false);
    expect(settings.project.settings.model?.name).toBe('project');
    settings.setTrusted(true);
    expect(settings.isTrusted).toBe(false);
  } finally { await service.dispose(); }
});

it('allows repeated session setup and preserves explicit trust adoption', async () => {
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  try {
    expect(createCliSettingsService({ service, environmentPolicy: 'session' })).toBe(service);
    const settings = service.resolve({ projectPath: project });
    settings.setTrusted(true);
    settings.reload();
    expect(settings.isTrusted).toBe(true);
    expect(settings.merged.model.name).toBe('project');
  } finally { await service.dispose(); }
});

it('keeps a committed touched value when unrelated invalid fields exceed recovery limits', async () => {
  const file = join(root, 'user', 'settings.json');
  writeFileSync(file, JSON.stringify({ model: { name: 'before' } }));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const warning = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  try {
    const settings = service.resolve({ projectPath: project, sources: ['user'] });
    writeFileSync(file, JSON.stringify({
      model: { name: 'before' }, permissions: { additionalDirectories: Array(25).fill(123) },
    }));
    expect(settings.setValue('user', 'model.name', 'after')).toBe(true);
    expect(settings.user.settings.model?.name).toBe('after');
    expect(settings.merged.model.name).toBe('after');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.model.name).toBe('after');
    expect(disk.permissions.additionalDirectories).toHaveLength(25);
    expect(warning).toHaveBeenCalled();
  } finally { await service.dispose(); }
});


it('honors an explicit non-headless host without forcing trust from the process', async () => {
  const service = new SettingsService(undefined, { headless: false });
  try {
    createCliSettingsService({ service, environmentPolicy: 'session' });
    expect(service.resolve({ projectPath: project }).isTrusted).toBe(false);
  } finally { await service.dispose(); }
});

it('uses session trust for project environment files without changing interactive trust', async () => {
  const key = ENV_GIT_BASH_PATH;
  const original = process.env[key];
  delete process.env[key];
  writeFileSync(join(project, CONFIG_DIR, '.env'), `${key}=/project/bash\n`);
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  try {
    expect(service.resolve({ projectPath: project }).isTrusted).toBe(false);
    expect(process.env[key]).toBeUndefined();
    const headless = service.resolve({ projectPath: project, headless: true });
    expect(headless.isTrusted).toBe(true);
    expect(process.env[key]).toBe('/project/bash');
    expect(service.resolve({ projectPath: project }).isTrusted).toBe(false);
  } finally {
    await service.dispose();
    restoreLoadedEnvironment();
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

it.each([undefined, false])(
  'preserves ordinary CLI env trust from merged flag settings (headless=%s)',
  async (headless) => {
    const key = ENV_SHELL_PREFIX;
    const original = process.env[key];
    delete process.env[key];
    writeFileSync(join(project, CONFIG_DIR, '.env'), `${key}=flag-trust-probe\n`);
    const service = createCliSettingsService({ environmentPolicy: 'session' });
    try {
      const settings = service.resolve({
        projectPath: project,
        headless,
        flagSettings: { security: { folderTrust: { enabled: false } } },
      });
      expect(settings.isTrusted).toBe(false);
      expect(settings.merged.security.folderTrust.enabled).toBe(false);
      expect(process.env[key]).toBe('flag-trust-probe');
    } finally {
      await service.dispose();
      restoreLoadedEnvironment();
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  },
);
