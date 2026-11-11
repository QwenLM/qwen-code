/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runLogger } from '../utils/runLogger.js';
import { loadKnownMarketplacesConfig } from './management/marketplaceManager.js';
import { BRAND_PLUGIN_META_DIR } from '../config/brand.js';
import {
  KnownMarketplacesFileSchema,
  type KnownMarketplacesFile,
} from './schemas.js';
import {
  atomicWriteToZipCache,
  getMarketplaceJsonRelativePath,
  getPluginZipCachePath,
  getZipCacheKnownMarketplacesPath,
} from './zipCache.js';

// ── Metadata I/O ──

/**
 * Read known_marketplaces.json from the zip cache.
 * Returns empty object if file doesn't exist, can't be parsed, or fails schema
 * validation (data comes from a shared mounted volume — other containers may write).
 */
export async function readZipCacheKnownMarketplaces(): Promise<KnownMarketplacesFile> {
  try {
    const content = await readFile(getZipCacheKnownMarketplacesPath(), 'utf-8');
    const parsed = KnownMarketplacesFileSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      runLogger.warn(
        `Invalid known_marketplaces.json in zip cache: ${parsed.error.message}`,
      );
      return {};
    }
    return parsed.data;
  } catch {
    return {};
  }
}
/**
 * Write known_marketplaces.json to the zip cache atomically.
 */
export async function writeZipCacheKnownMarketplaces(
  data: KnownMarketplacesFile,
): Promise<void> {
  await atomicWriteToZipCache(
    getZipCacheKnownMarketplacesPath(),
    JSON.stringify(data, null, 2),
  );
}


/**
 * Save a marketplace JSON to the zip cache from its install location.
 */
export async function saveMarketplaceJsonToZipCache(
  marketplaceName: string,
  installLocation: string,
): Promise<void> {
  const zipCachePath = getPluginZipCachePath();
  if (!zipCachePath) {
    return;
  }
  const content = await readMarketplaceJsonContent(installLocation);
  if (content !== null) {
    const relPath = getMarketplaceJsonRelativePath(marketplaceName);
    await atomicWriteToZipCache(join(zipCachePath, relPath), content);
  }
}

/**
 * Read marketplace.json content from a cloned marketplace directory or file.
 * Checks the brand's metadata directory, marketplace.json, and the path itself
 * (for URL sources where installLocation IS the marketplace JSON file).
 */
async function readMarketplaceJsonContent(dir: string): Promise<string | null> {
  const candidates = [
    join(dir, BRAND_PLUGIN_META_DIR, 'marketplace.json'),
    join(dir, 'marketplace.json'),
    dir, // For URL sources, installLocation IS the marketplace JSON file
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf-8');
    } catch {
      // ENOENT or EISDIR — try next
    }
  }
  return null;
}

/**
 * Sync marketplace data to zip cache for offline access.
 * Saves marketplace JSONs and merges with previously cached data
 * so ephemeral containers can access marketplaces without re-cloning.
 */
export async function syncMarketplacesToZipCache(): Promise<void> {
  let knownMarketplaces: Record<string, { installLocation?: string }>;
  try {
    knownMarketplaces = loadKnownMarketplacesConfig();
  } catch {
    // Corrupted config — don't throw during startup paths
    return;
  }

  // Save marketplace JSONs to zip cache
  for (const [name, entry] of Object.entries(knownMarketplaces)) {
    if (!entry.installLocation) continue;
    try {
      await saveMarketplaceJsonToZipCache(name, entry.installLocation);
    } catch (error) {
      runLogger.warn(`Failed to save marketplace JSON for ${name}: ${error}`);
    }
  }

  // Merge with previously cached data (ephemeral containers lose global config)
  const zipCacheKnownMarketplaces = await readZipCacheKnownMarketplaces();
  const mergedKnownMarketplaces: KnownMarketplacesFile = {
    ...zipCacheKnownMarketplaces,
    ...(knownMarketplaces as KnownMarketplacesFile),
  };
  await writeZipCacheKnownMarketplaces(mergedKnownMarketplaces);
}
