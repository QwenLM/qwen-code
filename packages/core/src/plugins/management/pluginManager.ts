/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildPluginRuntimeItems,
  type BuildPluginRuntimeItemsOptions,
  type PluginRuntimeItem,
} from './pluginRuntimeState.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import { BRAND_CLI_BIN } from '../../config/brand.js';
import {
  buildPluginId,
  parsePluginIdentifier,
} from '../pluginIdentifier.js';
import { loadAllPlugins, loadPluginFromDirectory } from '../pluginLoader.js';
import { collectPluginResources } from '../loading/pluginResourceCollector.js';
import { validatePlugin } from '../validation/validatePlugin.js';
import type { PluginScope } from '../schemas.js';
import {
  getPluginErrorMessage,
  type LoadedPlugin,
  type PluginError,
} from '../types.js';
import {
  autoInstallDependencies,
  dependencyRefToString,
  getLoadedPluginId,
  resolveDependencyPluginId,
  verifyAndDemoteDependencies,
  type DependencyIssue,
} from './pluginDependencies.js';
import {
  invalidateInstalledPluginsCache,
  refreshPluginDisplayName,
  isPluginInstalled,
  isPluginInstalledForCwd,
  loadInstalledPluginsFromDisk,
  getInstalledPluginsForMarketplace,
  type PluginInstallationEntry,
  type InstalledPluginsState,
} from './installedPluginsManager.js';
import {
  getMarketplace,
  getPluginById,
  getPluginByIdCacheOnly,
  listKnownMarketplaces,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js';
import {
  installLocalPluginOp,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
  type InstallPluginResult,
  type PluginOperationError,
} from './pluginOperations.js';
import {
  setPluginEnabledOp,
  type PluginSettingsAccessor,
} from './pluginEnableDisable.js';
import type { PluginResources } from '../loading/pluginResourceCollector.js';
import type { PluginValidationReport } from '../validation/validatePlugin.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  reconcilePluginsForStartup,
  type HeadlessInstallResult,
} from '../headlessPluginInstall.js';
import type { DeclaredMarketplace } from '../reconciler.js';
import { removeConfiguredMarketplace } from './marketplaceOperations.js';
import {
  startAutoUpdateScheduler,
  collectUpdateCandidates,
  checkAndUpdatePlugin,
  type AutoUpdateOptions,
  type PluginUpdateCandidate,
} from './pluginAutoUpdate.js';

export const PLUGIN_MANAGEMENT_SCOPES = [
  'user',
  'project',
  'local',
] as const;

export type PluginManagementScope =
  (typeof PLUGIN_MANAGEMENT_SCOPES)[number];

export interface PluginManagerMergedSettings {
  enabledPlugins?: Record<string, boolean>;
  blockedMarketplaces?: string[];
  strictKnownMarketplaces?: boolean;
  extraKnownMarketplaces?: Record<string, { source: unknown }>;
}

/**
 * Core-owned view of plugin settings. The CLI adapts its multi-scope
 * LoadedSettings object to this narrow contract.
 */
export interface PluginManagerSettingsStore extends PluginSettingsAccessor {
  getMergedSettings(): PluginManagerMergedSettings;
  getScopedEnabledPlugins(
    scope: PluginManagementScope,
  ): Readonly<Record<string, boolean>>;
  getScopedExtraKnownMarketplaces(
    scope: PluginManagementScope,
  ): Readonly<Record<string, { source: unknown }>>;
  patchScopedEnabledPlugins(
    scope: PluginManagementScope,
    patch: Record<string, boolean | undefined>,
  ): boolean;
}

export interface PluginManagerHost {
  settings: PluginManagerSettingsStore;
  cwd: string;
  /** Enables remote ZIP installation for this host. */
  installRemotePluginZip?: (
    source: string,
    scope: PluginManagementScope,
    options: { projectPath?: string },
  ) => Promise<InstallPluginResult | PluginOperationError>;
}

export class PluginManagerError extends Error {
  constructor(readonly pluginError: PluginError) {
    super(getPluginErrorMessage(pluginError));
    this.name = 'PluginManagerError';
  }
}

export interface PluginListRow {
  id: string;
  name: string;
  source: string;
  version?: string;
  scope: PluginManagementScope | 'managed' | 'flag';
  enabled: boolean;
  canDisable: boolean;
  /** Project root associated with project/local installations. */
  projectPath?: string;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  displayName?: string;
  description?: string;
  resources?: PluginResources;
}

export interface StaleEnabledPluginSetting {
  pluginId: string;
  scope: PluginManagementScope;
}

export interface PluginListResult {
  installed: PluginListRow[];
  available?: Array<{
    pluginId: string;
    name: string;
    marketplaceName: string;
    version?: string;
    displayName?: string;
    description?: string;
    source: unknown;
  }>;
  staleSettings: StaleEnabledPluginSetting[];
  warnings: string[];
}

export interface PluginManagerInstallResult {
  pluginId: string;
  version: string;
  installPath: string;
  shadowedByManagedPluginId?: string;
  /** Product-supplied notices; terminal adapters render them without product checks. */
  notices?: string[];
  runtimeReloadRequired: true;
}

export interface PluginManagerUninstallResult {
  pluginId: string;
  scope: PluginManagementScope;
  fullyRemoved: boolean;
  reverseDependents: string[];
  runtimeReloadRequired: true;
}

export interface PluginManagerUpdateResult {
  pluginId: string;
  runtimeReloadRequired: true;
}

export interface PluginManagerEnableResult {
  pluginId: string;
  enabled: boolean;
  staleSettingDisabled?: boolean;
  runtimeReloadRequired: boolean;
}

export interface PluginManagerDisableAllResult {
  disabledCount: number;
  skippedLocked: number;
  runtimeReloadRequired: boolean;
}

export interface PluginSessionLoadOptions {
  pluginDirs?: string[];
  /** Startup preserves thrown directory-loader failures; reload collects them. */
  collectPluginDirFailure?: boolean;
  /** Skip product-supplied plugins before the host identity is available. */
  skipAdditionalPlugins?: boolean;
}

export interface PluginSessionLoadResult {
  plugins: LoadedPlugin[];
  errors: PluginError[];
}

type MarketplaceDependencyEntry = {
  name: string;
  dependencies?: unknown[];
};

const SCOPE_PRIORITY: Record<PluginScope, number> = {
  managed: -1,
  local: 0,
  project: 1,
  user: 2,
};

const SCOPE_PRECEDENCE: Record<PluginManagementScope, number> = {
  user: 0,
  project: 1,
  local: 2,
};

export function getEnabledPluginIds(
  settings: PluginManagerMergedSettings,
): string[] {
  return Object.entries(settings.enabledPlugins ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id);
}

export function getDisabledPluginIds(
  settings: PluginManagerMergedSettings,
): string[] {
  return Object.entries(settings.enabledPlugins ?? {})
    .filter(([, enabled]) => enabled === false)
    .map(([id]) => id);
}

function projectPathApplies(
  entryProjectPath: string | undefined,
  currentProjectPath: string,
): boolean {
  if (!entryProjectPath) return true;
  const entryPath = resolve(entryProjectPath);
  const currentPath = resolve(currentProjectPath);
  return (
    currentPath === entryPath || currentPath.startsWith(`${entryPath}${sep}`)
  );
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

function looksLikeLocalPath(input: string, cwd: string): boolean {
  const expanded = expandHome(input);
  return (
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('/') ||
    input.startsWith('~') ||
    /^[a-zA-Z]:[/\\]/.test(input) ||
    existsSync(resolve(cwd, expanded))
  );
}

function resolveLocalPath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function isRemotePluginZipUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname.toLowerCase().endsWith('.zip')
    );
  } catch {
    return false;
  }
}

export function getPluginDisplayLabel(
  plugin: { name: string; displayName?: string },
  entry?: { displayName?: string },
): string {
  return entry?.displayName ?? plugin.displayName ?? plugin.name;
}

export function selectDisableAllCandidates(
  loadedPlugins: readonly LoadedPlugin[],
  canDisable: (pluginId: string) => boolean = () => true,
): { pluginIds: string[]; skippedLocked: number } {
  const enabledIds = [
    ...new Set(
      loadedPlugins
        .filter((plugin) => plugin.enabled !== false)
        .map((plugin) => getLoadedPluginId(plugin)),
    ),
  ];
  const isLocked = (pluginId: string) => !canDisable(pluginId);
  return {
    pluginIds: enabledIds.filter((id) => !isLocked(id)),
    skippedLocked: enabledIds.filter(isLocked).length,
  };
}

export interface AdditionalPluginLoadOptions {
  disabledIds: ReadonlySet<string>;
  purpose: 'session' | 'management';
  blockedMarketplaces: ReadonlySet<string>;
}

export interface AdditionalPluginLoadResult extends PluginSessionLoadResult {
  /** Names remain claimed even when a product plugin fails to load. */
  claimedNames: ReadonlySet<string>;
}

export type PluginManagerFactory = (host: PluginManagerHost) => PluginManager;

export function createDefaultPluginManager(
  host: PluginManagerHost,
): PluginManager {
  return new PluginManager(host);
}

export class PluginManager {
  constructor(protected readonly host: PluginManagerHost) {}

  /** Products may declare default marketplaces for startup reconciliation. */
  protected getBuiltinDeclaredMarketplaces(): Record<string, DeclaredMarketplace> {
    return {};
  }

  /** Products may reserve installations without removing them from shared storage. */
  protected isPluginExcluded(_pluginId: string): boolean {
    return false;
  }

  protected getPluginUnsupportedMessage(pluginId: string): string {
    return `Plugin "${pluginId}" is unsupported in this runtime.`;
  }

  protected getEnabledPluginIds(
    settings = this.host.settings.getMergedSettings(),
  ): string[] {
    return getEnabledPluginIds(settings).filter(
      (id) => !this.isPluginExcluded(id),
    );
  }

  protected getDisabledPluginIds(
    settings = this.host.settings.getMergedSettings(),
  ): string[] {
    return getDisabledPluginIds(settings).filter(
      (id) => !this.isPluginExcluded(id),
    );
  }

  protected refreshPluginDisplayName(
    ...args: Parameters<typeof refreshPluginDisplayName>
  ): void {
    if (this.isPluginExcluded(args[0])) return;
    refreshPluginDisplayName(...args);
  }

  protected setPluginEnabled(
    ...args: Parameters<typeof setPluginEnabledOp>
  ): ReturnType<typeof setPluginEnabledOp> {
    if (this.isPluginExcluded(args[0])) {
      return { ok: false, error: this.getPluginUnsupportedMessage(args[0]) };
    }
    const [pluginId, enabled, settings, options] = args;
    const filterIds = (ids: string[]) =>
      ids.filter((id) => !this.isPluginExcluded(id));
    // Filter the operation's read view; writes still target the original settings.
    const filteredSettings: PluginSettingsAccessor = {
      getEnabledPlugins: () => filterIds(settings.getEnabledPlugins()),
      getDisabledPlugins: () => filterIds(settings.getDisabledPlugins()),
      getPluginsSettings: () => {
        const pluginSettings = settings.getPluginsSettings();
        return {
          ...pluginSettings,
          disabled: pluginSettings.disabled
            ? filterIds(pluginSettings.disabled)
            : undefined,
        };
      },
      setPluginEnabled: (...values) => settings.setPluginEnabled(...values),
    };
    return setPluginEnabledOp(pluginId, enabled, filteredSettings, {
      ...options,
      toggleDependency: (...dependencyArgs) =>
        this.setPluginEnabled(...dependencyArgs),
    });
  }

  protected async installMarketplacePlugin(
    ...args: Parameters<typeof installPluginOp>
  ): ReturnType<typeof installPluginOp> {
    const [plugin, scope, options] = args;
    return installPluginOp(plugin, scope, {
      ...options,
      getPluginExclusionReason: (id) =>
        this.isPluginExcluded(id)
          ? this.getPluginUnsupportedMessage(id)
          : undefined,
    });
  }

  /** Marketplace browsing includes installed entries as well as available ones. */
  async getMarketplacePlugins(name: string) {
    const marketplace = await getMarketplace(name);
    if (!marketplace) return null;
    return {
      ...marketplace,
      plugins: marketplace.plugins.filter(
        (entry) => !this.isPluginExcluded(buildPluginId(entry.name, name)),
      ),
    };
  }

  getInstalledPluginsForMarketplace(name: string) {
    return getInstalledPluginsForMarketplace(name, (id) =>
      this.isPluginExcluded(id),
    );
  }

  removeMarketplace(
    args: Omit<
      Parameters<typeof removeConfiguredMarketplace>[0],
      'isPluginExcluded'
    >,
  ) {
    return removeConfiguredMarketplace({
      ...args,
      isPluginExcluded: (id) => this.isPluginExcluded(id),
    });
  }

  startAutoUpdate(options: Omit<AutoUpdateOptions, 'manager'>): void {
    startAutoUpdateScheduler({ ...options, manager: this });
  }

  collectAutoUpdateCandidates(
    options: AutoUpdateOptions,
    refreshedMarketplaces: ReadonlySet<string>,
  ): PluginUpdateCandidate[] {
    return collectUpdateCandidates(options, refreshedMarketplaces).filter(
      ({ pluginId }) => !this.isPluginExcluded(pluginId),
    );
  }

  checkAndUpdatePlugin(candidate: PluginUpdateCandidate) {
    if (this.isPluginExcluded(candidate.pluginId)) return Promise.resolve(null);
    return checkAndUpdatePlugin(
      candidate.pluginId,
      candidate.entry,
      (id, scope, options) => {
        this.assertPluginSupported(id);
        return updatePluginOp(id, scope, options);
      },
    );
  }

  /** Builtin writes share management checks; the host owns runtime reload/MCP. */
  setBuiltinEnabled(args: {
    pluginId: string;
    enabled: boolean;
    loadedPlugins: LoadedPlugin[];
  }) {
    this.assertPluginSupported(args.pluginId);
    return this.setPluginEnabled(
      args.pluginId,
      args.enabled,
      this.host.settings,
      {
        isBuiltin: true,
        loadedPlugins: args.loadedPlugins,
      },
    );
  }

  /** Additional product fields that participate in MCP variable substitution. */
  getMcpConfigStringFields(): readonly string[] {
    return [];
  }

  buildRuntimeItems(
    options: BuildPluginRuntimeItemsOptions,
  ): PluginRuntimeItem[] {
    return buildPluginRuntimeItems({
      ...options,
      isPluginExcluded: (id) => this.isPluginExcluded(id),
    });
  }

  /** Product preparation runs only for explicit management operations. */
  protected async prepareOperation(): Promise<void> {}

  /** A product may claim a bare name before ordinary installations. */
  protected findPreferredPluginId(_bareName: string): string | undefined {
    return undefined;
  }

  /** Additional plugins join the common resource/dependency loading pass. */
  protected async loadAdditionalPlugins(
    _state: InstalledPluginsState,
    _options: AdditionalPluginLoadOptions,
  ): Promise<AdditionalPluginLoadResult> {
    return { plugins: [], errors: [], claimedNames: new Set() };
  }

  protected getDisableAllCandidates(
    plugins: readonly LoadedPlugin[],
    _state: InstalledPluginsState,
  ): { pluginIds: string[]; skippedLocked: number } {
    return selectDisableAllCandidates(plugins);
  }

  /**
   * Resolve the plugins active for the current CLI session from explicit
   * directories and installed state. This operation is disk/cache-only and
   * does not refresh marketplaces or install plugins.
   */
  async loadSessionPlugins(
    options: PluginSessionLoadOptions = {},
  ): Promise<PluginSessionLoadResult> {
    let plugins: LoadedPlugin[] = [];
    const errors: PluginError[] = [];

    if (options.pluginDirs?.length) {
      const loadPluginDirs = async () => {
        const result = await loadAllPlugins(
          options.pluginDirs!.map((dir) => resolve(this.host.cwd, dir)),
          'flag',
          'local',
        );
        plugins = result.enabled;
        errors.push(...result.errors);
        for (const error of result.errors) {
          runLogger.warn(`[Plugin] Load error: ${JSON.stringify(error)}`);
        }
      };

      if (options.collectPluginDirFailure) {
        try {
          await loadPluginDirs();
        } catch (error) {
          errors.push({
            type: 'generic-error',
            source: 'flag',
            error: `Failed to reload flag plugins: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      } else {
        await loadPluginDirs();
      }
    }

    const installed = await this.loadInstalledPluginsForSession(
      plugins,
      options.skipAdditionalPlugins === true,
    );
    plugins = installed.plugins;
    errors.push(...installed.errors);
    if (installed.errors.length > 0) {
      runLogger.warn(
        `[Plugin] ${installed.errors.length} plugin(s) failed to load from installed state`,
      );
    }

    const localMarketplace =
      await this.loadEnabledLocalMarketplacePlugins(plugins);
    plugins.push(...localMarketplace.plugins);
    errors.push(...localMarketplace.errors);

    const dependencyResult = verifyAndDemoteDependencies(plugins);
    for (const plugin of plugins) {
      if (dependencyResult.demoted.has(getLoadedPluginId(plugin))) {
        plugin.enabled = false;
      }
    }
    for (const error of dependencyResult.errors) {
      if (error.type === 'dependency-unsatisfied') {
        runLogger.warn(
          `[Plugin] "${error.plugin}" disabled for this session: dependency "${error.dependency}" is ${error.reason}`,
        );
      }
    }
    errors.push(...dependencyResult.errors);

    // 已安装、企业和本地市场路径也要保留已检测到的 Hook 解析警告。
    // 显式插件路径已经汇总过同一对象，避免重复上报。
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      for (const warning of plugin.warnings ?? []) {
        if (
          (warning.type === 'hook-load-failed' ||
            (warning.type === 'component-load-failed' && warning.component === 'hooks')) &&
          !errors.includes(warning)
        ) {
          errors.push(warning);
        }
      }
    }

    return { plugins, errors };
  }

  async reconcileInstalledState(options?: {
    scope?: PluginManagementScope;
    sessionId?: string;
    onProgress?: (message: string) => void;
    /** Project settings may materialize marketplaces only after TUI trust. */
    includeProjectMarketplaces?: boolean;
  }): Promise<HeadlessInstallResult> {
    const merged = this.host.settings.getMergedSettings();
    const scopedMarketplaces: Record<string, { source: unknown }> =
      options?.includeProjectMarketplaces === false
        ? Object.assign(
            {},
            this.host.settings.getScopedExtraKnownMarketplaces('user'),
            this.host.settings.getScopedExtraKnownMarketplaces('local'),
          )
        : (merged.extraKnownMarketplaces ?? {});
    const declaredMarketplaces: Record<string, DeclaredMarketplace> = {
      ...this.getBuiltinDeclaredMarketplaces(),
      ...Object.fromEntries(
        Object.entries(scopedMarketplaces).map(([name, declaration]) => [
          name,
          {
            name,
            source: declaration.source as DeclaredMarketplace['source'],
          },
        ]),
      ),
    };
    return reconcilePluginsForStartup({
      declaredMarketplaces,
      enabledPluginIds: this.getEnabledPluginIds(merged),
      disabledPluginIds: this.getDisabledPluginIds(merged),
      scope: options?.scope ?? 'user',
      projectPath: this.host.cwd,
      blockedMarketplaces: getEffectiveBlockedMarketplaces(
        merged.blockedMarketplaces,
      ),
      strictKnownMarketplaces: merged.strictKnownMarketplaces,
      getPluginScope: (pluginId) => this.findEnabledPluginScope(pluginId),
      onProgress: options?.onProgress,
      sessionId: options?.sessionId,
    });
  }

  async validate(pluginPath: string): Promise<PluginValidationReport> {
    return validatePlugin(pluginPath);
  }

  resolvePluginId(plugin: string): string {
    if (plugin.includes('@')) return plugin;

    const managedId = this.findPreferredPluginId(plugin);
    if (managedId) return managedId;

    const installed = loadInstalledPluginsFromDisk();
    const configured = this.findPluginInSettings(plugin);
    if (
      configured &&
      installed.plugins[configured.pluginId]?.some(
        (entry) => entry.scope !== 'managed',
      )
    ) {
      return configured.pluginId;
    }
    if (installed.plugins[plugin] && !this.isPluginExcluded(plugin))
      return plugin;

    const matches = Object.keys(installed.plugins).filter(
      (id) =>
        !this.isPluginExcluded(id) &&
        installed.plugins[id].some((entry) => entry.scope !== 'managed') &&
        parsePluginIdentifier(id).name === plugin,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Plugin "${plugin}" is ambiguous. Use one of: ${matches.join(', ')}`,
      );
    }
    const aliases = Object.entries(installed.plugins)
      .filter(
        ([id, entries]) =>
          !this.isPluginExcluded(id) &&
          entries.some(
            (entry) =>
              entry.scope !== 'managed' && entry.displayName === plugin,
          ),
      )
      .map(([id]) => id);
    if (aliases.length > 1) {
      throw new Error(
        `Plugin "${plugin}" is ambiguous. Use one of: ${aliases.join(', ')}`,
      );
    }
    return aliases[0] ?? plugin;
  }

  resolveScopeForPlugin(
    pluginId: string,
    explicitScope?: PluginManagementScope,
  ): PluginManagementScope {
    if (explicitScope) return explicitScope;
    const configured = this.findPluginInSettings(pluginId);
    if (configured) return configured.scope;

    const entries = loadInstalledPluginsFromDisk().plugins[pluginId] ?? [];
    const sorted = entries
      .filter((entry) => this.entryAppliesToCurrentProject(entry))
      .sort(
        (a, b) =>
          (SCOPE_PRIORITY[a.scope as PluginManagementScope] ?? 9) -
          (SCOPE_PRIORITY[b.scope as PluginManagementScope] ?? 9),
      );
    const scope = sorted[0]?.scope;
    return scope === 'project' || scope === 'local' || scope === 'user'
      ? scope
      : 'user';
  }

  getStaleEnabledPluginSettings(
    installedState = loadInstalledPluginsFromDisk(),
  ): StaleEnabledPluginSetting[] {
    return this.getEnabledPluginIds(this.host.settings.getMergedSettings())
      .filter(
        (pluginId) =>
          !this.isPluginInstalledForCurrentProject(pluginId, installedState),
      )
      .map((pluginId) => ({
        pluginId,
        scope: this.findEnabledPluginScope(pluginId),
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  async list(options?: {
    includeAvailable?: boolean;
    includeResources?: boolean;
    pluginDirs?: string[];
  }): Promise<PluginListResult> {
    const pluginDirResult = await this.getPluginDirRows(options?.pluginDirs);
    const localMarketplace =
      await this.loadEnabledLocalMarketplacePlugins([]);
    const localMarketplaceRows = localMarketplace.plugins.map((plugin) => {
      const id = getLoadedPluginId(plugin);
      const scope = this.findEnabledPluginScope(id);
      return {
        id,
        name: plugin.name,
        source: plugin.source,
        version: plugin.manifest.version,
        scope,
        enabled: true,
        canDisable: true,
        ...(scope === 'project' || scope === 'local'
          ? { projectPath: this.host.cwd }
          : {}),
        installPath: plugin.path,
        displayName: plugin.displayName,
        description: plugin.manifest.description,
      } satisfies PluginListRow;
    });
    const excludedPaths = new Set(
      [...pluginDirResult.rows, ...localMarketplaceRows].map(
        (row) => row.installPath,
      ),
    );
    let installed = [
      ...pluginDirResult.rows,
      ...localMarketplaceRows,
      ...this.getInstalledPluginRows(excludedPaths),
    ];
    if (options?.includeResources) {
      installed = await this.enrichRows(installed);
    }
    return {
      installed,
      ...(options?.includeAvailable
        ? {
            available: await this.getAvailablePluginRows(
              new Set(localMarketplaceRows.map((row) => row.id)),
            ),
          }
        : {}),
      staleSettings: this.getStaleEnabledPluginSettings().filter(
        ({ pluginId }) =>
          !localMarketplaceRows.some((row) => row.id === pluginId),
      ),
      warnings: [
        ...pluginDirResult.warnings,
        ...localMarketplace.errors.map(
          (error) => `Warning: ${getPluginErrorMessage(error)}`,
        ),
      ],
    };
  }

  async install(args: {
    plugin: string;
    scope: PluginManagementScope;
  }): Promise<PluginManagerInstallResult> {
    await this.prepareOperation();
    const projectPath = this.getProjectPathForScope(args.scope);
    const remoteZip = isRemotePluginZipUrl(args.plugin);

    if (remoteZip || looksLikeLocalPath(args.plugin, this.host.cwd)) {
      if (remoteZip && !this.host.installRemotePluginZip) {
        throw new Error('Remote plugin ZIP installation is unavailable.');
      }
      const result = remoteZip
        ? await this.host.installRemotePluginZip!(args.plugin, args.scope, {
            projectPath,
          })
        : await installLocalPluginOp(
            resolveLocalPath(args.plugin, this.host.cwd),
            args.scope,
            { projectPath },
          );
      if (!result.ok) throw new PluginManagerError(result.error);

      invalidateInstalledPluginsCache();
      await this.ensurePluginDependencies(result.pluginId, args.scope);
      await this.enablePluginId(result.pluginId, args.scope, true);
      return {
        pluginId: result.pluginId,
        version: result.plugin?.manifest?.version ?? 'local',
        installPath: result.installPath,
        shadowedByManagedPluginId: this.getPluginShadow(result.pluginId),
        runtimeReloadRequired: true,
      };
    }

    const closure = await this.resolveMarketplaceDependencyClosure(args.plugin);
    for (const pluginId of closure) {
      this.assertPluginSupported(pluginId);
      this.assertMarketplaceAllowed(pluginId);
    }

    let lastInstallPath = '';
    let lastVersion = 'unknown';
    const settings = this.host.settings.getMergedSettings();
    const blockedMarketplaces = getEffectiveBlockedMarketplaces(
      settings.blockedMarketplaces,
    );
    for (const pluginId of closure) {
      const { marketplace } = parsePluginIdentifier(pluginId);
      const result = await this.installMarketplacePlugin(pluginId, args.scope, {
        marketplace,
        projectPath,
        strictKnownMarketplaces: settings.strictKnownMarketplaces ?? false,
        blockedMarketplaces,
      });
      if (!result.ok) throw new PluginManagerError(result.error);
      lastInstallPath = result.installPath;
      lastVersion = result.plugin?.manifest?.version ?? 'unknown';
    }

    invalidateInstalledPluginsCache();
    for (const pluginId of closure) {
      await this.enablePluginId(pluginId, args.scope, true);
    }

    const rootPluginId = closure[closure.length - 1] ?? args.plugin;
    await this.ensurePluginDependencies(rootPluginId, args.scope);
    return {
      pluginId: rootPluginId,
      version: lastVersion,
      installPath: lastInstallPath,
      shadowedByManagedPluginId: this.getPluginShadow(rootPluginId),
      runtimeReloadRequired: true,
    };
  }

  async uninstall(args: {
    plugin: string;
    scope: PluginManagementScope;
    keepData?: boolean;
  }): Promise<PluginManagerUninstallResult> {
    await this.prepareOperation();
    const pluginId = this.resolvePluginId(args.plugin);
    this.assertPluginSupported(pluginId);
    if (!isPluginInstalled(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is not installed.`);
    }

    const loadedPlugins = await this.loadInstalledPlugins();
    const result = await uninstallPluginOp(pluginId, args.scope, {
      projectPath: this.getProjectPathForScope(args.scope),
      deleteData: !args.keepData,
      loadedPlugins,
    });
    if (!result.ok) throw new PluginManagerError(result.error);
    if (result.fullyRemoved) {
      this.removePluginIntent(result.pluginId);
    } else {
      // Partial removal: the plugin still has records in other projects/scopes.
      // Clean the enabledPlugins entry for the scope being uninstalled in the
      // current project's settings to avoid a dangling key (Bug2).
      this.removePluginIntentForScope(result.pluginId, args.scope);
    }
    invalidateInstalledPluginsCache();
    return {
      pluginId: result.pluginId,
      scope: args.scope,
      fullyRemoved: result.fullyRemoved,
      reverseDependents: result.reverseDependents ?? [],
      runtimeReloadRequired: true,
    };
  }

  async update(args: {
    plugin: string;
    scope: PluginManagementScope;
  }): Promise<PluginManagerUpdateResult> {
    await this.prepareOperation();
    const pluginId = this.resolvePluginId(args.plugin);
    this.assertPluginSupported(pluginId);
    if (!isPluginInstalled(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is not installed.`);
    }
    const result = await updatePluginOp(pluginId, args.scope, {
      projectPath: this.getProjectPathForScope(args.scope),
    });
    if (!result.ok) throw new PluginManagerError(result.error);
    invalidateInstalledPluginsCache();
    return { pluginId: result.pluginId, runtimeReloadRequired: true };
  }

  async setEnabled(args: {
    plugin: string;
    enabled: boolean;
    scope?: PluginManagementScope;
  }): Promise<PluginManagerEnableResult> {
    await this.prepareOperation();
    const pluginId = this.resolvePluginId(args.plugin);
    this.assertPluginSupported(pluginId);
    const configured = this.findPluginInSettings(pluginId);

    if (
      !args.enabled &&
      args.plugin.includes('@') &&
      configured?.pluginId === pluginId &&
      !isPluginInstalled(pluginId)
    ) {
      if (args.scope && args.scope !== configured.scope) {
        throw new Error(
          `Plugin "${pluginId}" is configured at ${configured.scope} scope, not ${args.scope}. Use --scope ${configured.scope} or omit --scope to auto-detect.`,
        );
      }
      const result = this.setPluginEnabled(
        pluginId,
        false,
        this.host.settings,
        { scope: configured.scope },
      );
      if (!result.ok) throw new Error(result.error);
      return {
        pluginId,
        enabled: false,
        staleSettingDisabled: true,
        runtimeReloadRequired: false,
      };
    }

    const installedScopes = this.getApplicableInstallationScopes(pluginId);
    const isAdditionalOnly =
      isPluginInstalled(pluginId) &&
      installedScopes.length === 0 &&
      !!this.findPreferredPluginId(
        parsePluginIdentifier(pluginId).name,
      );
    if (
      !isPluginInstalled(pluginId) ||
      (installedScopes.length === 0 && !isAdditionalOnly)
    ) {
      if (
        isPluginInstalled(pluginId) &&
        installedScopes.length === 0 &&
        !isAdditionalOnly
      ) {
        throw new Error(
          `Plugin "${args.plugin}" is installed in another project but not in the current directory. Run \`${BRAND_CLI_BIN} plugins install ${args.plugin} -s local\` to install it here first.`,
        );
      }
      const suffix = args.plugin.includes('@')
        ? ''
        : ' Use plugin@marketplace format if the name is ambiguous.';
      throw new Error(`Plugin "${args.plugin}" is not installed.${suffix}`);
    }
    if (args.scope && !isAdditionalOnly) {
      this.assertExplicitScopeCanToggle({
        pluginId,
        requestedScope: args.scope,
        installedScopes,
      });
    }
    const scope = isAdditionalOnly
      ? 'user'
      : this.resolveScopeForPlugin(pluginId, args.scope);

    if (args.enabled) {
      if (!isAdditionalOnly) {
        await this.ensurePluginDependencies(pluginId, scope);
      }
      await this.enablePluginId(pluginId, scope, true);
    } else {
      const loadedPlugins = await this.loadInstalledPlugins();
      const result = this.setPluginEnabled(
        pluginId,
        false,
        this.host.settings,
        { scope, loadedPlugins },
      );
      if (!result.ok) throw new Error(result.error);
    }
    invalidateInstalledPluginsCache();
    return {
      pluginId,
      enabled: args.enabled,
      runtimeReloadRequired: true,
    };
  }

  async disableAll(): Promise<PluginManagerDisableAllResult> {
    // Additional-plugin loading owns any identity preparation it requires.
    const loadedPlugins = await this.loadInstalledPlugins();
    const { pluginIds, skippedLocked } = this.getDisableAllCandidates(
      loadedPlugins,
      loadInstalledPluginsFromDisk(),
    );
    for (const pluginId of pluginIds) {
      const result = this.setPluginEnabled(
        pluginId,
        false,
        this.host.settings,
        {
          scope: this.resolveScopeForPlugin(pluginId),
          loadedPlugins,
          skipDependentCheck: true,
        },
      );
      if (!result.ok) throw new Error(result.error);
    }
    return {
      disabledCount: pluginIds.length,
      skippedLocked,
      runtimeReloadRequired: pluginIds.length > 0,
    };
  }

  private getProjectPathForScope(
    scope: PluginManagementScope,
  ): string | undefined {
    return scope === 'project' || scope === 'local'
      ? this.host.cwd
      : undefined;
  }

  private entryAppliesToCurrentProject(entry: {
    scope: PluginScope;
    projectPath?: string;
  }): boolean {
    if (entry.scope !== 'project' && entry.scope !== 'local') return true;
    return projectPathApplies(entry.projectPath, this.host.cwd);
  }

  private isPluginInstalledForCurrentProject(
    pluginId: string,
    installedState: InstalledPluginsState,
  ): boolean {
    return (installedState.plugins[pluginId] ?? []).some((entry) =>
      this.entryAppliesToCurrentProject(entry),
    );
  }

  private findPluginInSettings(
    plugin: string,
  ): { pluginId: string; scope: PluginManagementScope } | undefined {
    for (const scope of ['local', 'project', 'user'] as const) {
      const enabledPlugins = this.host.settings.getScopedEnabledPlugins(scope);
      const match = Object.keys(enabledPlugins).find((id) => {
        if (id === plugin) return true;
        if (plugin.includes('@')) return false;
        return parsePluginIdentifier(id).name === plugin;
      });
      if (match) return { pluginId: match, scope };
    }
    return undefined;
  }

  private findEnabledPluginScope(pluginId: string): PluginManagementScope {
    const { name } = parsePluginIdentifier(pluginId);
    for (const scope of ['local', 'project', 'user'] as const) {
      const enabledPlugins = this.host.settings.getScopedEnabledPlugins(scope);
      const matchesEnabledIntent = Object.entries(enabledPlugins).some(
        ([configuredId, enabled]) =>
          enabled === true &&
          (configuredId === pluginId ||
            (!configuredId.includes('@') &&
              parsePluginIdentifier(configuredId).name === name)),
      );
      if (matchesEnabledIntent) {
        return scope;
      }
    }
    return 'user';
  }

  private getPluginShadow(pluginId: string): string | undefined {
    const managedId = this.findPreferredPluginId(
      parsePluginIdentifier(pluginId).name,
    );
    return managedId && managedId !== pluginId ? managedId : undefined;
  }

  protected assertPluginSupported(pluginId: string): void {
    if (this.isPluginExcluded(pluginId)) {
      throw new Error(this.getPluginUnsupportedMessage(pluginId));
    }
  }

  private getBlockedMarketplaceSet(): Set<string> {
    return new Set(
      getEffectiveBlockedMarketplaces(
        this.host.settings.getMergedSettings().blockedMarketplaces,
      ),
    );
  }

  private assertMarketplaceAllowed(pluginId: string): void {
    const { marketplace } = parsePluginIdentifier(pluginId);
    if (!marketplace) return;
    if (this.getBlockedMarketplaceSet().has(marketplace.toLowerCase())) {
      throw new Error(
        `Marketplace '${marketplace}' is blocked by enterprise policy`,
      );
    }
    if (
      this.host.settings.getMergedSettings().strictKnownMarketplaces &&
      !new Set(listKnownMarketplaces()).has(marketplace)
    ) {
      throw new Error(
        `Marketplace '${marketplace}' is not in the allowed marketplace list`,
      );
    }
  }

  private getApplicableInstallationScopes(
    pluginId: string,
  ): PluginManagementScope[] {
    const scopes = new Set<PluginManagementScope>();
    for (const entry of loadInstalledPluginsFromDisk().plugins[pluginId] ?? []) {
      if (!this.entryAppliesToCurrentProject(entry)) continue;
      if (
        entry.scope === 'user' ||
        entry.scope === 'project' ||
        entry.scope === 'local'
      ) {
        scopes.add(entry.scope);
      }
    }
    return [...scopes].sort((a, b) => SCOPE_PRIORITY[a] - SCOPE_PRIORITY[b]);
  }

  private assertExplicitScopeCanToggle(args: {
    pluginId: string;
    requestedScope: PluginManagementScope;
    installedScopes: PluginManagementScope[];
  }): void {
    const configured = this.findPluginInSettings(args.pluginId);
    if (
      configured &&
      configured.scope !== args.requestedScope &&
      SCOPE_PRECEDENCE[args.requestedScope] <=
        SCOPE_PRECEDENCE[configured.scope]
    ) {
      throw new Error(
        `Plugin "${args.pluginId}" is configured at ${configured.scope} scope, not ${args.requestedScope}. Use --scope ${configured.scope} or omit --scope to auto-detect.`,
      );
    }
    if (args.installedScopes.includes(args.requestedScope)) return;
    const installedScope = args.installedScopes[0];
    if (
      installedScope &&
      SCOPE_PRECEDENCE[args.requestedScope] <
        SCOPE_PRECEDENCE[installedScope]
    ) {
      throw new Error(
        `Plugin "${args.pluginId}" is installed at ${installedScope} scope, not ${args.requestedScope}. Use --scope ${installedScope} or omit --scope to auto-detect.`,
      );
    }
  }

  private removePluginIntent(pluginId: string): void {
    for (const scope of PLUGIN_MANAGEMENT_SCOPES) {
      this.removePluginIntentForScope(pluginId, scope);
    }
  }

  /**
   * Remove the enabledPlugins entry for a plugin in a single scope only.
   *
   * Used on partial uninstall (plugin still installed in other projects/scopes)
   * to clean the uninstalled scope's settings without touching other scopes.
   * This prevents a dangling `enabledPlugins` key in the current project's
   * settings file (Bug2).
   */
  private removePluginIntentForScope(
    pluginId: string,
    scope: PluginManagementScope,
  ): void {
    const { name } = parsePluginIdentifier(pluginId);
    const patch: Record<string, undefined> = {};
    const current = this.host.settings.getScopedEnabledPlugins(scope);
    for (const configuredId of Object.keys(current)) {
      const legacyBareId =
        !configuredId.includes('@') &&
        parsePluginIdentifier(configuredId).name === name;
      if (configuredId === pluginId || legacyBareId) {
        patch[configuredId] = undefined;
      }
    }
    if (Object.keys(patch).length === 0) return;
    const success = this.host.settings.patchScopedEnabledPlugins(scope, patch);
    if (!success) {
      throw new Error(`Failed to persist plugin "${pluginId}" settings.`);
    }
  }

  private async loadInstalledPluginsForSession(
    basePlugins: LoadedPlugin[],
    skipAdditionalPlugins = false,
  ): Promise<PluginSessionLoadResult> {
    const plugins = [...basePlugins];
    const errors: PluginError[] = [];
    const merged = this.host.settings.getMergedSettings();
    const enabledIds = new Set(this.getEnabledPluginIds(merged));
    const disabledIds = new Set(this.getDisabledPluginIds(merged));
    const configuredIds = new Set([...enabledIds, ...disabledIds]);
    const blockedMarketplaces = new Set(
      getEffectiveBlockedMarketplaces(merged.blockedMarketplaces),
    );
    let knownMarketplaceNames: Set<string> | null = null;

    if (merged.strictKnownMarketplaces) {
      try {
        knownMarketplaceNames = new Set(listKnownMarketplaces());
      } catch {
        // Preserve startup availability if the known-marketplace cache is bad.
      }
    }

    try {
      const state = loadInstalledPluginsFromDisk();
      const entries = Object.entries(state.plugins);
      const additional = skipAdditionalPlugins
        ? { plugins: [], errors: [], claimedNames: new Set<string>() }
        : await this.loadAdditionalPlugins(state, {
            disabledIds,
            purpose: 'session',
            blockedMarketplaces,
          });
      plugins.push(...additional.plugins);
      errors.push(...additional.errors);

      for (const [pluginId, installations] of entries) {
        if (this.isPluginExcluded(pluginId)) continue;
        const { marketplace, name } = parsePluginIdentifier(pluginId);
        if (
          marketplace &&
          blockedMarketplaces.has(marketplace.toLowerCase())
        ) {
          continue;
        }
        if (additional.claimedNames.has(name)) continue;
        if (installations.every((entry) => entry.scope === 'managed')) continue;
        if (!configuredIds.has(pluginId)) continue;

        // Product-owned installations must never fall through to ordinary loading.
        const candidates = installations.filter((entry) => entry.scope !== 'managed');
        const sorted = [...candidates].sort(
          (a: PluginInstallationEntry, b: PluginInstallationEntry) =>
            (SCOPE_PRIORITY[a.scope as PluginManagementScope] ?? 9) -
            (SCOPE_PRIORITY[b.scope as PluginManagementScope] ?? 9),
        );
        const entry = sorted.find((candidate) => {
          if (
            marketplace &&
            knownMarketplaceNames &&
            !knownMarketplaceNames.has(marketplace)
          ) {
            runLogger.warn(
              `[Plugin] Skipping "${pluginId}": marketplace not in known list (strictKnownMarketplaces policy)`,
            );
            return false;
          }
          return this.entryAppliesToCurrentProject(candidate);
        });
        if (!entry || plugins.some((plugin) => plugin.name === name)) continue;

        try {
          const source = marketplace ?? 'unknown';
          const loaded = await loadPluginFromDirectory(
            entry.installPath,
            source,
            source,
            { nameOverride: name },
          );
          if (loaded.ok) {
            this.refreshPluginDisplayName(
              pluginId,
              entry.installPath,
              loaded.plugin.displayName,
            );
            loaded.plugin.enabled = enabledIds.has(pluginId);
            plugins.push(loaded.plugin);
          } else {
            errors.push(loaded.error);
            runLogger.warn(
              `[Plugin] Failed to load installed plugin "${pluginId}": ${JSON.stringify(loaded.error)}`,
            );
          }
        } catch (error) {
          errors.push({
            type: 'generic-error',
            source: marketplace ?? 'unknown',
            plugin: name,
            error: `Failed to load plugin "${name}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          runLogger.warn(
            `[Plugin] Error loading installed plugin "${pluginId}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      runLogger.warn(
        `[Plugin] Failed to load installed plugins state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { plugins, errors };
  }

  /**
   * Load enabled local-path marketplace plugins directly from the materialized
   * marketplace. These entries intentionally need no installation record.
   */
  private async loadEnabledLocalMarketplacePlugins(
    loadedPlugins: readonly LoadedPlugin[],
  ): Promise<PluginSessionLoadResult> {
    const plugins: LoadedPlugin[] = [];
    const errors: PluginError[] = [];
    const merged = this.host.settings.getMergedSettings();
    const blockedMarketplaces = new Set(
      getEffectiveBlockedMarketplaces(merged.blockedMarketplaces),
    );

    for (const configuredId of this.getEnabledPluginIds(merged)) {
      const { name, marketplace } = parsePluginIdentifier(configuredId);
      if (!marketplace || blockedMarketplaces.has(marketplace.toLowerCase())) {
        continue;
      }
      if (
        isPluginInstalledForCwd(configuredId, this.host.cwd) ||
        loadedPlugins.some((plugin) => plugin.name === name) ||
        plugins.some((plugin) => plugin.name === name)
      ) {
        continue;
      }

      const lookup = await getPluginByIdCacheOnly(configuredId);
      if (!lookup || typeof lookup.entry.source !== 'string') continue;

      const loaded = await loadPluginFromDirectory(
        lookup.entry.source,
        lookup.marketplaceName,
        lookup.marketplaceName,
        { nameOverride: lookup.entry.name },
      );
      if (loaded.ok) {
        loaded.plugin.enabled = true;
        plugins.push(loaded.plugin);
      } else {
        errors.push(loaded.error);
        runLogger.warn(
          `[Plugin] Failed to load local marketplace plugin "${configuredId}": ${JSON.stringify(loaded.error)}`,
        );
      }
    }

    return { plugins, errors };
  }

  private async loadInstalledPlugins(options?: {
    includeUnconfigured?: boolean;
  }): Promise<LoadedPlugin[]> {
    const merged = this.host.settings.getMergedSettings();
    const enabledIds = new Set(this.getEnabledPluginIds(merged));
    const disabledIds = new Set(this.getDisabledPluginIds(merged));
    const configuredIds = new Set([...enabledIds, ...disabledIds]);
    const state = loadInstalledPluginsFromDisk();
    const entries = Object.entries(state.plugins);
    const plugins: LoadedPlugin[] = [];
    const additional = await this.loadAdditionalPlugins(state, {
      disabledIds,
      purpose: 'management',
      blockedMarketplaces: new Set(),
    });
    plugins.push(...additional.plugins);

    for (const [pluginId, installations] of entries) {
      if (this.isPluginExcluded(pluginId)) continue;
      const { marketplace, name } = parsePluginIdentifier(pluginId);
      if (additional.claimedNames.has(name)) continue;
      if (installations.every((entry) => entry.scope === 'managed')) continue;
      if (!options?.includeUnconfigured && !configuredIds.has(pluginId)) {
        continue;
      }
      const sorted = [...installations]
        .filter((entry) => entry.scope !== 'managed' && this.entryAppliesToCurrentProject(entry))
        .sort(
          (a, b) =>
            (SCOPE_PRIORITY[a.scope as PluginManagementScope] ?? 9) -
            (SCOPE_PRIORITY[b.scope as PluginManagementScope] ?? 9),
        );
      const entry = sorted[0];
      if (!entry) continue;
      const source = marketplace ?? 'local';
      const loaded = await loadPluginFromDirectory(
        entry.installPath,
        source,
        source,
        { nameOverride: name },
      );
      if (!loaded.ok) continue;
      this.refreshPluginDisplayName(
        pluginId,
        entry.installPath,
        loaded.plugin.displayName,
      );
      loaded.plugin.enabled = enabledIds.has(pluginId);
      plugins.push(loaded.plugin);
    }
    return plugins;
  }

  private async enablePluginId(
    pluginId: string,
    scope: PluginManagementScope,
    skipDependencyCheck: boolean,
  ): Promise<void> {
    const result = this.setPluginEnabled(pluginId, true, this.host.settings, {
      scope,
      loadedPlugins: await this.loadInstalledPlugins(),
      skipDependencyCheck,
    });
    if (!result.ok) throw new Error(result.error);
  }

  private async getAllowedDependencyMarketplaces(
    plugin: LoadedPlugin,
  ): Promise<string[] | undefined> {
    if (
      plugin.source === 'local' ||
      plugin.source === 'flag' ||
      plugin.source === 'builtin'
    ) {
      return undefined;
    }
    const marketplace = await getMarketplace(plugin.source).catch(() => null);
    return [
      plugin.source,
      ...(marketplace?.allowCrossMarketplaceDependenciesOn ?? []),
    ];
  }

  private async ensurePluginDependencies(
    pluginId: string,
    scope: PluginManagementScope,
  ): Promise<void> {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let loaded = await this.loadInstalledPlugins({ includeUnconfigured: true });
    let map = new Map(loaded.map((plugin) => [getLoadedPluginId(plugin), plugin]));
    const initiallyEnabled = new Set(
      loaded
        .filter((plugin) => plugin.enabled !== false)
        .map((plugin) => getLoadedPluginId(plugin)),
    );
    const root = map.get(pluginId);
    if (!root) throw new Error(`Plugin "${pluginId}" is not installed.`);
    const allowed = await this.getAllowedDependencyMarketplaces(root);

    const reload = async () => {
      loaded = await this.loadInstalledPlugins({ includeUnconfigured: true });
      map = new Map(
        loaded.map((plugin) => [getLoadedPluginId(plugin), plugin]),
      );
    };

    const ensure = async (id: string, stack: string[]): Promise<void> => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(
          `Dependency cycle detected: ${[...stack, id].join(' -> ')}`,
        );
      }
      const plugin = map.get(id);
      if (!plugin) throw new Error(`Plugin "${id}" is not installed.`);
      visiting.add(id);
      for (const dependency of plugin.manifest.dependencies ?? []) {
        const dependencyRef = dependencyRefToString(dependency);
        const dependencyId = resolveDependencyPluginId(dependency, plugin);
        let dependencyPlugin = map.get(dependencyId);
        if (!dependencyPlugin) {
          const { marketplace } = parsePluginIdentifier(dependencyId);
          if (!marketplace || marketplace === 'local') {
            throw new Error(
              `Dependency "${dependencyRef}" for "${id}" is not installed and cannot be auto-installed from a marketplace.`,
            );
          }
          const issue: DependencyIssue = {
            ref: dependencyRef,
            pluginId: dependencyId,
            reason: 'not-installed',
          };
          const settings = this.host.settings.getMergedSettings();
          const result = await autoInstallDependencies([issue], scope, {
            projectPath: this.getProjectPathForScope(scope),
            strictKnownMarketplaces:
              settings.strictKnownMarketplaces ?? false,
            blockedMarketplaces: getEffectiveBlockedMarketplaces(
              settings.blockedMarketplaces,
            ),
            allowedCrossMarketplaces: allowed,
            installPlugin: (...args) => this.installMarketplacePlugin(...args),
          });
          if (result.failed.length > 0) {
            const failure = result.failed[0];
            throw new Error(
              `Failed to install dependency "${failure.pluginId}" for "${id}": ${getPluginErrorMessage(failure.error)}`,
            );
          }
          invalidateInstalledPluginsCache();
          await reload();
          dependencyPlugin = map.get(dependencyId);
          if (!dependencyPlugin) {
            throw new Error(
              `Dependency "${dependencyId}" was installed but could not be loaded.`,
            );
          }
        }
        if (
          dependencyPlugin.enabled !== false &&
          initiallyEnabled.has(dependencyId)
        ) {
          continue;
        }
        await ensure(dependencyId, [...stack, id]);
        if (dependencyPlugin.enabled === false) {
          const result = this.setPluginEnabled(
            dependencyId,
            true,
            this.host.settings,
            {
              scope: this.resolveScopeForPlugin(dependencyId),
              loadedPlugins: loaded,
              skipDependencyCheck: true,
            },
          );
          if (!result.ok) throw new Error(result.error);
          dependencyPlugin.enabled = true;
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    await ensure(pluginId, []);
  }

  private async resolveMarketplaceDependencyClosure(
    plugin: string,
  ): Promise<string[]> {
    const rootLookup = await getPluginById(plugin);
    if (!rootLookup) {
      throw new Error(`Plugin "${plugin}" not found in any marketplace.`);
    }
    const rootId = buildPluginId(rootLookup.entry.name, rootLookup.marketplaceName);
    const rootMarketplace = rootLookup.marketplaceName;
    const marketplace = await getMarketplace(rootMarketplace).catch(() => null);
    const allowed = new Set([
      rootMarketplace,
      ...(marketplace?.allowCrossMarketplaceDependenciesOn ?? []),
    ]);
    const alreadyEnabled = new Set(
      (await this.loadInstalledPlugins())
        .filter((item) => item.enabled !== false)
        .map((item) => getLoadedPluginId(item)),
    );
    const entryById = new Map<
      string,
      { entry: MarketplaceDependencyEntry; marketplaceName: string }
    >([
      [
        rootId,
        { entry: rootLookup.entry, marketplaceName: rootLookup.marketplaceName },
      ],
    ]);
    const closure: string[] = [];
    const visited = new Set<string>();
    const visiting: string[] = [];

    const lookup = async (id: string) => {
      const cached = entryById.get(id);
      if (cached) return cached;
      const found = await getPluginById(id);
      if (!found) return undefined;
      const resolvedId = buildPluginId(found.entry.name, found.marketplaceName);
      const value = {
        entry: found.entry,
        marketplaceName: found.marketplaceName,
      };
      entryById.set(resolvedId, value);
      return value;
    };

    const visit = async (id: string, requiredBy: string): Promise<void> => {
      if (id !== rootId && alreadyEnabled.has(id)) return;
      const { marketplace: marketplaceName } = parsePluginIdentifier(id);
      if (!marketplaceName || !allowed.has(marketplaceName)) {
        throw new Error(
          `Dependency "${id}" (required by ${requiredBy}) is in a marketplace that is not allowed by the root marketplace.`,
        );
      }
      const cycleStart = visiting.indexOf(id);
      if (cycleStart !== -1) {
        throw new Error(
          `Dependency cycle detected: ${[...visiting.slice(cycleStart), id].join(' -> ')}`,
        );
      }
      if (visited.has(id)) return;
      const info = await lookup(id);
      if (!info) {
        throw new Error(`Dependency "${id}" (required by ${requiredBy}) not found.`);
      }
      visiting.push(id);
      for (const dependency of info.entry.dependencies ?? []) {
        const ref = dependencyRefToString(dependency);
        const parsed = parsePluginIdentifier(ref);
        await visit(
          buildPluginId(parsed.name, parsed.marketplace ?? info.marketplaceName),
          id,
        );
      }
      visiting.pop();
      visited.add(id);
      closure.push(id);
    };
    await visit(rootId, rootId);
    return closure;
  }

  private async getPluginDirRows(pluginDirs?: string[]): Promise<{
    rows: PluginListRow[];
    warnings: string[];
  }> {
    if (!pluginDirs?.length) return { rows: [], warnings: [] };
    const result = await loadAllPlugins(
      pluginDirs.map((dir) => resolve(this.host.cwd, dir)),
      'flag',
      'local',
    );
    return {
      rows: [...result.enabled, ...result.disabled].map((plugin) => {
        const id = getLoadedPluginId(plugin);
        const { name } = parsePluginIdentifier(id);
        return {
          id,
          name,
          source: buildPluginId(name, 'inline'),
          version: plugin.manifest.version,
          scope: 'flag' as const,
          enabled: plugin.enabled !== false,
          canDisable: false,
          installPath: plugin.path,
          description: plugin.manifest.description,
        };
      }),
      warnings: result.errors.map(
        (error) => `Warning: ${getPluginErrorMessage(error)}`,
      ),
    };
  }

  protected getInstalledPluginRows(
    excludedPaths: Set<string>,
  ): PluginListRow[] {
    const merged = this.host.settings.getMergedSettings();
    const enabledIds = new Set(this.getEnabledPluginIds(merged));
    const blocked = this.getBlockedMarketplaceSet();
    const rows: PluginListRow[] = [];

    for (const [pluginId, entries] of Object.entries(
      loadInstalledPluginsFromDisk().plugins,
    ).sort()) {
      if (this.isPluginExcluded(pluginId)) continue;
      const { marketplace, name } = parsePluginIdentifier(pluginId);
      if (marketplace && blocked.has(marketplace.toLowerCase())) continue;
      for (const entry of entries) {
        if (entry.scope === 'managed' || excludedPaths.has(entry.installPath)) continue;
        rows.push({
          id: pluginId,
          name,
          source: pluginId,
          version: entry.version,
          scope: entry.scope,
          enabled: enabledIds.has(pluginId),
          canDisable: true,
          projectPath: entry.projectPath,
          installPath: entry.installPath,
          installedAt: entry.installedAt,
          lastUpdated: entry.lastUpdated,
          displayName: undefined,
        });
      }
    }
    return rows;
  }

  private async getAvailablePluginRows(
    excludedPluginIds: ReadonlySet<string> = new Set(),
  ): Promise<
    NonNullable<PluginListResult['available']>
  > {
    const blocked = this.getBlockedMarketplaceSet();
    const available: NonNullable<PluginListResult['available']> = [];
    for (const marketplaceName of Object.keys(
      loadKnownMarketplacesConfig(),
    ).sort()) {
      if (blocked.has(marketplaceName.toLowerCase())) continue;
      const marketplace = await getMarketplace(marketplaceName);
      if (!marketplace) continue;
      for (const entry of marketplace.plugins) {
        const pluginId = buildPluginId(entry.name, marketplaceName);
        if (
          this.isPluginExcluded(pluginId) ||
          excludedPluginIds.has(pluginId) ||
          isPluginInstalledForCwd(pluginId, this.host.cwd)
        ) {
          continue;
        }
        available.push({
          pluginId,
          name: entry.name,
          marketplaceName,
          version: entry.version,
          displayName: entry.displayName,
          description: entry.description,
          source: entry.source,
        });
      }
    }
    return available;
  }

  private async enrichRows(rows: PluginListRow[]): Promise<PluginListRow[]> {
    const emptyResources: PluginResources = {
      skills: [],
      agents: [],
      mcpServers: [],
      commands: [],
      hooks: [],
    };
    return Promise.all(
      rows.map(async (row) => {
        if (row.resources) return row;
        try {
          const { marketplace } = parsePluginIdentifier(row.id);
          const result = await loadPluginFromDirectory(
            row.installPath,
            marketplace ?? 'local',
            marketplace ?? 'local',
          );
          if (!result.ok) return { ...row, resources: emptyResources };
          this.refreshPluginDisplayName(
            row.id,
            row.installPath,
            result.plugin.displayName,
          );
          return {
            ...row,
            displayName: row.displayName ?? result.plugin.displayName,
            description: row.description ?? result.plugin.manifest.description,
            resources: await collectPluginResources(result.plugin),
          };
        } catch {
          return { ...row, resources: emptyResources };
        }
      }),
    );
  }
}
