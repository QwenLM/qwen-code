/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfigHomeDir, homedir } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import { sanitizePluginId } from './pluginIdentifier.js';
import {
  ENV_PLUGIN_CACHE_DIR,
} from '../config/brand.js';

/**
 * Get the full path to the plugins directory.
 *
 * Priority:
 * 1. ENV_PLUGIN_CACHE_DIR env var (explicit override)
 * 2. Default: <global config dir>/plugins
 */
export function getPluginsDirectory(): string {
  const envOverride = process.env[ENV_PLUGIN_CACHE_DIR];
  if (envOverride) {
    // Handle tilde expansion for env vars set outside of shell
    if (envOverride.startsWith('~')) {
      return join(homedir(), envOverride.slice(1));
    }
    return envOverride;
  }
  return join(getConfigHomeDir(), 'plugins');
}

/**
 * Get the path to the plugin cache directory.
 * Structure: {pluginsDir}/cache/{marketplace}/{plugin}/{version}/
 */
export function getPluginCachePath(): string {
  return join(getPluginsDirectory(), 'cache');
}

/**
 * Get the path to the marketplaces directory.
 * Stores cloned/cached marketplace manifests.
 */
export function getMarketplacesDirectory(): string {
  return join(getPluginsDirectory(), 'marketplaces');
}

/**
 * Get the path to the installed_plugins.json file.
 *
 * **Read-only as of the V2 split**. This is the legacy / shared file that the
 * sibling IDE product still writes to in V1 `plugins[id] = object` shape.
 * CLI must NOT write to this file — see `getInstalledPluginsV2Path()`.
 */
export function getInstalledPluginsPath(): string {
  return join(getPluginsDirectory(), 'installed_plugins.json');
}

/**
 * Get the path to the CLI-owned V2 installed plugins file.
 *
 * Cross-product co-existence protocol: the sibling IDE product writes V1
 * (`plugins[id] = object`) into the shared `installed_plugins.json`. If CLI
 * keeps writing the same file in V2 (`plugins[id] = entry[]`), IDE entries
 * would either be overwritten or break IDE's parser. So CLI moves all of its
 * read/write into this separate V2 file; the legacy file is read once for a
 * one-way migration of any already-V2-shaped entries the CLI itself wrote in
 * an earlier session, then left alone.
 */
export function getInstalledPluginsV2Path(): string {
  return join(getPluginsDirectory(), 'installed_plugins_v2.json');
}

/**
 * Get the path to the known_marketplaces.json file.
 */
export function getKnownMarketplacesPath(): string {
  return join(getPluginsDirectory(), 'known_marketplaces.json');
}

/**
 * Get the versioned cache path for a specific plugin version.
 *
 * @param marketplace Marketplace name (or '_default' for local)
 * @param pluginName Plugin name
 * @param version Version string (semver or git sha)
 * @returns Absolute path to the versioned cache directory
 */
export function getVersionedCachePath(
  marketplace: string,
  pluginName: string,
  version: string,
): string {
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-');
  return join(
    getPluginCachePath(),
    sanitizePluginId(marketplace || '_default'),
    sanitizePluginId(pluginName),
    sanitizedVersion,
  );
}

/**
 * Pure path to a plugin's persistent data directory.
 * Does NOT create the directory — use getPluginDataDir() for that.
 */
export function pluginDataDirPath(pluginId: string): string {
  return join(getPluginsDirectory(), 'data', sanitizePluginId(pluginId));
}

/**
 * Get (and create) the persistent data directory for a plugin.
 *
 * Unlike the version-scoped install cache (which is orphaned and GC'd on
 * every update), this directory survives plugin updates — only removed on
 * last-scope uninstall.
 *
 * Sync because it may be called from sync String.replace() contexts.
 */
export function getPluginDataDir(pluginId: string): string {
  const dir = pluginDataDirPath(pluginId);
  mkdirSync(dir, { recursive: true });
  return dir;
}


/**
 * Best-effort cleanup of a plugin's data directory on last-scope uninstall.
 */
export async function deletePluginDataDir(pluginId: string): Promise<void> {
  const dir = pluginDataDirPath(pluginId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    runLogger.warn(
      `Failed to delete plugin data dir ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Ensure the plugins directory and its subdirectories exist.
 */
export function ensurePluginsDirectoryExists(): void {
  mkdirSync(getPluginsDirectory(), { recursive: true });
  mkdirSync(getPluginCachePath(), { recursive: true });
  mkdirSync(getMarketplacesDirectory(), { recursive: true });
}
