/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from './clipboardUtils.js';

// Mock execCommand to prevent actual system calls during testing
vi.mock('@qwen-code/qwen-code-core', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '@qwen-code/qwen-code-core';

describe('clipboardUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clipboardHasImage', () => {
    it('should return false when osascript fails on macOS', async () => {
      if (process.platform === 'darwin') {
        vi.mocked(execCommand).mockRejectedValue(new Error('Command failed'));

        const result = await clipboardHasImage();
        expect(result).toBe(false);
        expect(execCommand).toHaveBeenCalledWith('osascript', [
          '-e',
          'clipboard info',
        ]);
      } else {
        // Skip on non-macOS
        expect(true).toBe(true);
      }
    });

    it('should detect image on macOS when osascript succeeds', async () => {
      if (process.platform === 'darwin') {
        vi.mocked(execCommand).mockResolvedValue({
          stdout: '«class PNGf»',
          stderr: '',
          code: 0,
        });

        const result = await clipboardHasImage();
        expect(result).toBe(true);
        expect(execCommand).toHaveBeenCalledWith('osascript', [
          '-e',
          'clipboard info',
        ]);
      } else {
        // Skip on non-macOS
        expect(true).toBe(true);
      }
    });

    it('should return false on Windows when PowerShell command fails', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockRejectedValue(new Error('PowerShell failed'));

      const result = await clipboardHasImage();
      expect(result).toBe(false);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should return true when Windows clipboard has an image', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockResolvedValue({
        stdout: 'true',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(true);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should return false on Windows when clipboard has no image', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockResolvedValue({
        stdout: 'false',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should return false on unsupported platforms', async () => {
      // Temporarily override platform for testing
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'linux',
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);

      // Restore original platform
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
      });
    });
  });

  describe('saveClipboardImage', () => {
    it('should return null on macOS when osascript fails', async () => {
      if (process.platform === 'darwin') {
        vi.mocked(execCommand).mockRejectedValue(new Error('Command failed'));

        const result = await saveClipboardImage();
        expect(result).toBe(null);
        expect(execCommand).toHaveBeenCalledWith(
          'osascript',
          expect.anything(),
        );
      } else {
        // Skip on non-macOS
        expect(true).toBe(true);
      }
    });

    it('should return path when macOS successfully saves image', async () => {
      if (process.platform === 'darwin') {
        vi.mocked(execCommand).mockResolvedValue({
          stdout: 'success',
          stderr: '',
          code: 0,
        });

        const result = await saveClipboardImage();
        expect(result).not.toBe(null);
        expect(execCommand).toHaveBeenCalledWith(
          'osascript',
          expect.anything(),
        );
      } else {
        // Skip on non-macOS
        expect(true).toBe(true);
      }
    });

    it('should return null on Windows when PowerShell command fails', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockRejectedValue(new Error('PowerShell failed'));

      const result = await saveClipboardImage();
      expect(result).toBe(null);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should return null on Windows when clipboard has no image', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockResolvedValue({
        stdout: 'error',
        stderr: '',
        code: 0,
      });

      const result = await saveClipboardImage();
      expect(result).toBe(null);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should return path when Windows successfully saves image', async () => {
      // Temporarily override the platform for testing
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      vi.mocked(execCommand).mockResolvedValue({
        stdout: 'success',
        stderr: '',
        code: 0,
      });

      const result = await saveClipboardImage();
      expect(result).not.toBe(null);
      expect(execCommand).toHaveBeenCalledWith('powershell', expect.anything());
    });

    it('should handle errors gracefully on invalid directory', async () => {
      const result = await saveClipboardImage(
        '/invalid/path/that/does/not/exist',
      );

      if (process.platform === 'darwin') {
        // On macOS, might return null due to various errors
        expect(result === null || typeof result === 'string').toBe(true);
      } else if (process.platform === 'win32') {
        // On Windows, might return null due to various errors
        expect(result === null || typeof result === 'string').toBe(true);
      } else {
        // On other platforms, should always return null
        expect(result).toBe(null);
      }
    });
  });

  describe('cleanupOldClipboardImages', () => {
    it('should not throw errors', async () => {
      // Should handle missing directories gracefully
      await expect(
        cleanupOldClipboardImages('/path/that/does/not/exist'),
      ).resolves.not.toThrow();
    });

    it('should complete without errors on valid directory', async () => {
      await expect(cleanupOldClipboardImages('.')).resolves.not.toThrow();
    });
  });
});
