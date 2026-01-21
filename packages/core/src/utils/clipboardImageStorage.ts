/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

/**
 * Directory name for storing clipboard images
 * This directory is NOT in .gitignore so the AI can access pasted images
 */
export const CLIPBOARD_IMAGE_DIR = '.qwen-code-clipboard';

/**
 * Default cleanup threshold: 1 hour
 */
export const CLEANUP_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Supported image extensions for clipboard images
 */
export const SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.tiff',
  '.webp',
  '.bmp',
];

/**
 * Get the full path to the clipboard image directory
 * @param baseDir The base directory (usually workspace root)
 * @returns Full path to the clipboard image directory
 */
export function getClipboardImageDir(baseDir: string): string {
  return path.join(baseDir, CLIPBOARD_IMAGE_DIR);
}

/**
 * Ensure the clipboard image directory exists
 * @param baseDir The base directory (usually workspace root)
 * @returns Full path to the clipboard image directory
 */
export async function ensureClipboardImageDir(
  baseDir: string,
): Promise<string> {
  const dir = getClipboardImageDir(baseDir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Ensure the clipboard image directory exists (sync version)
 * @param baseDir The base directory (usually workspace root)
 * @returns Full path to the clipboard image directory
 */
export function ensureClipboardImageDirSync(baseDir: string): string {
  const dir = getClipboardImageDir(baseDir);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generate a unique filename for a clipboard image
 * @param extension File extension (with or without dot)
 * @returns Generated filename like "clipboard-1234567890.png"
 */
export function generateClipboardImageFilename(extension: string): string {
  const timestamp = Date.now();
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `clipboard-${timestamp}${ext}`;
}

/**
 * Save a base64 encoded image to the clipboard image directory
 * @param base64Data Base64 encoded image data (with or without data URL prefix)
 * @param fileName Original filename or generated filename
 * @param baseDir The base directory (usually workspace root)
 * @returns Relative path from baseDir to the saved file, or null if failed
 */
export async function saveBase64Image(
  base64Data: string,
  fileName: string,
  baseDir: string,
): Promise<string | null> {
  try {
    const dir = await ensureClipboardImageDir(baseDir);

    // Generate unique filename
    const ext = path.extname(fileName) || '.png';
    const tempFileName = generateClipboardImageFilename(ext);
    const tempFilePath = path.join(dir, tempFileName);

    // Extract base64 data if it's a data URL
    let pureBase64 = base64Data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      pureBase64 = dataUrlMatch[1];
    }

    // Write file
    const buffer = Buffer.from(pureBase64, 'base64');
    await fs.writeFile(tempFilePath, buffer);

    // Return relative path from baseDir
    return path.relative(baseDir, tempFilePath);
  } catch (error) {
    console.error('[clipboardImageStorage] Failed to save image:', error);
    return null;
  }
}

/**
 * Save a base64 encoded image to the clipboard image directory (sync version)
 * @param base64Data Base64 encoded image data (with or without data URL prefix)
 * @param fileName Original filename or generated filename
 * @param baseDir The base directory (usually workspace root)
 * @returns Relative path from baseDir to the saved file, or null if failed
 */
export function saveBase64ImageSync(
  base64Data: string,
  fileName: string,
  baseDir: string,
): string | null {
  try {
    const dir = ensureClipboardImageDirSync(baseDir);

    // Generate unique filename
    const ext = path.extname(fileName) || '.png';
    const tempFileName = generateClipboardImageFilename(ext);
    const tempFilePath = path.join(dir, tempFileName);

    // Extract base64 data if it's a data URL
    let pureBase64 = base64Data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      pureBase64 = dataUrlMatch[1];
    }

    // Write file
    const buffer = Buffer.from(pureBase64, 'base64');
    fsSync.writeFileSync(tempFilePath, buffer);

    // Return relative path from baseDir
    return path.relative(baseDir, tempFilePath);
  } catch (error) {
    console.error('[clipboardImageStorage] Failed to save image:', error);
    return null;
  }
}

/**
 * Clean up old clipboard image files
 * Removes files older than the specified threshold
 * @param baseDir The base directory (usually workspace root)
 * @param thresholdMs Age threshold in milliseconds (default: 1 hour)
 */
export async function cleanupOldClipboardImages(
  baseDir: string,
  thresholdMs: number = CLEANUP_THRESHOLD_MS,
): Promise<void> {
  try {
    const dir = getClipboardImageDir(baseDir);

    // Check if directory exists
    try {
      await fs.access(dir);
    } catch {
      // Directory doesn't exist, nothing to clean
      return;
    }

    const files = await fs.readdir(dir);
    const cutoffTime = Date.now() - thresholdMs;

    for (const file of files) {
      // Only clean up clipboard-* files with supported extensions
      if (file.startsWith('clipboard-')) {
        const ext = path.extname(file).toLowerCase();
        if (SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS.includes(ext)) {
          const filePath = path.join(dir, file);
          try {
            const stats = await fs.stat(filePath);
            if (stats.mtimeMs < cutoffTime) {
              await fs.unlink(filePath);
            }
          } catch {
            // Ignore errors for individual files
          }
        }
      }
    }
  } catch {
    // Ignore errors in cleanup
  }
}

/**
 * Check if a file extension is a supported clipboard image format
 * @param extension File extension (with or without dot)
 * @returns true if supported
 */
export function isSupportedClipboardImageExtension(extension: string): boolean {
  const ext = extension.startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;
  return SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS.includes(ext);
}
