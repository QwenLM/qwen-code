/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRAND_TEMP_PATH_SLUG } from '../../config/brand.js';
import { Downloader } from '../../utils/downloader.js';
import { runLogger } from '../../utils/runLogger.js';
import { looksLikePluginRoot } from '../pluginLoader.js';
import {
  installLocalPluginOp,
  type InstallPluginResult,
  type PluginOperationError,
} from './pluginOperations.js';
import {
  assertContainedSymlinks,
  extractArchiveSafely,
} from '../../utils/archiveUtils.js';

/** Hard cap for direct remote plugin downloads (100 MB). */
const MAX_REMOTE_PLUGIN_ZIP_BYTES = 100 * 1024 * 1024;
const INVALID_ARCHIVE_DIR_CHARS = new Set('<>:"/\\|?*');

/**
 * Derive a safe extraction directory from the URL filename. Besides making the
 * temp tree easier to diagnose, this becomes the fallback plugin name for a
 * flat, manifest-less archive when it enters the local installer.
 */
function deriveArchiveDirectoryName(url: URL): string {
  const encodedBasename = path.posix.basename(url.pathname);
  let decodedBasename = encodedBasename;
  try {
    decodedBasename = decodeURIComponent(encodedBasename);
  } catch {
    // Keep the encoded filename when percent escapes are malformed.
  }

  const stem = decodedBasename.replace(/\.zip$/i, '');
  const sanitizedStem = stem.replace(/[\s\S]/gu, (char) =>
    (char.codePointAt(0) ?? 0) < 0x20 || INVALID_ARCHIVE_DIR_CHARS.has(char)
      ? '-'
      : char,
  );
  const safeStem = sanitizedStem.replace(/^\.+/, '').replace(/[. ]+$/g, '');
  return safeStem || 'remote-plugin';
}

/**
 * Resolve a conventional plugin root after extraction. Archives may either be
 * flat or contain one wrapper directory. Finder metadata is ignored while
 * detecting that wrapper.
 */
async function resolveExtractedPluginRoot(extractDir: string): Promise<string> {
  if (await looksLikePluginRoot(extractDir)) return extractDir;

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const meaningfulEntries = entries.filter(
    (entry) =>
      entry.name !== '__MACOSX' &&
      entry.name !== '.DS_Store' &&
      !entry.name.startsWith('._'),
  );
  if (meaningfulEntries.length !== 1 || !meaningfulEntries[0].isDirectory()) {
    return extractDir;
  }

  const child = path.join(extractDir, meaningfulEntries[0].name);
  return (await looksLikePluginRoot(child)) ? child : extractDir;
}

/**
 * Download, safely extract, and install a plugin ZIP through the existing local
 * plugin validation/cache/registration path.
 */
export async function installRemotePluginZip(
  source: string,
  scope: 'user' | 'project' | 'local',
  options?: { projectPath?: string },
): Promise<InstallPluginResult | PluginOperationError> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Remote plugin install requires a valid HTTPS .zip URL.');
  }
  if (
    url.protocol !== 'https:' ||
    !url.pathname.toLowerCase().endsWith('.zip')
  ) {
    throw new Error('Remote plugin install requires an HTTPS .zip URL.');
  }

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `${BRAND_TEMP_PATH_SLUG}-plugin-remote-`),
  );
  const zipPath = path.join(tempDir, 'download.zip');
  const extractDir = path.join(tempDir, deriveArchiveDirectoryName(url));

  try {
    await new Downloader({ maxSize: MAX_REMOTE_PLUGIN_ZIP_BYTES }).download(
      source,
      zipPath,
    );
    await extractArchiveSafely(zipPath, extractDir, {
      symlinkPolicy: 'allow-contained',
    });
    const pluginRoot = await resolveExtractedPluginRoot(extractDir);
    // A wrapper archive may contain siblings outside the actual plugin root.
    // Links installed with the plugin must remain inside that narrower root.
    await assertContainedSymlinks(pluginRoot);
    return await installLocalPluginOp(pluginRoot, scope, options);
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Installation may already be registered at this point. Temp cleanup
      // must never turn that success into a reported failure.
      runLogger.warn(
        `[plugin-zip] Failed to clean temporary directory ${tempDir}`,
        error,
      );
    }
  }
}
