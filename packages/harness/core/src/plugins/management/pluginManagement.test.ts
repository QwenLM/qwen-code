/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_CLI_BIN } from '../../config/brand.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope, type LoadedSettings } from '@qwen-code/resource';
import type { Config } from '../../config/config.js';
import type { LoadedPlugin } from '../types.js';
import type { PluginValidationReport } from '../validation/validatePlugin.js';
import { PluginManager, PluginManagerError } from './pluginManager.js';
import {
  addConfiguredMarketplace,
  removeConfiguredMarketplace,
} from './marketplaceOperations.js';
import {
  listKnownMarketplaces,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js';
import {
  createCorePluginManager,
  createPluginSettingsAccessor,
} from './pluginManagerSettings.js';

vi.mock('./marketplaceOperations.js', () => ({
  addConfiguredMarketplace: vi.fn(),
  removeConfiguredMarketplace: vi.fn(),
}));
vi.mock('./marketplaceManager.js', async (original) => ({
  ...(await original<typeof import('./marketplaceManager.js')>()),
  listKnownMarketplaces: vi.fn(() => []),
  loadKnownMarketplacesConfig: vi.fn(() => ({})),
}));
import {
  addMarketplaceForCommand,
  disableAllPluginsForCommand,
  formatPluginMutationMessage,
  formatPluginValidationReport,
  getPluginCommandError,
  inferPluginErrorCode,
  installPluginForCommand,
  listMarketplacesForCommand,
  listPluginsForCommand,
  normalizePluginScope,
  parseBooleanFlag,
  parsePluginArgs,
  parseScopeFlag,
  removeMarketplaceForCommand,
  setPluginEnabledForCommand,
  uninstallPluginForCommand,
  updatePluginForCommand,
  validatePluginReportForCommand,
  PluginCommandError,
} from './pluginManagement.js';

type ScopedSettings = {
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, unknown>;
};

function createSettings(args?: {
  merged?: Record<string, unknown>;
  scoped?: Partial<Record<SettingScope, ScopedSettings>>;
}) {
  const scoped = new Map<SettingScope, ScopedSettings>(
    Object.entries(args?.scoped ?? {}).map(([scope, value]) => [
      scope as SettingScope,
      value,
    ]),
  );
  const setValue = vi.fn(
    (scope: SettingScope, path: string | readonly string[], next: unknown) => {
      const keys = typeof path === 'string' ? path.split('.') : [...path];
      const root = structuredClone(scoped.get(scope) ?? {}) as Record<
        string,
        unknown
      >;
      let container = root;
      for (const key of keys.slice(0, -1)) {
        const current = container[key];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          container[key] = {};
        }
        container = container[key] as Record<string, unknown>;
      }
      const key = keys.at(-1);
      if (!key) return false;
      if (next === undefined) delete container[key];
      else container[key] = next;
      scoped.set(scope, root as ScopedSettings);
      return true;
    },
  );
  return {
    isTrusted: true,
    merged: {
      enabledPlugins: {},
      blockedMarketplaces: [],
      strictKnownMarketplaces: false,
      ...(args?.merged ?? {}),
    },
    forScope: (scope: SettingScope) => ({
      settings: scoped.get(scope) ?? {},
    }),
    setValue,
    deleteValue: (scope: SettingScope, path: readonly string[]) =>
      setValue(scope, path, undefined),
    mutateScope: (
      scope: SettingScope,
      mutation: (editor: {
        set: (path: readonly string[], value: unknown) => void;
        delete: (path: readonly string[]) => void;
      }) => void,
    ) => {
      mutation({
        set: (path, value) => {
          setValue(scope, path, value);
        },
        delete: (path) => {
          setValue(scope, path, undefined);
        },
      });
      return true;
    },
    scoped,
  } as unknown as LoadedSettings & {
    setValue: ReturnType<typeof vi.fn>;
    scoped: Map<SettingScope, ScopedSettings>;
  };
}

describe('plugin command adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks builtin writes through the product factory before changing settings or reloading', async () => {
    const settings = createSettings();
    const manager = createCorePluginManager(settings);
    const write = vi
      .spyOn(manager, 'setBuiltinEnabled')
      .mockReturnValueOnce({ ok: false, error: 'Excluded by the host' });
    const reloadPlugins = vi.fn();
    const plugin = {
      name: 'host-tool',
      source: 'builtin',
      isBuiltin: true,
    } as LoadedPlugin;
    const config = {
      getPlugins: () => [plugin],
      getPluginManagerFactory: () => () => manager,
      reloadPlugins,
    } as unknown as Config;
    await expect(
      setPluginEnabledForCommand({
        settings,
        config,
        plugin: 'host-tool',
        enabled: false,
      }),
    ).rejects.toThrow('Excluded by the host');
    expect(write).toHaveBeenCalledWith({
      pluginId: 'host-tool@builtin',
      enabled: false,
      loadedPlugins: [plugin],
    });
    expect(settings.setValue).not.toHaveBeenCalled();
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it('keeps builtin dependency writes on the product manager path', async () => {
    class ProductManager extends PluginManager {
      protected override isPluginExcluded(id: string): boolean {
        return id === 'host-owned@mp' || super.isPluginExcluded(id);
      }
    }
    const settings = createSettings({
      merged: {
        enabledPlugins: { 'root@builtin': false, 'host-owned@mp': false },
      },
    });
    const plugins = [
      {
        name: 'root',
        source: 'builtin',
        isBuiltin: true,
        enabled: false,
        manifest: { name: 'root', dependencies: ['host-owned@mp'] },
      },
      {
        name: 'host-owned',
        source: 'mp',
        enabled: false,
        manifest: { name: 'host-owned' },
      },
    ] as LoadedPlugin[];
    const reloadPlugins = vi.fn();
    const config = {
      getPlugins: () => plugins,
      getPluginManagerFactory:
        () => (host: ConstructorParameters<typeof PluginManager>[0]) =>
          new ProductManager(host),
      reloadPlugins,
    } as unknown as Config;
    await expect(
      setPluginEnabledForCommand({
        settings,
        config,
        plugin: 'root',
        enabled: true,
      }),
    ).rejects.toThrow('unsupported in this runtime');
    expect(settings.setValue).not.toHaveBeenCalled();
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'applies builtin enabled=%s without a marketplace installation',
    async (enabled) => {
      const plugin = {
        name: 'demo-builtin',
        source: 'builtin',
        repository: 'builtin',
        isBuiltin: true,
        enabled: !enabled,
        path: '/plugins/demo-builtin',
        manifest: { name: 'demo-builtin', version: '1' },
        mcpServers: { 'demo-builtin': { command: 'runtime' } },
      } as LoadedPlugin;
      const settings = createSettings({
        merged: { enabledPlugins: { 'demo-builtin@builtin': !enabled } },
      });
      const events: string[] = [];
      const stopPlugin = vi.fn(async () => {
        events.push('stop');
      });
      const startPlugin = vi.fn(async () => {
        events.push('start');
      });
      const reloadSkills = vi.fn(async () => {
        events.push('skills');
      });
      const config = {
        getPlugins: () => [plugin],
        getMcpClientManager: () => ({ stopPlugin, startPlugin }),
        reloadPlugins: vi.fn(async () => {
          events.push('reload');
          return { enabled: [{ ...plugin, enabled }], errors: [] };
        }),
        reloadSkills,
      } as unknown as Config;
      const installedToggle = vi.spyOn(PluginManager.prototype, 'setEnabled');
      await expect(
        setPluginEnabledForCommand({
          plugin: 'demo-builtin@builtin',
          enabled,
          settings,
          config,
        }),
      ).resolves.toContain(enabled ? 'enabled' : 'disabled');
      expect(installedToggle).not.toHaveBeenCalled();
      expect(settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        ['enabledPlugins', 'demo-builtin@builtin'],
        enabled,
      );
      expect(events).toEqual(
        enabled ? ['reload', 'skills', 'start'] : ['stop', 'reload', 'skills'],
      );
      expect(enabled ? startPlugin : stopPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'demo-builtin',
          id: 'demo-builtin@builtin',
        }),
      );
    },
  );

  it('reports a builtin MCP stop failure and keeps runtime state available for retry', async () => {
    const plugin = {
      name: 'demo-builtin',
      source: 'builtin',
      repository: 'builtin',
      isBuiltin: true,
      enabled: true,
      path: '/plugins/demo-builtin',
      manifest: { name: 'demo-builtin', version: '1' },
      mcpServers: { 'demo-builtin': { command: 'runtime' } },
    } as LoadedPlugin;
    const reloadPlugins = vi.fn();
    const config = {
      getPlugins: () => [plugin],
      reloadPlugins,
      getMcpClientManager: () => ({
        stopPlugin: vi.fn().mockRejectedValue(new Error('stop failed')),
      }),
    } as unknown as Config;
    await expect(
      setPluginEnabledForCommand({
        plugin: 'demo-builtin@builtin',
        enabled: false,
        settings: createSettings(),
        config,
      }),
    ).rejects.toThrow('stop failed');
    expect(reloadPlugins).not.toHaveBeenCalled();
    expect(plugin.enabled).toBe(true);
  });

  it('keeps structured Core errors available to command callers', () => {
    const pluginError = {
      type: 'manifest-parse-error' as const,
      source: 'market',
      plugin: 'demo',
      manifestPath: '/demo/plugin.json',
      parseError: 'invalid manifest',
    };
    const error = new PluginCommandError(pluginError);

    expect(error).toBeInstanceOf(PluginManagerError);
    expect(getPluginCommandError(error)).toEqual(pluginError);
    expect(inferPluginErrorCode(error)).toBe('plugin_manifest_invalid');
  });

  it('adapts merged and scoped settings without exposing LoadedSettings to Core', () => {
    const settings = createSettings({
      merged: {
        enabledPlugins: { 'demo@mp': true },
        blockedMarketplaces: ['Internal'],
        strictKnownMarketplaces: true,
      },
      scoped: {
        [SettingScope.Project]: {
          enabledPlugins: { 'project@mp': true },
          extraKnownMarketplaces: {
            mp: { source: { source: 'github', repo: 'owner/mp' } },
          },
        },
      },
    });
    const accessor = createPluginSettingsAccessor(settings);

    expect(accessor.getMergedSettings()).toEqual({
      enabledPlugins: { 'demo@mp': true },
      blockedMarketplaces: ['Internal'],
      strictKnownMarketplaces: true,
    });
    expect(accessor.getScopedEnabledPlugins('project')).toEqual({
      'project@mp': true,
    });
    expect(accessor.getScopedExtraKnownMarketplaces('project')).toEqual({
      mp: { source: { source: 'github', repo: 'owner/mp' } },
    });

    accessor.setPluginEnabled('local', 'local@mp', false);
    expect(settings.scoped.get(SettingScope.Local)?.enabledPlugins).toEqual({
      'local@mp': false,
    });
  });

  it('formats install results while Core owns installation', async () => {
    vi.spyOn(PluginManager.prototype, 'install').mockResolvedValue({
      pluginId: 'demo@mp',
      version: '1.2.3',
      installPath: '/plugins/demo',
      notices: [
        'Note: "demo@mp" is currently shadowed by organization-managed "demo@qoder-enterprise-acme". It will become active if the organization-managed plugin is removed.',
      ],
      runtimeReloadRequired: true,
    });

    const result = await installPluginForCommand({
      plugin: 'demo@mp',
      scope: 'user',
      settings: createSettings(),
    });

    expect(result).toEqual({
      message:
        'Plugin "demo@mp" installed successfully. Note: "demo@mp" is currently shadowed by organization-managed "demo@qoder-enterprise-acme". It will become active if the organization-managed plugin is removed.',
      runtimeReloadRequired: true,
      pluginId: 'demo@mp',
      version: '1.2.3',
      installPath: '/plugins/demo',
    });
  });

  it('formats uninstall, update, enable and disable-all results', async () => {
    vi.spyOn(PluginManager.prototype, 'uninstall').mockResolvedValue({
      pluginId: 'demo@mp',
      scope: 'user',
      fullyRemoved: false,
      reverseDependents: ['consumer@mp'],
      runtimeReloadRequired: true,
    });
    vi.spyOn(PluginManager.prototype, 'update').mockResolvedValue({
      pluginId: 'demo@mp',
      runtimeReloadRequired: true,
    });
    vi.spyOn(PluginManager.prototype, 'setEnabled').mockResolvedValue({
      pluginId: 'demo@mp',
      enabled: false,
      runtimeReloadRequired: true,
    });
    vi.spyOn(PluginManager.prototype, 'disableAll').mockResolvedValue({
      disabledCount: 2,
      skippedLocked: 1,
      runtimeReloadRequired: true,
    });
    const settings = createSettings();

    await expect(
      uninstallPluginForCommand({
        plugin: 'demo@mp',
        scope: 'user',
        settings,
      }),
    ).resolves.toMatchObject({
      message:
        'Plugin "demo@mp" removed from scope "user". Warning: required by consumer@mp.',
    });
    await expect(
      updatePluginForCommand({
        plugin: 'demo@mp',
        scope: 'user',
        settings,
      }),
    ).resolves.toBe(
      'Plugin "demo@mp" updated successfully. Run /plugins reload to apply.',
    );
    await expect(
      setPluginEnabledForCommand({
        plugin: 'demo@mp',
        enabled: false,
        settings,
      }),
    ).resolves.toBe('Plugin "demo@mp" disabled. Run /plugins reload to apply.');
    await expect(disableAllPluginsForCommand(settings)).resolves.toBe(
      'Disabled 2 plugin(s). Skipped 1 admin-enforced plugin(s). Run /plugins reload to apply.',
    );
  });

  it('keeps stale-setting disable output distinct from runtime reload output', async () => {
    vi.spyOn(PluginManager.prototype, 'setEnabled').mockResolvedValue({
      pluginId: 'missing@mp',
      enabled: false,
      staleSettingDisabled: true,
      runtimeReloadRequired: false,
    });

    await expect(
      setPluginEnabledForCommand({
        plugin: 'missing@mp',
        enabled: false,
        settings: createSettings(),
      }),
    ).resolves.toBe('Stale plugin setting "missing@mp" disabled.');
  });

  it('formats text and JSON list results returned by Core', async () => {
    vi.spyOn(PluginManager.prototype, 'list').mockResolvedValue({
      installed: [
        {
          id: 'demo@mp',
          name: 'demo',
          source: 'demo@mp',
          version: '1.2.3',
          scope: 'project',
          enabled: true,
          canDisable: true,
          projectPath: '/workspace/project',
          installPath: '/demo',
        },
      ],
      available: [
        {
          pluginId: 'other@mp',
          name: 'other',
          marketplaceName: 'mp',
          source: './other',
        },
      ],
      staleSettings: [],
      warnings: [],
    });
    const settings = createSettings();

    await expect(listPluginsForCommand({ settings })).resolves.toBe(
      'demo@mp v1.2.3\n  Scope: project\n  Status: enabled',
    );
    const json = await listPluginsForCommand({
      settings,
      json: true,
      available: true,
    });
    expect(JSON.parse(json)).toEqual({
      installed: [
        expect.objectContaining({
          id: 'demo@mp',
          enabled: true,
          projectPath: '/workspace/project',
        }),
      ],
      available: [expect.objectContaining({ pluginId: 'other@mp' })],
    });
  });

  it('preserves scoped plugin intent with a read-only SettingsService snapshot', () => {
    const settings = createSettings({
      merged: { enabledPlugins: { 'demo@mp': true } },
      scoped: {
        [SettingScope.Project]: { enabledPlugins: { 'demo@mp': true } },
      },
    });
    const snapshot = {
      isTrusted: true,
      merged: settings.merged,
      forScope: settings.forScope,
    };
    const manager = createCorePluginManager(snapshot);
    const accessor = createPluginSettingsAccessor(snapshot);
    expect(() =>
      accessor.setPluginEnabled('project', 'demo@mp', false),
    ).toThrow('read-only');
    expect(() =>
      accessor.patchScopedEnabledPlugins('project', { 'demo@mp': false }),
    ).toThrow('read-only');
    expect(
      manager.getStaleEnabledPluginSettings({ version: 2, plugins: {} }),
    ).toEqual([{ pluginId: 'demo@mp', scope: 'project' }]);
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'respects project trust for raw snapshot layers: %s',
    (isTrusted) => {
      const settings = createSettings({
        merged: { enabledPlugins: { 'demo@mp': true } },
        scoped: {
          [SettingScope.User]: { enabledPlugins: { 'demo@mp': true } },
          [SettingScope.Project]: {
            enabledPlugins: { 'demo@mp': true },
            extraKnownMarketplaces: {
              projectMarket: {
                source: { source: 'directory', path: '/project/market' },
              },
            },
          },
          [SettingScope.Local]: { enabledPlugins: { 'local@mp': true } },
        },
      });
      const snapshot = {
        isTrusted,
        merged: settings.merged,
        forScope: settings.forScope,
      };
      const accessor = createPluginSettingsAccessor(snapshot);
      const manager = createCorePluginManager(snapshot);
      expect(
        manager.getStaleEnabledPluginSettings({ version: 2, plugins: {} }),
      ).toEqual([
        { pluginId: 'demo@mp', scope: isTrusted ? 'project' : 'user' },
      ]);
      expect(accessor.getScopedEnabledPlugins('project')).toEqual(
        isTrusted ? { 'demo@mp': true } : {},
      );
      expect(
        Object.keys(accessor.getScopedExtraKnownMarketplaces('project')),
      ).toEqual(isTrusted ? ['projectMarket'] : []);
      expect(accessor.getScopedEnabledPlugins('local')).toEqual({
        'local@mp': true,
      });
      expect(
        settings.forScope(SettingScope.Project).settings.enabledPlugins,
      ).toEqual({ 'demo@mp': true });
    },
  );

  it('does not render settings-only plugin intent in the default list', async () => {
    vi.spyOn(PluginManager.prototype, 'list').mockResolvedValue({
      installed: [],
      staleSettings: [{ pluginId: 'foreign@unknown-market', scope: 'user' }],
      warnings: [],
    });

    await expect(
      listPluginsForCommand({ settings: createSettings() }),
    ).resolves.toBe(
      `No plugins installed. Use \`${BRAND_CLI_BIN} plugins install\` to install a plugin.`,
    );
  });

  it('delegates validation and keeps presentation in CLI', async () => {
    const report = {
      schemaVersion: 1,
      validator: { name: BRAND_CLI_BIN, version: 'test' },
      valid: true,
      target: { inputPath: '/plugins/demo', resolvedPath: '/plugins/demo' },
      plugin: { name: 'demo' },
      diagnostics: [],
      summary: { errorCount: 0, warningCount: 0, componentCount: 0 },
    } as PluginValidationReport;
    vi.spyOn(PluginManager.prototype, 'validate').mockResolvedValue(report);

    await expect(validatePluginReportForCommand('/plugins/demo')).resolves.toBe(
      report,
    );
    expect(formatPluginValidationReport(report)).toContain(
      'Plugin "demo" is valid and ready to install.',
    );
  });
});

describe('plugin command parsing', () => {
  it('normalizes scope and extracts command flags', () => {
    expect(normalizePluginScope(undefined)).toBe('user');
    expect(parseScopeFlag(['demo', '--scope', 'project'])).toEqual({
      scope: 'project',
      rest: ['demo'],
    });
    expect(parseBooleanFlag(['demo', '--json'], ['--json'])).toEqual({
      enabled: true,
      rest: ['demo'],
    });
    expect(parsePluginArgs('install demo')).toEqual(['install', 'demo']);
  });

  it('rejects unsupported scopes', () => {
    expect(() => normalizePluginScope('managed')).toThrow(
      'Valid scopes: user, project, local',
    );
  });

  it('adds the reload hint only for runtime mutations', () => {
    expect(
      formatPluginMutationMessage({
        message: 'Installed.',
        runtimeReloadRequired: true,
      }),
    ).toBe('Installed. Run /plugins reload to apply.');
    expect(
      formatPluginMutationMessage({
        message: 'Already current.',
        runtimeReloadRequired: false,
      }),
    ).toBe('Already current.');
  });
});

describe('marketplace commands retained in CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports an existing marketplace declaration in the requested scope', async () => {
    vi.mocked(addConfiguredMarketplace).mockResolvedValue({
      name: 'team-market',
      alreadyMaterialized: true,
    });
    const args = {
      settings: createSettings(),
      sourceInput: './market',
      scope: 'project' as const,
    };

    await expect(addMarketplaceForCommand(args)).resolves.toBe(
      'Marketplace "team-market" already exists. Declared in project settings.',
    );
    expect(addConfiguredMarketplace).toHaveBeenCalledWith(args);
  });

  it('reports retained plugins after removing a single scope declaration', async () => {
    vi.mocked(removeConfiguredMarketplace).mockResolvedValue({
      kind: 'scope-only',
      scope: 'project',
      keptCount: 1,
    });
    const args = {
      settings: createSettings(),
      name: 'team-market',
      scope: 'project' as const,
    };

    await expect(removeMarketplaceForCommand(args)).resolves.toBe(
      'Marketplace "team-market" removed from project settings. It is still declared elsewhere, so 1 installed plugin was kept. Run /plugins reload to apply.',
    );
    expect(removeConfiguredMarketplace).toHaveBeenCalledWith({
      ...args,
      isPluginExcluded: expect.any(Function),
    });
  });

  it('reports uninstall impact when removing a marketplace', async () => {
    vi.mocked(removeConfiguredMarketplace).mockResolvedValue({
      kind: 'removed',
      removedCount: 2,
      skippedCacheRemoval: false,
    });

    await expect(
      removeMarketplaceForCommand({
        settings: createSettings(),
        name: 'team-market',
      }),
    ).resolves.toBe(
      'Marketplace "team-market" removed. Uninstalled 2 installed plugins from it; plugin caches were marked orphaned. Run /plugins reload to apply.',
    );
  });

  it('filters blocked marketplaces from list output', () => {
    vi.mocked(listKnownMarketplaces).mockReturnValue(['visible', 'blocked']);
    vi.mocked(loadKnownMarketplacesConfig).mockReturnValue({
      visible: {
        source: { source: 'directory', path: '/visible' },
        installLocation: '/cache/visible',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
      blocked: {
        source: { source: 'directory', path: '/blocked' },
        installLocation: '/cache/blocked',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    });
    const settings = createSettings({
      merged: { blockedMarketplaces: ['BLOCKED'] },
    });

    expect(listMarketplacesForCommand(settings.merged)).toContain('visible');
    expect(listMarketplacesForCommand(settings.merged)).not.toContain(
      'blocked\n',
    );
  });
});
