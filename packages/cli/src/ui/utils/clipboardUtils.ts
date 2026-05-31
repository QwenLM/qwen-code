/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createWriteStream, statSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('CLIPBOARD_UTILS');

const PROCESS_TIMEOUT_MS = 5000;

// Track which tool works on Linux to avoid redundant checks/failures
let linuxClipboardTool: 'wl-paste' | 'xclip' | null | undefined;

/**
 * Reset the cached Linux clipboard tool. Used for testing.
 */
export function resetLinuxClipboardTool(): void {
  linuxClipboardTool = undefined;
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
 * Helper to save command stdout to a file with timeout and proper cleanup.
 */
async function saveFromCommand(
  command: string,
  args: string[],
  destination: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const fileStream = createWriteStream(destination);
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

    child.stdout.pipe(fileStream);

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

    child.on('close', async (code) => {
      clearTimeout(timer);
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
          const stats = statSync(destination);
          safeResolve(stats.size > 0);
        } catch {
          safeResolve(false);
        }
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
 */
async function checkClipboardForImage(
  command: string,
  args: string[],
): Promise<boolean> {
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
        resolve(code === 0 && stdout.includes('image/'));
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
  if (process.platform === 'linux') {
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
    return false;
  }

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
      resolve([]);
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(
        stdout
          .trim()
          .split('\n')
          .filter((t) => t.startsWith('image/')),
      );
    });
    child.on('error', () => {
      clearTimeout(timer);
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
    const bmpPath = tempFilePath.replace('.png', '.bmp');
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
            { stdio: ['ignore', 'ignore', 'ignore'] },
          );
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
            else reject(new Error(`python3 exited with code ${code}`));
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
        debugLogger.debug(
          'Python PIL not available; BMP-to-PNG conversion failed:',
          err,
        );
        return bmpPath;
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
      const pngPath = path.join(tempDir, `clipboard-${timestamp}.png`);
      const tool = getLinuxClipboardTool();

      if (tool === 'wl-paste') {
        const savedPath = await saveFileWithWlPaste(pngPath);
        if (savedPath) {
          try {
            const stats = await fs.stat(savedPath);
            if (stats.size > 0) return savedPath;
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
