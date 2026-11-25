/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { BRAND_PLUGIN_META_DIR, ENV_PLUGIN_CACHE_DIR } from '../../config/brand.js';
import {
  addMarketplaceSourceFromSource,
  addMarketplaceSource,
  clearMarketplacesCache,
  getMarketplace,
  getPluginById,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
  replaceMarketplaceSource,
  removeMarketplaceSource,
  resolveSubPathManifestPath,
  saveKnownMarketplacesConfig,
} from './marketplaceManager.js';
import {
  addPluginInstallation,
  invalidateInstalledPluginsCache,
  loadInstalledPluginsFromDisk,
} from './installedPluginsManager.js';
const tmpDirs: string[] = [];

async function useTempPluginHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'test-marketplace-test-'));
  tmpDirs.push(dir);
  vi.stubEnv(ENV_PLUGIN_CACHE_DIR, dir);
  clearMarketplacesCache();
  invalidateInstalledPluginsCache();
  return dir;
}

async function writeMarketplace(
  dir: string,
  name: string,
  version?: string,
): Promise<void> {
  const manifestDir = join(dir, '.claude-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'Test Owner' },
      plugins: [],
      metadata: version ? { version } : undefined,
    }),
  );
}

async function writeMarketplaceWithRelativePlugin(
  dir: string,
  name: string,
  pluginName: string,
): Promise<string> {
  const manifestDir = join(dir, '.claude-plugin');
  await mkdir(manifestDir, { recursive: true });
  const relativeSource = `./plugins/${pluginName}`;
  await writeFile(
    join(manifestDir, 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'Test Owner' },
      plugins: [
        {
          name: pluginName,
          source: relativeSource,
        },
      ],
    }),
  );
  // Materialize the plugin directory referenced by the relative source.
  const pluginDir = join(dir, 'plugins', pluginName);
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  return relativeSource;
}

afterEach(async () => {
  clearMarketplacesCache();
  invalidateInstalledPluginsCache();
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('marketplaceManager', () => {
  it('adds a marketplace using the name declared by marketplace.json', async () => {
    const pluginHome = await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');

    const result = await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });

    expect(result).toMatchObject({
      name: 'team-market',
      alreadyMaterialized: false,
      resolvedSource: { source: 'directory', path: sourceDir },
    });
    expect(loadKnownMarketplacesConfig()['team-market']).toMatchObject({
      source: { source: 'directory', path: sourceDir },
      installLocation: join(pluginHome, 'marketplaces', 'team-market'),
    });
    await expect(
      readFile(
        join(
          pluginHome,
          'marketplaces',
          'team-market',
          '.claude-plugin',
          'marketplace.json',
        ),
        'utf-8',
      ),
    ).resolves.toContain('"team-market"');

    const duplicate = await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });
    expect(duplicate.alreadyMaterialized).toBe(true);
    expect(duplicate.name).toBe('team-market');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps cached directory marketplaces independent from internal symlink sources',
    async () => {
      const pluginHome = await useTempPluginHome();
      const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
      tmpDirs.push(sourceDir);
      await writeMarketplace(sourceDir, 'team-market');
      await mkdir(join(sourceDir, 'shared'), { recursive: true });
      await mkdir(join(sourceDir, 'plugins'), { recursive: true });
      await writeFile(join(sourceDir, 'shared', 'content.txt'), 'cached');
      await symlink('../shared', join(sourceDir, 'plugins', 'linked'));

      await addMarketplaceSourceFromSource({
        source: 'directory',
        path: sourceDir,
      });

      const cachedMarketplace = join(
        pluginHome,
        'marketplaces',
        'team-market',
      );
      expect(isAbsolute(await readlink(join(cachedMarketplace, 'plugins', 'linked')))).toBe(
        false,
      );

      await rm(sourceDir, { recursive: true, force: true });
      await expect(
        readFile(
          join(cachedMarketplace, 'plugins', 'linked', 'content.txt'),
          'utf-8',
        ),
      ).resolves.toBe('cached');
    },
  );

  it('allows a different source to overwrite the same marketplace name', async () => {
    await useTempPluginHome();
    const firstSource = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    const secondSource = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(firstSource, secondSource);
    await writeMarketplace(firstSource, 'team-market');
    await writeMarketplace(secondSource, 'team-market');

    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: firstSource,
    });
    const result = await addMarketplaceSourceFromSource({
      source: 'directory',
      path: secondSource,
    });

    expect(result).toMatchObject({
      name: 'team-market',
      alreadyMaterialized: false,
      resolvedSource: { source: 'directory', path: secondSource },
    });
    expect(loadKnownMarketplacesConfig()['team-market']).toMatchObject({
      source: { source: 'directory', path: secondSource },
    });
  });

  it('normalizes legacy same-source marketplace keys to the manifest name', async () => {
    await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');

    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });
    const config = loadKnownMarketplacesConfig();
    const entry = config['team-market'];
    delete config['team-market'];
    config['https://example.com/legacy-market.git'] = entry;
    saveKnownMarketplacesConfig(config);
    clearMarketplacesCache();

    const result = await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });

    expect(result).toMatchObject({
      name: 'team-market',
      alreadyMaterialized: true,
    });
    const normalized = loadKnownMarketplacesConfig();
    expect(normalized['team-market']).toMatchObject({
      source: { source: 'directory', path: sourceDir },
    });
    expect(normalized['https://example.com/legacy-market.git']).toBeUndefined();
  });

  it('matches same-source entries regardless of object key order', async () => {
    await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');
    saveKnownMarketplacesConfig({
      legacy: {
        source: {
          source: 'github',
          path: '.claude-plugin/marketplace.json',
          ref: 'main',
          repo: 'acme/plugins',
        },
        installLocation: sourceDir,
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = await addMarketplaceSourceFromSource({
      source: 'github',
      repo: 'acme/plugins',
      ref: 'main',
      path: '.claude-plugin/marketplace.json',
    });

    expect(result.alreadyMaterialized).toBe(true);
    expect(result.name).toBe('team-market');
  });

  it('matches nested source fields regardless of object key order', async () => {
    await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');
    saveKnownMarketplacesConfig({
      legacy: {
        source: {
          source: 'url',
          headers: {
            'X-Beta': '2',
            'X-Alpha': '1',
          },
          url: 'https://example.com/marketplace.json',
        },
        installLocation: sourceDir,
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = await addMarketplaceSourceFromSource({
      source: 'url',
      url: 'https://example.com/marketplace.json',
      headers: {
        'X-Alpha': '1',
        'X-Beta': '2',
      },
    });

    expect(result.alreadyMaterialized).toBe(true);
    expect(result.name).toBe('team-market');
  });

  it('removes installed plugins from a deleted marketplace', async () => {
    const pluginHome = await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');
    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });

    const alphaInstallPath = join(
      pluginHome,
      'cache',
      'team-market',
      'alpha',
      '1.0.0',
    );
    await mkdir(alphaInstallPath, { recursive: true });
    addPluginInstallation('alpha@team-market', {
      scope: 'user',
      installPath: alphaInstallPath,
    });
    addPluginInstallation('local-plugin@local', {
      scope: 'user',
      installPath: join(pluginHome, 'cache', 'local', 'local-plugin', 'local'),
    });

    const result = await removeMarketplaceSource('team-market');

    expect(loadKnownMarketplacesConfig()['team-market']).toBeUndefined();
    expect(result.removedPluginIds).toEqual(['alpha@team-market']);
    expect(result.orphanedPaths).toEqual([alphaInstallPath]);
    expect(
      loadInstalledPluginsFromDisk().plugins['alpha@team-market'],
    ).toBeUndefined();
    expect(
      loadInstalledPluginsFromDisk().plugins['local-plugin@local'],
    ).toHaveLength(1);
    expect(
      existsSync(join(pluginHome, 'marketplaces', 'team-market')),
    ).toBe(false);
    expect(existsSync(join(alphaInstallPath, '.orphaned_at'))).toBe(true);
  });

  it('does not recursively remove install locations outside marketplace cache', async () => {
    await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market');
    saveKnownMarketplacesConfig({
      'team-market': {
        source: { source: 'directory', path: sourceDir },
        installLocation: sourceDir,
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = await removeMarketplaceSource('team-market');

    expect(result.skippedCacheRemoval).toBe(true);
    expect(existsSync(sourceDir)).toBe(true);
    expect(loadKnownMarketplacesConfig()['team-market']).toBeUndefined();
  });

  it('normalizes relative plugin sources to absolute paths on add', async () => {
    const pluginHome = await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplaceWithRelativePlugin(sourceDir, 'team-market', 'alpha');

    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });

    const lookup = await getPluginById('alpha@team-market');
    expect(lookup).not.toBeNull();
    const source = lookup!.entry.source;
    expect(typeof source).toBe('string');
    expect(isAbsolute(source as string)).toBe(true);
    expect(source).not.toContain('./');
    expect(source).toBe(
      join(pluginHome, 'marketplaces', 'team-market', 'plugins', 'alpha'),
    );
    // The normalized source must point at a real directory on disk.
    expect(existsSync(source as string)).toBe(true);
  });

  it('exposes absolute plugin sources when loading a marketplace from disk', async () => {
    const pluginHome = await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplaceWithRelativePlugin(sourceDir, 'team-market', 'alpha');

    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });
    // Drop the in-memory cache so the next read comes from disk.
    clearMarketplacesCache();

    const marketplace = await getMarketplace('team-market');
    expect(marketplace).not.toBeNull();
    const entry = marketplace!.plugins.find((p) => p.name === 'alpha');
    expect(entry).toBeDefined();
    expect(isAbsolute(entry!.source as string)).toBe(true);
    expect(entry!.source).toBe(
      join(pluginHome, 'marketplaces', 'team-market', 'plugins', 'alpha'),
    );
  });

  it('re-normalizes relative plugin sources on refresh', async () => {
    const pluginHome = await useTempPluginHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'test-marketplace-src-'));
    tmpDirs.push(sourceDir);
    await writeMarketplaceWithRelativePlugin(sourceDir, 'team-market', 'alpha');

    await addMarketplaceSourceFromSource({
      source: 'directory',
      path: sourceDir,
    });
    clearMarketplacesCache();

    const marketplace = await refreshMarketplace('team-market');
    const entry = marketplace.plugins.find((p) => p.name === 'alpha');
    expect(entry).toBeDefined();
    expect(isAbsolute(entry!.source as string)).toBe(true);
    expect(entry!.source).toBe(
      join(pluginHome, 'marketplaces', 'team-market', 'plugins', 'alpha'),
    );
  });

  it('keeps the previous cache when a marketplace refresh fails', async () => {
    await useTempPluginHome();
    const sourceDir = await mkdtemp(
      join(tmpdir(), 'test-marketplace-refresh-src-'),
    );
    tmpDirs.push(sourceDir);
    await writeMarketplace(sourceDir, 'team-market', '1.0.0');
    await addMarketplaceSource('team-market', {
      source: 'directory',
      path: sourceDir,
    });
    await rm(sourceDir, { recursive: true, force: true });

    await expect(refreshMarketplace('team-market')).rejects.toThrow();

    clearMarketplacesCache();
    expect((await getMarketplace('team-market'))?.metadata?.version).toBe(
      '1.0.0',
    );
  });

  it('replaces a marketplace source and persists the declared source', async () => {
    const pluginHome = await useTempPluginHome();
    const oldSourceDir = await mkdtemp(
      join(tmpdir(), 'test-marketplace-old-src-'),
    );
    const newSourceDir = await mkdtemp(
      join(tmpdir(), 'test-marketplace-new-src-'),
    );
    tmpDirs.push(oldSourceDir, newSourceDir);
    await writeMarketplace(oldSourceDir, 'team-market', '1.0.0');
    await writeMarketplace(newSourceDir, 'team-market', '2.0.0');

    await addMarketplaceSource('team-market', {
      source: 'directory',
      path: oldSourceDir,
    });
    const config = loadKnownMarketplacesConfig();
    config['team-market']!.autoUpdate = false;
    saveKnownMarketplacesConfig(config);
    const replacementSource = {
      source: 'directory' as const,
      path: newSourceDir,
    };

    const marketplace = await replaceMarketplaceSource(
      'team-market',
      replacementSource,
    );

    expect(marketplace.metadata?.version).toBe('2.0.0');
    expect(loadKnownMarketplacesConfig()['team-market']).toMatchObject({
      source: replacementSource,
      installLocation: join(pluginHome, 'marketplaces', 'team-market'),
      autoUpdate: false,
    });
    clearMarketplacesCache();
    expect((await getMarketplace('team-market'))?.metadata?.version).toBe(
      '2.0.0',
    );
  });

  it('keeps the previous source and cache when source replacement fails', async () => {
    await useTempPluginHome();
    const oldSourceDir = await mkdtemp(
      join(tmpdir(), 'test-marketplace-old-src-'),
    );
    tmpDirs.push(oldSourceDir);
    await writeMarketplace(oldSourceDir, 'team-market', '1.0.0');
    const oldSource = {
      source: 'directory' as const,
      path: oldSourceDir,
    };
    await addMarketplaceSource('team-market', oldSource);

    await expect(
      replaceMarketplaceSource('team-market', {
        source: 'directory',
        path: join(oldSourceDir, 'missing'),
      }),
    ).rejects.toThrow();

    expect(loadKnownMarketplacesConfig()['team-market']?.source).toEqual(
      oldSource,
    );
    clearMarketplacesCache();
    expect((await getMarketplace('team-market'))?.metadata?.version).toBe(
      '1.0.0',
    );
  });
});

describe('resolveSubPathManifestPath', () => {
  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'test-subpath-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('prefers Qwen marketplace metadata in discovery and disk cache loading', async () => {
    const root = await useTempPluginHome();
    const dir = join(root, '中文 marketplace');
    await writeMarketplace(dir, 'legacy-market');
    await mkdir(join(dir, '.qwen-plugin'));
    await writeFile(
      join(dir, '.qwen-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'qwen-market',
        owner: { name: 'Test Owner' },
        plugins: [],
      }),
    );

    expect(await resolveSubPathManifestPath(root, '中文 marketplace')).toBe(
      join(dir, '.qwen-plugin', 'marketplace.json'),
    );
    await addMarketplaceSourceFromSource({ source: 'directory', path: dir });
    clearMarketplacesCache();
    expect((await getMarketplace('qwen-market'))?.name).toBe('qwen-market');
  });

  it('returns direct path when subPath ends in .json', async () => {
    const root = await makeTempDir();
    const claudeDir = join(root, '.claude-plugin');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'marketplace.json'), '{}');

    const result = await resolveSubPathManifestPath(
      root,
      '.claude-plugin/marketplace.json',
    );
    expect(result).toBe(join(root, '.claude-plugin', 'marketplace.json'));
  });

  it('handles case-insensitive .JSON suffix', async () => {
    const root = await makeTempDir();

    const result = await resolveSubPathManifestPath(
      root,
      'Plugin/MARKETPLACE.JSON',
    );
    expect(result).toBe(join(root, 'Plugin', 'MARKETPLACE.JSON'));
  });

  it('returns direct path when subPath resolves to an existing file', async () => {
    const root = await makeTempDir();
    const customFile = join(root, 'custom-manifest');
    await writeFile(customFile, '{}');

    const result = await resolveSubPathManifestPath(root, 'custom-manifest');
    expect(result).toBe(customFile);
  });

  it('falls back to convention discovery when subPath is a directory', async () => {
    const root = await makeTempDir();
    const subdir = join(root, 'subdir');
    const claudeDir = join(subdir, '.claude-plugin');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'marketplace.json'), '{}');

    const result = await resolveSubPathManifestPath(root, 'subdir');
    expect(result).toBe(join(subdir, '.claude-plugin', 'marketplace.json'));
  });

  it('prefers the current brand over .claude-plugin in directory fallback', async () => {
    const root = await makeTempDir();
    const subdir = join(root, 'subdir');
    await mkdir(join(subdir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await writeFile(join(subdir, BRAND_PLUGIN_META_DIR, 'marketplace.json'), '{}');
    await mkdir(join(subdir, '.claude-plugin'), { recursive: true });
    await writeFile(join(subdir, '.claude-plugin', 'marketplace.json'), '{}');

    const result = await resolveSubPathManifestPath(root, 'subdir');
    expect(result).toBe(join(subdir, BRAND_PLUGIN_META_DIR, 'marketplace.json'));
  });

  it('returns default path for nonexistent directory (clear error on read)', async () => {
    const root = await makeTempDir();

    const result = await resolveSubPathManifestPath(root, 'nonexistent');
    expect(result).toBe(
      join(root, 'nonexistent', '.qwen-plugin', 'marketplace.json'),
    );
  });

  it('resolves the canonical CC layout when path is ".claude-plugin"', async () => {
    const root = await makeTempDir();
    const claudeDir = join(root, '.claude-plugin');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'marketplace.json'), '{}');

    const result = await resolveSubPathManifestPath(root, '.claude-plugin');
    expect(result).toBe(join(root, '.claude-plugin', 'marketplace.json'));
  });

  it('returns a path that surfaces ENOENT cleanly when explicit .json file is missing', async () => {
    const root = await makeTempDir();

    const result = await resolveSubPathManifestPath(
      root,
      '.claude-plugin/marketplace.json',
    );
    expect(result).toBe(join(root, '.claude-plugin', 'marketplace.json'));
    // Verify the consumer-side readFile produces a meaningful ENOENT
    await expect(readFile(result, 'utf-8')).rejects.toThrow(/ENOENT/);
  });
});
