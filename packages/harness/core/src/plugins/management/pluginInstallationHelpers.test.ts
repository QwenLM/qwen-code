/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { ENV_PLUGIN_CACHE_DIR } from '../../config/brand.js';
import {
  getPluginInstallations,
  invalidateInstalledPluginsCache,
} from './installedPluginsManager.js';
import { getVersionedCachePath } from '../pluginDirectories.js';
import { cacheAndRegisterPlugin } from './pluginInstallationHelpers.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename) };
});

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `plugin-install-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(mkdir).mockClear();
  vi.mocked(rename).mockReset();
  vi.unstubAllEnvs();
  invalidateInstalledPluginsCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(process.platform === 'win32')('cacheAndRegisterPlugin', () => {
  it('sanitizes marketplace-backed plugin symlinks before version caching', async () => {
    const pluginHome = await createTempDir('home');
    const marketplaceRoot = await createTempDir('marketplace');
    const externalRoot = await createTempDir('external');
    vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
    invalidateInstalledPluginsCache();

    const pluginRoot = join(marketplaceRoot, 'plugins', 'demo');
    const internalTarget = join(pluginRoot, 'shared', 'internal');
    const marketplaceSharedTarget = join(
      marketplaceRoot,
      'shared',
      'marketplace',
    );
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'skills'), { recursive: true });
    await mkdir(internalTarget, { recursive: true });
    await mkdir(marketplaceSharedTarget, { recursive: true });
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
    );
    await writeFile(join(internalTarget, 'content.txt'), 'internal');
    await writeFile(join(marketplaceSharedTarget, 'content.txt'), 'shared');
    await writeFile(join(externalRoot, 'content.txt'), 'external');
    await symlink('../shared/internal', join(pluginRoot, 'skills', 'internal'));
    await symlink(
      '../../../shared/marketplace',
      join(pluginRoot, 'skills', 'marketplace-shared'),
    );
    await symlink(externalRoot, join(pluginRoot, 'skills', 'external'));

    const result = await cacheAndRegisterPlugin(
      'demo@team-market',
      pluginRoot,
      'user',
      {
        marketplaceInstallLocation: marketplaceRoot,
        version: '1.0.0',
      },
    );

    expect(result.ok).toBe(true);
    const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining(join(tmpdir(), `${slug}-plugin-cache-`)),
      { recursive: true },
    );
    if (!result.ok) return;
    const cachedSkills = join(result.installPath, 'skills');
    expect(isAbsolute(await readlink(join(cachedSkills, 'internal')))).toBe(
      false,
    );
    expect(
      (await lstat(join(cachedSkills, 'marketplace-shared'))).isDirectory(),
    ).toBe(true);
    await expect(lstat(join(cachedSkills, 'external'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await rm(marketplaceRoot, { recursive: true, force: true });
    await expect(
      readFile(join(cachedSkills, 'internal', 'content.txt'), 'utf-8'),
    ).resolves.toBe('internal');
    await expect(
      readFile(
        join(cachedSkills, 'marketplace-shared', 'content.txt'),
        'utf-8',
      ),
    ).resolves.toBe('shared');
  });
});

describe.skipIf(process.platform === 'win32')(
  'cacheAndRegisterPlugin — projectPath scoping',
  () => {
    async function installAt(
      scope: 'user' | 'project',
      pluginId: string,
    ): Promise<void> {
      const pluginHome = await createTempDir('home');
      const marketplaceRoot = await createTempDir('marketplace');
      vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
      invalidateInstalledPluginsCache();

      const pluginRoot = join(marketplaceRoot, 'plugins', 'demo');
      await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(pluginRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'demo', version: '1.0.0' }),
      );

      const result = await cacheAndRegisterPlugin(pluginId, pluginRoot, scope, {
        marketplaceInstallLocation: marketplaceRoot,
        version: '1.0.0',
        projectPath: '/some/project',
      });
      expect(result.ok).toBe(true);
    }

    it('omits projectPath on a user-scope install', async () => {
      await installAt('user', 'demo@team-market');

      const [entry] = getPluginInstallations('demo@team-market');
      expect(entry.scope).toBe('user');
      expect(entry.projectPath).toBeUndefined();
    });

    it('records projectPath on a project-scope install', async () => {
      await installAt('project', 'demo@team-market');

      const [entry] = getPluginInstallations('demo@team-market');
      expect(entry.scope).toBe('project');
      expect(entry.projectPath).toBe('/some/project');
    });
  },
);

it.each(['success', 'backup', 'publish'] as const)(
  'replaces unknown cache safely: %s',
  async (failure) => {
    const pluginHome = await createTempDir('swap-home');
    const source = await createTempDir('swap-source');
    vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
    invalidateInstalledPluginsCache();
    await mkdir(join(source, '.claude-plugin'));
    await writeFile(
      join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo' }),
    );
    await writeFile(join(source, 'new.txt'), 'new');
    const cache = getVersionedCachePath('team-market', 'demo', 'unknown');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'old.txt'), 'keep');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (
        (failure === 'backup' && from === cache) ||
        (failure === 'publish' &&
          to === cache &&
          String(from).includes('.tmp-'))
      ) {
        throw Object.assign(new Error('directory busy'), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    });
    const result = await cacheAndRegisterPlugin(
      'demo@team-market',
      source,
      'user',
      { version: 'unknown' },
    );
    expect(result.ok).toBe(failure === 'success');
    await expect(
      readFile(
        join(cache, failure === 'success' ? 'new.txt' : 'old.txt'),
        'utf8',
      ),
    ).resolves.toBe(failure === 'success' ? 'new' : 'keep');
    expect(await readdir(dirname(cache))).toEqual(['unknown']);
  },
);
