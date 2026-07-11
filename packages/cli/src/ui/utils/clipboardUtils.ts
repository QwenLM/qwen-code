/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { statSync, constants as fsConstants } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDebugLogger, unescapePath } from '@qwen-code/qwen-code-core';
import { wrapForMultiplexer } from '../../utils/osc.js';

const debugLogger = createDebugLogger('CLIPBOARD_UTILS');

const PROCESS_TIMEOUT_MS = 5000;

/**
 * Write text to clipboard via OSC 52 escape sequence (works over SSH).
 * @param text - Text to copy to clipboard
 * @returns true if sequence was written, false if no TTY available or text too large
 */
export function writeOsc52(text: string): boolean {
  try {
    // Prevent multi-megabyte escape sequences that can crash/hang terminals.
    // iTerm2 caps at ~100KB base64, xterm at ~8KB. 75KB utf-8 ~ 100KB base64.
    const MAX_OSC52_BYTES = 75_000;
    if (Buffer.byteLength(text, 'utf-8') > MAX_OSC52_BYTES) {
      debugLogger.warn(
        `writeOsc52: text too large (${Buffer.byteLength(text, 'utf-8')} bytes), skipping`,
      );
      return false;
    }
    const base64 = Buffer.from(text, 'utf-8').toString('base64');
    // OSC 52: \x1b]52;c;<base64>\x07 (c = clipboard)
    const sequence = wrapForMultiplexer(`\x1b]52;c;${base64}\x07`);
    // Prefer stderr to avoid Ink's stdout rendering pipeline
    const stream = process.stderr.isTTY
      ? process.stderr
      : process.stdout.isTTY
        ? process.stdout
        : null;
    if (!stream) {
      debugLogger.warn(
        'OSC 52 clipboard requires a TTY; stdout/stderr not connected to terminal',
      );
      return false;
    }
    stream.write(sequence, (err) => {
      if (err) debugLogger.warn('writeOsc52: async write failed:', err);
    });
    return true;
  } catch (e) {
    debugLogger.warn('writeOsc52 failed:', e);
    return false;
  }
}

// Track which tool works on Linux to avoid redundant checks/failures
let linuxClipboardTool: 'wl-paste' | 'xclip' | null | undefined;

// Cache for wl-paste image types (reset after each paste operation)
let cachedWlPasteImageTypes: string[] | null = null;

// Cache for @teddyzhu/clipboard module (macOS/Windows fallback)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClipboardModule: any = null;
let clipboardLoadAttempted = false;

/**
 * Get and cache the @teddyzhu/clipboard module.
 * Only used on macOS/Windows as fallback for Linux platform-native tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getClipboardModule(): Promise<any | null> {
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
 * Reset the cached Linux clipboard tool. Used for testing.
 */
export function resetLinuxClipboardTool(): void {
  linuxClipboardTool = undefined;
  cachedWlPasteImageTypes = null;
}

/**
 * Detect the Linux clipboard tool.
 * Handles WSL2 where XDG_SESSION_TYPE may be unset but WAYLAND_DISPLAY is set.
 */
function getLinuxClipboardTool(): 'wl-paste' | 'xclip' | null {
  if (linuxClipboardTool !== undefined) return linuxClipboardTool;

  const sessionType = process.env['XDG_SESSION_TYPE'];
  const waylandDisplay = process.env['WAYLAND_DISPLAY'];
  const display = process.env['DISPLAY'];

  let toolName: 'wl-paste' | 'xclip' | null = null;

  if (sessionType === 'wayland' || waylandDisplay) {
    toolName = 'wl-paste';
  } else if (sessionType === 'x11' || display) {
    toolName = 'xclip';
  } else {
    linuxClipboardTool = null;
    return null;
  }

  try {
    execSync('command -v ' + toolName, { stdio: 'ignore' });
    linuxClipboardTool = toolName;
    return toolName;
  } catch {
    debugLogger.warn(`${toolName} not found`);
    linuxClipboardTool = null;
    return null;
  }
}

/**
 * Helper to save command stdout to a file with timeout and proper cleanup.
 */
async function saveFromCommand(
  command: string,
  args: string[],
  destination: string,
): Promise<boolean> {
  // Open with O_EXCL first to refuse symlink following.
  // If file already exists (race), return false immediately.
  let fd;
  try {
    fd = await fs.open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    );
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fileStream = fd.createWriteStream();
    let stderr = '';
    let resolved = false;

    const safeResolve = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        try {
          if (!child.killed) child.kill();
        } catch {
          /* ignore */
        }
        try {
          fileStream.destroy();
        } catch {
          /* ignore */
        }
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      debugLogger.debug(`${command} timed out after ${PROCESS_TIMEOUT_MS}ms`);
      safeResolve(false);
    }, PROCESS_TIMEOUT_MS);

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdout.pipe(fileStream);

    child.stdout.on('error', (err) => {
      debugLogger.debug(`stdout error for ${command}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });

    child.on('error', (err) => {
      debugLogger.debug(`Failed to spawn ${command}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });

    fileStream.on('error', (err) => {
      debugLogger.debug(`File stream error for ${destination}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;

      if (code !== 0) {
        debugLogger.debug(
          `${command} exited with code ${code}. Args: ${args.join(' ')}`,
        );
        if (stderr) debugLogger.debug(`${command} stderr: ${stderr.trim()}`);
        safeResolve(false);
        return;
      }

      const checkFile = () => {
        fs.stat(destination)
          .then((stats) => {
            safeResolve(stats.size > 0);
          })
          .catch(() => {
            safeResolve(false);
          });
      };

      if (fileStream.writableFinished) {
        checkFile();
      } else {
        fileStream.on('finish', checkFile);
        fileStream.on('close', () => {
          if (!resolved) checkFile();
        });
      }
    });
  });
}

/**
 * Check if the clipboard contains an image using the specified tool.
 * Merged function replacing checkWlPasteForImage and checkXclipForImage.
 * For wl-paste, caches the result for reuse by saveClipboardImage.
 */
async function checkClipboardForImage(
  command: string,
  args: string[],
): Promise<boolean> {
  // For wl-paste --list-types, cache the result
  if (
    command === 'wl-paste' &&
    args.length === 1 &&
    args[0] === '--list-types'
  ) {
    const types = await getWlPasteImageTypes();
    return types.length > 0;
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(false);
      }, PROCESS_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(
          code === 0 &&
            stdout
              .split('\n')
              // WSL2 Wayland: Windows clipboard exposes images as BMP (image/bmp),
              // which we convert to PNG via python3 PIL. Both formats must be detected.
              .some((line) => line === 'image/png' || line === 'image/bmp'),
        );
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Checks if the system clipboard contains an image.
 * Uses platform-native tools (wl-paste/xclip) on Linux.
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  cachedWlPasteImageTypes = null; // Fresh check each time
  if (process.platform === 'linux') {
    try {
      const tool = getLinuxClipboardTool();
      if (tool === 'wl-paste') {
        return checkClipboardForImage('wl-paste', ['--list-types']);
      }
      if (tool === 'xclip') {
        return checkClipboardForImage('xclip', [
          '-selection',
          'clipboard',
          '-t',
          'TARGETS',
          '-o',
        ]);
      }
    } catch (error) {
      debugLogger.error('Error checking clipboard for image:', error);
    }
    return false;
  }

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
 * Get the available image MIME types from wl-paste.
 * Uses cached result if available to avoid redundant calls.
 */
async function getWlPasteImageTypes(): Promise<string[]> {
  // Return cached result if available
  if (cachedWlPasteImageTypes !== null) {
    return cachedWlPasteImageTypes;
  }

  return new Promise<string[]>((resolve) => {
    const child = spawn('wl-paste', ['--list-types'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // Do NOT cache failed result (timeout)
      resolve([]);
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Do NOT cache failed result
        resolve([]);
        return;
      }
      const types = stdout
        .trim()
        .split('\n')
        .filter((t) => t === 'image/png' || t === 'image/bmp');
      cachedWlPasteImageTypes = types;
      resolve(types);
    });
    child.on('error', () => {
      clearTimeout(timer);
      // Do NOT cache failed result (error)
      resolve([]);
    });
  });
}

/**
 * Saves clipboard content to a file using wl-paste (Wayland).
 * Handles both PNG and BMP formats (WSL2 exposes BMP from Windows clipboard).
 * Returns the saved file path on success, false on failure.
 */
async function saveFileWithWlPaste(
  tempFilePath: string,
): Promise<string | false> {
  const imageTypes = await getWlPasteImageTypes();

  if (imageTypes.includes('image/png')) {
    const success = await saveFromCommand(
      'wl-paste',
      ['--no-newline', '--type', 'image/png'],
      tempFilePath,
    );
    if (success) return tempFilePath;
    try {
      await fs.unlink(tempFilePath);
    } catch {
      /* ignore */
    }
  }

  if (imageTypes.includes('image/bmp')) {
    const bmpPath = tempFilePath.replace(/\.png$/, '.bmp');
    const bmpSuccess = await saveFromCommand(
      'wl-paste',
      ['--no-newline', '--type', 'image/bmp'],
      bmpPath,
    );
    if (bmpSuccess) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            'python3',
            [
              '-c',
              'import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2])',
              bmpPath,
              tempFilePath,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
            reject(new Error('python3 timed out'));
          }, PROCESS_TIMEOUT_MS);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  `python3 exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`,
                ),
              );
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        try {
          await fs.unlink(bmpPath);
        } catch {
          /* ignore */
        }
        return tempFilePath;
      } catch (err) {
        debugLogger.warn(
          'BMP-to-PNG conversion failed (install python3-pil for BMP support):',
          err,
        );
        try {
          await fs.unlink(bmpPath);
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(tempFilePath);
        } catch {
          /* ignore */
        }
        // Return false to report clean failure — downstream expects .png
        return false;
      }
    }
    try {
      await fs.unlink(bmpPath);
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Saves clipboard content to a file using xclip (X11).
 */
async function saveFileWithXclip(tempFilePath: string): Promise<boolean> {
  const success = await saveFromCommand(
    'xclip',
    ['-selection', 'clipboard', '-t', 'image/png', '-o'],
    tempFilePath,
  );
  if (success) return true;
  try {
    await fs.unlink(tempFilePath);
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Saves the image from clipboard to a temporary file.
 * Uses platform-native tools (wl-paste/xclip) on Linux.
 * @param targetDir The target directory to create temp files within
 * @returns The path to the saved image file, or null if no image or error
 */
export async function saveClipboardImage(
  targetDir?: string,
): Promise<string | null> {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, 'clipboard');
    await fs.mkdir(tempDir, { recursive: true });
    const timestamp = new Date().getTime();

    if (process.platform === 'linux') {
      const pngPath = path.join(
        tempDir,
        `clipboard-${timestamp}-${randomUUID()}.png`,
      );
      const tool = getLinuxClipboardTool();

      if (tool === 'wl-paste') {
        const savedPath = await saveFileWithWlPaste(pngPath);
        if (savedPath) {
          try {
            const stats = await fs.stat(savedPath);
            if (stats.size > 0) return savedPath;
            // Empty file — clean up
            await fs.unlink(savedPath);
          } catch {
            /* ignore */
          }
        }
        return null;
      }
      if (tool === 'xclip') {
        if (await saveFileWithXclip(pngPath)) return pngPath;
        return null;
      }
      return null;
    }

    const mod = await getClipboardModule();
    if (!mod) return null;
    const clipboard = new mod.ClipboardManager();

    if (!clipboard.hasFormat('image')) {
      return null;
    }

    const tempFilePath = path.join(
      tempDir,
      `clipboard-${timestamp}-${randomUUID()}.png`,
    );
    const imageData = clipboard.getImageData();
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
 * Cleans up old temporary clipboard image files using LRU strategy.
 * Keeps maximum 100 images, when exceeding removes 50 oldest files.
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

    if (imageFiles.length > MAX_IMAGES) {
      imageFiles.sort((a, b) => a.atime - b.atime);
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
