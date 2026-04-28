/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger, unescapePath } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('CLIPBOARD_UTILS');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClipboardModule = any;

let cachedClipboardModule: ClipboardModule | null = null;
let clipboardLoadAttempted = false;

async function getClipboardModule(): Promise<ClipboardModule | null> {
  if (clipboardLoadAttempted) return cachedClipboardModule;
  clipboardLoadAttempted = true;

  try {
    const modName = '@teddyzhu/clipboard';
    cachedClipboardModule = await import(modName);
    return cachedClipboardModule;
  } catch (_e) {
    debugLogger.error(
      'Failed to load @teddyzhu/clipboard native module. Clipboard image features will be unavailable.',
    );
    return null;
  }
}

/**
 * Checks if the system clipboard contains an image
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const mod = await getClipboardModule();
    if (!mod) return false;
    const clipboard = new mod.ClipboardManager();
    return clipboard.hasFormat('image');
  } catch (error) {
    debugLogger.error('Error checking clipboard for image:', error);
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
    const mod = await getClipboardModule();
    if (!mod) return null;
    const clipboard = new mod.ClipboardManager();

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
    debugLogger.error('Error saving clipboard image:', error);
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
          file.endsWith('.jpeg') ||
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

/* -------------------- base64 / data-URL / drag-drop helpers -------------------- */

// Image magic bytes — matched against the first few bytes of a decoded buffer.
const IMAGE_MAGIC: Array<{
  ext: string;
  mimeType: string;
  check: (b: Buffer) => boolean;
}> = [
  {
    ext: 'png',
    mimeType: 'image/png',
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    ext: 'jpg',
    mimeType: 'image/jpeg',
    check: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    mimeType: 'image/gif',
    check: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    ext: 'webp',
    mimeType: 'image/webp',
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    ext: 'bmp',
    mimeType: 'image/bmp',
    check: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d,
  },
  {
    ext: 'tiff',
    mimeType: 'image/tiff',
    check: (b) =>
      b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)),
  },
];

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
]);

function detectByMagic(buf: Buffer): { ext: string; mimeType: string } | null {
  for (const m of IMAGE_MAGIC) {
    if (m.check(buf)) return { ext: m.ext, mimeType: m.mimeType };
  }
  return null;
}

function isLikelyBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/**
 * Try to interpret a pasted text payload as an inline base64 image.
 *
 * Accepts either:
 *   - a `data:image/<type>;base64,<payload>` URL, or
 *   - a raw base64 string whose decoded bytes start with a known image magic.
 *
 * Returns null when the text is not a recognizable image — callers then treat
 * it as ordinary text.
 */
export function tryDecodeBase64Image(
  text: string,
): { buffer: Buffer; mimeType: string; ext: string } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length < 32) return null;

  // Data URL form.
  const dataUrl =
    /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (dataUrl) {
    const declaredMime = dataUrl[1].toLowerCase();
    const payload = dataUrl[2].replace(/\s+/g, '');
    if (!isLikelyBase64(payload)) return null;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(payload, 'base64');
    } catch {
      return null;
    }
    if (buffer.length === 0) return null;
    const sniffed = detectByMagic(buffer);
    const mimeType = sniffed?.mimeType ?? declaredMime;
    const ext = sniffed?.ext ?? EXT_BY_MIME[declaredMime] ?? 'bin';
    return { buffer, mimeType, ext };
  }

  // Raw base64 form. Be conservative — require the decoded prefix to match a
  // known image magic so we never silently turn JWTs / hashes into images.
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length < 64 || !isLikelyBase64(compact)) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(compact, 'base64');
  } catch {
    return null;
  }
  const sniffed = detectByMagic(buffer);
  if (!sniffed) return null;
  return { buffer, mimeType: sniffed.mimeType, ext: sniffed.ext };
}

/**
 * Persist a decoded image buffer to the standard clipboard temp dir,
 * returning the absolute file path.
 */
export async function saveDecodedImage(
  buffer: Buffer,
  ext: string,
  targetDir?: string,
): Promise<string> {
  const baseDir = targetDir || process.cwd();
  const tempDir = path.join(baseDir, 'clipboard');
  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(
    tempDir,
    `clipboard-${Date.now()}.${ext || 'bin'}`,
  );
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Try to interpret a pasted text payload as a file path dragged onto the
 * terminal pointing at a local image file. Returns the absolute path when it
 * exists, is a regular file, and has a recognized image extension. Terminals
 * typically wrap drag-drop paths in single quotes when the path contains
 * spaces; both quoted and unquoted forms are accepted.
 */
export function detectDraggedImagePath(text: string): string | null {
  if (!text) return null;
  let candidate = text.trim();
  if (candidate.length < 3) return null;
  const quoteMatch = candidate.match(/^'(.*)'$/) ?? candidate.match(/^"(.*)"$/);
  if (quoteMatch) {
    candidate = quoteMatch[1];
  }
  candidate = unescapePath(candidate.trim());
  if (!candidate || candidate.includes('\n')) return null;
  const ext = path.extname(candidate).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  try {
    const stats = statSync(candidate);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}
