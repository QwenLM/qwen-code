/**
 * Unit tests for CLI path utilities
 * Tests executable detection, parsing, and spawn info preparation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  parseExecutableSpec,
  prepareSpawnInfo,
  findNativeCliPath,
} from '../../src/utils/cliPath.js';

// Mock fs module
vi.mock('node:fs');
const mockFs = vi.mocked(fs);

// Mock child_process module
vi.mock('node:child_process');
const mockExecSync = vi.mocked(execSync);

// Mock process.versions for bun detection
const originalVersions = process.versions;

describe('CLI Path Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.versions
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions },
      writable: true,
    });
    // Default: tsx is available (can be overridden in specific tests)
    mockExecSync.mockReturnValue(Buffer.from(''));
    // Default: mock statSync to return a proper file stat object
    mockFs.statSync.mockReturnValue({
      isFile: () => true,
    } as ReturnType<typeof import('fs').statSync>);
  });

  afterEach(() => {
    // Restore original process.versions
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      writable: true,
    });
  });

  describe('parseExecutableSpec', () => {
    describe('auto-detection (no spec provided)', () => {
      it('should auto-detect native CLI when no spec provided', () => {
        // Mock environment variable
        const originalEnv = process.env['QWEN_CODE_CLI_PATH'];
        process.env['QWEN_CODE_CLI_PATH'] = '/usr/local/bin/qwen';
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec();

        expect(result).toEqual({
          executablePath: path.resolve('/usr/local/bin/qwen'),
          isExplicitRuntime: false,
        });

        // Restore env
        process.env['QWEN_CODE_CLI_PATH'] = originalEnv;
      });

      it('should throw when auto-detection fails', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec()).toThrow(
          'qwen CLI not found. Please:',
        );
      });
    });

    describe('runtime prefix parsing', () => {
      it('should parse node runtime prefix', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('node:/path/to/cli.js');

        expect(result).toEqual({
          runtime: 'node',
          executablePath: path.resolve('/path/to/cli.js'),
          isExplicitRuntime: true,
        });
      });

      it('should parse bun runtime prefix', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('bun:/path/to/cli.js');

        expect(result).toEqual({
          runtime: 'bun',
          executablePath: path.resolve('/path/to/cli.js'),
          isExplicitRuntime: true,
        });
      });

      it('should parse tsx runtime prefix', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('tsx:/path/to/index.ts');

        expect(result).toEqual({
          runtime: 'tsx',
          executablePath: path.resolve('/path/to/index.ts'),
          isExplicitRuntime: true,
        });
      });

      it('should parse deno runtime prefix', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('deno:/path/to/cli.ts');

        expect(result).toEqual({
          runtime: 'deno',
          executablePath: path.resolve('/path/to/cli.ts'),
          isExplicitRuntime: true,
        });
      });

      it('should throw for invalid runtime prefix format', () => {
        expect(() => parseExecutableSpec('invalid:format')).toThrow(
          'Unsupported runtime',
        );
      });

      it('should throw when runtime-prefixed file does not exist', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec('node:/nonexistent/cli.js')).toThrow(
          'Executable file not found at',
        );
      });
    });

    describe('command name detection', () => {
      it('should detect command names without path separators', () => {
        const result = parseExecutableSpec('qwen');

        expect(result).toEqual({
          executablePath: 'qwen',
          isExplicitRuntime: false,
        });
      });

      it('should detect command names on Windows', () => {
        const result = parseExecutableSpec('qwen.exe');

        expect(result).toEqual({
          executablePath: 'qwen.exe',
          isExplicitRuntime: false,
        });
      });
    });

    describe('file path resolution', () => {
      it('should resolve absolute file paths', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('/absolute/path/to/qwen');

        expect(result).toEqual({
          executablePath: path.resolve('/absolute/path/to/qwen'),
          isExplicitRuntime: false,
        });
      });

      it('should resolve relative file paths', () => {
        mockFs.existsSync.mockReturnValue(true);

        const result = parseExecutableSpec('./relative/path/to/qwen');

        expect(result).toEqual({
          executablePath: path.resolve('./relative/path/to/qwen'),
          isExplicitRuntime: false,
        });
      });

      it('should throw when file path does not exist', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec('/nonexistent/path')).toThrow(
          'Executable file not found at',
        );
      });
    });
  });

  describe('prepareSpawnInfo', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(true);
    });

    describe('native executables', () => {
      it('should prepare spawn info for native binary command', () => {
        const result = prepareSpawnInfo('qwen');

        expect(result).toEqual({
          command: 'qwen',
          args: [],
          type: 'native',
          originalInput: 'qwen',
        });
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

    describe('JavaScript files', () => {
      it('should use node for .js files', () => {
        const result = prepareSpawnInfo('/path/to/cli.js');

        expect(result).toEqual({
          command: process.execPath,
          args: [path.resolve('/path/to/cli.js')],
          type: 'node',
          originalInput: '/path/to/cli.js',
        });
      });

      it('should default to node for .js files (not auto-detect bun)', () => {
        // Even when running under bun, default to node for .js files
        Object.defineProperty(process, 'versions', {
          value: { ...originalVersions, bun: '1.0.0' },
          writable: true,
        });

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

      it('should throw helpful error when tsx is not available', () => {
        // Mock tsx not being available
        mockExecSync.mockImplementation(() => {
          throw new Error('Command not found');
        });

        const resolvedPath = path.resolve('/path/to/index.ts');
        expect(() => prepareSpawnInfo('/path/to/index.ts')).toThrow(
          `TypeScript file '${resolvedPath}' requires 'tsx' runtime, but it's not available`,
        );
        expect(() => prepareSpawnInfo('/path/to/index.ts')).toThrow(
          'Please install tsx: npm install -g tsx',
        );
      });
    });

    describe('explicit runtime specifications', () => {
      it('should use explicit node runtime', () => {
        const result = prepareSpawnInfo('node:/path/to/cli.js');

        expect(result).toEqual({
          command: process.execPath,
          args: [path.resolve('/path/to/cli.js')],
          type: 'node',
          originalInput: 'node:/path/to/cli.js',
        });
      });

      it('should use explicit bun runtime', () => {
        const result = prepareSpawnInfo('bun:/path/to/cli.js');

        expect(result).toEqual({
          command: 'bun',
          args: [path.resolve('/path/to/cli.js')],
          type: 'bun',
          originalInput: 'bun:/path/to/cli.js',
        });
      });

      it('should use explicit tsx runtime', () => {
        const result = prepareSpawnInfo('tsx:/path/to/index.ts');

        expect(result).toEqual({
          command: 'tsx',
          args: [path.resolve('/path/to/index.ts')],
          type: 'tsx',
          originalInput: 'tsx:/path/to/index.ts',
        });
      });

      it('should use explicit deno runtime', () => {
        const result = prepareSpawnInfo('deno:/path/to/cli.ts');

        expect(result).toEqual({
          command: 'deno',
          args: [path.resolve('/path/to/cli.ts')],
          type: 'deno',
          originalInput: 'deno:/path/to/cli.ts',
        });
      });
    });

    describe('auto-detection fallback', () => {
      it('should auto-detect when no spec provided', () => {
        // Mock environment variable
        const originalEnv = process.env['QWEN_CODE_CLI_PATH'];
        process.env['QWEN_CODE_CLI_PATH'] = '/usr/local/bin/qwen';

        const result = prepareSpawnInfo();

        expect(result).toEqual({
          command: path.resolve('/usr/local/bin/qwen'),
          args: [],
          type: 'native',
          originalInput: '',
        });

        // Restore env
        process.env['QWEN_CODE_CLI_PATH'] = originalEnv;
      });
    });
  });

  describe('findNativeCliPath', () => {
    it('should find CLI from environment variable', () => {
      const originalEnv = process.env['QWEN_CODE_CLI_PATH'];
      process.env['QWEN_CODE_CLI_PATH'] = '/custom/path/to/qwen';
      mockFs.existsSync.mockReturnValue(true);

      const result = findNativeCliPath();

      expect(result).toBe(path.resolve('/custom/path/to/qwen'));

      process.env['QWEN_CODE_CLI_PATH'] = originalEnv;
    });

    it('should search common installation locations', () => {
      const originalEnv = process.env['QWEN_CODE_CLI_PATH'];
      delete process.env['QWEN_CODE_CLI_PATH'];

      // Mock fs.existsSync to return true for volta bin
      // Use path.join to match platform-specific path separators
      const voltaBinPath = path.join('.volta', 'bin', 'qwen');
      mockFs.existsSync.mockImplementation((p) => {
        return p.toString().includes(voltaBinPath);
      });

      const result = findNativeCliPath();

      expect(result).toContain(voltaBinPath);

      process.env['QWEN_CODE_CLI_PATH'] = originalEnv;
    });

    it('should throw descriptive error when CLI not found', () => {
      const originalEnv = process.env['QWEN_CODE_CLI_PATH'];
      delete process.env['QWEN_CODE_CLI_PATH'];
      mockFs.existsSync.mockReturnValue(false);

      expect(() => findNativeCliPath()).toThrow('qwen CLI not found. Please:');

      process.env['QWEN_CODE_CLI_PATH'] = originalEnv;
    });
  });

  describe('real-world use cases', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(true);
    });

    it('should handle development with TypeScript source', () => {
      const devPath = '/Users/dev/qwen-code/packages/cli/index.ts';
      const result = prepareSpawnInfo(devPath);

      expect(result).toEqual({
        command: 'tsx',
        args: [path.resolve(devPath)],
        type: 'tsx',
        originalInput: devPath,
      });
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

    it('should handle bun runtime with bundle', () => {
      const bundlePath = '/path/to/cli.js';
      const result = prepareSpawnInfo(`bun:${bundlePath}`);

      expect(result).toEqual({
        command: 'bun',
        args: [path.resolve(bundlePath)],
        type: 'bun',
        originalInput: `bun:${bundlePath}`,
      });
    });
  });

  describe('error cases', () => {
    it('should provide helpful error for missing TypeScript file', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => prepareSpawnInfo('/missing/index.ts')).toThrow(
        'Executable file not found at',
      );
    });

    it('should provide helpful error for missing JavaScript file', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => prepareSpawnInfo('/missing/cli.js')).toThrow(
        'Executable file not found at',
      );
    });

    it('should provide helpful error for invalid runtime specification', () => {
      expect(() => prepareSpawnInfo('invalid:spec')).toThrow(
        'Unsupported runtime',
      );
    });
  });

  describe('comprehensive validation', () => {
    describe('runtime validation', () => {
      it('should reject unsupported runtimes', () => {
        expect(() =>
          parseExecutableSpec('unsupported:/path/to/file.js'),
        ).toThrow(
          "Unsupported runtime 'unsupported'. Supported runtimes: node, bun, tsx, deno",
        );
      });

      it('should validate runtime availability for explicit runtime specs', () => {
        mockFs.existsSync.mockReturnValue(true);
        // Mock bun not being available
        mockExecSync.mockImplementation((command) => {
          if (command.includes('bun')) {
            throw new Error('Command not found');
          }
          return Buffer.from('');
        });

        expect(() => parseExecutableSpec('bun:/path/to/cli.js')).toThrow(
          "Runtime 'bun' is not available on this system. Please install it first.",
        );
      });

      it('should allow node runtime (always available)', () => {
        mockFs.existsSync.mockReturnValue(true);

        expect(() => parseExecutableSpec('node:/path/to/cli.js')).not.toThrow();
      });

      it('should validate file extension matches runtime', () => {
        mockFs.existsSync.mockReturnValue(true);

        expect(() => parseExecutableSpec('tsx:/path/to/file.js')).toThrow(
          "File extension '.js' is not compatible with runtime 'tsx'",
        );
      });

      it('should validate node runtime with JavaScript files', () => {
        mockFs.existsSync.mockReturnValue(true);

        expect(() => parseExecutableSpec('node:/path/to/file.ts')).toThrow(
          "File extension '.ts' is not compatible with runtime 'node'",
        );
      });

      it('should accept valid runtime-file combinations', () => {
        mockFs.existsSync.mockReturnValue(true);

        expect(() => parseExecutableSpec('tsx:/path/to/file.ts')).not.toThrow();
        expect(() =>
          parseExecutableSpec('node:/path/to/file.js'),
        ).not.toThrow();
        expect(() =>
          parseExecutableSpec('bun:/path/to/file.mjs'),
        ).not.toThrow();
      });
    });

    describe('command name validation', () => {
      it('should reject empty command names', () => {
        expect(() => parseExecutableSpec('')).toThrow(
          'Command name cannot be empty',
        );
        expect(() => parseExecutableSpec('   ')).toThrow(
          'Command name cannot be empty',
        );
      });

      it('should reject invalid command name characters', () => {
        expect(() => parseExecutableSpec('qwen@invalid')).toThrow(
          "Invalid command name 'qwen@invalid'. Command names should only contain letters, numbers, dots, hyphens, and underscores.",
        );

        expect(() => parseExecutableSpec('qwen/invalid')).not.toThrow(); // This is treated as a path
      });

      it('should accept valid command names', () => {
        expect(() => parseExecutableSpec('qwen')).not.toThrow();
        expect(() => parseExecutableSpec('qwen-code')).not.toThrow();
        expect(() => parseExecutableSpec('qwen_code')).not.toThrow();
        expect(() => parseExecutableSpec('qwen.exe')).not.toThrow();
        expect(() => parseExecutableSpec('qwen123')).not.toThrow();
      });
    });

    describe('file path validation', () => {
      it('should validate file exists', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec('/nonexistent/path')).toThrow(
          'Executable file not found at',
        );
      });

      it('should validate path points to a file, not directory', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.statSync.mockReturnValue({
          isFile: () => false,
        } as ReturnType<typeof import('fs').statSync>);

        expect(() => parseExecutableSpec('/path/to/directory')).toThrow(
          'exists but is not a file',
        );
      });

      it('should accept valid file paths', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.statSync.mockReturnValue({
          isFile: () => true,
        } as ReturnType<typeof import('fs').statSync>);

        expect(() => parseExecutableSpec('/path/to/qwen')).not.toThrow();
        expect(() => parseExecutableSpec('./relative/path')).not.toThrow();
      });
    });

    describe('error message quality', () => {
      it('should provide helpful error for missing runtime-prefixed file', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec('tsx:/missing/file.ts')).toThrow(
          'Executable file not found at',
        );
        expect(() => parseExecutableSpec('tsx:/missing/file.ts')).toThrow(
          'Please check the file path and ensure the file exists',
        );
      });

      it('should provide helpful error for missing regular file', () => {
        mockFs.existsSync.mockReturnValue(false);

        expect(() => parseExecutableSpec('/missing/file')).toThrow(
          'Set QWEN_CODE_CLI_PATH environment variable',
        );
        expect(() => parseExecutableSpec('/missing/file')).toThrow(
          'Install qwen globally: npm install -g qwen',
        );
        expect(() => parseExecutableSpec('/missing/file')).toThrow(
          'Force specific runtime: bun:/path/to/cli.js or tsx:/path/to/index.ts',
        );
      });
    });
  });
});
