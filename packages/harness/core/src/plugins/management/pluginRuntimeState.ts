/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve, sep } from 'node:path';

import { buildPluginId, parsePluginIdentifier } from '../pluginIdentifier.js';
import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import type { LoadedPlugin, PluginError } from '../types.js';
import {
  type InstalledPluginsState,
} from './installedPluginsManager.js';

export interface InstalledPluginItem {
  type: 'plugin';
  id: string;
  name: string;
  plugin: LoadedPlugin;
  marketplace: string;
  isEnabled: boolean;
  errorCount: number;
  needsReload?: boolean;
  pendingRemoval?: boolean;
  installScope?: string;
  shadowed?: boolean;
  shadowedBy?: string;
  canToggle?: boolean;
}

export interface FailedPluginItem {
  type: 'failed-plugin';
  id: string;
  name: string;
  marketplace: string;
  errorCount: number;
  errors: PluginError[];
}

export type PluginMcpServerStatus =
  | 'connected'
  | 'disabled'
  | 'pending'
  | 'needs-auth'
  | 'failed';

export interface PluginMcpServerItem {
  type: 'mcp-server';
  id: string;
  name: string;
  status: PluginMcpServerStatus;
  indented: boolean;
  parentPlugin?: string;
  parentScope?: string;
}

export interface PendingPluginItem {
  type: 'pending-plugin';
  id: string;
  name: string;
  installPath: string;
  scope: string;
  isEnabled: boolean;
  needsReload: true;
  shadowed?: boolean;
  shadowedBy?: string;
}

export type PluginRuntimeItem =
  | InstalledPluginItem
  | FailedPluginItem
  | PluginMcpServerItem
  | PendingPluginItem;

export interface BuildPluginRuntimeItemsOptions {
  isPluginExcluded?: (pluginId: string) => boolean;
  runtimePlugins: LoadedPlugin[];
  pluginErrors: PluginError[];
  enabledPlugins?: Readonly<Record<string, boolean>>;
  blockedMarketplaces?: readonly string[];
  installedState: InstalledPluginsState;
  cwd: string;
  /** Product-computed state for externally managed installations. */
  additionalPluginStates?: ReadonlyMap<string, { enabled: boolean; canToggle: boolean }>;
  /** Live connection status per MCP server name; missing names render as pending. */
  mcpServerStatuses?: ReadonlyMap<string, PluginMcpServerStatus>;
}

const SCOPE_ORDER: Record<string, number> = {
  flag: 0,
  local: 1,
  project: 2,
  user: 3,
  managed: 4,
  builtin: 5,
};

function projectPathApplies(
  entryProjectPath: string | undefined,
  cwd: string,
): boolean {
  if (!entryProjectPath) return true;
  const entryPath = resolve(entryProjectPath);
  const currentPath = resolve(cwd);
  return (
    currentPath === entryPath || currentPath.startsWith(`${entryPath}${sep}`)
  );
}

/**
 * Build the installed-plugin state consumed by interactive renderers. Disk is
 * authoritative for installed plugins; session-only and built-in plugins do not
 * require an installation record. Other runtime plugins expose pending removal.
 */
export function buildPluginRuntimeItems(
  options: BuildPluginRuntimeItemsOptions,
): PluginRuntimeItem[] {
  const {
    runtimePlugins,
    pluginErrors,
    installedState,
    cwd,
  } = options;
  const isPluginExcluded = options.isPluginExcluded ?? (() => false);
  const enabledIds = new Set(
    Object.entries(options.enabledPlugins ?? {})
      .filter(([, enabled]) => enabled)
      .map(([pluginId]) => pluginId)
      .filter((pluginId) => !isPluginExcluded(pluginId)),
  );
  const configuredIds = new Set(
    Object.keys(options.enabledPlugins ?? {}).filter(
      (pluginId) => !isPluginExcluded(pluginId),
    ),
  );
  const items: PluginRuntimeItem[] = [];
  const blockedMarketplaceSet = new Set(
    getEffectiveBlockedMarketplaces(options.blockedMarketplaces),
  );
  const isBlockedMarketplace = (marketplace: string | undefined): boolean =>
    !!marketplace && blockedMarketplaceSet.has(marketplace.toLowerCase());
  const isBlockedPluginId = (pluginId: string): boolean => {
    if (isPluginExcluded(pluginId)) return true;
    return isBlockedMarketplace(parsePluginIdentifier(pluginId).marketplace);
  };
  const isBlockedPluginError = (error: PluginError): boolean => {
    if ('marketplace' in error && isBlockedMarketplace(error.marketplace)) {
      return true;
    }
    if (
      'pluginId' in error &&
      error.pluginId &&
      isBlockedPluginId(error.pluginId)
    ) return true;
    return isBlockedMarketplace(error.source);
  };

  const errorsByPlugin = new Map<string, PluginError[]>();
  for (const error of pluginErrors) {
    if (isBlockedPluginError(error)) continue;
    const pluginName =
      ('pluginId' in error ? error.pluginId : undefined) ?? error.source;
    const errors = errorsByPlugin.get(pluginName) ?? [];
    errors.push(error);
    errorsByPlugin.set(pluginName, errors);
  }

  const runtimeMap = new Map<string, LoadedPlugin>();
  const runtimeNames = new Set<string>();
  const flagLoadedNames = new Set<string>();
  for (const plugin of runtimePlugins) {
    const pluginId = buildPluginId(plugin.name, plugin.source);
    if (isPluginExcluded(pluginId)) continue;
    runtimeMap.set(pluginId, plugin);
    runtimeNames.add(plugin.name);
    if (plugin.source === 'flag') flagLoadedNames.add(plugin.name);
  }

  for (const [name, errors] of errorsByPlugin) {
    if (runtimeNames.has(name)) continue;
    items.push({
      type: 'failed-plugin',
      id: `failed-${name}`,
      name,
      marketplace: errors[0]?.source ?? '',
      errorCount: errors.length,
      errors,
    });
  }

  const processedRuntimeIds = new Set<string>();
  for (const [pluginId, entries] of Object.entries(installedState.plugins)) {
    if (isPluginExcluded(pluginId)) continue;
    const { marketplace, name } = parsePluginIdentifier(pluginId);
    if (isBlockedMarketplace(marketplace)) continue;
    const additionalState = options.additionalPluginStates?.get(pluginId);
    const hasManagedEntry = entries.some((entry) => entry.scope === 'managed');
    const visibleEntries = additionalState
      ? entries
      : entries.filter((entry) => entry.scope !== 'managed');
    if (hasManagedEntry && visibleEntries.length === 0) {
      processedRuntimeIds.add(pluginId);
      continue;
    }
    if (!entries.length) continue;
    if (!additionalState && !configuredIds.has(pluginId)) continue;

    const sortedEntries = visibleEntries
      .filter(
        (entry) =>
          (entry.scope !== 'project' && entry.scope !== 'local') ||
          projectPathApplies(entry.projectPath, cwd),
      )
      .sort(
        (a, b) => (SCOPE_ORDER[a.scope] ?? 99) - (SCOPE_ORDER[b.scope] ?? 99),
      );
    const shadowedByFlag = flagLoadedNames.has(name || pluginId);
    let primaryEntry: (typeof sortedEntries)[0] | null = null;

    for (let index = 0; index < sortedEntries.length; index++) {
      const entry = sortedEntries[index];
      const isShadowed = index > 0 || shadowedByFlag;
      if (!primaryEntry) primaryEntry = entry;

      const runtimePlugin = !isShadowed ? runtimeMap.get(pluginId) : undefined;
      const isAdditionalEntry = !!additionalState && entry.scope === 'managed';
      const diskEnabled = isAdditionalEntry ? additionalState.enabled : enabledIds.has(pluginId);

      if (runtimePlugin && !isShadowed) {
        processedRuntimeIds.add(pluginId);
        const runtimeEnabled = runtimePlugin.enabled !== false;
        items.push({
          type: 'plugin',
          id: `plugin-${runtimePlugin.name}`,
          name: runtimePlugin.displayName ?? runtimePlugin.name,
          plugin: runtimePlugin,
          marketplace: runtimePlugin.source ?? '',
          isEnabled: diskEnabled,
          errorCount: errorsByPlugin.get(runtimePlugin.name)?.length ?? 0,
          needsReload: isAdditionalEntry ? false : runtimeEnabled !== diskEnabled,
          installScope: entry.scope,
          canToggle: !isAdditionalEntry || additionalState.canToggle,
        });

        for (const serverName of Object.keys(runtimePlugin.mcpServers ?? {})) {
          items.push({
            type: 'mcp-server',
            id: `mcp-${runtimePlugin.name}-${serverName}`,
            name: serverName,
            status: diskEnabled
              ? (options.mcpServerStatuses?.get(serverName) ?? 'pending')
              : 'disabled',
            indented: true,
            parentPlugin: runtimePlugin.name,
            parentScope: entry.scope,
          });
        }
      } else if (isShadowed) {
        const shadowedBy = shadowedByFlag ? 'flag' : primaryEntry.scope;
        const shadowedRuntimePlugin = runtimeMap.get(pluginId);
        if (shadowedRuntimePlugin) {
          items.push({
            type: 'plugin',
            id: `plugin-${shadowedRuntimePlugin.name}-${entry.scope}`,
            name:
              shadowedRuntimePlugin.displayName ?? shadowedRuntimePlugin.name,
            plugin: shadowedRuntimePlugin,
            marketplace: shadowedRuntimePlugin.source ?? '',
            isEnabled: enabledIds.has(pluginId),
            errorCount: 0,
            installScope: entry.scope,
            shadowed: true,
            shadowedBy,
          });
        } else {
          items.push({
            type: 'pending-plugin',
            id: `pending-${pluginId}-${entry.scope}`,
            name: name || pluginId,
            installPath: entry.installPath,
            scope: entry.scope,
            isEnabled: enabledIds.has(pluginId),
            needsReload: true,
            shadowed: true,
            shadowedBy,
          });
        }
      } else {
        items.push({
          type: 'pending-plugin',
          id: `pending-${pluginId}-${entry.scope}`,
          name: name || pluginId,
          installPath: entry.installPath,
          scope: entry.scope,
          isEnabled: diskEnabled,
          needsReload: true,
        });
      }
    }
  }

  for (const [pluginId, plugin] of runtimeMap) {
    if (processedRuntimeIds.has(pluginId)) continue;
    if (isBlockedMarketplace(parsePluginIdentifier(pluginId).marketplace)) {
      continue;
    }
    const isFlagLoaded = plugin.source === 'flag';
    const isBuiltin = plugin.isBuiltin === true;
    const requiresInstallation = !isFlagLoaded && !isBuiltin;
    items.push({
      type: 'plugin',
      id: `plugin-${plugin.name}`,
      name: plugin.displayName ?? plugin.name,
      plugin,
      marketplace: plugin.source ?? '',
      isEnabled: plugin.enabled !== false,
      errorCount: errorsByPlugin.get(plugin.name)?.length ?? 0,
      pendingRemoval: requiresInstallation,
      needsReload: requiresInstallation,
      installScope: isFlagLoaded ? 'flag' : isBuiltin ? 'builtin' : undefined,
    });
  }

  return items;
}
