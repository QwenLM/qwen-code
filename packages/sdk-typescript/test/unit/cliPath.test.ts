/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for CLI path utilities
 * Tests executable detection, parsing, and spawn info preparation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  prepareSpawnInfo,
  findBundledCliPath,
} from '../../src/utils/cliPath.js';

// Mock fs module
vi.mock('node:fs');
const mockFs = vi.mocked(fs);

// Mock child_process module
vi.mock('node:child_process');
const mockExecSync = vi.mocked(execSync);

describe('CLI Path Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: mock statSync to return a proper file stat object
    mockFs.statSync.mockReturnValue({
      isFile: () => true,
    } as ReturnType<typeof import('fs').statSync>);
    // Default: return true for existsSync (can be overridden in specific tests)
    mockFs.existsSync.mockReturnValue(true);
    // Default: tsx is available (can be overridden in specific tests)
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  describe('findBundledCliPath', () => {
    it('should find bundled CLI when it exists', () => {
      // Mock existsSync to return true for bundled CLI
      mockFs.existsSync.mockImplementation((p) => {
        const pathStr = p.toString();
        return (
          pathStr.includes('cli/cli.js') || pathStr.includes('cli\\cli.js')
        );
      });

      const result = findBundledCliPath();

      expect(result).toContain('cli.js');
    });

    it('should throw descriptive error when bundled CLI not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => findBundledCliPath()).toThrow('Bundled qwen CLI not found');
      expect(() => findBundledCliPath()).toThrow('Searched locations:');
    });
  });

  describe('prepareSpawnInfo', () => {
    describe('auto-detection (no spec provided)', () => {
      it('should auto-detect bundled CLI when no spec provided', () => {
        // Mock existsSync to return true for bundled CLI
        mockFs.existsSync.mockImplementation((p) => {
          const pathStr = p.toString();
          return (
            pathStr.includes('cli/cli.js') || pathStr.includes('cli\\cli.js')
          );
        });

        const result = prepareSpawnInfo();

        expect(result.command).toBe(process.execPath);
        expect(result.args[0]).toContain('cli.js');
        expect(result.type).toBe('node');
        expect(result.originalInput).toBe('');
      });

      it('should throw when bundled CLI not found', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => prepareSpawnInfo()).toThrow('Bundled qwen CLI not found');
      });
    });

    describe('command name detection', () => {
      it('should detect command names without path separators', () => {
        const result = prepareSpawnInfo('qwen');

        expect(result).toEqual({
          command: 'qwen',
          args: [],
          type: 'native',
          originalInput: 'qwen',
        });
      });

      it('should detect command names on Windows', () => {
        const result = prepareSpawnInfo('qwen.exe');

        expect(result).toEqual({
          command: 'qwen.exe',
          args: [],
          type: 'native',
          originalInput: 'qwen.exe',
        });
      });

      it('should reject invalid command name characters', () => {
        expect(() => prepareSpawnInfo('qwen@invalid')).toThrow(
          "Invalid command name 'qwen@invalid'. Command names should only contain letters, numbers, dots, hyphens, and underscores.",
        );
      });

      it('should accept valid command names', () => {
        expect(() => prepareSpawnInfo('qwen')).not.toThrow();
        expect(() => prepareSpawnInfo('qwen-code')).not.toThrow();
        expect(() => prepareSpawnInfo('qwen_code')).not.toThrow();
        expect(() => prepareSpawnInfo('qwen.exe')).not.toThrow();
        expect(() => prepareSpawnInfo('qwen123')).not.toThrow();
      });
    });

    describe('JavaScript files', () => {
      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
      });

      it('should use node for .js files', () => {
        const result = prepareSpawnInfo('/path/to/cli.js');

        expect(result).toEqual({
          command: process.execPath,
          args: [path.resolve('/path/to/cli.js')],
          type: 'node',
          originalInput: '/path/to/cli.js',
        });
      });

      it('should handle .mjs files', () => {
        const result = prepareSpawnInfo('/path/to/cli.mjs');

        expect(result).toEqual({
          command: process.execPath,
          args: [path.resolve('/path/to/cli.mjs')],
          type: 'node',
          originalInput: '/path/to/cli.mjs',
        });
      });

      it('should handle .cjs files', () => {
        const result = prepareSpawnInfo('/path/to/cli.cjs');

        expect(result).toEqual({
          command: process.execPath,
          args: [path.resolve('/path/to/cli.cjs')],
          type: 'node',
          originalInput: '/path/to/cli.cjs',
        });
      });
    });

    describe('TypeScript files', () => {
      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
      });

      it('should use tsx for .ts files when tsx is available', () => {
        // tsx is available by default in beforeEach
        const result = prepareSpawnInfo('/path/to/index.ts');

        expect(result).toEqual({
          command: 'tsx',
          args: [path.resolve('/path/to/index.ts')],
          type: 'tsx',
          originalInput: '/path/to/index.ts',
        });
      });

      it('should use tsx for .tsx files when tsx is available', () => {
        const result = prepareSpawnInfo('/path/to/cli.tsx');

        expect(result).toEqual({
          command: 'tsx',
          args: [path.resolve('/path/to/cli.tsx')],
          type: 'tsx',
          originalInput: '/path/to/cli.tsx',
        });
      });

      it('should fallback to native when tsx is not available', () => {
        // Mock tsx not being available
        mockExecSync.mockImplementation(() => {
          throw new Error('Command not found');
        });

        const result = prepareSpawnInfo('/path/to/index.ts');

        expect(result).toEqual({
          command: path.resolve('/path/to/index.ts'),
          args: [],
          type: 'native',
          originalInput: '/path/to/index.ts',
        });
      });
    });

    describe('native executables', () => {
      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
      });

      it('should prepare spawn info for native binary path', () => {
        const result = prepareSpawnInfo('/usr/local/bin/qwen');

        expect(result).toEqual({
          command: path.resolve('/usr/local/bin/qwen'),
          args: [],
          type: 'native',
          originalInput: '/usr/local/bin/qwen',
        });
      });
    });

    describe('file path resolution', () => {
      it('should resolve absolute file paths', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = prepareSpawnInfo('/absolute/path/to/qwen');

        expect(result.command).toBe(path.resolve('/absolute/path/to/qwen'));
        expect(result.type).toBe('native');
      });

      it('should resolve relative file paths', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = prepareSpawnInfo('./relative/path/to/cli.js');

        expect(result.command).toBe(process.execPath);
        expect(result.args[0]).toBe(path.resolve('./relative/path/to/cli.js'));
        expect(result.type).toBe('node');
      });

      it('should throw when file path does not exist', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => prepareSpawnInfo('/nonexistent/path')).toThrow(
          'Executable file not found at',
        );
      });

      it('should throw when path is a directory', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.statSync.mockReturnValue({
          isFile: () => false,
        } as ReturnType<typeof import('fs').statSync>);

        expect(() => prepareSpawnInfo('/path/to/directory')).toThrow(
          'exists but is not a file',
        );
      });
    });
  });

  describe('Windows path handling', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(true);
    });

    it('should handle Windows paths with drive letters', () => {
      const windowsPath = 'D:\\path\\to\\cli.js';
      const result = prepareSpawnInfo(windowsPath);

      expect(result).toEqual({
        command: process.execPath,
        args: [path.resolve(windowsPath)],
        type: 'node',
        originalInput: windowsPath,
      });
    });

    it('should handle Windows paths with forward slashes', () => {
      const windowsPath = 'C:/path/to/cli.js';
      const result = prepareSpawnInfo(windowsPath);

      expect(result.command).toBe(process.execPath);
      expect(result.args[0]).toBe(path.resolve(windowsPath));
      expect(result.type).toBe('node');
    });

    it('should not confuse Windows drive letters with invalid syntax', () => {
      const windowsPath = 'D:\\workspace\\project\\cli.js';
      const result = prepareSpawnInfo(windowsPath);

      // Should use node runtime based on .js extension
      expect(result.type).toBe('node');
      expect(result.command).toBe(process.execPath);
    });

    it('should handle Windows paths when file is missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => prepareSpawnInfo('D:\\missing\\cli.js')).toThrow(
        'Executable file not found at',
      );
    });

    it('should handle mixed path separators', () => {
      // Users might paste paths with mixed separators
      const mixedPath = 'C:\\Users/project\\cli.js';
      const result = prepareSpawnInfo(mixedPath);

      expect(result.command).toBe(process.execPath);
      expect(result.type).toBe('node');
      // path.resolve normalizes the separators
      expect(result.args[0]).toBe(path.resolve(mixedPath));
    });

    it('should handle UNC paths', () => {
      // Windows network paths: \\server\share\path
      const uncPath = '\\\\server\\share\\path\\cli.js';
      const result = prepareSpawnInfo(uncPath);

      expect(result.command).toBe(process.execPath);
      expect(result.type).toBe('node');
      expect(result.args[0]).toBe(path.resolve(uncPath));
    });

    it('should handle Windows native executables', () => {
      const windowsPath = 'C:\\Program Files\\qwen\\qwen.exe';
      const result = prepareSpawnInfo(windowsPath);

      // .exe files without .js extension should be treated as native
      expect(result.type).toBe('native');
      expect(result.command).toBe(path.resolve(windowsPath));
      expect(result.args).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('should throw for empty string', () => {
      expect(() => prepareSpawnInfo('')).toThrow(
        'Executable path cannot be empty',
      );
    });

    it('should throw for whitespace-only string', () => {
      expect(() => prepareSpawnInfo('   ')).toThrow(
        'Executable path cannot be empty',
      );
    });

    it('should provide helpful error for missing file', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => prepareSpawnInfo('/missing/file')).toThrow(
        'Executable file not found at',
      );
      expect(() => prepareSpawnInfo('/missing/file')).toThrow(
        'Please check the file path and ensure the file exists',
      );
    });
  });

  describe('real-world use cases', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(true);
    });

    it('should handle production bundle validation', () => {
      const bundlePath = '/path/to/bundled/cli.js';
      const result = prepareSpawnInfo(bundlePath);

      expect(result).toEqual({
        command: process.execPath,
        args: [path.resolve(bundlePath)],
        type: 'node',
        originalInput: bundlePath,
      });
    });

    it('should handle production native binary', () => {
      const result = prepareSpawnInfo('qwen');

      expect(result).toEqual({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
    });

    it('should handle ESM bundle', () => {
      const bundlePath = '/path/to/cli.mjs';
      const result = prepareSpawnInfo(bundlePath);

      expect(result).toEqual({
        command: process.execPath,
        args: [path.resolve(bundlePath)],
        type: 'node',
        originalInput: bundlePath,
      });
    });

    it('should handle CJS bundle', () => {
      const bundlePath = '/path/to/cli.cjs';
      const result = prepareSpawnInfo(bundlePath);

      expect(result).toEqual({
        command: process.execPath,
        args: [path.resolve(bundlePath)],
        type: 'node',
        originalInput: bundlePath,
      });
    });
  });
});
