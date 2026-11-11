/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';

import { runLogger } from '../../utils/runLogger.js';
import { detectSingleWrapperDir } from '../pluginArchiveRoot.js';
import type { PluginSource } from '../schemas.js';
import { extractZipToDirectory } from '../zipCache.js';
import { downloadVerifiedZip } from '../verifiedZipDownload.js';

export type ArchivePluginSource = Extract<PluginSource, { source: 'archive' }>;

export const MAX_PLUGIN_ARCHIVE_BYTES = 100 * 1024 * 1024;

export function isArchivePluginSource(
  source: PluginSource,
): source is ArchivePluginSource {
  return typeof source === 'object' && source.source === 'archive';
}

/**
 * Download, verify and unpack an archive plugin source into `targetDir`.
 * `targetDir` must exist and be empty; it is replaced by the plugin root
 * (a single wrapper directory inside the ZIP is stripped).
 */
export async function fetchArchiveSource(
  source: ArchivePluginSource,
  targetDir: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  onProgress?.(`Downloading ${source.url}...`);
  const { zipPath } = await downloadVerifiedZip({
    url: source.url,
    sha256: source.sha256,
    maxBytes: MAX_PLUGIN_ARCHIVE_BYTES,
  });
  const extractDir = `${targetDir}-extract-${randomUUID()}`;
  try {
    onProgress?.('Verifying and extracting archive...');
    await extractZipToDirectory(zipPath, extractDir);
    const pluginRoot = await detectSingleWrapperDir(extractDir);
    await rm(targetDir, { recursive: true, force: true });
    await rename(pluginRoot, targetDir);
    runLogger.log(
      `[PluginArchive] Extracted archive from ${source.url} (sha256 ${source.sha256})`,
    );
  } finally {
    await rm(zipPath, { force: true }).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}
