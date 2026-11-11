/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Types
export * from './types.js';

// Plugin loader
export {
  loadPluginFromDirectory,
  loadAllPlugins,
  looksLikePluginRoot,
  findManifestPath,
} from './pluginLoader.js';

// Plugin identifier utilities
export {
  parsePluginIdentifier,
  buildPluginId,
  sanitizePluginId,
} from './pluginIdentifier.js';

// Installed plugins manager
export {
  loadInstalledPluginsFromDisk,
  addPluginInstallation,
  removePluginInstallation,
  getInstalledPluginsForMarketplace,
  isPluginInstalled,
  isPluginInstalledForCwd,
  invalidateInstalledPluginsCache,
  isPluginUserVisibleInList,
  isManagedLocked,
  getManagedShadowedNames,
  type PluginInstallationEntry,
  type InstalledPluginsState,
} from './management/installedPluginsManager.js';

// Plugin cache paths
export {
  getPluginCachePath,
  getVersionedCachePath,
} from './pluginDirectories.js';
// Plugin archives (download, verify, extract)
export {
  downloadVerifiedZip,
  type DownloadResult,
} from './verifiedZipDownload.js';
export { extractZipToDirectory } from './zipCache.js';
export { detectSingleWrapperDir } from './pluginArchiveRoot.js';
export { formatManifestError } from './validation/manifestErrors.js';
export { readInstalledPluginsV2Raw } from './management/installedPluginsRaw.js';

// Legacy plugin identity migration
export {
  discoverLegacyMarketplaceAliases,
  migrateInstalledPluginIds,
  commitLegacyMarketplaceAliases,
  type LegacyMarketplaceAliases,
} from './legacyPluginIdentityMigration.js';

// Marketplace manager
export {
  loadKnownMarketplacesConfig,
  addMarketplaceSourceFromSource,
  removeMarketplaceSource,
  getMarketplace,
  refreshMarketplace,
  refreshAllMarketplaces,
  setMarketplaceAutoUpdate,
  listKnownMarketplaces,
  getPluginById,
  type KnownMarketplace,
  type PluginMarketplace,
} from './management/marketplaceManager.js';

// Plugin operations (install/uninstall/update)
export {
  installPluginOp,
  installLocalPluginOp,
  getPluginContentValidationError,
  uninstallPluginOp,
  updatePluginOp,
  type InstallPluginResult,
  type PluginOperationError,
} from './management/pluginOperations.js';

// Plugin commands
export {
  loadAllPluginCommands,
  type PluginCommandDefinition,
} from './loadPluginCommands.js';

// Schemas & schema-derived types
export {
  PluginMarketplaceEntrySchema,
  PluginManifestSchema,
  Sha256HexSchema,
  type MarketplaceSource,
} from './schemas.js';

// Plugin dependency resolution
export {
  autoInstallDependencies,
  verifyAndDemoteDependencies,
  getLoadedPluginId,
  resolveDependencyPluginId,
  dependencyRefToString,
  type DependencyIssue,
} from './management/pluginDependencies.js';

// Plugin auto-update scheduler
export {
  startAutoUpdateScheduler,
  stopAutoUpdateScheduler,
} from './management/pluginAutoUpdate.js';

// Plugin policy
export {
  getEffectiveBlockedMarketplaces,
} from './pluginPolicy.js';

// Plugin Git utilities
export {
  getPluginGitTimeoutMs,
  getPluginTimeoutSeconds,
} from './pluginGit.js';

// Plugin resource collection
export {
  collectPluginResources,
  type PluginResources,
} from './loading/pluginResourceCollector.js';

// Parse marketplace input
export { parseMarketplaceInput } from './parseMarketplaceInput.js';

// Validate plugin
export {
  validatePlugin,
  type PluginValidationReport,
} from './validation/validatePlugin.js';

// Reconciler (marketplace reconciliation)
export {
  type DeclaredMarketplace,
} from './reconciler.js';

export { copyContainedTree } from './pluginTreeCopy.js';

// Headless plugin installation
export {
  formatMissingPluginDiagnostic,
  installPluginsForHeadless,
  reconcilePluginsForStartup,
  type MissingPluginDiagnostic,
} from './headlessPluginInstall.js';

// Plugin options storage
export {
  substitutePluginVariables,
} from './configuration/pluginOptionsStorage.js';

// Refresh (Layer-3 reload)
export {
  clearAllPluginCaches,
} from './refresh.js';

// settings.pluginConfigs substitution
export {
  applyPluginConfigsToPlugins,
  type PluginConfigsRoot,
} from './configuration/pluginConfigSubstitution.js';

// Enable / Disable operations
export {
  setPluginEnabledOp,
  type PluginSettingsAccessor,
} from './management/pluginEnableDisable.js';

// User-triggered plugin lifecycle
export {
  PluginManager,
  PluginManagerError,
  PLUGIN_MANAGEMENT_SCOPES,
  createDefaultPluginManager,
  getPluginDisplayLabel,
  type PluginManagementScope,
  type PluginManagerMergedSettings,
  type PluginManagerSettingsStore,
  type PluginManagerHost,
  type PluginManagerFactory,
  type AdditionalPluginLoadOptions,
  type AdditionalPluginLoadResult,
  type PluginListRow,
  type StaleEnabledPluginSetting,
  type PluginListResult,
  type PluginManagerInstallResult,
  type PluginManagerUninstallResult,
  type PluginManagerUpdateResult,
  type PluginManagerEnableResult,
  type PluginManagerDisableAllResult,
  type PluginSessionLoadOptions,
  type PluginSessionLoadResult,
} from './management/pluginManager.js';

export { refreshActivePlugins } from './management/refreshActivePlugins.js';

export {
  buildPluginRuntimeItems,
  type BuildPluginRuntimeItemsOptions,
  type InstalledPluginItem,
  type FailedPluginItem,
  type PluginMcpServerStatus,
  type PluginMcpServerItem,
  type PendingPluginItem,
  type PluginRuntimeItem,
} from './management/pluginRuntimeState.js';
