/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plugin Zip Cache Module
 *
 * Manages plugins as ZIP archives in a mounted directory (e.g., Filestore/NFS).
 * When ENV_PLUGIN_ZIP_CACHE is enabled and ENV_PLUGIN_CACHE_DIR is set,
 * plugins are stored as ZIPs in that directory and extracted to a session-local
 * temp directory at startup.
 *
 * Directory structure of the zip cache:
 * /mnt/plugins-cache/
 *   ├── known_marketplaces.json
 *   ├── installed_plugins.json
 *   ├── marketplaces/
 *   │   ├── official-marketplace.json
 *   │   └── company-marketplace.json
 *   └── plugins/
 *       ├── official-marketplace/
 *       │   └── plugin-a/
 *       │       └── 1.0.0.zip
 *       └── company-marketplace/
 *           └── plugin-b/
 *               └── 2.1.3.zip
 */

import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { runLogger } from '../utils/runLogger.js';
import { expandTilde } from '../utils/expandTilde.js';
import type { MarketplaceSource } from './schemas.js';
import { ENV_PLUGIN_ZIP_CACHE, ENV_PLUGIN_CACHE_DIR } from '../config/brand.js';

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Check if the plugin zip cache mode is enabled.
 */
export function isPluginZipCacheEnabled(): boolean {
  return isEnvTruthy(process.env[ENV_PLUGIN_ZIP_CACHE]);
}

/**
 * Get the path to the zip cache directory.
 * Requires ENV_PLUGIN_CACHE_DIR to be set.
 * Returns undefined if zip cache is not enabled.
 */
export function getPluginZipCachePath(): string | undefined {
  if (!isPluginZipCacheEnabled()) {
    return undefined;
  }
  const dir = process.env[ENV_PLUGIN_CACHE_DIR];
  return dir ? expandTilde(dir) : undefined;
}

/**
 * Get the path to known_marketplaces.json in the zip cache.
 */
export function getZipCacheKnownMarketplacesPath(): string {
  const cachePath = getPluginZipCachePath();
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled');
  }
  return join(cachePath, 'known_marketplaces.json');
}


/**
 * Get the marketplaces directory within the zip cache.
 */
export function getZipCacheMarketplacesDir(): string {
  const cachePath = getPluginZipCachePath();
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled');
  }
  return join(cachePath, 'marketplaces');
}

/**
 * Get the plugins directory within the zip cache.
 */
export function getZipCachePluginsDir(): string {
  const cachePath = getPluginZipCachePath();
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled');
  }
  return join(cachePath, 'plugins');
}

// ---------------------------------------------------------------------------
// Session plugin cache
// ---------------------------------------------------------------------------

// A temp directory on local disk (NOT in the mounted zip cache) that holds
// extracted plugins for the duration of the session.
let sessionPluginCachePath: string | null = null;

/**
 * Clean up the session plugin cache directory.
 * Should be called when the session ends.
 */
export async function cleanupSessionPluginCache(): Promise<void> {
  if (!sessionPluginCachePath) {
    return;
  }
  try {
    await rm(sessionPluginCachePath, { recursive: true, force: true });
    runLogger.log(
      `Cleaned up session plugin cache at ${sessionPluginCachePath}`,
    );
  } catch (error) {
    runLogger.warn(`Failed to clean up session plugin cache: ${error}`);
  } finally {
    sessionPluginCachePath = null;
  }
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Write data to a file in the zip cache atomically.
 * Writes to a temp file in the same directory, then renames.
 */
export async function atomicWriteToZipCache(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  const tmpName = `.${basename(targetPath)}.tmp.${randomBytes(4).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, targetPath);
  } catch (error) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Zip creation
// ---------------------------------------------------------------------------

// fflate ZippableFile tuple: [data, opts]. Stores {os, attrs} so extraction
// can recover Unix exec bits.
type ZipEntry = [Uint8Array, { os: number; attrs: number }];

/**
 * Create a ZIP archive from a directory.
 * Resolves symlinks to actual file contents (replaces symlinks with real data).
 * Stores Unix mode bits in external_attr so extractZipToDirectory can restore
 * +x — otherwise the round-trip (git clone → zip → extract) loses exec bits.
 *
 * @param sourceDir - Directory to zip
 * @returns ZIP file as Uint8Array
 */
export async function createZipFromDirectory(
  sourceDir: string,
): Promise<Uint8Array> {
  const files: Record<string, ZipEntry> = {};
  const visited = new Set<string>();
  await collectFilesForZip(sourceDir, '', files, visited);

  const { zipSync } = await import('fflate');
  const zipData = zipSync(files, { level: 6 });
  runLogger.log(
    `Created ZIP from ${sourceDir}: ${Object.keys(files).length} files, ${zipData.length} bytes`,
  );
  return zipData;
}

/**
 * Recursively collect files from a directory for zipping.
 * Uses lstat to detect symlinks and tracks visited inodes for cycle detection.
 */
async function collectFilesForZip(
  baseDir: string,
  relativePath: string,
  files: Record<string, ZipEntry>,
  visited: Set<string>,
): Promise<void> {
  const currentDir = relativePath ? join(baseDir, relativePath) : baseDir;
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  // Track visited directories by dev+ino to detect symlink cycles.
  // bigint: true avoids precision loss on Windows NTFS where file indices
  // can exceed Number.MAX_SAFE_INTEGER.
  try {
    const dirStat = await stat(currentDir, { bigint: true });
    // ReFS/NFS/FUSE may report dev=0 and ino=0 for everything — fail open
    // and skip cycle detection rather than skip the directory.
    if (dirStat.dev !== 0n || dirStat.ino !== 0n) {
      const key = `${dirStat.dev}:${dirStat.ino}`;
      if (visited.has(key)) {
        runLogger.log(`Skipping symlink cycle at ${currentDir}`);
        return;
      }
      visited.add(key);
    }
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === '.git') {
      continue;
    }

    const fullPath = join(currentDir, entry);
    const relPath = relativePath ? `${relativePath}/${entry}` : entry;

    let fileStat;
    try {
      fileStat = await lstat(fullPath);
    } catch {
      continue;
    }

    // Skip symlinked directories (follow symlinked files)
    if (fileStat.isSymbolicLink()) {
      try {
        const targetStat = await stat(fullPath);
        if (targetStat.isDirectory()) {
          continue;
        }
        fileStat = targetStat;
      } catch {
        continue; // broken symlink
      }
    }

    if (fileStat.isDirectory()) {
      await collectFilesForZip(baseDir, relPath, files, visited);
    } else if (fileStat.isFile()) {
      try {
        const content = await readFile(fullPath);
        // os=3 (Unix) + st_mode in high 16 bits of external_attr
        files[relPath] = [
          new Uint8Array(content),
          { os: 3, attrs: (fileStat.mode & 0xffff) << 16 },
        ];
      } catch (error) {
        runLogger.warn(`Failed to read file for zip: ${relPath}: ${error}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Zip extraction
// ---------------------------------------------------------------------------

/**
 * Parse Unix mode bits from a ZIP's central directory external_attr fields.
 * fflate doesn't surface these, so we parse the raw central directory ourselves.
 *
 * Returns a map of relative-path → Unix mode (e.g., 0o755).
 */
function parseZipModes(zipBuf: Uint8Array): Record<string, number> {
  const modes: Record<string, number> = {};
  const dv = new DataView(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength);

  // Find the End of Central Directory record (last 22+ bytes)
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return modes;

  const cdOffset = dv.getUint32(eocdOffset + 16, true);
  const cdSize = dv.getUint32(eocdOffset + 12, true);
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  const decoder = new TextDecoder();

  while (pos < cdEnd && pos + 46 <= zipBuf.length) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break; // central dir signature

    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const externalAttr = dv.getUint32(pos + 38, true);
    const versionMadeBy = dv.getUint8(pos + 5); // high byte = OS

    if (nameLen > 0 && pos + 46 + nameLen <= zipBuf.length) {
      const nameBytes = zipBuf.subarray(pos + 46, pos + 46 + nameLen);
      const name = decoder.decode(nameBytes);

      // OS = 3 (Unix) → high 16 bits of external_attr = st_mode
      if (versionMadeBy === 3) {
        const mode = (externalAttr >>> 16) & 0xffff;
        if (mode) {
          modes[name] = mode;
        }
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return modes;
}

/**
 * Extract a ZIP file to a target directory.
 *
 * @param zipPath - Path to the ZIP file
 * @param targetDir - Directory to extract into
 */
export async function extractZipToDirectory(
  zipPath: string,
  targetDir: string,
): Promise<void> {
  const zipBuf = new Uint8Array(await readFile(zipPath));
  const { unzipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = unzipSync(zipBuf);
  const modes = parseZipModes(zipBuf);

  await mkdir(targetDir, { recursive: true });

  // Zip bomb protection: reject if decompressed size > 50× compressed size
  let totalSize = 0;
  const maxSize = zipBuf.length * 50;
  for (const data of Object.values(files)) {
    totalSize += data.length;
    if (totalSize > maxSize) {
      throw new Error(
        `Zip bomb detected: decompressed size exceeds 50× compressed size (${zipBuf.length} bytes)`,
      );
    }
  }

  for (const [relPath, data] of Object.entries(files)) {
    // Path traversal protection
    if (relPath.includes('..')) {
      runLogger.warn(`Skipping zip entry with path traversal: ${relPath}`);
      continue;
    }

    // Skip macOS-only resource-fork sidecars (`__MACOSX/`, `._*`). These get
    // added automatically when a Finder user zips a folder; they pollute the
    // extracted tree and confuse plugin loaders that look for known paths.
    if (relPath.startsWith('__MACOSX/') || relPath === '__MACOSX') continue;
    if (basename(relPath).startsWith('._')) continue;

    // Skip directory entries (trailing slash)
    if (relPath.endsWith('/')) {
      await mkdir(join(targetDir, relPath), { recursive: true });
      continue;
    }

    const fullPath = join(targetDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);

    const mode = modes[relPath];
    if (mode && mode & 0o111) {
      // Swallow EPERM/ENOTSUP (NFS root_squash, some FUSE mounts) — losing +x
      // is better than aborting mid-extraction.
      await chmod(fullPath, mode & 0o777).catch(() => {});
    }
  }

  runLogger.log(
    `Extracted ZIP to ${targetDir}: ${Object.keys(files).length} entries`,
  );
}

// ---------------------------------------------------------------------------
// In-place conversion
// ---------------------------------------------------------------------------

/**
 * Convert a plugin directory to a ZIP in-place: zip → atomic write → delete dir.
 */
export async function convertDirectoryToZipInPlace(
  dirPath: string,
  zipPath: string,
): Promise<void> {
  const zipData = await createZipFromDirectory(dirPath);
  await atomicWriteToZipCache(zipPath, zipData);
  await rm(dirPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Marketplace path helpers
// ---------------------------------------------------------------------------

/**
 * Get the relative path for a marketplace JSON file within the zip cache.
 * Format: marketplaces/{marketplace-name}.json
 */
export function getMarketplaceJsonRelativePath(
  marketplaceName: string,
): string {
  const sanitized = marketplaceName.replace(/[^a-zA-Z0-9\-_]/g, '-');
  return join('marketplaces', `${sanitized}.json`);
}

/**
 * Check if a marketplace source type is supported by zip cache mode.
 *
 * Supported: github, git, url (clone to temp, rename into cacheDir).
 * Excluded: file, directory (paths outside cacheDir — nonsensical in containers),
 * npm (node_modules bloat on mount).
 */
export function isMarketplaceSourceSupportedByZipCache(
  source: MarketplaceSource,
): boolean {
  return ['github', 'git', 'url'].includes(source.source);
}
