/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _resetRipgrepUtilsCachesForTest,
  canUseRipgrep,
  getBuiltinRipgrep,
  resolveRipgrep,
  runRipgrep,
} from './ripgrepUtils.js';
import { fileExists } from './fileUtils.js';
import { execCommand, isCommandAvailable } from './shell-utils.js';
import path from 'node:path';

vi.mock('./fileUtils.js', () => ({
  fileExists: vi.fn(),
}));

vi.mock('./shell-utils.js', () => ({
  execCommand: vi.fn(),
  isCommandAvailable: vi.fn(),
}));

describe('ripgrepUtils', () => {
  beforeEach(() => {
    _resetRipgrepUtilsCachesForTest();
    vi.mocked(fileExists).mockReset();
    vi.mocked(isCommandAvailable).mockReset();
    vi.mocked(execCommand).mockReset();
  });

  describe('getBuiltinRipgrep', () => {
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

  describe('resolveRipgrep', () => {
    it('keeps builtin and system selections cached separately', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('falls back to system ripgrep when builtin is enabled but unavailable', async () => {
      vi.mocked(fileExists).mockResolvedValue(false);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });

      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });
  });

  describe('canUseRipgrep builtin fallback', () => {
    // A bundled binary that exists but dies on exec, e.g. arm64 kernels with
    // 64K pages (#2676).
    const builtinFailsSystemWorks = () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        if (command !== 'rg') {
          throw new Error(`Command failed: ${command} --version`);
        }
        return { stdout: 'ripgrep 14.1.1', stderr: '', code: 0 };
      });
    };

    it('falls back to system rg when the bundled binary exists but cannot run', async () => {
      builtinFailsSystemWorks();

      await expect(canUseRipgrep(true)).resolves.toBe(true);
    });

    it('caches the fallback selection and does not re-probe the broken builtin', async () => {
      builtinFailsSystemWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      vi.mocked(execCommand).mockClear();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      expect(execCommand).not.toHaveBeenCalled();
    });

    it('reports the bundled failure when system rg is unusable too', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        throw new Error(
          command === 'rg' ? 'system rg broken' : 'bundled rg broken',
        );
      });

      // The bundled failure is the root cause, so it must not be masked by the
      // system probe that ran after it.
      await expect(canUseRipgrep(true)).rejects.toThrow('bundled rg broken');
      expect(execCommand).toHaveBeenCalledWith(
        'rg',
        ['--version'],
        expect.anything(),
      );
    });

    it('leaves the system-only selection unpolluted after a fallback', async () => {
      builtinFailsSystemWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('resolves for every concurrent caller, not just the first', async () => {
      builtinFailsSystemWorks();

      await expect(
        Promise.all([canUseRipgrep(true), canUseRipgrep(true)]),
      ).resolves.toEqual([true, true]);
    });

    it('lets runRipgrep fall back instead of throwing', async () => {
      builtinFailsSystemWorks();

      await expect(runRipgrep(['--version'])).resolves.toBeDefined();
    });

    it('never probes the bundled binary when useBuiltin is false (#5361)', async () => {
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
      vi.mocked(execCommand).mockRejectedValue(new Error('system rg broken'));

      await expect(canUseRipgrep(false)).rejects.toThrow('system rg broken');
      expect(fileExists).not.toHaveBeenCalled();
    });
  });
});
