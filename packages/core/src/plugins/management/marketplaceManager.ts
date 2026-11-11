/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readFile,
  writeFile,
  mkdir,
  rm,
  rename,
  stat,
} from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative } from 'node:path';

import {
  KnownMarketplacesFileSchema,
  PluginMarketplaceSchema,
  MarketplaceNameSchema,
  type MarketplaceSource,
  type PluginMarketplaceEntry,
  isLocalMarketplaceSource,
} from '../schemas.js';
import {
  getMarketplacesDirectory,
  getKnownMarketplacesPath,
  ensurePluginsDirectoryExists,
  deletePluginDataDir,
} from '../pluginDirectories.js';
import { parsePluginIdentifier } from '../pluginIdentifier.js';
import { formatZodIssues } from '../validation/manifestErrors.js';
import { runLogger } from '../../utils/runLogger.js';
import { unmanagedRequest } from '../../utils/fetch.js';
import { removeAllPluginsForMarketplace } from './installedPluginsManager.js';
import { markPluginVersionOrphaned } from '../cacheUtils.js';
import {
  execPluginGit,
  formatPluginTimeoutDuration,
  getPluginGitTimeoutMs,
} from '../pluginGit.js';
import { copyPluginTree } from '../pluginTreeCopy.js';
import { BRAND_PLUGIN_META_DIR } from '../../config/brand.js';

const GIT_TIMEOUT_MS = getPluginGitTimeoutMs();

function isExecTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeExecError = error as Error & {
    killed?: boolean;
    signal?: NodeJS.Signals | string | null;
    code?: string | number | null;
  };

  return (
    maybeExecError.code === 'ETIMEDOUT' ||
    (maybeExecError.killed === true && maybeExecError.signal === 'SIGTERM') ||
    /\btimed out\b|\btimeout\b/i.test(error.message)
  );
}

function marketplaceGitTimeoutError(
  operation: 'clone' | 'pull',
  url: string,
): Error {
  return new Error(
    `Git ${operation} timed out after ${formatPluginTimeoutDuration()}: ${url}. Check your network connection and try again.`,
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A known marketplace entry stored in known_marketplaces.json.
 */
export interface KnownMarketplace {
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

/**
 * A fully parsed marketplace manifest.
 */
export interface PluginMarketplace {
  name: string;
  owner?: { name: string; email?: string; url?: string };
  plugins: PluginMarketplaceEntry[];
  metadata?: {
    pluginRoot?: string;
    version?: string;
    description?: string;
  };
  forceRemoveDeletedPlugins?: boolean;
  allowCrossMarketplaceDependenciesOn?: string[];
}

/**
 * Result of looking up a plugin by ID.
 */
export interface PluginLookupResult {
  entry: PluginMarketplaceEntry;
  marketplaceName: string;
  marketplaceSource: MarketplaceSource;
  /** Copy boundary for marketplace-backed local plugin sources. */
  marketplaceInstallLocation: string;
}

export interface MarketplaceRemovalResult {
  removedPluginIds: string[];
  orphanedPaths: string[];
  skippedCacheRemoval?: boolean;
}

/**
 * Progress callback for long-running marketplace operations.
 */
export type MarketplaceProgressFn = (message: string) => void;

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const marketplaceCache = new Map<string, PluginMarketplace>();
let knownMarketplacesConfigCache: Record<string, KnownMarketplace> | null =
  null;

export function clearMarketplacesCache(): void {
  marketplaceCache.clear();
  knownMarketplacesConfigCache = null;
}

// ---------------------------------------------------------------------------
// Known marketplaces config (state layer)
// ---------------------------------------------------------------------------

/**
 * Load known_marketplaces.json from disk.
 */
export function loadKnownMarketplacesConfig(): Record<
  string,
  KnownMarketplace
> {
  if (knownMarketplacesConfigCache) return knownMarketplacesConfigCache;

  const filePath = getKnownMarketplacesPath();
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    const result = KnownMarketplacesFileSchema.safeParse(json);
    if (result.success) {
      knownMarketplacesConfigCache = result.data as Record<
        string,
        KnownMarketplace
      >;
      return knownMarketplacesConfigCache;
    }
    runLogger.warn(
      `[Marketplace] Invalid known_marketplaces.json, returning empty`,
    );
    return {};
  } catch {
    return {};
  }
}

/**
 * Save known_marketplaces.json to disk.
 */
export function saveKnownMarketplacesConfig(
  config: Record<string, KnownMarketplace>,
): void {
  ensurePluginsDirectoryExists();
  const filePath = getKnownMarketplacesPath();
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  knownMarketplacesConfigCache = config;
}

/** Compare marketplace sources using JSON semantics without key-order sensitivity. */
export function marketplaceSourcesEqual(
  left: MarketplaceSource,
  right: MarketplaceSource,
): boolean {
  return stableStringify(left) === stableStringify(right);
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

function getSafeMarketplaceInstallLocation(name: string): string {
  const marketplacesDir = resolve(getMarketplacesDirectory());
  const installLocation = resolve(join(marketplacesDir, name));
  const rel = relative(marketplacesDir, installLocation);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Marketplace name "${name}" resolves outside the marketplace cache directory.`,
    );
  }
  return installLocation;
}

function isMarketplaceCacheLocation(path: string): boolean {
  const marketplacesDir = resolve(getMarketplacesDirectory());
  const target = resolve(path);
  const rel = relative(marketplacesDir, target);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Add / Remove marketplace sources
// ---------------------------------------------------------------------------

/**
 * Add a new marketplace source. Fetches the marketplace manifest and
 * saves it to the local cache.
 */
export async function addMarketplaceSource(
  name: string,
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  ensurePluginsDirectoryExists();

  const nameResult = MarketplaceNameSchema.safeParse(name);
  if (!nameResult.success) {
    throw new Error(
      `Invalid marketplace name "${name}": ${nameResult.error.issues[0]?.message}`,
    );
  }

  const config = loadKnownMarketplacesConfig();

  if (config[name]) {
    throw new Error(
      `Marketplace "${name}" already exists. Use refreshMarketplace() to update it.`,
    );
  }

  const installLocation = getSafeMarketplaceInstallLocation(name);

  onProgress?.(`Fetching marketplace "${name}"...`);
  const fetched = await fetchMarketplaceFromSource(
    source,
    installLocation,
    onProgress,
  );
  const marketplace = normalizeMarketplacePluginSources(
    fetched,
    installLocation,
  );

  config[name] = {
    source,
    installLocation,
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };
  saveKnownMarketplacesConfig(config);
  marketplaceCache.set(name, marketplace);

  return marketplace;
}

/**
 * Add a marketplace source whose manifest declares its own marketplace name.
 * This matches the user-facing `/plugin marketplace add <source>` flow.
 */
export async function addMarketplaceSourceFromSource(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressFn,
): Promise<{
  name: string;
  marketplace: PluginMarketplace;
  alreadyMaterialized: boolean;
  resolvedSource: MarketplaceSource;
}> {
  ensurePluginsDirectoryExists();

  const resolvedSource =
    isLocalMarketplaceSource(source) && !isAbsolute(source.path)
      ? { ...source, path: resolve(source.path) }
      : source;

  const config = loadKnownMarketplacesConfig();
  for (const [existingName, existingEntry] of Object.entries(config)) {
    if (marketplaceSourcesEqual(existingEntry.source, resolvedSource)) {
      const marketplace = await getMarketplace(existingName);
      if (marketplace && marketplace.name !== existingName) {
        delete config[existingName];
        config[marketplace.name] = {
          ...existingEntry,
          source: resolvedSource,
        };
        saveKnownMarketplacesConfig(config);
        marketplaceCache.delete(existingName);
        marketplaceCache.set(marketplace.name, marketplace);
        return {
          name: marketplace.name,
          marketplace,
          alreadyMaterialized: true,
          resolvedSource,
        };
      }
      return {
        name: existingName,
        marketplace:
          marketplace ?? {
            name: existingName,
            plugins: [],
          },
        alreadyMaterialized: true,
        resolvedSource,
      };
    }
  }

  const tempName = `.tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const tempLocation = join(getMarketplacesDirectory(), tempName);

  try {
    onProgress?.('Fetching marketplace...');
    const fetched = await fetchMarketplaceFromSource(
      resolvedSource,
      tempLocation,
      onProgress,
    );

    const nameResult = MarketplaceNameSchema.safeParse(fetched.name);
    if (!nameResult.success) {
      throw new Error(
        `Invalid marketplace name "${fetched.name}": ${nameResult.error.issues[0]?.message}`,
      );
    }

    const installLocation = getSafeMarketplaceInstallLocation(fetched.name);
    if (installLocation !== tempLocation) {
      await rm(installLocation, { recursive: true, force: true });
      await mkdir(dirname(installLocation), { recursive: true });
      await rename(tempLocation, installLocation);
    }

    // Resolve relative plugin sources against the final install location
    // (the marketplace was fetched into tempLocation and then relocated).
    const marketplace = normalizeMarketplacePluginSources(
      fetched,
      installLocation,
    );

    config[marketplace.name] = {
      source: resolvedSource,
      installLocation,
      lastUpdated: new Date().toISOString(),
      autoUpdate: true,
    };
    saveKnownMarketplacesConfig(config);
    marketplaceCache.set(marketplace.name, marketplace);

    return {
      name: marketplace.name,
      marketplace,
      alreadyMaterialized: false,
      resolvedSource,
    };
  } catch (error) {
    try {
      if (existsSync(tempLocation)) {
        await rm(tempLocation, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

/**
 * Remove a marketplace source and clean up cached files.
 */
export async function removeMarketplaceSource(
  name: string,
  isPluginExcluded?: (pluginId: string) => boolean,
): Promise<MarketplaceRemovalResult> {
  const config = loadKnownMarketplacesConfig();

  if (!config[name]) {
    throw new Error(`Marketplace "${name}" not found.`);
  }

  const entry = config[name];
  let skippedCacheRemoval = false;

  // Do this before touching anything else. Once the marketplace is forgotten,
  // nothing ever revisits its plugin records, so a failure here has to abort
  // while the marketplace is still intact.
  const removal = removeAllPluginsForMarketplace(name, isPluginExcluded);
  if (!removal) {
    throw new Error(
      `Cannot remove marketplace "${name}": the plugin state file is unreadable, so its plugins cannot be cleaned up.`,
    );
  }
  const { removedPluginIds, orphanedPaths } = removal;

  if (entry.installLocation && existsSync(entry.installLocation)) {
    if (isMarketplaceCacheLocation(entry.installLocation)) {
      try {
        await rm(entry.installLocation, { recursive: true, force: true });
      } catch (e) {
        runLogger.warn(
          `[Marketplace] Failed to remove cache for "${name}": ${e}`,
        );
      }
    } else {
      skippedCacheRemoval = true;
      runLogger.warn(
        `[Marketplace] Skipping cache removal for "${name}" because installLocation is outside the marketplace cache directory: ${entry.installLocation}`,
      );
    }
  }

  delete config[name];
  saveKnownMarketplacesConfig(config);
  marketplaceCache.delete(name);

  const cleanups = await Promise.allSettled([
    ...orphanedPaths.map((installPath) =>
      markPluginVersionOrphaned(installPath),
    ),
    ...removedPluginIds.map((pluginId) => deletePluginDataDir(pluginId)),
  ]);
  for (const cleanup of cleanups) {
    if (cleanup.status === 'rejected') {
      runLogger.warn(
        `[Marketplace] Best-effort cleanup failed for "${name}": ${cleanup.reason}`,
      );
    }
  }

  return { removedPluginIds, orphanedPaths, skippedCacheRemoval };
}

// ---------------------------------------------------------------------------
// Load / Refresh marketplaces
// ---------------------------------------------------------------------------

/**
 * Get a marketplace by name. Uses in-memory cache, falls back to disk,
 * then fetches from source if needed.
 */
export async function getMarketplace(
  name: string,
): Promise<PluginMarketplace | null> {
  // Check memory cache
  const cached = marketplaceCache.get(name);
  if (cached) return cached;

  const config = loadKnownMarketplacesConfig();
  const entry = config[name];
  if (!entry) return null;

  // Try loading from disk cache
  const diskResult = await loadMarketplaceFromDisk(entry.installLocation);
  if (diskResult) {
    marketplaceCache.set(name, diskResult);
    return diskResult;
  }

  // Fetch from source
  try {
    const fetched = await fetchMarketplaceFromSource(
      entry.source,
      entry.installLocation,
    );
    const marketplace = normalizeMarketplacePluginSources(
      fetched,
      entry.installLocation,
    );
    marketplaceCache.set(name, marketplace);

    // Update timestamp
    entry.lastUpdated = new Date().toISOString();
    saveKnownMarketplacesConfig(config);

    return marketplace;
  } catch (e) {
    runLogger.warn(
      `[Marketplace] Failed to fetch "${name}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Get a marketplace from disk cache only (no network).
 * Used for fast startup paths.
 */
export async function getMarketplaceCacheOnly(
  name: string,
): Promise<PluginMarketplace | null> {
  const cached = marketplaceCache.get(name);
  if (cached) return cached;

  const config = loadKnownMarketplacesConfig();
  const entry = config[name];
  if (!entry) return null;

  const diskResult = await loadMarketplaceFromDisk(entry.installLocation);
  if (diskResult) {
    marketplaceCache.set(name, diskResult);
    return diskResult;
  }

  return null;
}

/**
 * Refresh a marketplace from its source.
 */
export async function refreshMarketplace(
  name: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  const config = loadKnownMarketplacesConfig();
  const entry = config[name];
  if (!entry) {
    throw new Error(`Marketplace "${name}" not found.`);
  }
  return replaceMarketplaceCache(
    name,
    entry.source,
    `Refreshing marketplace "${name}"...`,
    onProgress,
  );
}

/**
 * Replace a marketplace's declared source without exposing a half-written
 * cache. The new source is fetched into a staging directory first; only a
 * successful fetch is swapped into place and persisted.
 */
export async function replaceMarketplaceSource(
  name: string,
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  return replaceMarketplaceCache(
    name,
    source,
    `Replacing marketplace source for "${name}"...`,
    onProgress,
  );
}

async function replaceMarketplaceCache(
  name: string,
  source: MarketplaceSource,
  progressMessage: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  ensurePluginsDirectoryExists();

  const config = loadKnownMarketplacesConfig();
  const entry = config[name];
  if (!entry) {
    throw new Error(`Marketplace "${name}" not found.`);
  }

  const finalLocation = isMarketplaceCacheLocation(entry.installLocation)
    ? entry.installLocation
    : getSafeMarketplaceInstallLocation(name);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempLocation = join(getMarketplacesDirectory(), `.tmp-replace-${nonce}`);
  const backupLocation = join(
    getMarketplacesDirectory(),
    `.backup-replace-${nonce}`,
  );
  let movedExistingCache = false;
  let installedReplacement = false;

  try {
    onProgress?.(progressMessage);
    const fetched = await fetchMarketplaceFromSource(
      source,
      tempLocation,
      onProgress,
    );
    const marketplace = normalizeMarketplacePluginSources(
      fetched,
      finalLocation,
    );

    await mkdir(dirname(finalLocation), { recursive: true });
    if (existsSync(finalLocation)) {
      await rename(finalLocation, backupLocation);
      movedExistingCache = true;
    }
    await rename(tempLocation, finalLocation);
    installedReplacement = true;

    const previousEntry = { ...entry };
    entry.source = source;
    entry.installLocation = finalLocation;
    entry.lastUpdated = new Date().toISOString();
    try {
      // Keep the shared config object so concurrent refreshes of different
      // marketplaces cannot overwrite one another's persisted timestamps or
      // cache-location migrations.
      saveKnownMarketplacesConfig(config);
    } catch (error) {
      Object.assign(entry, previousEntry);
      throw error;
    }
    marketplaceCache.set(name, marketplace);

    if (movedExistingCache) {
      try {
        await rm(backupLocation, { recursive: true, force: true });
      } catch (error) {
        runLogger.warn(
          `[Marketplace] Failed to remove replacement backup for "${name}": ${error}`,
        );
      }
    }

    return marketplace;
  } catch (error) {
    try {
      if (installedReplacement && existsSync(finalLocation)) {
        await rm(finalLocation, { recursive: true, force: true });
      }
      if (movedExistingCache && existsSync(backupLocation)) {
        await rename(backupLocation, finalLocation);
      }
      if (existsSync(tempLocation)) {
        await rm(tempLocation, { recursive: true, force: true });
      }
    } catch (rollbackError) {
      runLogger.warn(
        `[Marketplace] Failed to roll back source replacement for "${name}": ${rollbackError}`,
      );
    }
    throw error;
  }
}

/**
 * Refresh all known marketplaces.
 */
export async function refreshAllMarketplaces(
  onProgress?: MarketplaceProgressFn,
): Promise<{
  refreshed: string[];
  errors: Array<{ name: string; error: string }>;
}> {
  const config = loadKnownMarketplacesConfig();
  const names = Object.keys(config);

  const results = await Promise.allSettled(
    names.map((name) => refreshMarketplace(name, onProgress)),
  );

  const refreshed: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      refreshed.push(names[i]);
    } else {
      errors.push({
        name: names[i],
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  return { refreshed, errors };
}

/**
 * Set auto-update flag for a marketplace.
 */
export function setMarketplaceAutoUpdate(
  name: string,
  autoUpdate: boolean,
): void {
  const config = loadKnownMarketplacesConfig();
  const entry = config[name];
  if (!entry) {
    throw new Error(`Marketplace "${name}" not found.`);
  }
  entry.autoUpdate = autoUpdate;
  saveKnownMarketplacesConfig(config);
}

/**
 * List all known marketplace names.
 */
export function listKnownMarketplaces(): string[] {
  return Object.keys(loadKnownMarketplacesConfig());
}

// ---------------------------------------------------------------------------
// Plugin lookup across marketplaces
// ---------------------------------------------------------------------------

/**
 * Look up a plugin by its identifier across all known marketplaces.
 *
 * If the identifier includes a marketplace (name@marketplace), only
 * that marketplace is searched. Otherwise, all marketplaces are checked
 * and the first match wins.
 */
export async function getPluginById(
  pluginId: string,
): Promise<PluginLookupResult | null> {
  const { name, marketplace: specifiedMarketplace } =
    parsePluginIdentifier(pluginId);

  if (specifiedMarketplace) {
    const mp = await getMarketplace(specifiedMarketplace);
    if (!mp) return null;
    const config = loadKnownMarketplacesConfig();
    const entry = mp.plugins.find((p) => p.name === name);
    if (!entry) return null;
    return {
      entry,
      marketplaceName: specifiedMarketplace,
      marketplaceSource: config[specifiedMarketplace].source,
      marketplaceInstallLocation:
        config[specifiedMarketplace].installLocation,
    };
  }

  // Search all marketplaces
  const config = loadKnownMarketplacesConfig();
  for (const [mpName, mpConfig] of Object.entries(config)) {
    const mp = await getMarketplace(mpName);
    if (!mp) continue;
    const entry = mp.plugins.find((p) => p.name === name);
    if (entry) {
      return {
        entry,
        marketplaceName: mpName,
        marketplaceSource: mpConfig.source,
        marketplaceInstallLocation: mpConfig.installLocation,
      };
    }
  }

  return null;
}

/**
 * Look up a plugin using cache-only marketplace data (no network).
 */
export async function getPluginByIdCacheOnly(
  pluginId: string,
): Promise<PluginLookupResult | null> {
  const { name, marketplace: specifiedMarketplace } =
    parsePluginIdentifier(pluginId);

  if (specifiedMarketplace) {
    const mp = await getMarketplaceCacheOnly(specifiedMarketplace);
    if (!mp) return null;
    const config = loadKnownMarketplacesConfig();
    const entry = mp.plugins.find((p) => p.name === name);
    if (!entry) return null;
    return {
      entry,
      marketplaceName: specifiedMarketplace,
      marketplaceSource: config[specifiedMarketplace].source,
      marketplaceInstallLocation:
        config[specifiedMarketplace].installLocation,
    };
  }

  const config = loadKnownMarketplacesConfig();
  for (const [mpName, mpConfig] of Object.entries(config)) {
    const mp = await getMarketplaceCacheOnly(mpName);
    if (!mp) continue;
    const entry = mp.plugins.find((p) => p.name === name);
    if (entry) {
      return {
        entry,
        marketplaceName: mpName,
        marketplaceSource: mpConfig.source,
        marketplaceInstallLocation: mpConfig.installLocation,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Source fetching (git, url, file, directory)
// ---------------------------------------------------------------------------

/**
 * Fetch a marketplace manifest from its source and save to disk.
 */
async function fetchMarketplaceFromSource(
  source: MarketplaceSource,
  installLocation: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  switch (source.source) {
    case 'github':
      return fetchFromGithub(source, installLocation, onProgress);
    case 'git':
      return fetchFromGit(source, installLocation, onProgress);
    case 'url':
      return fetchFromUrl(source, installLocation, onProgress);
    case 'file':
      return fetchFromFile(source, installLocation);
    case 'directory':
      return fetchFromDirectory(source, installLocation);
    case 'npm':
      throw new Error('NPM marketplace source is not yet implemented.');
    default:
      throw new Error(
        `Unsupported marketplace source type: ${(source as { source: string }).source}`,
      );
  }
}

/**
 * Load a marketplace manifest from disk cache.
 */
async function loadMarketplaceFromDisk(
  installLocation: string,
): Promise<PluginMarketplace | null> {
  // Try marketplace.json in standard locations (most specific first)
  for (const candidate of [
    join(installLocation, BRAND_PLUGIN_META_DIR, 'marketplace.json'),
    join(installLocation, '.claude-plugin', 'marketplace.json'),
    join(installLocation, 'marketplace.json'), // root fallback
    installLocation, // the path itself might be a JSON file (URL sources)
  ]) {
    try {
      const raw = await readFile(candidate, 'utf-8');
      const marketplace = parseMarketplaceManifest(raw, candidate);
      return normalizeMarketplacePluginSources(marketplace, installLocation);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse and validate a marketplace manifest.
 */
function parseMarketplaceManifest(
  raw: string,
  source: string,
): PluginMarketplace {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in marketplace manifest (${source}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = PluginMarketplaceSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Invalid marketplace manifest (${source}): ${formatZodIssues(result.error)}`,
    );
  }

  return result.data as PluginMarketplace;
}

/**
 * Resolve each plugin entry's relative ("./…") source against the
 * marketplace's install location.
 *
 * A relative plugin source is only meaningful relative to the marketplace
 * root (its `installLocation`). Historically every consumer that fetched a
 * plugin (install, update, headless startup install) had to re-derive that
 * location and pass it down, and paths that forgot to — notably
 * `/plugins update` — failed with "Cannot resolve relative source ... without
 * marketplace install location".
 *
 * We fix this at the root by normalizing sources to absolute paths at the
 * single point where a marketplace object is materialized with its final
 * `installLocation`. Downstream consumers then never observe an unresolved
 * relative source. Object (non-string) sources and already-absolute paths are
 * returned unchanged.
 */
function normalizeMarketplacePluginSources(
  marketplace: PluginMarketplace,
  installLocation: string,
): PluginMarketplace {
  let changed = false;
  const plugins = marketplace.plugins.map((entry) => {
    const { source } = entry;
    if (typeof source !== 'string' || !source.startsWith('./')) {
      return entry;
    }
    changed = true;
    return { ...entry, source: resolve(installLocation, source) };
  });

  return changed ? { ...marketplace, plugins } : marketplace;
}

// ---------------------------------------------------------------------------
// Source-specific fetch implementations
// ---------------------------------------------------------------------------

async function fetchFromGithub(
  source: Extract<MarketplaceSource, { source: 'github' }>,
  installLocation: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  const { repo, ref, path: subPath } = source;

  // Try SSH first, fall back to HTTPS
  const sshUrl = `git@github.com:${repo}.git`;
  const httpsUrl = `https://github.com/${repo}.git`;

  try {
    onProgress?.(`Cloning ${repo} via SSH...`);
    await gitClone(sshUrl, installLocation, ref, source.sparsePaths);
  } catch {
    onProgress?.(`SSH failed, trying HTTPS...`);
    await gitClone(httpsUrl, installLocation, ref, source.sparsePaths);
  }

  const manifestPath = subPath
    ? await resolveSubPathManifestPath(installLocation, subPath)
    : await resolveMarketplaceManifestPath(installLocation);

  const raw = await readFile(manifestPath, 'utf-8');
  return parseMarketplaceManifest(raw, manifestPath);
}

async function fetchFromGit(
  source: Extract<MarketplaceSource, { source: 'git' }>,
  installLocation: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  const { url, ref, path: subPath } = source;

  onProgress?.(`Cloning ${url}...`);
  await gitClone(url, installLocation, ref, source.sparsePaths);

  const manifestPath = subPath
    ? await resolveSubPathManifestPath(installLocation, subPath)
    : await resolveMarketplaceManifestPath(installLocation);

  const raw = await readFile(manifestPath, 'utf-8');
  return parseMarketplaceManifest(raw, manifestPath);
}

async function fetchFromUrl(
  source: Extract<MarketplaceSource, { source: 'url' }>,
  installLocation: string,
  onProgress?: MarketplaceProgressFn,
): Promise<PluginMarketplace> {
  onProgress?.(`Fetching ${source.url}...`);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(source.headers ?? {}),
  };

  const response = await unmanagedRequest(source.url, { headers }, {
    timeoutMs: GIT_TIMEOUT_MS,
    bodyIdleTimeoutMs: 30_000,
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} fetching marketplace from ${source.url}`,
    );
  }

  const raw = await response.text();
  const marketplace = parseMarketplaceManifest(raw, source.url);

  // Cache to disk
  const targetPath = installLocation.endsWith('.json')
    ? installLocation
    : join(installLocation, 'marketplace.json');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, raw, 'utf-8');

  return marketplace;
}

async function fetchFromFile(
  source: Extract<MarketplaceSource, { source: 'file' }>,
  installLocation: string,
): Promise<PluginMarketplace> {
  const absolutePath = resolve(source.path);
  const raw = await readFile(absolutePath, 'utf-8');
  const marketplace = parseMarketplaceManifest(raw, absolutePath);

  // Copy to cache location
  const targetPath = installLocation.endsWith('.json')
    ? installLocation
    : join(installLocation, 'marketplace.json');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, raw, 'utf-8');

  return marketplace;
}

async function fetchFromDirectory(
  source: Extract<MarketplaceSource, { source: 'directory' }>,
  installLocation: string,
): Promise<PluginMarketplace> {
  const absolutePath = resolve(source.path);
  const manifestPath = await resolveMarketplaceManifestPath(absolutePath);
  const raw = await readFile(manifestPath, 'utf-8');
  const marketplace = parseMarketplaceManifest(raw, manifestPath);

  if (absolutePath !== installLocation) {
    await mkdir(dirname(installLocation), { recursive: true });
    try {
      await rm(installLocation, { recursive: true, force: true });
    } catch {
      /* ok if doesn't exist */
    }
    await copyPluginTree(absolutePath, installLocation);
  }

  return marketplace;
}

// ---------------------------------------------------------------------------
// Marketplace manifest path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a marketplace manifest path when a sub-path is explicitly provided.
 *
 * Three-stage resolution:
 * 1. If subPath ends in `.json` → treat as direct file path
 * 2. If subPath resolves to an existing file → use it directly
 * 3. Otherwise treat subPath as a directory and delegate to
 *    resolveMarketplaceManifestPath for convention-based discovery
 */
export async function resolveSubPathManifestPath(
  installLocation: string,
  subPath: string,
): Promise<string> {
  const direct = join(installLocation, subPath);

  if (subPath.toLowerCase().endsWith('.json')) {
    return direct;
  }

  try {
    const s = await stat(direct);
    if (s.isFile()) return direct;
  } catch {
    /* fall through to directory resolution */
  }

  return resolveMarketplaceManifestPath(direct);
}

/**
 * Resolve the marketplace.json path within a cloned/cached directory.
 * Checks the current brand, compatibility directories, then the root.
 */
async function resolveMarketplaceManifestPath(
  installLocation: string,
): Promise<string> {
  const candidates = [
    join(installLocation, BRAND_PLUGIN_META_DIR, 'marketplace.json'),
    join(installLocation, '.claude-plugin', 'marketplace.json'),
    join(installLocation, 'marketplace.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to the current brand's path (will produce a clear error on read).
  return join(installLocation, BRAND_PLUGIN_META_DIR, 'marketplace.json');
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Clone a git repository to a target path.
 */
async function gitClone(
  url: string,
  targetPath: string,
  ref?: string,
  sparsePaths?: string[],
): Promise<void> {
  // Remove existing directory if present
  if (existsSync(targetPath)) {
    await rm(targetPath, { recursive: true, force: true });
  }

  await mkdir(dirname(targetPath), { recursive: true });

  const args = ['clone', '--depth', '1'];
  if (sparsePaths && sparsePaths.length > 0) {
    args.push('--filter=blob:none', '--sparse');
  }
  if (ref) {
    args.push('--branch', ref);
  }
  args.push(url, targetPath);

  try {
    await execPluginGit(args, {
      timeout: GIT_TIMEOUT_MS,
    });
    if (sparsePaths && sparsePaths.length > 0) {
      await execPluginGit(['sparse-checkout', 'set', ...sparsePaths], {
        cwd: targetPath,
        timeout: GIT_TIMEOUT_MS,
      });
    }
  } catch (error) {
    // Clean up partial clone
    try {
      await rm(targetPath, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (isExecTimeoutError(error)) {
      throw marketplaceGitTimeoutError('clone', url);
    }
    throw error;
  }
}
