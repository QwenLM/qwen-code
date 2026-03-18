/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';

const CLIPBOARD_DIR_NAME = 'clipboard';
const DEFAULT_MAX_IMAGES = 100;

export function getClipboardImageDir(): string {
  return path.join(Storage.getGlobalTempDir(), CLIPBOARD_DIR_NAME);
}

/**
 * Saves an image buffer to the shared clipboard image directory.
 * Both the CLI terminal paste and the VS Code webview paste converge here
 * after converting their respective inputs (native clipboard buffer / base64)
 * into a Node Buffer.
 */
export async function saveImageBufferToClipboardDir(
  buffer: Buffer,
  fileName: string,
): Promise<string> {
  const dir = getClipboardImageDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Removes the oldest clipboard images when the total exceeds {@link maxImages}.
 * Uses mtime for ordering (most-recently-written survives).
 */
export async function pruneClipboardImages(
  maxImages: number = DEFAULT_MAX_IMAGES,
): Promise<void> {
  try {
    const dir = getClipboardImageDir();
    const files = await fs.readdir(dir);
    const imageFiles: Array<{ filePath: string; mtimeMs: number }> = [];

    for (const file of files) {
      if (file.startsWith('clipboard-')) {
        const filePath = path.join(dir, file);
        const stats = await fs.stat(filePath);
        imageFiles.push({ filePath, mtimeMs: stats.mtimeMs });
      }
    }

    if (imageFiles.length > maxImages) {
      imageFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { filePath } of imageFiles.slice(maxImages)) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    // Ignore errors in cleanup — directory may not exist yet
  }
}
