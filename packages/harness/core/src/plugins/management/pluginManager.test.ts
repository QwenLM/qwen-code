/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin } from '../types.js';
import type { InstalledPluginsState } from './installedPluginsManager.js';
import type {
  PluginManagementScope,
  PluginManagerSettingsStore,
} from './pluginManager.js';

const state = vi.hoisted(() => ({
  installed: { version: 2, plugins: {} } as InstalledPluginsState,
  manifests: {} as Record<string, unknown[]>,
}));

const operationMocks = vi.hoisted(() => ({
  installLocalPluginOp: vi.fn(),
  installPluginOp: vi.fn(),
  uninstallPluginOp: vi.fn(),
  updatePluginOp: vi.fn(),
}));

const marketplaceMocks = vi.hoisted(() => ({
  getMarketplace: vi.fn(),
  getPluginById: vi.fn(),
  getPluginByIdCacheOnly: vi.fn(),
  listKnownMarketplaces: vi.fn<() => string[]>(() => []),
  loadKnownMarketplacesConfig: vi.fn(() => ({})),
}));

const dependencyMocks = vi.hoisted(() => ({
  autoInstallDependencies: vi.fn(),
}));

const enableMocks = vi.hoisted(() => ({
  setPluginEnabledOp: vi.fn(),
}));

const loaderMocks = vi.hoisted(() => ({
  loadAllPlugins: vi.fn(),
  loadPluginFromDirectory: vi.fn(),
}));


const reconcileMocks = vi.hoisted(() => ({
  reconcilePluginsForStartup: vi.fn(),
}));

vi.mock('./installedPluginsManager.js', () => ({
  getManagedShadowedNames: vi.fn(() => new Set<string>()),
  invalidateInstalledPluginsCache: vi.fn(),
  refreshPluginDisplayName: vi.fn(),
  isManagedLocked: vi.fn(
    (entry: { userCanDisable?: boolean; userVisible?: boolean }) =>
      entry.userCanDisable === false || entry.userVisible === false,
  ),
  isPluginInstalled: vi.fn(
    (pluginId: string) =>
      (state.installed.plugins[pluginId]?.length ?? 0) > 0,
  ),
  isPluginInstalledForCwd: vi.fn((pluginId: string, cwd: string) => {
    const entries = state.installed.plugins[pluginId];
    if (!entries || entries.length === 0) return false;
    return entries.some((entry: { scope: string; projectPath?: string }) => {
      if (entry.scope !== 'project' && entry.scope !== 'local') return true;
      if (!entry.projectPath) return true;
      return (
        cwd === entry.projectPath || cwd.startsWith(entry.projectPath + '/')
      );
    });
  }),
  isPluginUserVisibleInList: vi.fn(
    (entry: { userVisible?: boolean }) => entry.userVisible !== false,
  ),
  loadInstalledPluginsFromDisk: vi.fn(() => state.installed),
  loadInstalledPluginsFresh: vi.fn(() => state.installed),
}));

vi.mock('./pluginOperations.js', () => operationMocks);
vi.mock('./marketplaceManager.js', () => marketplaceMocks);
vi.mock('./pluginEnableDisable.js', () => enableMocks);
vi.mock('../pluginLoader.js', () => loaderMocks);
vi.mock('../headlessPluginInstall.js', () => reconcileMocks);
vi.mock('../loading/pluginResourceCollector.js', () => ({
  collectPluginResources: vi.fn(),
}));
vi.mock('../validation/validatePlugin.js', () => ({
  validatePlugin: vi.fn(),
}));
vi.mock('./pluginDependencies.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pluginDependencies.js')>();
  return {
    ...actual,
    autoInstallDependencies: dependencyMocks.autoInstallDependencies,
  };
});

import {
  PluginManager,
  PluginManagerError,
  selectDisableAllCandidates,
} from './pluginManager.js';

function createPlugin(id: string, dependencies: unknown[] = []): LoadedPlugin {
  const [name, source = 'local'] = id.split('@');
  return {
    name,
    source,
    repository: source,
    path: `/${id}`,
    enabled: true,
    manifest: {
      name,
      version: '1.0.0',
      ...(dependencies.length > 0 ? { dependencies } : {}),
    },
  } as LoadedPlugin;
}

function createSettings(
  initial: Partial<Record<PluginManagementScope, Record<string, boolean>>> = {},
  marketplaces: Partial<
    Record<
      PluginManagementScope,
      Record<string, { source: unknown }>
    >
  > = {},
): PluginManagerSettingsStore & {
  records: Record<PluginManagementScope, Record<string, boolean>>;
} {
  const records = {
    user: { ...(initial.user ?? {}) },
    project: { ...(initial.project ?? {}) },
    local: { ...(initial.local ?? {}) },
  };
  const merged = () => ({
    ...records.user,
    ...records.project,
    ...records.local,
  });
  const settings = {
    records,
    getEnabledPlugins: () =>
      Object.entries(merged())
        .filter(([, enabled]) => enabled)
        .map(([id]) => id),
    getDisabledPlugins: () =>
      Object.entries(merged())
        .filter(([, enabled]) => !enabled)
        .map(([id]) => id),
    getPluginsSettings: () => ({}),
    setPluginEnabled: (
      scope: PluginManagementScope,
      pluginId: string,
      enabled: boolean,
    ) => {
      records[scope][pluginId] = enabled;
      return true;
    },
    getMergedSettings: () => ({ enabledPlugins: merged() }),
    getScopedEnabledPlugins: (scope: PluginManagementScope) => records[scope],
    getScopedExtraKnownMarketplaces: (scope: PluginManagementScope) =>
      marketplaces[scope] ?? {},
    patchScopedEnabledPlugins: (
      scope: PluginManagementScope,
      patch: Record<string, boolean | undefined>,
    ) => {
      for (const [id, value] of Object.entries(patch)) {
        if (value === undefined) delete records[scope][id];
        else records[scope][id] = value;
      }
      return true;
    },
  };
  return settings;
}

function createManager(args?: {
  settings?: PluginManagerSettingsStore;
  installRemotePluginZip?: ReturnType<typeof vi.fn>;
}) {
  return new PluginManager({
    settings: args?.settings ?? createSettings(),
    cwd: '/workspace/project',
    installRemotePluginZip: args?.installRemotePluginZip,
  });
}

describe('PluginManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.installed = { version: 2, plugins: {} };
    state.manifests = {};

    loaderMocks.loadAllPlugins.mockResolvedValue({
      enabled: [],
      disabled: [],
      errors: [],
    });
    loaderMocks.loadPluginFromDirectory.mockImplementation(
      async (_path, source, _repository, options) => {
        const id = `${options?.nameOverride ?? 'unknown'}@${source}`;
        return {
          ok: true,
          plugin: createPlugin(id, state.manifests[id]),
        };
      },
    );

    reconcileMocks.reconcilePluginsForStartup.mockResolvedValue({
      changed: false,
      marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
      plugins: { installed: [], failed: [], missing: [] },
    });
    marketplaceMocks.getMarketplace.mockImplementation(async (name) => ({
      name,
      plugins: [],
      ...(name === 'root-mp'
        ? { allowCrossMarketplaceDependenciesOn: ['dep-mp'] }
        : {}),
    }));
    marketplaceMocks.getPluginById.mockImplementation(async (pluginId) => {
      const [name, marketplace] = pluginId.split('@');
      if (!marketplace || !(pluginId in state.manifests)) return null;
      return {
        entry: {
          name,
          source: `./${pluginId}`,
          dependencies: state.manifests[pluginId],
        },
        marketplaceName: marketplace,
        marketplaceSource: { source: 'directory', path: `/mp/${marketplace}` },
        marketplaceInstallLocation: `/mp/${marketplace}`,
      };
    });
    marketplaceMocks.getPluginByIdCacheOnly.mockResolvedValue(null);
    operationMocks.installPluginOp.mockImplementation(async (pluginId) => {
      state.installed.plugins[pluginId] = [
        { scope: 'user', installPath: `/${pluginId}` },
      ];
      return {
        ok: true,
        pluginId,
        plugin: createPlugin(pluginId, state.manifests[pluginId]),
        installPath: `/${pluginId}`,
        marketplace: pluginId.split('@')[1],
      };
    });
    enableMocks.setPluginEnabledOp.mockImplementation(
      (pluginId, enabled, settings, options) => {
        settings.setPluginEnabled(options?.scope ?? 'user', pluginId, enabled);
        return { ok: true, pluginId, enabled };
      },
    );
  });

  it('filters marketplace browsing through the manager without changing the cached manifest', async () => {
    const manifest = {
      name: 'host-market',
      plugins: [{ name: 'host-owned' }, { name: 'ordinary' }],
    };
    marketplaceMocks.getMarketplace.mockResolvedValueOnce(manifest);
    class ProductManager extends PluginManager {
      protected override isPluginExcluded(id: string) {
        return id === 'host-owned@host-market';
      }
    }
    const result = await new ProductManager({
      settings: createSettings(),
      cwd: '/workspace',
    }).getMarketplacePlugins('host-market');
    expect(result?.plugins).toEqual([{ name: 'ordinary' }]);
    expect(manifest.plugins).toHaveLength(2);
  });

  it('uses a product manager exclusion for discovery and background candidates', async () => {
    class ProductManager extends PluginManager {
      protected override isPluginExcluded(id: string) {
        return id === 'host-owned@mp' || super.isPluginExcluded(id);
      }
    }
    const entry = {
      scope: 'user' as const,
      installPath: '/cache/plugin',
      version: '1',
    };
    state.installed.plugins = {
      'host-owned@mp': [entry],
      'ordinary@mp': [entry],
      'managed@mp': [{ ...entry, scope: 'managed' }],
    };
    marketplaceMocks.getMarketplace.mockResolvedValueOnce({
      name: 'mp',
      plugins: [{ name: 'host-owned' }, { name: 'ordinary' }],
    });
    const manager = new ProductManager({
      settings: createSettings(),
      cwd: '/workspace',
    });
    expect((await manager.getMarketplacePlugins('mp'))?.plugins).toEqual([
      { name: 'ordinary' },
    ]);
    expect(
      manager.collectAutoUpdateCandidates({ enabled: true }, new Set(['mp'])),
    ).toEqual([{ pluginId: 'ordinary@mp', entry }]);
  });

  it('updates the installation project and scope without preparing interactive authentication', async () => {
    const manager = createManager();
    const prepare = vi.spyOn(
      manager as unknown as { prepareOperation(): Promise<void> },
      'prepareOperation',
    );
    marketplaceMocks.getPluginById.mockResolvedValueOnce({
      entry: { version: '2' },
    });
    operationMocks.updatePluginOp.mockResolvedValueOnce({
      ok: true,
      version: '2',
    });
    const result = await manager.checkAndUpdatePlugin({
      pluginId: 'ordinary@mp',
      entry: {
        scope: 'project',
        projectPath: '/another/项目 with spaces',
        installPath: '/cache/ordinary',
        version: '1',
      },
    });
    expect(operationMocks.updatePluginOp).toHaveBeenCalledWith(
      'ordinary@mp',
      'project',
      {
        projectPath: '/another/项目 with spaces',
      },
    );
    expect(result).toMatchObject({
      updated: true,
      scope: 'project',
      projectPath: '/another/项目 with spaces',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('skips excluded background work and rejects builtin writes before changing settings', async () => {
    class ProductManager extends PluginManager {
      protected override isPluginExcluded(id: string) {
        return id === 'host-owned@host-market';
      }
    }
    const manager = new ProductManager({
      settings: createSettings(),
      cwd: '/workspace',
    });
    const pluginId = 'host-owned@host-market';
    await expect(
      manager.checkAndUpdatePlugin({
        pluginId,
        entry: { scope: 'user', installPath: '/ide/security' },
      }),
    ).resolves.toBeNull();
    expect(marketplaceMocks.getPluginById).not.toHaveBeenCalled();
    expect(() =>
      manager.setBuiltinEnabled({
        pluginId,
        enabled: false,
        loadedPlugins: [],
      }),
    ).toThrow('unsupported in this runtime');
    expect(enableMocks.setPluginEnabledOp).not.toHaveBeenCalled();
    expect(operationMocks.updatePluginOp).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves existing installed hook warnings only when enabled=%s',
    async (enabled) => {
      state.installed.plugins = {
        'broken@mp': [{ scope: 'user', installPath: '/broken' }],
      };
      const plugin = createPlugin('broken@mp');
      const warning = {
        type: 'component-load-failed' as const,
        component: 'hooks' as const,
        plugin: 'broken',
        source: 'mp',
        path: '/broken/hooks/hooks.json',
        reason: 'Invalid JSON',
      };
      plugin.warnings = [warning];
      loaderMocks.loadPluginFromDirectory.mockResolvedValueOnce({
        ok: true,
        plugin,
      });
      const settings = createSettings({ user: { 'broken@mp': enabled } });
      const result = await createManager({ settings }).loadSessionPlugins();
      expect(result.errors).toEqual(enabled ? [warning] : []);
    },
  );

  it('loads explicit and configured installed plugins for a session', async () => {
    const flagPlugin = createPlugin('flagged@flag');
    loaderMocks.loadAllPlugins.mockResolvedValueOnce({
      enabled: [flagPlugin],
      disabled: [],
      errors: [],
    });
    state.installed.plugins = {
      'enabled@mp': [{ scope: 'user', installPath: '/enabled' }],
      'disabled@mp': [{ scope: 'user', installPath: '/disabled' }],
      'cached-only@mp': [{ scope: 'user', installPath: '/cached-only' }],
      'flagged@mp': [{ scope: 'user', installPath: '/shadowed' }],
      'demo-plugin@demo-market': [
        { scope: 'user', installPath: '/create-plugin' },
      ],
      'host-owned@host-market': [{ scope: 'user', installPath: '/host-owned' }],
    };
    const settings = createSettings({
      user: {
        'enabled@mp': true,
        'disabled@mp': false,
        'flagged@mp': true,
        'demo-plugin@demo-market': true,
        'host-owned@host-market': true,
      },
    });

    const result = await createManager({ settings }).loadSessionPlugins({
      pluginDirs: ['./plugins/flagged'],
    });

    expect(loaderMocks.loadAllPlugins).toHaveBeenCalledWith(
      ['/workspace/project/plugins/flagged'],
      'flag',
      'local',
    );
    expect(
      result.plugins.map(
        (plugin) => `${plugin.name}@${plugin.source}:${plugin.enabled}`,
      ),
    ).toEqual([
      'flagged@flag:true',
      'enabled@mp:true',
      'disabled@mp:false',
      'demo-plugin@demo-market:true',
      'host-owned@host-market:true',
    ]);
    expect(
      loaderMocks.loadPluginFromDirectory.mock.calls.map(([path]) => path),
    ).toEqual(['/enabled', '/disabled', '/create-plugin', '/host-owned']);
    expect(result.errors).toEqual([]);
  });

  // daemon 路由的 root 加载要求「这次加载不碰登录态」：企业插件的加载会触发 lazy auth
  // init，而 daemon 的身份要等宿主握手帧才到（见 PluginSessionLoadOptions.skipAdditionalPlugins）。

  it('loads enabled local marketplace plugins in place without an installation record', async () => {
    const settings = createSettings({
      project: { 'local-plugin@local-market': true },
    });
    marketplaceMocks.getPluginByIdCacheOnly.mockResolvedValue({
      entry: {
        name: 'local-plugin',
        source: '/marketplaces/local-market/plugins/local-plugin',
      },
      marketplaceName: 'local-market',
      marketplaceSource: {
        source: 'directory',
        path: '/marketplaces/local-market',
      },
      marketplaceInstallLocation: '/marketplaces/local-market',
    });

    const manager = createManager({ settings });
    const result = await manager.loadSessionPlugins();

    expect(loaderMocks.loadPluginFromDirectory).toHaveBeenCalledWith(
      '/marketplaces/local-market/plugins/local-plugin',
      'local-market',
      'local-market',
      { nameOverride: 'local-plugin' },
    );
    expect(result.plugins).toEqual([
      expect.objectContaining({
        name: 'local-plugin',
        source: 'local-market',
        enabled: true,
      }),
    ]);

    const listed = await manager.list();
    expect(listed.installed).toEqual([
      expect.objectContaining({
        id: 'local-plugin@local-market',
        scope: 'project',
        installPath: '/local-plugin@local-market',
      }),
    ]);
    expect(listed.staleSettings).toEqual([]);
  });

  it('applies marketplace policy and dependency demotion during session loading', async () => {
    state.installed.plugins = {
      'consumer@known': [{ scope: 'user', installPath: '/consumer' }],
      'blocked@blocked-mp': [{ scope: 'user', installPath: '/blocked' }],
      'unknown@unknown-mp': [{ scope: 'user', installPath: '/unknown' }],
    };
    state.manifests['consumer@known'] = ['missing@known'];
    marketplaceMocks.listKnownMarketplaces.mockReturnValue(['known']);
    const settings = createSettings({
      user: {
        'consumer@known': true,
        'blocked@blocked-mp': true,
        'unknown@unknown-mp': true,
      },
    });
    vi.spyOn(settings, 'getMergedSettings').mockReturnValue({
      enabledPlugins: settings.getMergedSettings().enabledPlugins,
      blockedMarketplaces: ['blocked-mp'],
      strictKnownMarketplaces: true,
    });

    const result = await createManager({ settings }).loadSessionPlugins();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      name: 'consumer',
      source: 'known',
      enabled: false,
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: 'dependency-unsatisfied',
        plugin: 'consumer',
        dependency: 'missing@known',
      }),
    ]);
    expect(loaderMocks.loadPluginFromDirectory).toHaveBeenCalledTimes(1);
  });

  it('does not declare built-in marketplaces by default', async () => {
    await createManager().reconcileInstalledState();

    expect(reconcileMocks.reconcilePluginsForStartup).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMarketplaces: {} }),
    );
  });

  it('builds startup reconciliation options from the host settings', async () => {
    const settings = createSettings(
      {
        user: { 'enabled@mp': true, 'disabled@mp': false },
        project: { legacy: true },
      },
      {
        user: {
          mp: { source: { source: 'github', repo: 'owner/repo' } },
        },
      },
    );
    const getMergedSettings = vi
      .spyOn(settings, 'getMergedSettings')
      .mockImplementation(() => ({
        enabledPlugins: {
          ...settings.records.user,
          ...settings.records.project,
          ...settings.records.local,
        },
        blockedMarketplaces: ['BLOCKED'],
        strictKnownMarketplaces: true,
        extraKnownMarketplaces: {
          mp: { source: { source: 'github', repo: 'owner/repo' } },
        },
      }));

    await createManager({ settings }).reconcileInstalledState({
      sessionId: 'session-1',
    });

    expect(reconcileMocks.reconcilePluginsForStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMarketplaces: {
          mp: {
            name: 'mp',
            source: { source: 'github', repo: 'owner/repo' },
          },
        },
        enabledPluginIds: ['enabled@mp', 'legacy'],
        disabledPluginIds: ['disabled@mp'],
        scope: 'user',
        projectPath: '/workspace/project',
        blockedMarketplaces: ['blocked'],
        strictKnownMarketplaces: true,
        sessionId: 'session-1',
        getPluginScope: expect.any(Function),
      }),
    );
    const options = reconcileMocks.reconcilePluginsForStartup.mock.calls[0][0];
    expect(options.getPluginScope('enabled@mp')).toBe('user');
    expect(options.getPluginScope('legacy@mp')).toBe('project');
    expect(getMergedSettings).toHaveBeenCalled();
  });

  it('excludes project marketplace declarations from headless reconciliation', async () => {
    const settings = createSettings(
      { user: { 'enabled@user-market': true } },
      {
        user: {
          'user-market': {
            source: { source: 'github', repo: 'owner/user-market' },
          },
        },
        project: {
          'project-market': {
            source: { source: 'github', repo: 'owner/project-market' },
          },
        },
        local: {
          'local-market': {
            source: { source: 'directory', path: '/local-market' },
          },
        },
      },
    );

    await createManager({ settings }).reconcileInstalledState({
      includeProjectMarketplaces: false,
    });

    expect(reconcileMocks.reconcilePluginsForStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMarketplaces: {
          'user-market': {
            name: 'user-market',
            source: { source: 'github', repo: 'owner/user-market' },
          },
          'local-market': {
            name: 'local-market',
            source: { source: 'directory', path: '/local-market' },
          },
        },
      }),
    );
  });

  it('reconciles a user-declared URL marketplace', async () => {
    const settings = createSettings(
      {},
      {
        user: {
          'custom-market': {
            source: { source: 'url', url: 'https://mirror.example/m.json' },
          },
        },
      },
    );

    await createManager({ settings }).reconcileInstalledState({
      includeProjectMarketplaces: false,
    });

    expect(reconcileMocks.reconcilePluginsForStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMarketplaces: {
          'custom-market': {
            name: 'custom-market',
            source: { source: 'url', url: 'https://mirror.example/m.json' },
          },
        },
      }),
    );
  });

  it('preflights the full dependency closure before installing', async () => {
    state.manifests = {
      'root@root-mp': ['dep@dep-mp'],
      'dep@dep-mp': ['leaf@leaf-mp'],
      'leaf@leaf-mp': [],
    };

    await expect(
      createManager().install({ plugin: 'root@root-mp', scope: 'user' }),
    ).rejects.toThrow(/not allowed by the root marketplace/);
    expect(operationMocks.installPluginOp).not.toHaveBeenCalled();
  });

  it('installs marketplace dependencies before the root plugin', async () => {
    state.manifests = {
      'root@root-mp': ['dep@dep-mp'],
      'dep@dep-mp': [],
    };
    const settings = createSettings();

    const result = await createManager({ settings }).install({
      plugin: 'root@root-mp',
      scope: 'user',
    });

    expect(operationMocks.installPluginOp.mock.calls.map(([id]) => id)).toEqual([
      'dep@dep-mp',
      'root@root-mp',
    ]);
    expect(result.pluginId).toBe('root@root-mp');
    expect(settings.records.user).toEqual({
      'dep@dep-mp': true,
      'root@root-mp': true,
    });
  });

  it('preserves structured plugin operation errors', async () => {
    state.manifests = { 'root@root-mp': [] };
    const pluginError = {
      type: 'manifest-parse-error' as const,
      source: 'root-mp',
      plugin: 'root',
      manifestPath: '/root/plugin.json',
      parseError: 'invalid manifest',
    };
    operationMocks.installPluginOp.mockResolvedValueOnce({
      ok: false,
      error: pluginError,
    });

    await expect(
      createManager().install({ plugin: 'root@root-mp', scope: 'user' }),
    ).rejects.toMatchObject({ pluginError });
    await expect(
      Promise.reject(new PluginManagerError(pluginError)),
    ).rejects.toBeInstanceOf(PluginManagerError);
  });

  it('routes remote ZIP transport through the host adapter', async () => {
    const settings = createSettings();
    const installRemotePluginZip = vi.fn(async () => {
      state.installed.plugins['demo@local'] = [
        { scope: 'user', installPath: '/plugins/demo' },
      ];
      return {
        ok: true as const,
        pluginId: 'demo@local',
        plugin: createPlugin('demo@local'),
        installPath: '/plugins/demo',
        marketplace: 'local',
      };
    });

    const result = await createManager({
      settings,
      installRemotePluginZip,
    }).install({ plugin: 'https://example.test/demo.zip', scope: 'user' });

    expect(installRemotePluginZip).toHaveBeenCalledWith(
      'https://example.test/demo.zip',
      'user',
      { projectPath: undefined },
    );
    expect(operationMocks.installPluginOp).not.toHaveBeenCalled();
    expect(result.pluginId).toBe('demo@local');
  });

  it('rejects remote ZIP installation when the host omits the installer', async () => {
    await expect(
      createManager().install({
        plugin: 'https://example.test/demo.zip',
        scope: 'user',
      }),
    ).rejects.toThrow('Remote plugin ZIP installation is unavailable.');
  });

  it('resolves relative local plugin paths against the host cwd', async () => {
    operationMocks.installLocalPluginOp.mockImplementation(async (pluginPath) => {
      state.installed.plugins['demo@local'] = [
        { scope: 'user', installPath: pluginPath },
      ];
      return {
        ok: true,
        pluginId: 'demo@local',
        plugin: createPlugin('demo@local'),
        installPath: pluginPath,
        marketplace: 'local',
      };
    });

    await createManager().install({ plugin: './demo', scope: 'user' });

    expect(operationMocks.installLocalPluginOp).toHaveBeenCalledWith(
      '/workspace/project/demo',
      'user',
      { projectPath: undefined },
    );
  });

  it('reports display-name ambiguity across scopes just like original names', () => {
    state.installed.plugins['user@mp'] = [{
      scope: 'user', installPath: '/user', displayName: '中文插件',
    }];
    state.installed.plugins['project@mp'] = [{
      scope: 'project', installPath: '/project', displayName: '中文插件',
      projectPath: '/workspace/project',
    }];
    expect(() => createManager().resolvePluginId('中文插件')).toThrow(
      'Use one of: user@mp, project@mp',
    );
  });

  it('uninstalls an unconfigured plugin by its Chinese display name', async () => {
    state.installed.plugins['demo@mp'] = [
      { scope: 'user', installPath: '/demo', displayName: '中文插件' },
    ];
    loaderMocks.loadPluginFromDirectory.mockResolvedValue({
      ok: true,
      plugin: { ...createPlugin('demo@mp'), displayName: '中文插件' },
    });
    operationMocks.uninstallPluginOp.mockResolvedValue({
      ok: true,
      pluginId: 'demo@mp',
      fullyRemoved: true,
    });

    await createManager().uninstall({ plugin: '中文插件', scope: 'user' });

    expect(operationMocks.uninstallPluginOp).toHaveBeenCalledWith(
      'demo@mp',
      'user',
      expect.any(Object),
    );
  });

  it('prefers the original name over a matching display name', async () => {
    for (const name of ['demo', 'other']) {
      state.installed.plugins[`${name}@mp`] = [
        { scope: 'user', installPath: `/${name}`, displayName: '中文插件' },
      ];
    }
    loaderMocks.loadPluginFromDirectory.mockImplementation(
      async (_path, source, _repository, options) => ({
        ok: true,
        plugin: {
          ...createPlugin(`${options.nameOverride}@${source}`),
          displayName: 'demo',
        },
      }),
    );
    operationMocks.uninstallPluginOp.mockResolvedValue({
      ok: true,
      pluginId: 'demo@mp',
      fullyRemoved: true,
    });

    await createManager().uninstall({ plugin: 'demo', scope: 'user' });

    expect(operationMocks.uninstallPluginOp).toHaveBeenCalledWith(
      'demo@mp',
      'user',
      expect.any(Object),
    );
  });

  it('rejects ambiguous display names without uninstalling', async () => {
    for (const name of ['first', 'second']) {
      state.installed.plugins[`${name}@mp`] = [
        { scope: 'user', installPath: `/${name}`, displayName: '中文插件' },
      ];
    }
    loaderMocks.loadPluginFromDirectory.mockImplementation(
      async (_path, source, _repository, options) => ({
        ok: true,
        plugin: {
          ...createPlugin(`${options.nameOverride}@${source}`),
          displayName: '中文插件',
        },
      }),
    );

    await expect(
      createManager().uninstall({
        plugin: '中文插件',
        scope: 'user',
      }),
    ).rejects.toThrow('Use one of: first@mp, second@mp');
    expect(operationMocks.uninstallPluginOp).not.toHaveBeenCalled();
  });

  it('resolves persisted display names without loading plugin files', () => {
    state.installed.plugins['demo@mp'] = [{
      scope: 'project', installPath: '/demo', projectPath: '/another/project',
      displayName: '中文插件',
    }];
    expect(createManager().resolvePluginId('中文插件')).toBe('demo@mp');
    expect(loaderMocks.loadPluginFromDirectory).not.toHaveBeenCalled();
  });

  it('removes desired-state entries only after a full uninstall', async () => {
    state.installed.plugins['demo@mp'] = [
      { scope: 'user', installPath: '/demo' },
    ];
    const settings = createSettings({
      user: { 'demo@mp': true, 'other@mp': true },
      project: { demo: true },
    });
    operationMocks.uninstallPluginOp.mockResolvedValue({
      ok: true,
      pluginId: 'demo@mp',
      fullyRemoved: true,
    });

    await createManager({ settings }).uninstall({
      plugin: 'demo@mp',
      scope: 'user',
    });

    expect(settings.records.user).toEqual({ 'other@mp': true });
    expect(settings.records.project).toEqual({});
  });



  it('enables an installed plugin without a pre-existing settings entry', async () => {
    state.installed.plugins['cached@mp'] = [
      { scope: 'user', installPath: '/cached' },
    ];
    const settings = createSettings();

    await createManager({ settings }).setEnabled({
      plugin: 'cached@mp',
      enabled: true,
    });

    expect(settings.records.user['cached@mp']).toBe(true);
  });

  it('gives a helpful error when enabling a plugin installed in another project', async () => {
    // Plugin installed with local scope in projectA, but manager cwd is
    // /workspace/project (not projectA) — the Bug1 enable deadlock.
    state.installed.plugins['worker@jet-skills'] = [
      {
        scope: 'local',
        installPath: '/cache/worker/local',
        projectPath: '/projectA',
      },
    ];
    const settings = createSettings();

    await expect(
      createManager({ settings }).setEnabled({
        plugin: 'worker@jet-skills',
        enabled: true,
      }),
    ).rejects.toThrow(/installed in another project/);
  });

  it('allows a fully-qualified stale settings entry to be disabled', async () => {
    const settings = createSettings({
      user: { 'missing@mp': true },
    });

    const result = await createManager({ settings }).setEnabled({
      plugin: 'missing@mp',
      enabled: false,
    });

    expect(result).toMatchObject({
      pluginId: 'missing@mp',
      staleSettingDisabled: true,
      runtimeReloadRequired: false,
    });
    expect(settings.records.user['missing@mp']).toBe(false);
  });

  it('rejects a lower-precedence explicit scope', async () => {
    state.installed.plugins['project@mp'] = [
      {
        scope: 'project',
        installPath: '/project',
        projectPath: '/workspace/project',
      },
    ];
    const settings = createSettings({
      project: { 'project@mp': true },
    });

    await expect(
      createManager({ settings }).setEnabled({
        plugin: 'project@mp',
        enabled: true,
        scope: 'user',
      }),
    ).rejects.toThrow(
      'Plugin "project@mp" is configured at project scope, not user.',
    );
  });

  it('ignores dangling settings intent when resolving a bare name', () => {
    state.installed.plugins['demo@real'] = [
      { scope: 'user', installPath: '/real' },
    ];
    const settings = createSettings({
      user: { 'demo@missing': true },
    });

    expect(createManager({ settings }).resolvePluginId('demo')).toBe(
      'demo@real',
    );
  });

  it('cleans enabledPlugins for the uninstalled scope on partial uninstall (Bug2)', async () => {
    state.installed.plugins['demo@mp'] = [
      { scope: 'user', installPath: '/demo-user' },
      {
        scope: 'project',
        installPath: '/demo-project',
        projectPath: '/workspace/project',
      },
    ];
    const settings = createSettings({
      user: { 'demo@mp': true },
      project: { 'demo@mp': true },
    });
    operationMocks.uninstallPluginOp.mockResolvedValue({
      ok: true,
      pluginId: 'demo@mp',
      fullyRemoved: false,
    });

    await createManager({ settings }).uninstall({
      plugin: 'demo@mp',
      scope: 'user',
    });

    // User scope enabledPlugins cleaned (the user-scope installation was removed).
    expect(settings.records.user).toEqual({});
    // Project scope enabledPlugins untouched (project-scope installation remains).
    expect(settings.records.project).toEqual({ 'demo@mp': true });
  });

  it('disables only installations applicable to the current project', async () => {
    state.installed.plugins = {
      'active@mp': [
        {
          scope: 'project',
          installPath: '/active',
          projectPath: '/workspace/project',
        },
      ],
      'other@mp': [
        {
          scope: 'project',
          installPath: '/other',
          projectPath: '/workspace/other',
        },
      ],
    };
    const settings = createSettings({
      project: { 'active@mp': true, 'other@mp': true },
    });

    const result = await createManager({ settings }).disableAll();

    expect(result.disabledCount).toBe(1);
    expect(settings.records.project['active@mp']).toBe(false);
    expect(settings.records.project['other@mp']).toBe(true);
  });



  it('lists installed disabled plugins and stale enabled settings separately', async () => {
    state.installed.plugins['cached@mp'] = [
      { scope: 'user', installPath: '/cached', version: '1.0.0' },
    ];
    const settings = createSettings({
      user: { 'cached@mp': false, 'missing@mp': true },
    });

    const result = await createManager({ settings }).list();

    expect(result.installed).toEqual([
      expect.objectContaining({ id: 'cached@mp', enabled: false }),
    ]);
    expect(result.staleSettings).toEqual([
      { pluginId: 'missing@mp', scope: 'user' },
    ]);
  });

  it('reports enabled intent as missing when the only installation belongs to another project', async () => {
    state.installed.plugins['shared@mp'] = [
      {
        scope: 'project',
        projectPath: '/workspace/other',
        installPath: '/cache/shared/other',
      },
    ];
    const settings = createSettings({
      project: { 'shared@mp': true },
    });

    const result = await createManager({ settings }).list();

    expect(result.staleSettings).toEqual([
      { pluginId: 'shared@mp', scope: 'project' },
    ]);
  });

  it('preserves project paths while reporting enablement for the current context', async () => {
    state.installed.plugins['shared@mp'] = [
      {
        scope: 'project',
        projectPath: '/workspace/project',
        installPath: '/cache/shared/current',
        version: '1.0.0',
      },
      {
        scope: 'project',
        projectPath: '/workspace/other',
        installPath: '/cache/shared/other',
        version: '2.0.0',
      },
    ];
    const settings = createSettings({
      project: { 'shared@mp': true },
    });

    const result = await createManager({ settings }).list();

    expect(result.installed).toEqual([
      expect.objectContaining({
        id: 'shared@mp',
        projectPath: '/workspace/project',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'shared@mp',
        projectPath: '/workspace/other',
        enabled: true,
      }),
    ]);
  });



  it('reports a missing local manifest dependency before enabling', async () => {
    state.installed.plugins['root@local'] = [
      { scope: 'user', installPath: '/root' },
    ];
    state.manifests['root@local'] = [
      { name: 'missing', marketplace: 'local' },
    ];

    await expect(
      createManager().setEnabled({
        plugin: 'root@local',
        enabled: true,
      }),
    ).rejects.toThrow(
      'Dependency "missing@local" for "root@local" is not installed',
    );
  });
});

describe('plugin management rules', () => {
  it('allows a product to exclude locked candidates without defining its policy in Core', () => {
    const loaded = [createPlugin('normal@mp'), createPlugin('locked@external')];
    expect(selectDisableAllCandidates(loaded, (id) => id !== 'locked@external')).toEqual({
      pluginIds: ['normal@mp'], skippedLocked: 1,
    });
  });
});
