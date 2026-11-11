/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';

import {
  getInstalledPluginsV2Path,
  getKnownMarketplacesPath,
} from './pluginDirectories.js';
import {
  invalidateInstalledPluginsCache,
  loadInstalledPluginsFromDisk,
} from './management/installedPluginsManager.js';
import {
  clearMarketplacesCache,
  getMarketplaceCacheOnly,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
  type KnownMarketplace,
} from './management/marketplaceManager.js';
import { buildPluginId, parsePluginIdentifier } from './pluginIdentifier.js';
import { MarketplaceNameSchema } from './schemas.js';
import { writeFileSyncAtomic } from '../utils/fileWriteUtils.js';
import { runLogger } from '../utils/runLogger.js';
import {
  logPluginStateReadFailure,
  pluginStateWriteDiagnostics,
} from './management/pluginStateDiagnostics.js';

export type LegacyMarketplaceAliases = Record<string, string>;

export interface LegacyIdentityMigrationResult {
  changed: boolean;
  success: boolean;
}

/**
 * Discover source-like marketplace keys left by old CLI add flows.
 *
 * Discovery is cache-only and conservative: only slash-containing keys whose
 * cached manifest declares a valid canonical name are considered. If the
 * manifest is temporarily unavailable, the old state is left untouched so a
 * later startup can retry.
 */
export async function discoverLegacyMarketplaceAliases(): Promise<LegacyMarketplaceAliases> {
  const config = loadKnownMarketplacesConfig();
  const aliases: LegacyMarketplaceAliases = {};

  for (const [legacyName, entry] of Object.entries(config)) {
    if (!legacyName.includes('/')) continue;
    if (MarketplaceNameSchema.safeParse(legacyName).success) continue;

    try {
      const marketplace = await getMarketplaceCacheOnly(legacyName);
      const canonicalName = marketplace?.name;
      if (
        !canonicalName ||
        canonicalName === legacyName ||
        !MarketplaceNameSchema.safeParse(canonicalName).success
      ) {
        continue;
      }

      const canonicalEntry = config[canonicalName];
      if (
        canonicalEntry &&
        !marketplaceSourcesEqual(canonicalEntry, entry)
      ) {
        runLogger.warn(
          `[PluginMigration] Cannot normalize marketplace "${legacyName}" to "${canonicalName}": canonical name already uses a different source`,
        );
        continue;
      }

      aliases[legacyName] = canonicalName;
    } catch (error) {
      runLogger.debug(
        `[PluginMigration] Cannot inspect legacy marketplace "${legacyName}" yet: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return aliases;
}

/**
 * Rewrite installed V2 plugin IDs from legacy marketplace aliases to their
 * canonical manifest names. The raw object is preserved so unrelated malformed
 * or sibling-owned entries are never deleted as a side effect of this repair.
 */
export function migrateInstalledPluginIds(
  aliases: LegacyMarketplaceAliases,
): LegacyIdentityMigrationResult {
  if (Object.keys(aliases).length === 0) {
    return { changed: false, success: true };
  }

  const filePath = getInstalledPluginsV2Path();
  let json: unknown;
  let raw: string | undefined;
  try {
    raw = readFileSync(filePath, 'utf-8');
    json = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logPluginStateReadFailure(
        filePath,
        raw,
        (error as NodeJS.ErrnoException).code ??
          (raw === undefined ? 'UNKNOWN' : 'JSON_INVALID'),
      );
      runLogger.warn(
        `[PluginMigration] Cannot read installed plugin state: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { changed: false, success: false };
    }

    // Preserve the existing one-time migration from the legacy shared file.
    // It may materialize installed_plugins_v2.json for us.
    invalidateInstalledPluginsCache();
    loadInstalledPluginsFromDisk();
    try {
      raw = undefined;
      raw = readFileSync(filePath, 'utf-8');
      json = JSON.parse(raw);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') {
        return { changed: false, success: true };
      }
      logPluginStateReadFailure(
        filePath,
        raw,
        (retryError as NodeJS.ErrnoException).code ??
          (raw === undefined ? 'UNKNOWN' : 'JSON_INVALID'),
      );
      runLogger.warn(
        `[PluginMigration] Cannot read migrated plugin state: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      );
      return { changed: false, success: false };
    }
  }

  const root = json as { version?: unknown; plugins?: unknown } | null;
  if (
    !root ||
    typeof root !== 'object' ||
    root.version !== 2 ||
    !root.plugins ||
    typeof root.plugins !== 'object' ||
    Array.isArray(root.plugins)
  ) {
    runLogger.warn(
      `[PluginMigration] Cannot normalize plugin IDs because ${filePath} is not a V2 state`,
    );
    return { changed: false, success: false };
  }

  const plugins = root.plugins as Record<string, unknown>;
  let changed = false;

  for (const pluginId of Object.keys(plugins)) {
    const { name, marketplace } = parsePluginIdentifier(pluginId);
    if (!marketplace) continue;
    const canonicalMarketplace = aliases[marketplace];
    if (!canonicalMarketplace) continue;

    const legacyEntries = plugins[pluginId];
    if (!Array.isArray(legacyEntries)) {
      runLogger.warn(
        `[PluginMigration] Cannot normalize installed plugin "${pluginId}": installation entries are not an array`,
      );
      return { changed: false, success: false };
    }

    const canonicalId = buildPluginId(name, canonicalMarketplace);
    const canonicalEntries = plugins[canonicalId];
    if (canonicalEntries !== undefined && !Array.isArray(canonicalEntries)) {
      runLogger.warn(
        `[PluginMigration] Cannot merge installed plugin "${pluginId}" into "${canonicalId}": canonical entries are not an array`,
      );
      return { changed: false, success: false };
    }

    plugins[canonicalId] = mergeInstallationEntries(
      legacyEntries,
      canonicalEntries ?? [],
    );
    delete plugins[pluginId];
    changed = true;
  }

  if (!changed) return { changed: false, success: true };

  try {
    writeFileSyncAtomic(filePath, JSON.stringify(json, null, 2), {
      encoding: 'utf8',
      onDiagnostic: pluginStateWriteDiagnostics('identity-migration'),
    });
    invalidateInstalledPluginsCache();
    return { changed: true, success: true };
  } catch (error) {
    runLogger.warn(
      `[PluginMigration] Failed to save normalized plugin IDs: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { changed: false, success: false };
  }
}

/**
 * Commit marketplace key normalization after all dependent state has migrated.
 * Keeping this as the last step makes an interrupted migration discoverable
 * and retryable on the next startup.
 */
export function commitLegacyMarketplaceAliases(
  aliases: LegacyMarketplaceAliases,
): LegacyIdentityMigrationResult {
  if (Object.keys(aliases).length === 0) {
    return { changed: false, success: true };
  }

  const current = loadKnownMarketplacesConfig();
  const next = { ...current };
  let changed = false;

  for (const [legacyName, canonicalName] of Object.entries(aliases)) {
    const legacyEntry = next[legacyName];
    if (!legacyEntry) continue;

    const canonicalEntry = next[canonicalName];
    if (
      canonicalEntry &&
      !marketplaceSourcesEqual(canonicalEntry, legacyEntry)
    ) {
      runLogger.warn(
        `[PluginMigration] Marketplace "${legacyName}" was not normalized because "${canonicalName}" now uses a different source`,
      );
      return { changed: false, success: false };
    }

    if (!canonicalEntry) next[canonicalName] = legacyEntry;
    delete next[legacyName];
    changed = true;
  }

  if (!changed) return { changed: false, success: true };

  try {
    saveKnownMarketplacesConfig(next);
    clearMarketplacesCache();
    return { changed: true, success: true };
  } catch (error) {
    runLogger.warn(
      `[PluginMigration] Failed to save normalized marketplaces at ${getKnownMarketplacesPath()}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { changed: false, success: false };
  }
}

function mergeInstallationEntries(
  legacyEntries: unknown[],
  canonicalEntries: unknown[],
): unknown[] {
  const merged = [...legacyEntries];
  const indices = new Map<string, number>();

  for (let i = 0; i < merged.length; i++) {
    const identity = getInstallationIdentity(merged[i]);
    if (identity) indices.set(identity, i);
  }

  // Canonical entries win collisions: they may have been written more
  // recently than the legacy record.
  for (const entry of canonicalEntries) {
    const identity = getInstallationIdentity(entry);
    const existingIndex = identity ? indices.get(identity) : undefined;
    if (existingIndex === undefined) {
      if (identity) indices.set(identity, merged.length);
      merged.push(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }

  return merged;
}

function getInstallationIdentity(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const scope = record['scope'];
  if (!isString(scope)) return null;
  if (scope === 'project' || scope === 'local') {
    return `${scope}:${String(record['projectPath'] ?? '')}`;
  }
  return scope;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function marketplaceSourcesEqual(
  left: KnownMarketplace,
  right: KnownMarketplace,
): boolean {
  return stableStringify(left.source) === stableStringify(right.source);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
