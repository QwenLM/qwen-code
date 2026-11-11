/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parsePluginIdentifier, buildPluginId } from '../pluginIdentifier.js';
import { isPluginInstalled } from './installedPluginsManager.js';
import { installPluginOp } from './pluginOperations.js';
import type { LoadedPlugin, PluginError } from '../types.js';
import type { PluginScope } from '../schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyCheckResult {
  /** All dependencies satisfied */
  satisfied: boolean;
  /** Dependencies that are installed and enabled */
  resolved: string[];
  /** Dependencies that are missing or disabled */
  unsatisfied: DependencyIssue[];
}

export interface DependencyIssue {
  /** The dependency reference as written in manifest */
  ref: string;
  /** Resolved plugin ID (name@marketplace) */
  pluginId: string;
  /** Why it's unsatisfied */
  reason: 'not-installed' | 'not-enabled' | 'not-found-in-marketplace';
}

export interface AutoInstallResult {
  installed: string[];
  failed: Array<{ pluginId: string; error: PluginError }>;
}

export function getLoadedPluginId(plugin: Pick<LoadedPlugin, 'name' | 'source'>): string {
  return buildPluginId(plugin.name, plugin.source);
}

export function dependencyRefToString(dep: unknown): string {
  if (typeof dep === 'string') return dep;
  if (
    dep &&
    typeof dep === 'object' &&
    'name' in dep &&
    typeof (dep as { name: unknown }).name === 'string'
  ) {
    const obj = dep as { name: string; marketplace?: unknown };
    return typeof obj.marketplace === 'string'
      ? `${obj.name}@${obj.marketplace}`
      : obj.name;
  }
  return `${dep}`;
}

export function resolveDependencyPluginId(
  dependency: unknown,
  plugin: LoadedPlugin,
): string {
  const depRef = dependencyRefToString(dependency);
  const { name, marketplace } = parsePluginIdentifier(depRef);
  const resolvedMarketplace = marketplace ?? plugin.source;
  return resolvedMarketplace ? buildPluginId(name, resolvedMarketplace) : name;
}

// ---------------------------------------------------------------------------
// Dependency checking
// ---------------------------------------------------------------------------

/**
 * Check if all dependencies of a plugin are satisfied.
 *
 * @param plugin The plugin whose dependencies to check
 * @param enabledPluginIds Set of currently enabled plugin IDs
 * @returns Result indicating whether all deps are met
 */
export function checkDependencies(
  plugin: LoadedPlugin,
  enabledPluginIds: Set<string>,
): DependencyCheckResult {
  const deps = plugin.manifest.dependencies ?? [];
  const resolved: string[] = [];
  const unsatisfied: DependencyIssue[] = [];

  for (const dep of deps) {
    const depRef = dependencyRefToString(dep);
    const { name } = parsePluginIdentifier(depRef);
    const depPluginId = resolveDependencyPluginId(dep, plugin);

    // Check if installed
    if (!isPluginInstalled(depPluginId)) {
      // Also try bare name match (for local plugins)
      const bareInstalled = isPluginInstalled(name);
      if (!bareInstalled) {
        unsatisfied.push({
          ref: depRef,
          pluginId: depPluginId,
          reason: 'not-installed',
        });
        continue;
      }
    }

    // Check if enabled
    if (!enabledPluginIds.has(depPluginId) && !enabledPluginIds.has(name)) {
      unsatisfied.push({
        ref: depRef,
        pluginId: depPluginId,
        reason: 'not-enabled',
      });
      continue;
    }

    resolved.push(depPluginId);
  }

  return {
    satisfied: unsatisfied.length === 0,
    resolved,
    unsatisfied,
  };
}

export function verifyAndDemoteDependencies(
  plugins: readonly LoadedPlugin[],
): { demoted: Set<string>; errors: PluginError[] } {
  const knownPluginIds = new Set<string>();
  const knownPluginNames = new Set<string>();
  const enabledPluginIds = new Set<string>();
  const enabledPluginNameCounts = new Map<string, number>();
  const pluginIdMap = new Map<LoadedPlugin, string>();
  const errors: PluginError[] = [];

  for (const plugin of plugins) {
    const pluginId = getLoadedPluginId(plugin);
    pluginIdMap.set(plugin, pluginId);
    knownPluginIds.add(pluginId);
    knownPluginNames.add(plugin.name);

    if (plugin.enabled !== false) {
      enabledPluginIds.add(pluginId);
      enabledPluginNameCounts.set(
        plugin.name,
        (enabledPluginNameCounts.get(plugin.name) ?? 0) + 1,
      );
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const plugin of plugins) {
      const pluginId = pluginIdMap.get(plugin)!;
      if (!enabledPluginIds.has(pluginId)) continue;

      for (const dependency of plugin.manifest.dependencies ?? []) {
        const dependencyRef = dependencyRefToString(dependency);
        const { name, marketplace } = parsePluginIdentifier(dependencyRef);
        const dependencyId = resolveDependencyPluginId(dependency, plugin);
        const allowNameOnlyMatch =
          !marketplace &&
          (plugin.source === 'local' ||
            plugin.source === 'flag' ||
            plugin.source === 'builtin');
        const satisfied =
          enabledPluginIds.has(dependencyId) ||
          (allowNameOnlyMatch &&
            (enabledPluginNameCounts.get(name) ?? 0) > 0);

        if (satisfied) continue;

        const known =
          knownPluginIds.has(dependencyId) ||
          (allowNameOnlyMatch && knownPluginNames.has(name));

        enabledPluginIds.delete(pluginId);
        const count = enabledPluginNameCounts.get(plugin.name) ?? 0;
        if (count <= 1) {
          enabledPluginNameCounts.delete(plugin.name);
        } else {
          enabledPluginNameCounts.set(plugin.name, count - 1);
        }
        errors.push({
          type: 'dependency-unsatisfied',
          source: plugin.source,
          plugin: plugin.name,
          dependency: dependencyId,
          reason: known ? 'not-enabled' : 'not-found',
        });
        changed = true;
        break;
      }
    }
  }

  return {
    demoted: new Set(
      plugins
        .filter(
          (plugin) =>
            plugin.enabled !== false &&
            !enabledPluginIds.has(pluginIdMap.get(plugin)!),
        )
        .map((plugin) => pluginIdMap.get(plugin)!),
    ),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Auto-installation of missing dependencies
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-install missing dependencies from marketplaces.
 *
 * This only installs dependencies that are missing ('not-installed').
 * Dependencies that are installed but disabled require user action.
 *
 * @param issues The unsatisfied dependencies from checkDependencies
 * @param scope The scope to install dependencies at
 * @param options Policy and progress options
 */
export async function autoInstallDependencies(
  issues: DependencyIssue[],
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    projectPath?: string;
    strictKnownMarketplaces?: boolean;
    blockedMarketplaces?: string[];
    /** Marketplace names allowed for cross-marketplace dep resolution */
    allowedCrossMarketplaces?: string[];
    onProgress?: (msg: string) => void;
    installPlugin?: typeof installPluginOp;
  },
): Promise<AutoInstallResult> {
  const installable = issues.filter((i) => i.reason === 'not-installed');
  const installed: string[] = [];
  const failed: Array<{ pluginId: string; error: PluginError }> = [];

  for (const issue of installable) {
    const { marketplace } = parsePluginIdentifier(issue.pluginId);

    // Check if the marketplace is allowed for auto-install
    if (marketplace && options?.allowedCrossMarketplaces) {
      const allowed = new Set(options.allowedCrossMarketplaces);
      if (!allowed.has(marketplace)) {
        failed.push({
          pluginId: issue.pluginId,
          error: {
            type: 'marketplace-blocked-by-policy',
            source: 'dependency-auto-install',
            plugin: issue.pluginId,
            marketplace,
            blockedByBlocklist: false,
            allowedSources: [...allowed],
          },
        });
        continue;
      }
    }

    options?.onProgress?.(`Auto-installing dependency: ${issue.pluginId}...`);

    const result = await (options?.installPlugin ?? installPluginOp)(
      issue.pluginId,
      scope,
      {
        marketplace,
        projectPath: options?.projectPath,
        strictKnownMarketplaces: options?.strictKnownMarketplaces,
        blockedMarketplaces: options?.blockedMarketplaces,
        onProgress: options?.onProgress,
      },
    );

    if (result.ok) {
      installed.push(issue.pluginId);
    } else {
      failed.push({ pluginId: issue.pluginId, error: result.error });
    }
  }

  return { installed, failed };
}

// ---------------------------------------------------------------------------
// Dependency graph utilities
// ---------------------------------------------------------------------------

/**
 * Get the full dependency tree for a plugin (recursive).
 * Returns plugin IDs in topological order (dependencies first).
 *
 * @param pluginId The root plugin ID to resolve
 * @param loadedPlugins All currently loaded plugins
 * @returns Ordered list of dependency plugin IDs, or cycle error
 */
export function resolveDependencyOrder(
  pluginId: string,
  loadedPlugins: LoadedPlugin[],
): { order: string[] } | { cycle: string[] } {
  const pluginMap = new Map<string, LoadedPlugin>();
  for (const p of loadedPlugins) {
    const id = getLoadedPluginId(p);
    pluginMap.set(id, p);
    pluginMap.set(p.name, p); // also index by bare name
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(id: string, path: string[]): string[] | null {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return [...path, id]; // cycle detected

    visiting.add(id);
    const plugin = pluginMap.get(id);

    if (plugin) {
      const deps = plugin.manifest.dependencies ?? [];
      for (const dep of deps) {
        const depId = resolveDependencyPluginId(dep, plugin);

        const cycle = visit(depId, [...path, id]);
        if (cycle) return cycle;
      }
    }

    visiting.delete(id);
    visited.add(id);
    order.push(id);
    return null;
  }

  const cycle = visit(pluginId, []);
  if (cycle) return { cycle };
  return { order };
}

/**
 * Find all plugins that depend on a given plugin (reverse dependencies).
 * Useful for uninstall: warns user about dependents.
 *
 * @param pluginId The plugin being considered for removal
 * @param loadedPlugins All currently loaded plugins
 * @returns Plugin IDs that directly depend on the given plugin
 */
export function findDependents(
  pluginId: string,
  loadedPlugins: LoadedPlugin[],
): string[] {
  const { name: targetName } = parsePluginIdentifier(pluginId);
  const targetIsQualified = pluginId.includes('@');
  const dependents: string[] = [];

  for (const plugin of loadedPlugins) {
    const deps = plugin.manifest.dependencies ?? [];
    for (const dep of deps) {
      const depRef = dependencyRefToString(dep);
      const { name } = parsePluginIdentifier(depRef);
      const depId = resolveDependencyPluginId(dep, plugin);

      if (depId === pluginId || (!targetIsQualified && name === targetName)) {
        dependents.push(getLoadedPluginId(plugin));
        break;
      }
    }
  }

  return dependents;
}

export function findEnabledDependents(
  pluginId: string,
  loadedPlugins: LoadedPlugin[],
): string[] {
  return findDependents(
    pluginId,
    loadedPlugins.filter((plugin) => plugin.enabled !== false),
  );
}
