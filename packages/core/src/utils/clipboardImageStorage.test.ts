/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CLIPBOARD_IMAGE_DIR,
  CLEANUP_THRESHOLD_MS,
  SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS,
  getClipboardImageDir,
  ensureClipboardImageDir,
  ensureClipboardImageDirSync,
  generateClipboardImageFilename,
  saveBase64Image,
  saveBase64ImageSync,
  cleanupOldClipboardImages,
  isSupportedClipboardImageExtension,
} from './clipboardImageStorage.js';

describe('clipboardImageStorage', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constants', () => {
    it('should have correct clipboard image directory name', () => {
      expect(CLIPBOARD_IMAGE_DIR).toBe('.qwen-code-clipboard');
    });

    it('should have correct cleanup threshold (1 hour)', () => {
      expect(CLEANUP_THRESHOLD_MS).toBe(60 * 60 * 1000);
    });

    it('should support common image extensions', () => {
      expect(SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS).toContain('.png');
      expect(SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS).toContain('.jpg');
      expect(SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS).toContain('.jpeg');
      expect(SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS).toContain('.gif');
      expect(SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS).toContain('.webp');
    });
  });

  describe('getClipboardImageDir', () => {
    it('should return correct path', () => {
      const result = getClipboardImageDir('/workspace');
      expect(result).toBe(path.join('/workspace', '.qwen-code-clipboard'));
    });
  });

  describe('ensureClipboardImageDir', () => {
    it('should create directory if not exists', async () => {
      const dir = await ensureClipboardImageDir(tempDir);
      expect(dir).toBe(path.join(tempDir, CLIPBOARD_IMAGE_DIR));

      const stats = await fs.stat(dir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should not fail if directory already exists', async () => {
      await ensureClipboardImageDir(tempDir);
      const dir = await ensureClipboardImageDir(tempDir);
      expect(dir).toBe(path.join(tempDir, CLIPBOARD_IMAGE_DIR));
    });
  });

  describe('ensureClipboardImageDirSync', () => {
    it('should create directory if not exists', () => {
      const dir = ensureClipboardImageDirSync(tempDir);
      expect(dir).toBe(path.join(tempDir, CLIPBOARD_IMAGE_DIR));
      expect(fsSync.existsSync(dir)).toBe(true);
    });
  });

  describe('generateClipboardImageFilename', () => {
    it('should generate filename with timestamp and extension', () => {
      const filename = generateClipboardImageFilename('.png');
      expect(filename).toMatch(/^clipboard-\d+\.png$/);
    });

    it('should handle extension without dot', () => {
      const filename = generateClipboardImageFilename('jpg');
      expect(filename).toMatch(/^clipboard-\d+\.jpg$/);
    });
  });

  describe('saveBase64Image', () => {
    it('should save base64 image to file', async () => {
      // Simple 1x1 red PNG in base64
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

      const relativePath = await saveBase64Image(
        base64Data,
        'test.png',
        tempDir,
      );

      expect(relativePath).not.toBeNull();
      expect(relativePath).toMatch(
        /^\.qwen-code-clipboard\/clipboard-\d+\.png$/,
      );

      const fullPath = path.join(tempDir, relativePath!);
      const stats = await fs.stat(fullPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should handle data URL format', async () => {
      const base64Data =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

      const relativePath = await saveBase64Image(
        base64Data,
        'test.png',
        tempDir,
      );

      expect(relativePath).not.toBeNull();

      const fullPath = path.join(tempDir, relativePath!);
      const stats = await fs.stat(fullPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should use default extension if not provided', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

      const relativePath = await saveBase64Image(base64Data, 'noext', tempDir);

      expect(relativePath).toMatch(/\.png$/);
    });
  });

  describe('saveBase64ImageSync', () => {
    it('should save base64 image to file synchronously', () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

      const relativePath = saveBase64ImageSync(base64Data, 'test.png', tempDir);

      expect(relativePath).not.toBeNull();
      expect(relativePath).toMatch(
        /^\.qwen-code-clipboard\/clipboard-\d+\.png$/,
      );

      const fullPath = path.join(tempDir, relativePath!);
      expect(fsSync.existsSync(fullPath)).toBe(true);
    });
  });

  describe('cleanupOldClipboardImages', () => {
    it('should remove files older than threshold', async () => {
      // Create clipboard directory
      const clipboardDir = await ensureClipboardImageDir(tempDir);

      // Create an old file
      const oldFilePath = path.join(clipboardDir, 'clipboard-1234567890.png');
      await fs.writeFile(oldFilePath, 'test');

      // Set mtime to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(oldFilePath, twoHoursAgo, twoHoursAgo);

      // Create a new file
      const newFilePath = path.join(clipboardDir, 'clipboard-9999999999.png');
      await fs.writeFile(newFilePath, 'test');

      // Run cleanup
      await cleanupOldClipboardImages(tempDir);

      // Old file should be deleted
      await expect(fs.access(oldFilePath)).rejects.toThrow();

      // New file should still exist
      await expect(fs.access(newFilePath)).resolves.toBeUndefined();
    });

    it('should not fail if directory does not exist', async () => {
      // Should not throw
      await expect(cleanupOldClipboardImages(tempDir)).resolves.toBeUndefined();
    });

    it('should only clean clipboard-* files', async () => {
      const clipboardDir = await ensureClipboardImageDir(tempDir);

      // Create a non-clipboard file
      const otherFilePath = path.join(clipboardDir, 'other-file.png');
      await fs.writeFile(otherFilePath, 'test');

      // Set mtime to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(otherFilePath, twoHoursAgo, twoHoursAgo);

      // Run cleanup
      await cleanupOldClipboardImages(tempDir);

      // Other file should still exist
      await expect(fs.access(otherFilePath)).resolves.toBeUndefined();
    });
  });

  describe('isSupportedClipboardImageExtension', () => {
    it('should return true for supported extensions', () => {
      expect(isSupportedClipboardImageExtension('.png')).toBe(true);
      expect(isSupportedClipboardImageExtension('.jpg')).toBe(true);
      expect(isSupportedClipboardImageExtension('.jpeg')).toBe(true);
      expect(isSupportedClipboardImageExtension('.gif')).toBe(true);
      expect(isSupportedClipboardImageExtension('.webp')).toBe(true);
    });

    it('should return true for extensions without dot', () => {
      expect(isSupportedClipboardImageExtension('png')).toBe(true);
      expect(isSupportedClipboardImageExtension('jpg')).toBe(true);
    });

    it('should return false for unsupported extensions', () => {
      expect(isSupportedClipboardImageExtension('.txt')).toBe(false);
      expect(isSupportedClipboardImageExtension('.pdf')).toBe(false);
      expect(isSupportedClipboardImageExtension('.doc')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isSupportedClipboardImageExtension('.PNG')).toBe(true);
      expect(isSupportedClipboardImageExtension('.JPG')).toBe(true);
    });
  });
});
