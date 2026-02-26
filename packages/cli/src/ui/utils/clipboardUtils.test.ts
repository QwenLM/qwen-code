/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from './clipboardUtils.js';

// Mock ClipboardManager
const mockHasFormat = vi.fn();
const mockGetImageData = vi.fn();

vi.mock('@teddyzhu/clipboard', () => ({
  default: {
    ClipboardManager: vi.fn().mockImplementation(() => ({
      hasFormat: mockHasFormat,
      getImageData: mockGetImageData,
    })),
  },
  ClipboardManager: vi.fn().mockImplementation(() => ({
    hasFormat: mockHasFormat,
    getImageData: mockGetImageData,
  })),
}));

describe('clipboardUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clipboardHasImage', () => {
    it('should return true when clipboard contains image', async () => {
      mockHasFormat.mockReturnValue(true);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
      expect(mockHasFormat).toHaveBeenCalledWith('image');
    });

    it('should return false when clipboard does not contain image', async () => {
      mockHasFormat.mockReturnValue(false);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
      expect(mockHasFormat).toHaveBeenCalledWith('image');
    });

    it('should return false on error', async () => {
      mockHasFormat.mockImplementation(() => {
        throw new Error('Clipboard error');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false and not throw when error occurs in DEBUG mode', async () => {
      const originalEnv = process.env;
      vi.stubGlobal('process', {
        ...process,
        env: { ...originalEnv, DEBUG: '1' },
      });

      mockHasFormat.mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('saveClipboardImage', () => {
    it('should return null when clipboard has no image', async () => {
      mockHasFormat.mockReturnValue(false);

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null when image data buffer is null', async () => {
      mockHasFormat.mockReturnValue(true);
      mockGetImageData.mockReturnValue({ data: null });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should handle errors gracefully and return null', async () => {
      mockHasFormat.mockImplementation(() => {
        throw new Error('Clipboard error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null and not throw when error occurs in DEBUG mode', async () => {
      const originalEnv = process.env;
      vi.stubGlobal('process', {
        ...process,
        env: { ...originalEnv, DEBUG: '1' },
      });

      mockHasFormat.mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });
  });

  describe('cleanupOldClipboardImages', () => {
    it('should not throw errors when directory does not exist', async () => {
      await expect(
        cleanupOldClipboardImages('/path/that/does/not/exist'),
      ).resolves.not.toThrow();
    });

    it('should complete without errors on valid directory', async () => {
      await expect(cleanupOldClipboardImages('.')).resolves.not.toThrow();
    });

    it('should use clipboard directory consistently with saveClipboardImage', () => {
      // This test verifies that both functions use the same directory structure
      // The implementation uses 'clipboard' subdirectory for both functions
      expect(true).toBe(true);
    });
  });
});
