/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { resolve, basename, dirname, sep } from 'node:path';
import { cp, lstat, realpath, rm, stat } from 'node:fs/promises';

import { loadPluginFromDirectory } from '../pluginLoader.js';
import { getPluginContentValidationError } from '../validation/pluginContentValidation.js';
import {
  getPluginById,
  listKnownMarketplaces,
  type MarketplaceProgressFn,
} from './marketplaceManager.js';
import {
  addPluginInstallation,
  removePluginInstallation,
  getPluginInstallationsFresh,
  type PluginInstallationEntry,
} from './installedPluginsManager.js';
import {
  deletePluginDataDir,
  getVersionedCachePath,
} from '../pluginDirectories.js';
import { markPluginVersionOrphaned } from '../cacheUtils.js';
import { parsePluginIdentifier, buildPluginId } from '../pluginIdentifier.js';
import { cacheAndRegisterPlugin } from './pluginInstallationHelpers.js';
import { findEnabledDependents } from './pluginDependencies.js';
import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import { runLogger } from '../../utils/runLogger.js';
import { debugLogger } from '../../utils/debugLogger.js';
import type { PluginScope } from '../schemas.js';
import { getPluginErrorMessage } from '../types.js';
import type { LoadedPlugin, PluginError } from '../types.js';
import { isPathContained } from '../../utils/pathContainment.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface InstallPluginResult {
  ok: true;
  pluginId: string;
  plugin: LoadedPlugin;
  installPath: string;
  marketplace: string;
}

export interface UninstallPluginResult {
  ok: true;
  pluginId: string;
  fullyRemoved: boolean;
  reverseDependents?: string[];
}

export interface UpdatePluginResult {
  ok: true;
  pluginId: string;
  oldPath: string;
  newPath: string;
  version?: string;
}

export interface PluginOperationError {
  ok: false;
  error: PluginError;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install a plugin from a marketplace.
 *
 * Delegates to pluginInstallationHelpers for the actual fetch/cache/register
 * work. This function handles marketplace resolution and policy checks.
 */
export async function installPluginOp(
  pluginQuery: string,
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    /** Check product ownership before and after resolving a marketplace ID. */
    getPluginExclusionReason?: (pluginId: string) => string | undefined;
    version?: string;
    marketplace?: string;
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    /** Enterprise policy: only allow plugins from known marketplaces */
    strictKnownMarketplaces?: boolean;
    /** Enterprise policy: blocked marketplace names */
    blockedMarketplaces?: string[];
  },
): Promise<InstallPluginResult | PluginOperationError> {
  const { name, marketplace: parsedMarketplace } =
    parsePluginIdentifier(pluginQuery);
  const targetMarketplace = options?.marketplace ?? parsedMarketplace;
  const fullQuery = targetMarketplace
    ? buildPluginId(name, targetMarketplace)
    : name;

  const exclusionReason = options?.getPluginExclusionReason?.(fullQuery);
  if (exclusionReason !== undefined) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install',
        plugin: fullQuery,
        error: exclusionReason,
      },
    };
  }

  // --- Enterprise policy checks ---
  if (targetMarketplace) {
    const blocked = new Set(
      getEffectiveBlockedMarketplaces(options?.blockedMarketplaces),
    );
    if (blocked.has(targetMarketplace.toLowerCase())) {
      return {
        ok: false,
        error: {
          type: 'marketplace-blocked-by-policy',
          source: 'install',
          plugin: fullQuery,
          marketplace: targetMarketplace,
          blockedByBlocklist: true,
          allowedSources: listKnownMarketplaces().filter(
            (m) => !blocked.has(m.toLowerCase()),
          ),
        },
      };
    }

    if (options?.strictKnownMarketplaces) {
      const known = new Set(listKnownMarketplaces());
      if (!known.has(targetMarketplace)) {
        return {
          ok: false,
          error: {
            type: 'marketplace-blocked-by-policy',
            source: 'install',
            plugin: fullQuery,
            marketplace: targetMarketplace,
            blockedByBlocklist: false,
            allowedSources: [...known].filter((m) => !blocked.has(m)),
          },
        };
      }
    }
  }

  // 1. Look up plugin in marketplaces
  options?.onProgress?.(`Searching for plugin "${fullQuery}"...`);
  const lookup = await getPluginById(fullQuery);

  if (!lookup) {
    return {
      ok: false,
      error: {
        type: 'plugin-not-found',
        source: 'install',
        pluginId: fullQuery,
        marketplace: targetMarketplace ?? 'all',
      },
    };
  }

  const { entry, marketplaceName, marketplaceInstallLocation } = lookup;
  const pluginId = buildPluginId(entry.name, marketplaceName);
  const resolvedExclusionReason = options?.getPluginExclusionReason?.(pluginId);
  if (resolvedExclusionReason !== undefined) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install',
        plugin: pluginId,
        error: resolvedExclusionReason,
      },
    };
  }
  runLogger.log(
    `[installPluginOp] found: pluginId=${pluginId}, marketplace=${marketplaceName}`,
  );

  // Post-lookup policy check (for unqualified queries where marketplace is resolved now)
  if (!targetMarketplace) {
    const blocked = new Set(
      getEffectiveBlockedMarketplaces(options?.blockedMarketplaces),
    );
    if (blocked.has(marketplaceName.toLowerCase())) {
      return {
        ok: false,
        error: {
          type: 'marketplace-blocked-by-policy',
          source: 'install',
          plugin: pluginId,
          marketplace: marketplaceName,
          blockedByBlocklist: true,
          allowedSources: listKnownMarketplaces().filter(
            (m) => !blocked.has(m.toLowerCase()),
          ),
        },
      };
    }
  }

  // 2. Cache and register via shared helpers (handles fetch, validate, version, zip cache)
  options?.onProgress?.(`Downloading plugin "${pluginId}"...`);

  // Relative plugin sources are normalized to absolute paths when the
  // marketplace is materialized (see marketplaceManager), so entry.source is
  // already absolute here.
  const cacheResult = await cacheAndRegisterPlugin(
    pluginId,
    entry.source,
    scope,
    {
      projectPath: options?.projectPath,
      onProgress: options?.onProgress,
      version: options?.version,
      marketplaceInstallLocation,
    },
  );

  if (!cacheResult.ok) {
    // Only the TUI sees this failure otherwise: the log used to stop at the
    // "found" line above, which is why a failed marketplace install could not
    // be diagnosed from qwen.log at all.
    runLogger.error(
      `[installPluginOp] install failed: pluginId=${pluginId}, error=${getPluginErrorMessage(cacheResult.error)}`,
    );
    return { ok: false, error: cacheResult.error };
  }

  // 3. Load the cached plugin to return full LoadedPlugin
  const loadResult = await loadPluginFromDirectory(
    cacheResult.installPath,
    marketplaceName,
    marketplaceName,
  );

  if (!loadResult.ok) {
    return { ok: false, error: loadResult.error };
  }

  const plugin = loadResult.plugin;
  plugin.path = cacheResult.installPath;
  plugin.source = marketplaceName;

  return {
    ok: true,
    pluginId,
    plugin,
    installPath: cacheResult.installPath,
    marketplace: marketplaceName,
  };
}

// ---------------------------------------------------------------------------
// Local install helpers
// ---------------------------------------------------------------------------

/** Top-level entries that should never be copied from a plugin directory. */
const EXCLUDED_TOP_LEVEL = new Set(['.git', 'node_modules', '.env']);
const EXCLUDED_PATTERNS = [/^\.env\./]; // .env.local, .env.production, etc.

export { getPluginContentValidationError } from '../validation/pluginContentValidation.js';

/**
 * Derive a plugin name from a directory path using its basename.
 *
 * Strips leading dots and returns the remainder verbatim. The directory passed
 * to a local install is treated as the plugin root, so the name comes straight
 * from its basename. When a manifest is present the loader's manifest.name
 * takes precedence over this value.
 *
 * Returns `undefined` only when the stripped basename is empty.
 */
function derivePluginNameFromPath(absolutePath: string): string | undefined {
  const stripped = basename(absolutePath).replace(/^\.+/, '');
  if (!stripped) return undefined;
  return stripped;
}

interface LocalInstallArgs {
  sourcePath: string;
  plugin: LoadedPlugin;
  name: string;
  version: string;
  scope: Exclude<PluginScope, 'managed'>;
  projectPath?: string;
}

/**
 * Copy a plugin directory to the versioned cache path and register
 * the installation entry.
 */
async function copyAndRegisterLocalPlugin(
  args: LocalInstallArgs,
): Promise<InstallPluginResult | PluginOperationError> {
  const { sourcePath, plugin, name, version, scope, projectPath } = args;
  const pluginId = buildPluginId(name, 'local');
  const cachePath = getVersionedCachePath('local', name, version);

  try {
    const canonicalSourceRoot = await realpath(sourcePath);
    // A same-version reinstall must replace the old tree rather than merge
    // into it; otherwise commands/hooks removed from the new source survive.
    await rm(cachePath, { recursive: true, force: true });
    await cp(sourcePath, cachePath, {
      recursive: true,
      force: true,
      // Dereference symlinks — copy the target content, never the link itself
      dereference: true,
      // Blocklist: exclude known harmful entries, allow everything else
      filter: async (srcPath) => {
        if (srcPath === sourcePath) return true;
        const rel = srcPath.slice(sourcePath.length + 1).split(sep)[0];
        if (!rel) return true;
        if (EXCLUDED_TOP_LEVEL.has(rel)) return false;
        if (EXCLUDED_PATTERNS.some((p) => p.test(rel))) return false;
        // With dereference enabled, materialize safe top-level links while
        // preventing the copy from reaching outside or recursing into an
        // ancestor directory.
        if (srcPath === `${sourcePath}${sep}${rel}`) {
          try {
            const sourceStat = await lstat(srcPath);
            if (sourceStat.isSymbolicLink()) {
              const canonicalTarget = await realpath(srcPath);
              const targetStat = await stat(srcPath);
              const canonicalParent = await realpath(dirname(srcPath));
              if (
                !isPathContained(canonicalTarget, canonicalSourceRoot) ||
                (targetStat.isDirectory() &&
                  isPathContained(canonicalParent, canonicalTarget))
              ) {
                debugLogger.warn(
                  `[installLocalPluginOp] Skipping unsafe symlink: ${srcPath}`,
                );
                return false;
              }
              debugLogger.debug(
                `[installLocalPluginOp] Materializing contained symlink: ${srcPath}`,
              );
            }
          } catch {
            // If we can't stat it, skip it
            return false;
          }
        }
        return true;
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        plugin: name,
        error: `Failed to copy plugin to cache: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  const installEntry: PluginInstallationEntry = {
    scope,
    installPath: cachePath,
    displayName: plugin.displayName,
    version,
    installedAt: new Date().toISOString(),
    projectPath,
  };
  addPluginInstallation(pluginId, installEntry);

  return {
    ok: true,
    pluginId,
    plugin,
    installPath: cachePath,
    marketplace: 'local',
  };
}

/**
 * Install a plugin from a local directory (no marketplace lookup).
 *
 * The path is always treated as the plugin root (it must contain convention
 * dirs/files or a manifest). Version subdirectories are not supported — point
 * the install directly at the directory holding the plugin content.
 *
 * Always registers as `name@local`. The version comes from the manifest's
 * `version` field when present, otherwise falls back to `local`. Completely
 * independent of the marketplace system; marketplace.json (if present) is
 * silently ignored.
 *
 * Copies to cache for consistency with the marketplace install flow.
 */
export async function installLocalPluginOp(
  pluginPath: string,
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    projectPath?: string;
  },
): Promise<InstallPluginResult | PluginOperationError> {
  const absolutePath = resolve(pluginPath);

  // The plugin loader silently tolerates missing/non-directory paths (needed
  // for --plugin-dir). As an explicit install operation, surface a precise
  // error here instead of falling through to the generic "no plugin content"
  // message.
  let pathStat;
  try {
    pathStat = await stat(absolutePath);
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        plugin: basename(absolutePath),
        error:
          (err as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? `Directory not found: ${absolutePath}`
            : `Cannot access path: ${absolutePath} (${(err as NodeJS.ErrnoException)?.code ?? err})`,
      },
    };
  }
  if (!pathStat.isDirectory()) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        plugin: basename(absolutePath),
        error: `Not a directory: ${absolutePath}`,
      },
    };
  }

  // Derive a fallback plugin name from the directory basename. When a manifest
  // is present its name wins (see below); this only matters for manifest-less,
  // convention-only plugins.
  const pluginName = derivePluginNameFromPath(absolutePath);
  if (!pluginName) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        plugin: basename(absolutePath),
        error: `Invalid plugin directory name: "${basename(absolutePath)}". The basename cannot be empty after stripping leading dots.`,
      },
    };
  }

  const loadResult = await loadPluginFromDirectory(
    absolutePath,
    'local',
    'local',
  );

  if (!loadResult.ok) {
    return { ok: false, error: loadResult.error };
  }

  const contentValidationError = getPluginContentValidationError(
    loadResult.plugin,
    absolutePath,
  );
  if (contentValidationError) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        plugin: pluginName,
        error: contentValidationError,
      },
    };
  }

  // Manifest is the source of truth for name/version; fall back to the
  // directory basename for the name and 'local' for the version.
  return copyAndRegisterLocalPlugin({
    sourcePath: absolutePath,
    plugin: loadResult.plugin,
    name: loadResult.plugin.name || pluginName,
    version: loadResult.plugin.manifest.version ?? 'local',
    scope,
    projectPath: options?.projectPath,
  });
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Uninstall a plugin at a specific scope.
 *
 * If this is the last scope, the cache directory is marked as orphaned
 * and the plugin's data directory is deleted.
 */
export async function uninstallPluginOp(
  pluginId: string,
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    projectPath?: string;
    deleteData?: boolean;
    loadedPlugins?: LoadedPlugin[];
    force?: boolean;
  },
): Promise<UninstallPluginResult | PluginOperationError> {
  const installations = getPluginInstallationsFresh(pluginId);

  if (installations.length === 0) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'uninstall',
        plugin: pluginId,
        error: `Plugin "${pluginId}" is not installed.`,
      },
    };
  }

  // Managed entries are controlled by the organization; users cannot
  // uninstall them.
  if (installations.some((e) => e.scope === 'managed')) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'uninstall',
        plugin: pluginId,
        error: `Plugin "${pluginId}" is blocked by enterprise policy and cannot be uninstalled.`,
      },
    };
  }

  // Find installation at the specified scope
  const scopeEntry = installations.find(
    (e) =>
      e.scope === scope &&
      (scope === 'project' || scope === 'local'
        ? e.projectPath === options?.projectPath
        : true),
  );

  if (!scopeEntry) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'uninstall',
        plugin: pluginId,
        error: `Plugin "${pluginId}" is not installed at scope "${scope}".`,
      },
    };
  }

  const reverseDependents =
    options?.loadedPlugins && options.force !== true
      ? findEnabledDependents(pluginId, options.loadedPlugins)
      : [];

  // Remove from installed_plugins.json
  const fullyRemoved = removePluginInstallation(
    pluginId,
    scope,
    options?.projectPath,
  );

  // If fully removed, mark cache orphaned and optionally delete data
  if (fullyRemoved) {
    if (scopeEntry.installPath && existsSync(scopeEntry.installPath)) {
      await markPluginVersionOrphaned(scopeEntry.installPath);
    }
    if (options?.deleteData !== false) {
      await deletePluginDataDir(pluginId);
    }
  }

  return {
    ok: true,
    pluginId,
    fullyRemoved,
    reverseDependents:
      reverseDependents.length > 0 ? reverseDependents : undefined,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a plugin to the latest version from its marketplace.
 *
 * Delegates to pluginInstallationHelpers for fetch/cache. Handles version
 * tracking and orphaning of old versions.
 */
export async function updatePluginOp(
  pluginId: string,
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
  },
): Promise<UpdatePluginResult | PluginOperationError> {
  const installations = getPluginInstallationsFresh(pluginId);
  const scopeEntry = installations.find(
    (e) =>
      e.scope === scope &&
      (scope === 'project' || scope === 'local'
        ? e.projectPath === options?.projectPath
        : true),
  );

  if (!scopeEntry) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'update',
        plugin: pluginId,
        error: `Plugin "${pluginId}" is not installed at scope "${scope}".`,
      },
    };
  }

  // Look up latest version
  const lookup = await getPluginById(pluginId);
  if (!lookup) {
    return {
      ok: false,
      error: {
        type: 'plugin-not-found',
        source: 'update',
        pluginId,
        marketplace: parsePluginIdentifier(pluginId).marketplace ?? 'all',
      },
    };
  }

  const { entry, marketplaceName, marketplaceInstallLocation } = lookup;
  const resolvedPluginId = buildPluginId(entry.name, marketplaceName);

  // Fetch, validate, cache via shared helpers
  options?.onProgress?.(`Downloading update for "${pluginId}"...`);
  const cacheResult = await cacheAndRegisterPlugin(
    resolvedPluginId,
    entry.source,
    scope,
    {
      projectPath: options?.projectPath,
      onProgress: options?.onProgress,
      marketplaceInstallLocation,
    },
  );

  if (!cacheResult.ok) {
    return { ok: false, error: cacheResult.error };
  }

  // Mark old version orphaned
  const oldPath = scopeEntry.installPath;
  if (oldPath && oldPath !== cacheResult.installPath && existsSync(oldPath)) {
    await markPluginVersionOrphaned(oldPath);
  }

  return {
    ok: true,
    pluginId,
    oldPath,
    newPath: cacheResult.installPath,
    version: cacheResult.version,
  };
}
