/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LoadedSettings,
  SettingScope,
  type MergedSettings,
  type Settings,
} from '@qwen-code/resource';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarketplaceInput } from '../parseMarketplaceInput.js';
import { clearAllPluginCaches } from '../refresh.js';
import {
  getInstalledPluginsForMarketplace,
  invalidateInstalledPluginsCache,
} from './installedPluginsManager.js';
import {
  addMarketplaceSourceFromSource,
  loadKnownMarketplacesConfig,
  removeMarketplaceSource,
} from './marketplaceManager.js';
import {
  addConfiguredMarketplace,
  removeConfiguredMarketplace,
} from './marketplaceOperations.js';
import { PluginManager } from './pluginManager.js';
import { createCorePluginManager } from './pluginManagerSettings.js';

vi.mock('../parseMarketplaceInput.js', () => ({
  parseMarketplaceInput: vi.fn(),
}));
vi.mock('../refresh.js', () => ({ clearAllPluginCaches: vi.fn() }));
vi.mock('./installedPluginsManager.js', () => ({
  getInstalledPluginsForMarketplace: vi.fn(),
  invalidateInstalledPluginsCache: vi.fn(),
}));
vi.mock('./marketplaceManager.js', () => ({
  addMarketplaceSourceFromSource: vi.fn(),
  loadKnownMarketplacesConfig: vi.fn(),
  removeMarketplaceSource: vi.fn(),
}));

const marketplace = 'demo-market';
const localSource = { source: 'directory', path: '/absolute/market' } as const;
const declaration = { source: 'owner/repo', type: 'github' };
const installedId = `one@${marketplace}`;
const excludedId = `host-owned@${marketplace}`;
const otherId = 'one@another-market';

function createSettings(
  user: Settings = {},
  project: Settings = {},
  local: Settings = {},
) {
  const file = (settings: Settings) => ({
    path: '',
    settings,
    originalSettings: structuredClone(settings),
  });
  return new LoadedSettings(
    {
      merge: () => ({}) as MergedSettings,
      runtimeValues: (settings) => settings,
      normalizeOriginal: () => {},
      resolveEnvironment: (settings) => settings,
      normalizeDisplaySettings: () => {},
      readFile: () => ({ settings: {}, originalSettings: {} }),
    },
    file(user),
    file(project),
    file(local),
    true,
  );
}

describe('configured marketplaces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadKnownMarketplacesConfig).mockReturnValue({
      [marketplace]: {
        source: localSource,
        installLocation: '/cache/market',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it.each([
    ['project', SettingScope.Project, ' ./市场 name ', './市场 name'],
    ['local', SettingScope.Local, '..\\市场 name', '..\\市场 name'],
    ['user', SettingScope.User, './市场 name', localSource.path],
  ] as const)(
    'persists the right source path in %s settings',
    async (scope, settingScope, input, path) => {
      vi.mocked(parseMarketplaceInput).mockResolvedValue(localSource);
      vi.mocked(addMarketplaceSourceFromSource).mockResolvedValue({
        name: marketplace,
        marketplace: { name: marketplace, plugins: [] },
        resolvedSource: localSource,
        alreadyMaterialized: true,
      });
      const settings = createSettings();
      const onProgress = vi.fn();

      await expect(
        addConfiguredMarketplace({
          settings,
          sourceInput: input,
          scope,
          onProgress,
        }),
      ).resolves.toEqual({ name: marketplace, alreadyMaterialized: true });

      expect(addMarketplaceSourceFromSource).toHaveBeenCalledWith(
        localSource,
        onProgress,
      );
      expect(
        settings.forScope(settingScope).settings.extraKnownMarketplaces,
      ).toEqual({
        [marketplace]: { source: { ...localSource, path } },
      });
      expect(clearAllPluginCaches).toHaveBeenCalledWith({
        clearOrphanExclusions: false,
      });
    },
  );

  it('removes only the selected declaration while the marketplace is declared elsewhere', async () => {
    vi.mocked(getInstalledPluginsForMarketplace).mockReturnValue({
      pluginIds: [installedId],
      orphanedPaths: [],
      installationCount: 1,
    });
    const settings = createSettings(
      { extraKnownMarketplaces: { [marketplace]: declaration } },
      {
        extraKnownMarketplaces: { [marketplace]: declaration },
        enabledPlugins: { [installedId]: true },
      },
    );

    await expect(
      removeConfiguredMarketplace({
        settings,
        name: marketplace,
        scope: 'project',
      }),
    ).resolves.toEqual({ kind: 'scope-only', scope: 'project', keptCount: 1 });

    expect(
      settings.project.settings.extraKnownMarketplaces?.[marketplace],
    ).toBeUndefined();
    expect(
      settings.user.settings.extraKnownMarketplaces?.[marketplace],
    ).toEqual(declaration);
    expect(settings.project.settings.enabledPlugins).toEqual({
      [installedId]: true,
    });
    expect(removeMarketplaceSource).not.toHaveBeenCalled();
    expect(invalidateInstalledPluginsCache).not.toHaveBeenCalled();
    expect(clearAllPluginCaches).toHaveBeenCalledWith({
      clearOrphanExclusions: false,
    });
  });

  it.each([undefined, 'user'] as const)(
    'fully removes the marketplace for scope %s',
    async (scope) => {
      vi.mocked(removeMarketplaceSource).mockResolvedValue({
        removedPluginIds: [installedId],
        orphanedPaths: [],
        skippedCacheRemoval: true,
      });
      const settings = createSettings(
        {
          extraKnownMarketplaces: { [marketplace]: declaration },
          enabledPlugins: { [installedId]: true, [excludedId]: true },
        },
        {
          ...(scope === undefined && {
            extraKnownMarketplaces: { [marketplace]: declaration },
          }),
          enabledPlugins: { [installedId]: false, [otherId]: true },
        },
        { enabledPlugins: { [installedId]: true, [otherId]: false } },
      );

      await expect(
        removeConfiguredMarketplace({
          settings,
          name: marketplace,
          scope,
        }),
      ).resolves.toEqual({
        kind: 'removed',
        removedCount: 1,
        skippedCacheRemoval: true,
      });

      expect(removeMarketplaceSource).toHaveBeenCalledWith(
        marketplace,
        expect.any(Function),
      );
      expect(
        settings.user.settings.extraKnownMarketplaces?.[marketplace],
      ).toBeUndefined();
      expect(
        settings.project.settings.extraKnownMarketplaces?.[marketplace],
      ).toBeUndefined();
      expect(settings.user.settings.enabledPlugins).toEqual({});
      expect(settings.project.settings.enabledPlugins).toEqual({
        [otherId]: true,
      });
      expect(settings.local.settings.enabledPlugins).toEqual({
        [otherId]: false,
      });
      expect(clearAllPluginCaches).toHaveBeenCalledWith({
        clearOrphanExclusions: false,
      });
      expect(invalidateInstalledPluginsCache).toHaveBeenCalledOnce();
    },
  );

  it('uses the manager exclusion for both installation cleanup and enabled settings', async () => {
    class ProductManager extends PluginManager {
      protected override isPluginExcluded(id: string): boolean {
        return (
          id === installedId || id === excludedId || super.isPluginExcluded(id)
        );
      }
    }
    const settings = createSettings({
      extraKnownMarketplaces: { [marketplace]: declaration },
      enabledPlugins: {
        [installedId]: true,
        [`ordinary@${marketplace}`]: true,
        [excludedId]: false,
      },
    });
    vi.mocked(removeMarketplaceSource).mockResolvedValueOnce({
      removedPluginIds: [`ordinary@${marketplace}`],
      orphanedPaths: [],
    });
    const manager = createCorePluginManager(settings, {
      factory: (host) => new ProductManager(host),
    });
    await manager.removeMarketplace({ settings, name: marketplace });
    expect(settings.user.settings.enabledPlugins).toEqual({
      [installedId]: true,
      [excludedId]: false,
    });
    const exclusion = vi.mocked(removeMarketplaceSource).mock.calls[0][1]!;
    expect(exclusion(installedId)).toBe(true);
    expect(exclusion(excludedId)).toBe(true);
    expect(exclusion(`ordinary@${marketplace}`)).toBe(false);
  });

  it('rejects a scope that has no declaration', async () => {
    const settings = createSettings({
      extraKnownMarketplaces: { [marketplace]: declaration },
    });

    await expect(
      removeConfiguredMarketplace({
        settings,
        name: marketplace,
        scope: 'project',
      }),
    ).rejects.toThrow('is not declared in project settings');
    expect(removeMarketplaceSource).not.toHaveBeenCalled();
    expect(clearAllPluginCaches).not.toHaveBeenCalled();
  });
});
