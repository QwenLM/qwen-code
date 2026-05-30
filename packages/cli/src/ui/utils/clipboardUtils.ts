/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('CLIPBOARD_UTILS');

// Track which tool works on Linux to avoid redundant checks/failures
let linuxClipboardTool: 'wl-paste' | 'xclip' | null | undefined;

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
    execSync(`command -v ${toolName}`, { stdio: 'ignore' });
    linuxClipboardTool = toolName;
    return toolName;
  } catch {
    debugLogger.warn(`${toolName} not found`);
    linuxClipboardTool = null;
    return null;
  }
}

/**
 * Helper to save command stdout to a file.
 */
async function saveFromCommand(
  command: string,
  args: string[],
  destination: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    const fileStream = createWriteStream(destination);
    let resolved = false;

    const safeResolve = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    child.stdout.pipe(fileStream);

    child.on('error', (err) => {
      debugLogger.debug(`Failed to spawn ${command}:`, err);
      safeResolve(false);
    });

    fileStream.on('error', (err) => {
      debugLogger.debug(`File stream error for ${destination}:`, err);
      safeResolve(false);
    });

    child.on('close', async (code) => {
      if (resolved) return;

      if (code !== 0) {
        debugLogger.debug(
          `${command} exited with code ${code}. Args: ${args.join(' ')}`,
        );
        safeResolve(false);
        return;
      }

      const checkFile = async () => {
        try {
          const { stat } = await import('node:fs/promises');
          const stats = await stat(destination);
          safeResolve(stats.size > 0);
        } catch {
          safeResolve(false);
        }
      };

      if (fileStream.writableFinished) {
        await checkFile();
      } else {
        fileStream.on('finish', checkFile);
        fileStream.on('close', async () => {
          if (!resolved) await checkFile();
        });
      }
    });
  });
}

/**
 * Check if the clipboard contains an image using wl-paste (Wayland).
 */
async function checkWlPasteForImage(): Promise<boolean> {
  try {
    return new Promise<boolean>((resolve) => {
      const child = spawn('wl-paste', ['--list-types']);
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.on('close', () => {
        resolve(stdout.includes('image/'));
      });
      child.on('error', () => resolve(false));
    });
  } catch (e) {
    debugLogger.warn('Error checking wl-clipboard for image:', e);
  }
  return false;
}

/**
 * Check if the clipboard contains an image using xclip (X11).
 */
async function checkXclipForImage(): Promise<boolean> {
  try {
    return new Promise<boolean>((resolve) => {
      const child = spawn('xclip', [
        '-selection',
        'clipboard',
        '-t',
        'TARGETS',
        '-o',
      ]);
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.on('close', () => {
        resolve(stdout.includes('image/'));
      });
      child.on('error', () => resolve(false));
    });
  } catch (e) {
    debugLogger.warn('Error checking xclip for image:', e);
  }
  return false;
}

/**
 * Checks if the system clipboard contains an image.
 * Uses platform-native tools (wl-paste/xclip) on Linux.
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  // Linux: use platform-native tools
  if (process.platform === 'linux') {
    const tool = getLinuxClipboardTool();
    if (tool === 'wl-paste') {
      return checkWlPasteForImage();
    }
    if (tool === 'xclip') {
      return checkXclipForImage();
    }
    return false;
  }

  // Fallback: use @teddyzhu/clipboard native module (macOS, Windows)
  try {
    const modName = '@teddyzhu/clipboard';
    const mod = await import(modName);
    const clipboard = new mod.ClipboardManager();
    return clipboard.hasFormat('image');
  } catch (error) {
    debugLogger.error('Error checking clipboard for image:', error);
    return false;
  }
}

/**
 * Get the available image MIME types from wl-paste.
 */
async function getWlPasteImageTypes(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const child = spawn('wl-paste', ['--list-types']);
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('close', () => {
      resolve(
        stdout
          .trim()
          .split('\n')
          .filter((t) => t.startsWith('image/')),
      );
    });
    child.on('error', () => resolve([]));
  });
}

/**
 * Saves clipboard content to a file using wl-paste (Wayland).
 * Handles both PNG and BMP formats (WSL2 exposes BMP from Windows clipboard).
 */
async function saveFileWithWlPaste(tempFilePath: string): Promise<boolean> {
  const imageTypes = await getWlPasteImageTypes();

  // Try PNG first
  if (imageTypes.includes('image/png')) {
    const success = await saveFromCommand(
      'wl-paste',
      ['--no-newline', '--type', 'image/png'],
      tempFilePath,
    );
    if (success) return true;
    try {
      await fs.unlink(tempFilePath);
    } catch {
      /* ignore */
    }
  }

  // Try BMP (common in WSL2) and convert to PNG
  if (imageTypes.includes('image/bmp')) {
    const bmpPath = tempFilePath.replace('.png', '.bmp');
    const bmpSuccess = await saveFromCommand(
      'wl-paste',
      ['--no-newline', '--type', 'image/bmp'],
      bmpPath,
    );
    if (bmpSuccess) {
      // Try converting BMP to PNG using Python PIL
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('python3', [
            '-c',
            `from PIL import Image; Image.open('${bmpPath}').save('${tempFilePath}')`,
          ]);
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`python3 exited with code ${code}`));
          });
          child.on('error', reject);
        });
        // Clean up BMP file
        try {
          await fs.unlink(bmpPath);
        } catch {
          /* ignore */
        }
        return true;
      } catch {
        // Python PIL not available, return BMP as-is
        try {
          await fs.rename(bmpPath, tempFilePath.replace('.png', '.bmp'));
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(bmpPath);
        } catch {
          /* ignore */
        }
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
  const baseDir = targetDir || process.cwd();
  const tempDir = path.join(baseDir, 'clipboard');
  await fs.mkdir(tempDir, { recursive: true });
  const timestamp = new Date().getTime();

  // Linux: use platform-native tools
  if (process.platform === 'linux') {
    const pngPath = path.join(tempDir, `clipboard-${timestamp}.png`);
    const tool = getLinuxClipboardTool();

    if (tool === 'wl-paste') {
      if (await saveFileWithWlPaste(pngPath)) {
        // Verify the file exists and has content
        try {
          const stats = await fs.stat(pngPath);
          if (stats.size > 0) return pngPath;
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

  // Fallback: use @teddyzhu/clipboard native module (macOS, Windows)
  try {
    const modName = '@teddyzhu/clipboard';
    const mod = await import(modName);
    const clipboard = new mod.ClipboardManager();

    if (!clipboard.hasFormat('image')) {
      return null;
    }

    const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);
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
