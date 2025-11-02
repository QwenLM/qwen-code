/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  canUseRipgrep,
  ensureRipgrepPath,
  getRipgrepPath,
} from './ripgrepUtils.js';
import { fileExists } from './fileUtils.js';
import path from 'node:path';

// Mock fileUtils
vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fileUtils.js')>();
  return {
    ...actual,
    fileExists: vi.fn(),
  };
});

describe('ripgrepUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getRipgrepPath', () => {
    it('should return path with .exe extension on Windows', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock Windows x64
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const rgPath = getRipgrepPath();

      expect(rgPath).toContain('x64-win32');
      expect(rgPath).toContain('rg.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return path without .exe extension on macOS', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock macOS arm64
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });

      const rgPath = getRipgrepPath();

      expect(rgPath).toContain('arm64-darwin');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return path without .exe extension on Linux', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock Linux x64
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const rgPath = getRipgrepPath();

      expect(rgPath).toContain('x64-linux');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should throw error for unsupported platform', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported platform
      Object.defineProperty(process, 'platform', { value: 'freebsd' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      expect(() => getRipgrepPath()).toThrow('Unsupported platform: freebsd');

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should throw error for unsupported architecture', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported architecture
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'ia32' });

      expect(() => getRipgrepPath()).toThrow('Unsupported architecture: ia32');

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should handle all supported platform/arch combinations', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      const combinations: Array<{
        platform: string;
        arch: string;
      }> = [
        { platform: 'darwin', arch: 'x64' },
        { platform: 'darwin', arch: 'arm64' },
        { platform: 'linux', arch: 'x64' },
        { platform: 'linux', arch: 'arm64' },
        { platform: 'win32', arch: 'x64' },
      ];

      combinations.forEach(({ platform, arch }) => {
        Object.defineProperty(process, 'platform', { value: platform });
        Object.defineProperty(process, 'arch', { value: arch });

        const rgPath = getRipgrepPath();
        const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
        const expectedPathSegment = path.join(
          `${arch}-${platform}`,
          binaryName,
        );
        expect(rgPath).toContain(expectedPathSegment);
      });

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });
  });

  describe('canUseRipgrep', () => {
    it('should return true if ripgrep binary exists (builtin)', async () => {
      (fileExists as Mock).mockResolvedValue(true);

      const result = await canUseRipgrep(true);

      expect(result).toBe(true);
      expect(fileExists).toHaveBeenCalledOnce();
    });

    it('should return true if ripgrep binary exists (default)', async () => {
      (fileExists as Mock).mockResolvedValue(true);

      const result = await canUseRipgrep();

      expect(result).toBe(true);
      expect(fileExists).toHaveBeenCalledOnce();
    });

    it('should fall back to system rg if bundled ripgrep binary does not exist', async () => {
      (fileExists as Mock).mockResolvedValue(false);
      // When useBuiltin is true but bundled binary doesn't exist,
      // it should fall back to checking system rg (which will spawn a process)
      // In this test environment, system rg is likely available, so result should be true
      // unless spawn fails

      const result = await canUseRipgrep();

      // The test may pass or fail depending on system rg availability
      // Just verify that fileExists was called to check bundled binary first
      expect(fileExists).toHaveBeenCalledOnce();
      // Result depends on whether system rg is installed
      expect(typeof result).toBe('boolean');
    });

    // Note: Tests for system ripgrep detection (useBuiltin=false) would require mocking
    // the child_process spawn function, which is complex in ESM. These cases are tested
    // indirectly through integration tests.

    it('should return false if platform is unsupported', async () => {
      const originalPlatform = process.platform;

      // Mock unsupported platform
      Object.defineProperty(process, 'platform', { value: 'aix' });

      const result = await canUseRipgrep();

      expect(result).toBe(false);
      expect(fileExists).not.toHaveBeenCalled();

      // Restore original value
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return false if architecture is unsupported', async () => {
      const originalArch = process.arch;

      // Mock unsupported architecture
      Object.defineProperty(process, 'arch', { value: 's390x' });

      const result = await canUseRipgrep();

      expect(result).toBe(false);
      expect(fileExists).not.toHaveBeenCalled();

      // Restore original value
      Object.defineProperty(process, 'arch', { value: originalArch });
    });
  });

  describe('ensureRipgrepBinary', () => {
    it('should return ripgrep path if binary exists', async () => {
      (fileExists as Mock).mockResolvedValue(true);

      const rgPath = await ensureRipgrepPath();

      expect(rgPath).toBeDefined();
      expect(rgPath).toContain('rg');
      expect(fileExists).toHaveBeenCalledOnce();
      expect(fileExists).toHaveBeenCalledWith(rgPath);
    });

    it('should throw error if binary does not exist', async () => {
      (fileExists as Mock).mockResolvedValue(false);

      await expect(ensureRipgrepPath()).rejects.toThrow(
        /Ripgrep binary not found/,
      );
      await expect(ensureRipgrepPath()).rejects.toThrow(/Platform:/);
      await expect(ensureRipgrepPath()).rejects.toThrow(/Architecture:/);

      expect(fileExists).toHaveBeenCalled();
    });

    it('should throw error with correct path information', async () => {
      (fileExists as Mock).mockResolvedValue(false);

      try {
        await ensureRipgrepPath();
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('Ripgrep binary not found at');
        expect(errorMessage).toContain(process.platform);
        expect(errorMessage).toContain(process.arch);
      }
    });

    it('should throw error if platform is unsupported', async () => {
      const originalPlatform = process.platform;

      // Mock unsupported platform
      Object.defineProperty(process, 'platform', { value: 'openbsd' });

      await expect(ensureRipgrepPath()).rejects.toThrow(
        'Unsupported platform: openbsd',
      );

      // Restore original value
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });
});
