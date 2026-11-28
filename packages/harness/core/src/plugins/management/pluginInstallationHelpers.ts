/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { BRAND_TEMP_PATH_SLUG } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  addPluginInstallation,
  type PluginInstallationEntry,
} from './installedPluginsManager.js';
import {
  getPluginById,
  getPluginByIdCacheOnly,
  type MarketplaceProgressFn,
} from './marketplaceManager.js';
import { loadPluginFromDirectory } from '../pluginLoader.js';
import {
  getVersionedCachePath,
  getPluginsDirectory,
} from '../pluginDirectories.js';
import { parsePluginIdentifier, buildPluginId } from '../pluginIdentifier.js';
import { isPluginBlockedByPolicy } from '../pluginPolicy.js';
import { calculatePluginVersion } from './pluginVersioning.js';
import {
  isPluginZipCacheEnabled,
  convertDirectoryToZipInPlace,
  getZipCachePluginsDir,
} from '../zipCache.js';
import type { PluginScope, PluginSource } from '../schemas.js';
import type { PluginError, PluginManifest } from '../types.js';
import { execPluginGit } from '../pluginGit.js';
import { copyPluginTree } from '../pluginTreeCopy.js';
import {
  fetchArchiveSource,
  isArchivePluginSource,
} from './pluginArchiveFetch.js';

// ---------------------------------------------------------------------------
// Promisified exec
// ---------------------------------------------------------------------------

const execAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheAndRegisterResult {
  ok: true;
  installPath: string;
  version: string;
}

export interface CacheAndRegisterError {
  ok: false;
  error: PluginError;
}

export interface InstallResolvedResult {
  ok: true;
  pluginId: string;
  installPath: string;
  version: string;
}

export interface InstallResolvedError {
  ok: false;
  pluginId: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

function createPluginTempDir(label: string): string {
  return join(
    tmpdir(),
    `${BRAND_TEMP_PATH_SLUG}-plugin-${label}-${randomUUID()}`,
  );
}

// ---------------------------------------------------------------------------
// Shared finalization: version → cache → zip → register
// ---------------------------------------------------------------------------

/**
 * After plugin source is in tempDir and validated, commit it to the versioned
 * cache directory and register in installed_plugins.json.
 */
async function commitToCache(
  tempDir: string,
  pluginId: string,
  marketplaceName: string,
  source: PluginSource,
  manifest: PluginManifest | undefined,
  scope: PluginScope,
  options?: {
    projectPath?: string;
    version?: string;
  },
): Promise<CacheAndRegisterResult | CacheAndRegisterError> {
  const { name } = parsePluginIdentifier(pluginId);

  const version =
    options?.version ??
    (await calculatePluginVersion(pluginId, source, manifest, tempDir));

  const cachePath = getVersionedCachePath(marketplaceName, name, version);
  await mkdir(dirname(cachePath), { recursive: true });
  // Stage beside the destination so publishing stays on the same filesystem.
  const nonce = randomUUID();
  const stagedPath = `${cachePath}.tmp-${nonce}`;
  const backupPath = `${cachePath}.backup-${nonce}`;
  let movedExistingCache = false;
  try {
    await copyPluginTree(tempDir, stagedPath);
    try {
      await rename(cachePath, backupPath);
      movedExistingCache = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(stagedPath, cachePath);
    } catch (error) {
      if (movedExistingCache) {
        await rename(backupPath, cachePath).catch((rollbackError) => {
          runLogger.warn(
            `[InstallHelper] Could not restore cache; backup retained at ${backupPath}: ${getErrorMessage(rollbackError)}`,
          );
        });
      }
      throw error;
    }
    if (movedExistingCache) {
      await rm(backupPath, { recursive: true, force: true }).catch((error) => {
        runLogger.warn(
          `[InstallHelper] Could not remove cache backup ${backupPath}: ${getErrorMessage(error)}`,
        );
      });
    }
  } finally {
    await rm(stagedPath, { recursive: true, force: true }).catch((error) => {
      runLogger.warn(
        `[InstallHelper] Could not remove staged cache ${stagedPath}: ${getErrorMessage(error)}`,
      );
    });
  }

  let finalPath = cachePath;
  if (isPluginZipCacheEnabled()) {
    try {
      const zipDir = getZipCachePluginsDir();
      const zipPath = join(zipDir, marketplaceName, name, `${version}.zip`);
      await convertDirectoryToZipInPlace(cachePath, zipPath);
      finalPath = zipPath;
    } catch (e) {
      runLogger.warn(
        `[InstallHelper] Failed to convert to ZIP, using directory: ${e}`,
      );
    }
  }

  const installEntry: PluginInstallationEntry = {
    scope,
    installPath: finalPath,
    displayName: manifest?.displayName,
    version,
    installedAt: new Date().toISOString(),
    // Only project/local installs are scoped to a directory. Entry matching
    // ignores projectPath for the other scopes, so recording the installing
    // process's cwd there would just be misleading noise.
    ...(scope === 'project' || scope === 'local'
      ? { projectPath: options?.projectPath }
      : {}),
  };
  if (!addPluginInstallation(pluginId, installEntry)) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'cache',
        plugin: pluginId,
        error: `Cached "${pluginId}" but could not record the installation; the plugin state file is unreadable.`,
      },
    };
  }

  return { ok: true, installPath: finalPath, version };
}

// ---------------------------------------------------------------------------
// Cache and register
// ---------------------------------------------------------------------------

/**
 * Converts an unexpected throw during caching into the structured error the
 * caching entry points promise to return.
 *
 * Every step these functions drive — tree copy, manifest load, version
 * calculation, cache commit — can throw, while the signatures advertise
 * `CacheAndRegisterResult | CacheAndRegisterError`. An escaping throw reached
 * the install UI as a bare runtime message with no plugin id, no failing stage
 * and no stack anywhere in `qwen.log`, which is why a marketplace install
 * failure could only be diagnosed by disassembling the packaged binary. Keep
 * the throw inside the result contract, name the stage, and persist the stack.
 */
function toCacheStageError(
  pluginId: string,
  stage: string,
  error: unknown,
): CacheAndRegisterError {
  const message =
    error instanceof Error ? error.message : getErrorMessage(error);
  const details = error instanceof Error ? (error.stack ?? message) : message;
  runLogger.error(
    `[InstallHelper] Unexpected failure while ${stage} plugin "${pluginId}": ${details}`,
  );
  return {
    ok: false,
    error: {
      type: 'generic-error',
      source: 'cache',
      plugin: pluginId,
      error: `Failed while ${stage} plugin "${pluginId}": ${message}`,
    },
  };
}

/**
 * Download/copy a plugin to the versioned cache directory and register it
 * in installed_plugins.json.
 *
 * Steps:
 * 1. Fetch plugin source to a temp directory
 * 2. Validate plugin manifest
 * 3. Calculate version, copy to cache, register
 */
export async function cacheAndRegisterPlugin(
  pluginId: string,
  source: PluginSource,
  scope: PluginScope,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    /** Pre-resolved marketplace install location (for local sources). */
    marketplaceInstallLocation?: string;
    /** Override version string. */
    version?: string;
  },
): Promise<CacheAndRegisterResult | CacheAndRegisterError> {
  const { marketplace } = parsePluginIdentifier(pluginId);
  const marketplaceName = marketplace ?? 'unknown';

  const tempDir = createPluginTempDir('cache');

  try {
    await mkdir(tempDir, { recursive: true });

    // Resolve the source path for local (relative) plugin sources
    let sourcePath: string;
    if (typeof source === 'string' && source.startsWith('./')) {
      if (!options?.marketplaceInstallLocation) {
        return {
          ok: false,
          error: {
            type: 'generic-error',
            source: 'cache',
            error: `Cannot resolve relative source "${source}" without marketplace install location`,
          },
        };
      }
      sourcePath = resolve(options.marketplaceInstallLocation, source);
    } else if (typeof source === 'string') {
      sourcePath = resolve(source);
    } else {
      // Non-local source — delegate to marketplace lookup
      return await cacheFromMarketplace(pluginId, scope, options);
    }

    // Copy local source to temp
    await copyPluginTree(sourcePath, tempDir, {
      containmentRoot: options?.marketplaceInstallLocation ?? sourcePath,
    });

    // Validate
    const loadResult = await loadPluginFromDirectory(
      tempDir,
      marketplaceName,
      marketplaceName,
    );

    if (!loadResult.ok) {
      return { ok: false, error: loadResult.error };
    }

    return await commitToCache(
      tempDir,
      pluginId,
      marketplaceName,
      source,
      loadResult.plugin.manifest,
      scope,
      options,
    );
  } catch (e) {
    return toCacheStageError(pluginId, 'caching', e);
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Cache a plugin by looking it up in the marketplace and fetching it.
 * Used for non-local (remote) plugin sources.
 */
async function cacheFromMarketplace(
  pluginId: string,
  scope: PluginScope,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    version?: string;
  },
): Promise<CacheAndRegisterResult | CacheAndRegisterError> {
  const lookup = await getPluginById(pluginId);
  if (!lookup) {
    const cacheLookup = await getPluginByIdCacheOnly(pluginId);
    if (!cacheLookup) {
      return {
        ok: false,
        error: {
          type: 'plugin-not-found',
          source: 'cache',
          pluginId,
          marketplace: parsePluginIdentifier(pluginId).marketplace ?? 'all',
        },
      };
    }
    return cachePluginFromEntry(
      pluginId,
      cacheLookup.entry.source,
      cacheLookup.marketplaceName,
      scope,
      {
        ...options,
        marketplaceInstallLocation:
          cacheLookup.marketplaceInstallLocation,
      },
    );
  }

  return cachePluginFromEntry(
    pluginId,
    lookup.entry.source,
    lookup.marketplaceName,
    scope,
    {
      ...options,
      marketplaceInstallLocation: lookup.marketplaceInstallLocation,
    },
  );
}

/**
 * Cache a plugin given its resolved marketplace entry source.
 */
async function cachePluginFromEntry(
  pluginId: string,
  source: PluginSource,
  marketplaceName: string,
  scope: PluginScope,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    version?: string;
    marketplaceInstallLocation?: string;
  },
): Promise<CacheAndRegisterResult | CacheAndRegisterError> {
  // Relative sources are normalized to absolute paths when the marketplace is
  // materialized (see marketplaceManager), so `source` here is either an
  // absolute local path or a remote source descriptor. Both are handled by
  // fetchPluginSource below.
  const tempDir = createPluginTempDir('fetch');
  try {
    await mkdir(tempDir, { recursive: true });

    const fetchResult = await fetchPluginSource(
      source,
      tempDir,
      options?.onProgress,
      options?.marketplaceInstallLocation,
    );
    if (!fetchResult.ok) {
      return { ok: false, error: fetchResult.error };
    }

    const loadResult = await loadPluginFromDirectory(
      tempDir,
      marketplaceName,
      marketplaceName,
    );
    if (!loadResult.ok) {
      return { ok: false, error: loadResult.error };
    }

    return await commitToCache(
      tempDir,
      pluginId,
      marketplaceName,
      source,
      loadResult.plugin.manifest,
      scope,
      options,
    );
  } catch (e) {
    return toCacheStageError(pluginId, 'caching', e);
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Install resolved plugin (settings-first)
// ---------------------------------------------------------------------------

/**
 * Install a plugin that has already been resolved from a marketplace.
 *
 * Settings-first flow:
 * 1. Check policy blocklists
 * 2. Cache and register the plugin
 *
 * Dependency resolution is handled by the caller (pluginStartupCheck or
 * headlessPluginInstall) to avoid circular installs.
 */
export async function installResolvedPlugin(
  pluginId: string,
  scope: PluginScope,
  options?: {
    projectPath?: string;
    onProgress?: MarketplaceProgressFn;
    blockedMarketplaces?: string[];
    strictKnownMarketplaces?: boolean;
    marketplaceInstallLocation?: string;
  },
): Promise<InstallResolvedResult | InstallResolvedError> {
  // 1. Policy check
  const { marketplace } = parsePluginIdentifier(pluginId);
  if (marketplace) {
    const blocked = isPluginBlockedByPolicy(pluginId, {
      plugins: {
        disabled: undefined,
        blockedMarketplaces: options?.blockedMarketplaces,
      },
    });
    if (blocked) {
      return {
        ok: false,
        pluginId,
        error: `Plugin "${pluginId}" is blocked by policy`,
      };
    }
  }

  // 2. Look up and cache
  const lookup = await getPluginById(pluginId);
  if (!lookup) {
    return {
      ok: false,
      pluginId,
      error: `Plugin "${pluginId}" not found in any marketplace`,
    };
  }

  const result = await cacheAndRegisterPlugin(
    buildPluginId(lookup.entry.name, lookup.marketplaceName),
    lookup.entry.source,
    scope,
    {
      projectPath: options?.projectPath,
      onProgress: options?.onProgress,
      marketplaceInstallLocation: lookup.marketplaceInstallLocation,
    },
  );

  if (!result.ok) {
    const errorMsg =
      'error' in result.error && typeof result.error.error === 'string'
        ? result.error.error
        : JSON.stringify(result.error);
    return { ok: false, pluginId, error: errorMsg };
  }

  return {
    ok: true,
    pluginId,
    installPath: result.installPath,
    version: result.version,
  };
}

// ---------------------------------------------------------------------------
// Plugin source fetching
// ---------------------------------------------------------------------------

interface FetchOk {
  ok: true;
}

interface FetchFail {
  ok: false;
  error: PluginError;
}

/**
 * Clone a git repository to targetDir, optionally checking out a ref and
 * extracting a subdirectory.
 */
async function cloneGitSource(
  url: string,
  targetDir: string,
  opts?: {
    ref?: string;
    sha?: string;
    subPath?: string;
    onProgress?: MarketplaceProgressFn;
  },
): Promise<FetchOk | FetchFail> {
  opts?.onProgress?.(`Cloning ${url}...`);

  const args = ['clone', '--depth', '1'];
  if (opts?.ref) args.push('--branch', opts.ref);
  if (opts?.sha) args.push('--no-checkout');

  const cloneDir = opts?.subPath
    ? `${targetDir}-clone-${randomUUID()}`
    : targetDir;
  args.push(url, cloneDir);

  try {
    await execPluginGit(args, {
      timeout: 120000,
    });

    if (opts?.sha) {
      try {
        await execPluginGit(['fetch', '--depth', '1', 'origin', opts.sha], {
          cwd: cloneDir,
          timeout: 120000,
        });
      } catch {
        await execPluginGit(['fetch', '--unshallow'], {
          cwd: cloneDir,
          timeout: 120000,
        });
      }
      await execPluginGit(['checkout', opts.sha], {
        cwd: cloneDir,
        timeout: 60000,
      });
    }

    if (opts?.subPath) {
      await copyPluginTree(join(cloneDir, opts.subPath), targetDir, {
        containmentRoot: cloneDir,
      });
    }

    return { ok: true };
  } finally {
    if (opts?.subPath) {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Fetch a plugin from a URL source.
 *
 * Claude marketplace plugin `source: "url"` entries are git repository URLs.
 */
async function fetchFromUrlSource(
  source: Extract<PluginSource, { source: 'url' }>,
  targetDir: string,
  onProgress?: MarketplaceProgressFn,
): Promise<FetchOk | FetchFail> {
  return cloneGitSource(source.url, targetDir, {
    ref: source.ref,
    sha: source.sha,
    onProgress,
  });
}

/**
 * Install a plugin from an npm package.
 *
 * Uses a shared npm-cache directory under the plugins directory.
 * Installs the package via `npm install --prefix`, then copies
 * from node_modules to the target directory.
 */
async function installFromNpm(
  packageName: string,
  targetDir: string,
  options: { registry?: string; version?: string } = {},
): Promise<FetchOk | FetchFail> {
  const npmCachePath = join(getPluginsDirectory(), 'npm-cache');
  await mkdir(npmCachePath, { recursive: true });

  const packageSpec = options.version
    ? `${packageName}@${options.version}`
    : packageName;

  const args = ['install', packageSpec, '--prefix', npmCachePath];
  if (options.registry) {
    args.push('--registry', options.registry);
  }

  try {
    await execAsync('npm', args, { timeout: 120000 });
  } catch (e) {
    const stderr =
      e instanceof Error && 'stderr' in e
        ? (e as { stderr: string }).stderr
        : String(e);
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'fetch',
        error: `Failed to install npm package "${packageSpec}": ${stderr}`,
      },
    };
  }

  // Determine the installed package directory
  // For scoped packages like @scope/name, npm puts them in node_modules/@scope/name
  const packagePath = join(npmCachePath, 'node_modules', packageName);
  try {
    await copyPluginTree(packagePath, targetDir);
  } catch (e) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'fetch',
        error: `npm package installed but could not copy to target: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  return { ok: true };
}

/**
 * Fetch plugin files from a PluginSource to a local directory.
 */
async function fetchPluginSource(
  source: PluginSource,
  targetDir: string,
  onProgress?: MarketplaceProgressFn,
  marketplaceInstallLocation?: string,
): Promise<FetchOk | FetchFail> {
  try {
    if (typeof source === 'string') {
      const sourcePath = resolve(source);
      await copyPluginTree(sourcePath, targetDir, {
        containmentRoot: marketplaceInstallLocation ?? sourcePath,
      });
      return { ok: true };
    }

    if (isArchivePluginSource(source)) {
      await fetchArchiveSource(source, targetDir, onProgress);
      return { ok: true };
    }

    if (typeof source === 'object' && source !== null) {
      const src = source as Record<string, unknown>;

      if (src['source'] === 'github' || src['source'] === 'git') {
        const url =
          src['source'] === 'github'
            ? `https://github.com/${src['repo'] as string}.git`
            : (src['url'] as string);

        return await cloneGitSource(url, targetDir, {
          ref: src['ref'] as string | undefined,
          sha: src['sha'] as string | undefined,
          subPath: src['path'] as string | undefined,
          onProgress,
        });
      }

      if (src['source'] === 'git-subdir') {
        return await cloneGitSource(src['url'] as string, targetDir, {
          ref: src['ref'] as string | undefined,
          subPath: src['path'] as string,
          onProgress,
        });
      }

      if (src['source'] === 'npm') {
        return await installFromNpm(src['package'] as string, targetDir, {
          registry: src['registry'] as string | undefined,
          version: src['version'] as string | undefined,
        });
      }

      if (src['source'] === 'url') {
        return await fetchFromUrlSource(
          source as Extract<PluginSource, { source: 'url' }>,
          targetDir,
          onProgress,
        );
      }
    }

    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'fetch',
        error: `Unsupported plugin source: ${JSON.stringify(source)}`,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        type: 'generic-error',
        source: 'fetch',
        error: `Failed to fetch plugin: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}
