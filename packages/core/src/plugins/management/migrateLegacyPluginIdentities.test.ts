/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitLegacyMarketplaceAliases,
  discoverLegacyMarketplaceAliases,
  migrateInstalledPluginIds,
} from '../legacyPluginIdentityMigration.js';

import {
  SettingScope,
  type LoadedSettings,
  type Settings,
} from '@qwen-code/resource';
import { migrateLegacyPluginIdentities } from './migrateLegacyPluginIdentities.js';

vi.mock('../legacyPluginIdentityMigration.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../legacyPluginIdentityMigration.js')
    >();
  return {
    ...actual,
    discoverLegacyMarketplaceAliases: vi.fn(),
    migrateInstalledPluginIds: vi.fn(),
    commitLegacyMarketplaceAliases: vi.fn(),
  };
});

const aliases = {
  'thedotmack/claude-mem': 'thedotmack',
};

describe('migrateLegacyPluginIdentities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverLegacyMarketplaceAliases).mockResolvedValue(aliases);
    vi.mocked(migrateInstalledPluginIds).mockReturnValue({
      changed: true,
      success: true,
    });
    vi.mocked(commitLegacyMarketplaceAliases).mockReturnValue({
      changed: true,
      success: true,
    });
  });

  it('migrates every persisted settings reference before committing the marketplace key', async () => {
    const settings = createSettings({
      enabledPlugins: {
        'claude-mem@thedotmack/claude-mem': true,
        'kept@market': false,
      },
      pluginConfigs: {
        'claude-mem@thedotmack/claude-mem': {
          mcpServers: { server: { mode: 'compact' } },
        },
      },
      extraKnownMarketplaces: {
        'thedotmack/claude-mem': {
          source: 'thedotmack/claude-mem',
          type: 'github',
        },
      },
      blockedMarketplaces: ['safe-market', 'thedotmack/claude-mem'],
    });

    await expect(migrateLegacyPluginIdentities(settings)).resolves.toBe(true);

    expect(settings.merged.enabledPlugins).toEqual({
      'claude-mem@thedotmack': true,
      'kept@market': false,
    });
    expect(settings.merged.pluginConfigs).toEqual({
      'claude-mem@thedotmack': {
        mcpServers: { server: { mode: 'compact' } },
      },
    });
    expect(settings.merged.extraKnownMarketplaces).toEqual({
      thedotmack: {
        source: 'thedotmack/claude-mem',
        type: 'github',
      },
    });
    expect(settings.merged.blockedMarketplaces).toEqual([
      'safe-market',
      'thedotmack',
    ]);
    expect(commitLegacyMarketplaceAliases).toHaveBeenCalledWith(aliases);
  });

  it('keeps canonical settings values when legacy and canonical keys collide', async () => {
    const settings = createSettings({
      enabledPlugins: {
        'claude-mem@thedotmack/claude-mem': true,
        'claude-mem@thedotmack': false,
      },
      pluginConfigs: {
        'claude-mem@thedotmack/claude-mem': {
          mcpServers: { server: { source: 'legacy' } },
        },
        'claude-mem@thedotmack': {
          mcpServers: { server: { source: 'canonical' } },
        },
      },
    });

    await migrateLegacyPluginIdentities(settings);

    expect(settings.merged.enabledPlugins).toEqual({
      'claude-mem@thedotmack': false,
    });
    expect(settings.merged.pluginConfigs).toEqual({
      'claude-mem@thedotmack': {
        mcpServers: { server: { source: 'canonical' } },
      },
    });
  });

  it('does not rewrite settings or commit the marketplace if installed state cannot migrate', async () => {
    vi.mocked(migrateInstalledPluginIds).mockReturnValue({
      changed: false,
      success: false,
    });
    const settings = createSettings({
      enabledPlugins: {
        'claude-mem@thedotmack/claude-mem': true,
      },
    });

    await expect(migrateLegacyPluginIdentities(settings)).rejects.toThrow(
      'could not update installed plugin state',
    );
    expect(settings.merged.enabledPlugins).toEqual({
      'claude-mem@thedotmack/claude-mem': true,
    });
    expect(commitLegacyMarketplaceAliases).not.toHaveBeenCalled();
  });
});

function createSettings(userSettings: Settings): LoadedSettings {
  const scoped = {
    [SettingScope.User]: structuredClone(userSettings),
    [SettingScope.Project]: {} as Settings,
    [SettingScope.Local]: {} as Settings,
  };

  return {
    get merged() {
      return scoped[SettingScope.User];
    },
    forScope(scope) {
      return {
        settings:
          scoped[
            (scope[0].toUpperCase() + scope.slice(1)) as keyof typeof scoped
          ],
      };
    },
    mutateScope(scope, mutation) {
      const root = scoped[
        (scope[0].toUpperCase() + scope.slice(1)) as keyof typeof scoped
      ] as Record<string, unknown>;
      mutation({
        get(path) {
          const keys = typeof path === 'string' ? path.split('.') : [...path];
          return keys.reduce<unknown>(
            (current, key) =>
              current && typeof current === 'object'
                ? (current as Record<string, unknown>)[key]
                : undefined,
            root,
          );
        },
        set(path, value) {
          const key = typeof path === 'string' ? path : path[0];
          if (!key) return false;
          root[key] = value;
          return true;
        },
        delete(path) {
          const key = typeof path === 'string' ? path : path[0];
          if (!key) return false;
          return delete root[key];
        },
        update() {
          throw new Error('Not used by this test');
        },
      });
      return true;
    },
  } as LoadedSettings;
}
