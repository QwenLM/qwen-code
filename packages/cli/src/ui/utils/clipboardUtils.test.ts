/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { execCommand } from '@qwen-code/qwen-code-core';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from './clipboardUtils.js';

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    execCommand: vi.fn(),
  };
});

describe('clipboardUtils', () => {
  const mockExecCommand = vi.mocked(execCommand);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clipboardHasImage', () => {
    test('detects image on macOS', async () => {
      // Mock macOS platform
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
      });

      mockExecCommand.mockResolvedValue({
        stdout: '«class PNGf»',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('osascript', [
        '-e',
        'clipboard info',
      ]);
    });

    test('does not detect image on macOS when no image present', async () => {
      // Mock macOS platform
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
      });

      mockExecCommand.mockResolvedValue({
        stdout: 'text',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    test('detects image on Windows', async () => {
      // Mock Windows platform
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      mockExecCommand.mockResolvedValue({
        stdout: 'True',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    test('does not detect image on Windows when no image present', async () => {
      // Mock Windows platform
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      mockExecCommand.mockResolvedValue({
        stdout: 'False',
        stderr: '',
        code: 0,
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    test('detects image on Linux with xclip', async () => {
      // Mock Linux platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
      });

      // Mock successful 'which xclip' command
      mockExecCommand.mockImplementation((command, args) => {
        if (command === 'which' && args[0] === 'xclip') {
          return Promise.resolve({
            stdout: '/usr/bin/xclip',
            stderr: '',
            code: 0,
          });
        }
        if (command === 'xclip' && args.includes('-o')) {
          return Promise.resolve({
            stdout: 'fake image data',
            stderr: '',
            code: 0,
          });
        }
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      });

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    test('handles error gracefully', async () => {
      // Mock any platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
      });

      mockExecCommand.mockRejectedValue(new Error('Command failed'));

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('saveClipboardImage', () => {
    test('saves image on macOS', async () => {
      // Mock macOS platform
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
      });

      mockExecCommand.mockImplementation((command, _args) => {
        if (command === 'osascript') {
          return Promise.resolve({ stdout: 'success', stderr: '', code: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      });

      // Mock fs operations
      const mockMkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const mockStat = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 1000,
        mtimeMs: Date.now(),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ino: 0,
        dev: 0,
        atimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
        atime: new Date(),
        mtime: new Date(),
        ctime: new Date(),
        birthtime: new Date(),
      } as unknown as Stats);

      const result = await saveClipboardImage('/tmp');
      expect(result).toContain('clipboard-');
      expect(result).toContain('.png');
      expect(mockMkdir).toHaveBeenCalledWith(
        path.join('/tmp', '.qwen-clipboard'),
        { recursive: true },
      );

      mockMkdir.mockRestore();
      mockStat.mockRestore();
    });

    test('saves image on Windows', async () => {
      // Mock Windows platform
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });

      mockExecCommand.mockImplementation((command, _args) => {
        if (command === 'powershell') {
          return Promise.resolve({ stdout: 'success', stderr: '', code: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      });

      // Mock fs operations
      const mockMkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const mockStat = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 1000,
        mtimeMs: Date.now(),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ino: 0,
        dev: 0,
        atimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
        atime: new Date(),
        mtime: new Date(),
        ctime: new Date(),
        birthtime: new Date(),
      } as unknown as Stats);

      const result = await saveClipboardImage('/tmp');
      expect(result).toContain('clipboard-');
      expect(result).toContain('.png');

      mockMkdir.mockRestore();
      mockStat.mockRestore();
    });
  });

  describe('cleanupOldClipboardImages', () => {
    test('cleans up old files', async () => {
      // Mock fs operations
      const mockAccess = vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      const mockReaddir = vi
        .spyOn(fs, 'readdir')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(['clipboard-123.png', 'clipboard-456.jpg'] as any);
      const mockStat = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 1000,
        mtimeMs: Date.now() - 10 * 60 * 1000, // 10 minutes ago (older than 5 min threshold)
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ino: 0,
        dev: 0,
        atimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
        atime: new Date(),
        mtime: new Date(),
        ctime: new Date(),
        birthtime: new Date(),
      } as unknown as Stats);
      const mockUnlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      await cleanupOldClipboardImages('/tmp');

      expect(mockAccess).toHaveBeenCalledWith(
        path.join('/tmp', '.qwen-clipboard'),
      );
      expect(mockReaddir).toHaveBeenCalledWith(
        path.join('/tmp', '.qwen-clipboard'),
      );
      expect(mockUnlink).toHaveBeenCalled(); // Called for each old file

      mockAccess.mockRestore();
      mockReaddir.mockRestore();
      mockStat.mockRestore();
      mockUnlink.mockRestore();
    });

    test('does not clean up recent files', async () => {
      // Mock fs operations
      const mockAccess = vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      const mockReaddir = vi
        .spyOn(fs, 'readdir')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(['clipboard-recent.png'] as any);
      const mockStat = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 1000,
        mtimeMs: Date.now() - 2 * 60 * 1000, // 2 minutes ago (newer than 5 min threshold)
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ino: 0,
        dev: 0,
        atimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
        atime: new Date(),
        mtime: new Date(),
        ctime: new Date(),
        birthtime: new Date(),
      } as unknown as Stats);
      const mockUnlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      await cleanupOldClipboardImages('/tmp');

      expect(mockAccess).toHaveBeenCalledWith(
        path.join('/tmp', '.qwen-clipboard'),
      );
      expect(mockReaddir).toHaveBeenCalledWith(
        path.join('/tmp', '.qwen-clipboard'),
      );
      expect(mockUnlink).not.toHaveBeenCalled(); // Should not be called for recent files

      mockAccess.mockRestore();
      mockReaddir.mockRestore();
      mockStat.mockRestore();
      mockUnlink.mockRestore();
    });
  });
});
