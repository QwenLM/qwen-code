/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parsePartialPath,
  isPathLikeToken,
  scanDirectory,
  scanDirectoryForPaths,
  getDirectoryCompletions,
  getPathCompletions,
  clearPathCache,
} from '../utils/directoryCompletion.js';
import * as fs from 'node:fs/promises';

// Mock fs/promises
vi.mock('node:fs/promises');

const mockReaddir = vi.mocked(fs.readdir);

// Helper to create a mock Dirent
function mockDirent(name: string, isDir: boolean): unknown {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

// Cast mockReaddir to accept our mock objects
const mockReaddirAny = mockReaddir as unknown as {
  mockResolvedValue: (value: unknown[]) => void;
};

describe('directoryCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPathCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parsePartialPath', () => {
    it('handles empty input', () => {
      const result = parsePartialPath('', '/some/base');
      expect(result).toEqual({ directory: '/some/base', prefix: '' });
    });

    it('handles empty input with no basePath', () => {
      const originalCwd = process.cwd;
      process.cwd = () => '/mock/cwd';
      const result = parsePartialPath('');
      expect(result).toEqual({ directory: '/mock/cwd', prefix: '' });
      process.cwd = originalCwd;
    });

    it('parses path ending with separator', () => {
      const result = parsePartialPath('src/');
      // dirname may return 'src' or 'src/' depending on platform
      expect(result.prefix).toBe('');
      expect(result.directory).toMatch(/^src\/?$/);
    });

    it('parses path with prefix', () => {
      const result = parsePartialPath('src/uti');
      expect(result).toEqual({ directory: 'src', prefix: 'uti' });
    });

    it('handles tilde expansion', () => {
      const result = parsePartialPath('~/.config');
      expect(result.prefix).toBe('.config');
    });

    it('handles relative path', () => {
      const result = parsePartialPath('./src/uti');
      expect(result).toEqual({ directory: './src', prefix: 'uti' });
    });

    it('handles parent directory', () => {
      const result = parsePartialPath('../lib');
      expect(result).toEqual({ directory: '..', prefix: 'lib' });
    });
  });

  describe('isPathLikeToken', () => {
    it('recognizes absolute paths', () => {
      expect(isPathLikeToken('/usr/local')).toBe(true);
    });

    it('recognizes relative paths', () => {
      expect(isPathLikeToken('./src')).toBe(true);
      expect(isPathLikeToken('../lib')).toBe(true);
    });

    it('recognizes home paths', () => {
      expect(isPathLikeToken('~/.config')).toBe(true);
      expect(isPathLikeToken('~')).toBe(true);
    });

    it('rejects non-path tokens', () => {
      expect(isPathLikeToken('hello')).toBe(false);
      expect(isPathLikeToken('command')).toBe(false);
      expect(isPathLikeToken('')).toBe(false);
    });
  });

  describe('scanDirectory', () => {
    it('returns only directories, excluding hidden', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('src', true),
        mockDirent('test', true),
        mockDirent('.git', true),
        mockDirent('file.txt', false),
      ]);

      const result = await scanDirectory('/mock');

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.name)).toEqual(['src', 'test']);
    });

    it('caches results', async () => {
      mockReaddirAny.mockResolvedValue([mockDirent('src', true)]);

      await scanDirectory('/mock');
      await scanDirectory('/mock');

      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    it('returns empty array on error', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const result = await scanDirectory('/nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('scanDirectoryForPaths', () => {
    it('returns both files and directories', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('src', true),
        mockDirent('package.json', false),
        mockDirent('.git', true),
      ]);

      const result = await scanDirectoryForPaths('/mock');

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('directory'); // directories first
    });

    it('includes hidden files when requested', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('.git', true),
        mockDirent('src', true),
      ]);

      const result = await scanDirectoryForPaths('/mock', true);

      expect(result).toHaveLength(2);
    });
  });

  describe('getDirectoryCompletions', () => {
    it('returns matching directories', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('src', true),
        mockDirent('scripts', true),
        mockDirent('test', true),
        mockDirent('file.txt', false),
      ]);

      const result = await getDirectoryCompletions('s');

      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('src/');
      expect(result[0].value).toBe('src/');
      expect(result[1].label).toBe('scripts/');
    });

    it('respects maxResults', async () => {
      const entries = Array.from({ length: 20 }, (_, i) =>
        mockDirent(`dir${i}`, true),
      );
      mockReaddirAny.mockResolvedValue(entries);

      const result = await getDirectoryCompletions('', { maxResults: 5 });
      expect(result).toHaveLength(5);
    });
  });

  describe('getPathCompletions', () => {
    it('returns both files and directories', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('src', true),
        mockDirent('README.md', false),
      ]);

      const result = await getPathCompletions('', { basePath: '/mock' });

      expect(result).toHaveLength(2);
      expect(result[0].value).toBe('src/');
      expect(result[1].value).toBe('README.md');
    });

    it('preserves directory prefix in results', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('utils', true),
        mockDirent('util.ts', false),
      ]);

      const result = await getPathCompletions('src/ut');

      expect(result[0].value).toBe('src/utils/');
      expect(result[1].value).toBe('src/util.ts');
    });

    it('strips leading ./ from directory portion', async () => {
      mockReaddirAny.mockResolvedValue([mockDirent('file.ts', false)]);

      const result = await getPathCompletions('./f');

      expect(result[0].value).toBe('file.ts');
    });

    it('handles Unicode filename prefixes', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('日本語.txt', false),
        mockDirent('日誌.log', false),
      ]);

      const result = await getPathCompletions('./日');

      expect(result).toHaveLength(2);
      expect(result[0].value).toBe('日本語.txt');
    });

    it('handles filenames with spaces', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('my file.txt', false),
        mockDirent('my document.pdf', false),
      ]);

      const result = await getPathCompletions('./my');

      expect(result).toHaveLength(2);
    });

    it('handles deep nested paths', async () => {
      mockReaddirAny.mockResolvedValue([
        mockDirent('deep', true),
        mockDirent('other', true),
      ]);

      const result = await getPathCompletions('a/b/c/d');

      // Only 'deep' matches prefix 'd'; dirPortion strips the 'd' prefix
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('a/b/c/deep/');
    });
  });
});
