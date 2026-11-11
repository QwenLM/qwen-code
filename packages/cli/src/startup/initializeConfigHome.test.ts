/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigDirFlagOverrideForTest } from '../config/configDirFlag.js';

vi.mock('../qwen.js', () => ({ main: vi.fn() }));

async function initializeCliConfigHome(
  names?: { user: string; project: string },
  entry: 'runCli' | 'runWorkerCli' = 'runCli',
) {
  if (names) {
    vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', names.user);
    vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', names.project);
  }
  const cli = await import('@qwen-code/qwen-code');
  await cli[entry]();
}

const argv = process.argv;
const tempRoots: string[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = ['node', 'cli'];

  vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', undefined);
  vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', undefined);
  // Existing environment fixtures now supply their product prefix.
  vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
  vi.stubEnv('QWEN_CONFIG_DIR', undefined);
  vi.stubEnv('QWEN_CONFIG_DIR_NAME', undefined);
  vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', undefined);
  vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
  vi.stubEnv('EXAMPLE_CN_CONFIG_DIR', undefined);
  vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', undefined);
});

it.each(['runCli', 'runWorkerCli'] as const)(
  '%s can start after Core paths have loaded with brand defaults',
  async (entry) => {
    vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', '.example-cn');
    vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', '.example');
    const paths = await import('../../../core/src/utils/paths.js');
    await initializeCliConfigHome(undefined, entry);
    const { main } = await import('../qwen.js');
    expect(main).toHaveBeenCalledOnce();
    expect(paths.GLOBAL_CONFIG_DIR).toBe('.example-cn');
    expect(paths.CONFIG_DIR).toBe('.example');
  },
);
afterEach(async () => {
  vi.unstubAllEnvs();
  const { setConfigHomeDir } = await import('@qwen-code/core/sessions');
  setConfigHomeDir(undefined);
  clearConfigDirFlagOverrideForTest();
  process.argv = argv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it.each([
  [undefined, '.qwen', '.qwen'],
  [{ user: '.example', project: '.example' }, '.example', '.example'],
  [{ user: '.example-cn', project: '.example' }, '.example-cn', '.example'],
] as const)(
  'reads actual user and project settings from the selected directories (%j)',
  async (names, user, project) => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), 'config-home-中文 空格-'),
    );
    tempRoots.push(home);
    const workspace = path.join(home, 'workspace');
    vi.stubEnv('EXAMPLE_CLI_HOME', home);
    vi.stubEnv('EXAMPLE_CN_CLI_HOME', home);
    for (const name of ['.qwen', '.example', '.example-cn']) {
      const userRoot = path.join(home, name);
      const projectRoot = path.join(workspace, name);
      await fs.mkdir(userRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(
        path.join(userRoot, 'settings.json'),
        JSON.stringify({
          security: { folderTrust: { enabled: false } },
          ui: { theme: name },
        }),
      );
      await fs.writeFile(
        path.join(projectRoot, 'settings.json'),
        JSON.stringify({ context: { fileName: `${name}.md` } }),
      );
    }
    await initializeCliConfigHome(names);
    const { createCliSettingsService } = await import(
      '../config/createCliSettingsService.js'
    );
    const { loadSettingsWithService } = await import(
      '../test-utils/resolveSettings.js'
    );
    const service = createCliSettingsService({ environmentPolicy: 'session' });
    try {
      const settings = loadSettingsWithService(workspace, service);
      expect(settings.user.path).toBe(path.join(home, user, 'settings.json'));
      expect(settings.user.settings.ui?.theme).toBe(user);
      expect(settings.project.path).toBe(
        path.join(workspace, project, 'settings.json'),
      );
      expect(settings.project.settings.context?.fileName).toBe(`${project}.md`);
    } finally {
      await service.dispose();
    }
  },
);

it.each([
  [undefined, '.qwen', '.qwen'],
  [{ user: '.example', project: '.example' }, '.example', '.example'],
  [{ user: '.example-cn', project: '.example' }, '.example-cn', '.example'],
] as const)(
  'reads both directory levels from the brand defaults (%j)',
  async (names, user, project) => {
    await initializeCliConfigHome(names);
    const paths = await import('../../../core/src/utils/paths.js');
    expect(paths.GLOBAL_CONFIG_DIR).toBe(user);
    expect(paths.CONFIG_DIR).toBe(project);
  },
);

it.each(['runCli', 'runWorkerCli'] as const)(
  '%s synchronizes the session library with the selected root',
  async (entry) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'session-root-'));
    tempRoots.push(home);
    vi.stubEnv('EXAMPLE_CLI_HOME', home);
    vi.stubEnv('EXAMPLE_CN_CLI_HOME', home);
    vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', '.example-cn');
    vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', '.example');
    const { getConfigHomeDir: getSessionRoot } = await import(
      '@qwen-code/core/sessions'
    );
    await initializeCliConfigHome(
      { user: '.example-cn', project: '.example' },
      entry,
    );
    const paths = await import('../../../core/src/utils/paths.js');
    expect(paths.getConfigHomeDir()).toBe(path.join(home, '.example-cn'));
    expect(getSessionRoot()).toBe(paths.getConfigHomeDir());
  },
);

it.each([
  ['global', '.example', undefined, undefined],
  ['cn', '.example-cn', undefined, undefined],
  ['cn', '.example-cn', 'flag', undefined],
  ['global', '.example', 'flag', undefined],
  ['cn', '.example-cn', 'environment', undefined],
  ['cn', '.example-cn', undefined, '.自定义 CN'],
] as const)(
  'session storage follows site=%s, default=%s, override=%s, name=%s',
  async (site, user, override, customName) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'session-root-'));
    tempRoots.push(home);
    vi.stubEnv('EXAMPLE_CLI_HOME', home);
    vi.stubEnv('EXAMPLE_CN_CLI_HOME', home);

    vi.stubEnv('BRAND_ENV_PREFIX', site === 'cn' ? 'EXAMPLE_CN_' : 'EXAMPLE_');
    const target = path.join(home, '自定义 root');
    if (override === 'flag') process.argv.push('--config-dir', target);
    if (override === 'environment')
      vi.stubEnv(
        site === 'cn' ? 'EXAMPLE_CN_CONFIG_DIR' : 'EXAMPLE_CONFIG_DIR',
        target,
      );
    if (customName)
      vi.stubEnv(
        site === 'cn' ? 'EXAMPLE_CN_CONFIG_DIR_NAME' : 'EXAMPLE_CONFIG_DIR_NAME',
        customName,
      );
    await initializeCliConfigHome({ user, project: '.example' });
    const paths = await import('../../../core/src/utils/paths.js');
    const sessions = await import('@qwen-code/core/sessions');
    expect(paths.getConfigHomeDir()).toBe(
      override ? target : path.join(home, customName ?? user),
    );
    expect(sessions.getConfigHomeDir()).toBe(paths.getConfigHomeDir());
  },
);

it('applies the flag as a complete root without mutating the environment or project directory', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'config-flag-'));
  tempRoots.push(home);
  const target = path.join(home, '中文 e\u0301quipe');
  vi.stubEnv('EXAMPLE_CONFIG_DIR', '/environment-root');
  const earlyPaths = await import('../../../core/src/utils/paths.js');
  earlyPaths.getConfigHomeDir();
  process.argv.push('--config-dir', path.relative(process.cwd(), target));
  await initializeCliConfigHome();
  const paths = await import('../../../core/src/utils/paths.js');
  expect(paths.getConfigHomeDir()).toBe(target.normalize('NFC'));
  const sessions = await import('@qwen-code/core/sessions');
  expect(sessions.getConfigHomeDir()).toBe(target.normalize('NFC'));
  expect(paths.CONFIG_DIR).toBe('.qwen');
  expect(process.env['EXAMPLE_CONFIG_DIR']).toBe('/environment-root');
});

it.each(['runCli', 'runWorkerCli'] as const)(
  '%s rejects a file config root before starting main for read-only commands',
  async (entry) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'config-file-'));
    tempRoots.push(home);
    const file = path.join(home, 'afile.txt');
    await fs.writeFile(file, 'not-a-directory');
    process.argv.push('--config-dir', file, 'mcp', 'list');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { main } = await import('../qwen.js');

    await expect(initializeCliConfigHome(undefined, entry)).rejects.toThrow(
      'process.exit called',
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('not a directory');
    expect(main).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('not-a-directory');
  },
);

it('keeps the complete environment root when no flag is present', async () => {
  vi.stubEnv('EXAMPLE_CONFIG_DIR', '/environment-root');
  await initializeCliConfigHome();
  const paths = await import('../../../core/src/utils/paths.js');
  expect(paths.getConfigHomeDir()).toBe(path.resolve('/environment-root'));
  const sessions = await import('@qwen-code/core/sessions');
  expect(sessions.getConfigHomeDir()).toBe(path.resolve('/environment-root'));
});

it('uses QWEN_CONFIG_DIR when no product prefix is injected', async () => {
  vi.stubEnv('BRAND_ENV_PREFIX', undefined);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-config-'));
  tempRoots.push(root);
  vi.stubEnv('QWEN_CONFIG_DIR', root);
  await initializeCliConfigHome();
  const paths = await import('../../../core/src/utils/paths.js');
  const sessions = await import('@qwen-code/core/sessions');
  expect(paths.GLOBAL_CONFIG_DIR).toBe('.qwen');
  expect(paths.getConfigHomeDir()).toBe(root);
  expect(sessions.getConfigHomeDir()).toBe(root);
});

it.each([
  [undefined, ['--config-dir'], '--config-dir requires a directory path'],
  ['a/b', [], 'EXAMPLE_CONFIG_DIR_NAME must be a valid directory name'],
  ['.GIT', [], 'EXAMPLE_CONFIG_DIR_NAME must not use protected directory name'],
] as const)(
  'reports invalid startup options before loading Core (%j)',
  async (name, args, message) => {
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', name);
    process.argv.push(...args);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(initializeCliConfigHome()).rejects.toThrow(
      'process.exit called',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(message);
  },
);
