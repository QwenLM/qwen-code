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

// Mock child_process for platform-native clipboard tools
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execSync: vi.fn(),
}));

// Mock fs for file operations
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ atimeMs: 0 }),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock ClipboardManager for non-Linux fallback
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
    it('should return true when clipboard contains image on Linux', async () => {
      // Mock wl-paste --list-types returning image types
      const mockStdout = {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('image/png\nimage/bmp\n'));
          }
        }),
      };
      const mockChild = {
        stdout: mockStdout,
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    it('should return false when clipboard does not contain image on Linux', async () => {
      // Mock wl-paste --list-types returning no image types
      const mockStdout = {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('text/plain\n'));
          }
        }),
      };
      const mockChild = {
        stdout: mockStdout,
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('Clipboard error');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('saveClipboardImage', () => {
    it('should return null when clipboard has no image', async () => {
      // Mock wl-paste --list-types returning no image types
      const mockStdout = {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('text/plain\n'));
          }
        }),
      };
      const mockChild = {
        stdout: mockStdout,
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should handle errors gracefully and return null', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('Clipboard error');
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
  });
});
