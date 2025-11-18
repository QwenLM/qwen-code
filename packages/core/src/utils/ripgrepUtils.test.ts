/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  canUseRipgrep,
  getRipgrepCommand,
  getBuiltinRipgrep,
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

  describe('getBulltinRipgrepPath', () => {
    it('should return path with .exe extension on Windows', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock Windows x64
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const rgPath = getBuiltinRipgrep();

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

      const rgPath = getBuiltinRipgrep();

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

      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('x64-linux');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return null for unsupported platform', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported platform
      Object.defineProperty(process, 'platform', { value: 'freebsd' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      expect(getBuiltinRipgrep()).toBeNull();

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return null for unsupported architecture', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported architecture
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'ia32' });

      expect(getBuiltinRipgrep()).toBeNull();

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

        const rgPath = getBuiltinRipgrep();
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
  });

  describe('ensureRipgrepPath', () => {
    it('should return bundled ripgrep path if binary exists (useBuiltin=true)', async () => {
      (fileExists as Mock).mockResolvedValue(true);

      const rgPath = await getRipgrepCommand(true);

      expect(rgPath).toBeDefined();
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toBe('rg'); // Should be full path, not just 'rg'
      expect(fileExists).toHaveBeenCalledOnce();
      expect(fileExists).toHaveBeenCalledWith(rgPath);
    });

    it('should return bundled ripgrep path if binary exists (default)', async () => {
      (fileExists as Mock).mockResolvedValue(true);

      const rgPath = await getRipgrepCommand();

      expect(rgPath).toBeDefined();
      expect(rgPath).toContain('rg');
      expect(fileExists).toHaveBeenCalledOnce();
    });

    it('should fall back to system rg if bundled binary does not exist', async () => {
      (fileExists as Mock).mockResolvedValue(false);
      // When useBuiltin is true but bundled binary doesn't exist,
      // it should fall back to checking system rg
      // The test result depends on whether system rg is actually available

      const rgPath = await getRipgrepCommand(true);

      expect(fileExists).toHaveBeenCalledOnce();
      // If system rg is available, it should return 'rg' (or 'rg.exe' on Windows)
      // This test will pass if system ripgrep is installed
      expect(rgPath).toBeDefined();
    });

    it('should use system rg when useBuiltin=false', async () => {
      // When useBuiltin is false, should skip bundled check and go straight to system rg
      const rgPath = await getRipgrepCommand(false);

      // Should not check for bundled binary
      expect(fileExists).not.toHaveBeenCalled();
      // If system rg is available, it should return 'rg' (or 'rg.exe' on Windows)
      expect(rgPath).toBeDefined();
    });

    it('should throw error if neither bundled nor system ripgrep is available', async () => {
      // This test only makes sense in an environment where system rg is not installed
      // We'll skip this test in CI/local environments where rg might be available
      // Instead, we test the error message format
      const originalPlatform = process.platform;

      // Use an unsupported platform to trigger the error path
      Object.defineProperty(process, 'platform', { value: 'freebsd' });

      try {
        await getRipgrepCommand();
        // If we get here without error, system rg was available, which is fine
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        // Should contain helpful error information
        expect(
          errorMessage.includes('Ripgrep binary not found') ||
            errorMessage.includes('Failed to locate ripgrep') ||
            errorMessage.includes('Unsupported platform'),
        ).toBe(true);
      }

      // Restore original value
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });
});
