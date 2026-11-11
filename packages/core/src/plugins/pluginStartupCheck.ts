/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../utils/runLogger.js';
import {
  isPluginInstalled,
  isPluginInstalledForCwd,
} from './management/installedPluginsManager.js';
import {
  getPluginByIdCacheOnly,
  type MarketplaceProgressFn,
} from './management/marketplaceManager.js';
import { installResolvedPlugin } from './management/pluginInstallationHelpers.js';
import { parsePluginIdentifier, buildPluginId } from './pluginIdentifier.js';
import {
  ENTERPRISE_MARKETPLACE_PREFIXES,
  type PluginScope,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginInstallResult {
  installed: string[];
  failed: Array<{ pluginId: string; error: string }>;
}

export interface MissingPluginCheck {
  pluginId: string;
  reason: 'not-installed';
}

// ---------------------------------------------------------------------------
// Check enabled plugins
// ---------------------------------------------------------------------------

/**
 * Given a list of enabled plugin IDs (from settings), find those that are
 * registered external marketplace plugins and are not installed for the current cwd.
 * Local path entries are loaded in place and therefore do not require an
 * installation record. Settings-only intent that cannot be attributed to a
 * registered marketplace is shared configuration, not a CLI installation
 * failure, so it is logged and ignored.
 *
 * @param enabledPluginIds Plugin IDs declared as enabled (e.g., from settings.plugins.enabled)
 * @param cwd Current working directory used for project/local scope checks
 * @returns Missing registered external plugin diagnostics
 */
export async function findMissingPlugins(
  enabledPluginIds: string[],
  cwd?: string,
): Promise<MissingPluginCheck[]> {
  // Filter to plugins not installed for this cwd, then look up all in parallel.
  const candidates = enabledPluginIds.filter(
    (id) => !(cwd ? isPluginInstalledForCwd(id, cwd) : isPluginInstalled(id)),
  );

  const lookups = await Promise.all(
    candidates.map(async (pluginId) => {
      const { name, marketplace } = parsePluginIdentifier(pluginId);
      const normalizedMarketplace = marketplace?.toLowerCase();
      if (normalizedMarketplace === 'local') {
        runLogger.log(
          `[StartupCheck] Ignoring local plugin intent "${pluginId}" without an installation for the current project`,
        );
        return null;
      }
      if (
        normalizedMarketplace &&
        ENTERPRISE_MARKETPLACE_PREFIXES.some((prefix) =>
          normalizedMarketplace.startsWith(prefix),
        )
      ) {
        runLogger.log(
          `[StartupCheck] Ignoring enterprise-managed plugin intent "${pluginId}"; enterpriseSync owns its lifecycle`,
        );
        return null;
      }
      const qualifiedId = marketplace ? pluginId : name;
      const lookup = await getPluginByIdCacheOnly(qualifiedId);
      if (lookup) {
        // Marketplace-relative/local directory plugins are loaded in place.
        // They intentionally have no installed_plugins registry entry.
        if (typeof lookup.entry.source === 'string') return null;
        return {
          pluginId: buildPluginId(lookup.entry.name, lookup.marketplaceName),
          reason: 'not-installed' as const,
        };
      }
      runLogger.log(
        `[StartupCheck] Ignoring enabled plugin intent "${pluginId}" because it is not resolvable from a registered marketplace`,
      );
      return null;
    }),
  );

  return lookups.filter(
    (result): result is MissingPluginCheck => result !== null,
  );
}

/**
 * Check enabled plugins against installed state and return the list of
 * missing plugin IDs.
 *
 * @param enabledPluginIds Plugin IDs from settings
 * @param disabledPluginIds Plugin IDs explicitly disabled
 */
export async function checkEnabledPlugins(
  enabledPluginIds: string[],
  disabledPluginIds?: string[],
  cwd?: string,
): Promise<MissingPluginCheck[]> {
  const disabledSet = new Set(disabledPluginIds ?? []);

  // Filter out explicitly disabled plugins
  const effectiveEnabled = enabledPluginIds.filter(
    (id) => !disabledSet.has(id),
  );

  return findMissingPlugins(effectiveEnabled, cwd);
}

// ---------------------------------------------------------------------------
// Install missing plugins
// ---------------------------------------------------------------------------

/**
 * Install a list of missing plugins.
 *
 * @param pluginIds Plugin IDs to install
 * @param scope Installation scope
 * @param options Additional options
 */
export async function installSelectedPlugins(
  pluginIds: string[],
  scope: Exclude<PluginScope, 'managed'>,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    blockedMarketplaces?: string[];
    strictKnownMarketplaces?: boolean;
    /** Re-check desired state immediately before each asynchronous install. */
    shouldInstall?: (pluginId: string) => boolean;
  },
): Promise<PluginInstallResult> {
  const result: PluginInstallResult = {
    installed: [],
    failed: [],
  };

  for (const pluginId of pluginIds) {
    if (options?.shouldInstall && !options.shouldInstall(pluginId)) {
      runLogger.log(
        `[StartupCheck] Skipping "${pluginId}" because it is no longer enabled`,
      );
      continue;
    }
    options?.onProgress?.(`Installing "${pluginId}"...`);

    const installResult = await installResolvedPlugin(pluginId, scope, {
      projectPath: options?.projectPath,
      onProgress: options?.onProgress,
      blockedMarketplaces: options?.blockedMarketplaces,
      strictKnownMarketplaces: options?.strictKnownMarketplaces,
    });

    if (installResult.ok) {
      result.installed.push(pluginId);
      runLogger.log(`[StartupCheck] Installed "${pluginId}"`);
    } else {
      result.failed.push({ pluginId, error: installResult.error });
      runLogger.warn(
        `[StartupCheck] Failed to install "${pluginId}": ${installResult.error}`,
      );
    }
  }

  return result;
}
