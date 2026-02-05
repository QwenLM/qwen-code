/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClipboardManager } from '@teddyzhu/clipboard';

/**
 * Checks if the system clipboard contains an image
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const clipboard = new ClipboardManager();
    return clipboard.hasFormat('image');
  } catch (error) {
    if (process.env['DEBUG']) {
      console.error('Error checking clipboard for image:', error);
    }
    return false;
  }
}

/**
 * Saves the image from clipboard to a temporary file
 * @param targetDir The target directory to create temp files within
 * @returns The path to the saved image file, or null if no image or error
 */
export async function saveClipboardImage(
  targetDir?: string,
): Promise<string | null> {
  try {
    const clipboard = new ClipboardManager();

    if (!clipboard.hasFormat('image')) {
      return null;
    }

    // Create a temporary directory for clipboard images within the target directory
    // This avoids security restrictions on paths outside the target directory
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, 'clipboard');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();
    const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);

    const imageData = clipboard.getImageData();
    // Use data buffer from the API
    const buffer = imageData.data;

    if (!buffer) {
      return null;
    }

    await fs.writeFile(tempFilePath, buffer);

    return tempFilePath;
  } catch (error) {
    if (process.env['DEBUG']) {
      console.error('Error saving clipboard image:', error);
    }
    return null;
  }
}

/**
 * Cleans up old temporary clipboard image files using LRU strategy
 * Keeps maximum 100 images, when exceeding removes 50 oldest files to reduce cleanup frequency
 * @param targetDir The target directory where temp files are stored
 */
export async function cleanupOldClipboardImages(
  targetDir?: string,
): Promise<void> {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, 'clipboard');
    const files = await fs.readdir(tempDir);
    const MAX_IMAGES = 100;
    const CLEANUP_COUNT = 50;

    // Filter clipboard image files and get their stats
    const imageFiles: Array<{ name: string; path: string; atime: number }> = [];

    for (const file of files) {
      if (
        file.startsWith('clipboard-') &&
        (file.endsWith('.png') ||
          file.endsWith('.jpg') ||
          file.endsWith('.webp') ||
          file.endsWith('.heic') ||
          file.endsWith('.heif') ||
          file.endsWith('.tiff') ||
          file.endsWith('.gif') ||
          file.endsWith('.bmp'))
      ) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        imageFiles.push({
          name: file,
          path: filePath,
          atime: stats.atimeMs,
        });
      }
    }

    // If exceeds limit, remove CLEANUP_COUNT oldest files to reduce cleanup frequency
    if (imageFiles.length > MAX_IMAGES) {
      // Sort by access time (oldest first)
      imageFiles.sort((a, b) => a.atime - b.atime);

      // Remove CLEANUP_COUNT oldest files (or all excess files if less than CLEANUP_COUNT)
      const removeCount = Math.min(
        CLEANUP_COUNT,
        imageFiles.length - MAX_IMAGES + CLEANUP_COUNT,
      );
      const filesToRemove = imageFiles.slice(0, removeCount);
      for (const file of filesToRemove) {
        await fs.unlink(file.path);
      }
    }
  } catch {
    // Ignore errors in cleanup
  }
}
