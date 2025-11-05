/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GrepToolParams } from './grep.js';
import { GrepTool } from './grep.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import * as glob from 'glob';

vi.mock('glob', { spy: true });

// Mock the child_process module to control grep/git grep behavior
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error' || event === 'close') {
        // Simulate command not found or error for git grep and system grep
        // to force it to fall back to JS implementation.
        setTimeout(() => cb(1), 0); // cb(1) for error/close
      }
    },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
}));

describe('GrepTool', () => {
  let tempRootDir: string;
  let grepTool: GrepTool;
  const abortSignal = new AbortController().signal;

  const mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getFileExclusions: () => ({
      getGlobExcludes: () => [],
    }),
  } as unknown as Config;

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    grepTool = new GrepTool(mockConfig);

    // Create some test files and directories
    await fs.writeFile(
      path.join(tempRootDir, 'fileA.txt'),
      'hello world\nsecond line with world',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'fileB.js'),
      'const foo = "bar";\nfunction baz() { return "hello"; }',
    );
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileC.txt'),
      'another world in sub dir',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'fileD.md'),
      '# Markdown file\nThis is a test.',
    );
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params (pattern only)', () => {
      const params: GrepToolParams = { pattern: 'hello' };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (pattern and path)', () => {
      const params: GrepToolParams = { pattern: 'hello', path: '.' };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid params (pattern, path, and glob)', () => {
      const params: GrepToolParams = {
        pattern: 'hello',
        path: '.',
        glob: '*.txt',
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return error if pattern is missing', () => {
      const params = { path: '.' } as unknown as GrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should return error for invalid regex pattern', () => {
      const params: GrepToolParams = { pattern: '[[' };
      expect(grepTool.validateToolParams(params)).toContain(
        'Invalid regular expression pattern',
      );
    });

    it('should return error if path does not exist', () => {
      const params: GrepToolParams = { pattern: 'hello', path: 'nonexistent' };
      // Check for the core error message, as the full path might vary
      expect(grepTool.validateToolParams(params)).toContain(
        'Path does not exist:',
      );
      expect(grepTool.validateToolParams(params)).toContain('nonexistent');
    });

    it('should return error if path is a file, not a directory', async () => {
      const filePath = path.join(tempRootDir, 'fileA.txt');
      const params: GrepToolParams = { pattern: 'hello', path: filePath };
      expect(grepTool.validateToolParams(params)).toContain(
        `Path is not a directory: ${filePath}`,
      );
    });
  });

  describe('execute', () => {
    it('should find matches for a simple pattern in all files', async () => {
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 3 matches for pattern "world" in the workspace directory',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain(
        `File: ${path.join('sub', 'fileC.txt')}`,
      );
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 3 matches');
    });

    it('should find matches in a specific path', async () => {
      const params: GrepToolParams = { pattern: 'world', path: 'sub' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt'); // Path relative to 'sub'
      expect(result.llmContent).toContain('L1: another world in sub dir');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with a glob filter', async () => {
      const params: GrepToolParams = { pattern: 'hello', glob: '*.js' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in the workspace directory (filter: "*.js"):',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with a glob filter and path', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'sub', 'another.js'),
        'const greeting = "hello";',
      );
      const params: GrepToolParams = {
        pattern: 'hello',
        path: 'sub',
        glob: '*.js',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "hello" in path "sub" (filter: "*.js")',
      );
      expect(result.llmContent).toContain('File: another.js');
      expect(result.llmContent).toContain('L1: const greeting = "hello";');
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should return "No matches found" when pattern does not exist', async () => {
      const params: GrepToolParams = { pattern: 'nonexistentpattern' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'No matches found for pattern "nonexistentpattern" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle regex special characters correctly', async () => {
      const params: GrepToolParams = { pattern: 'foo.*bar' }; // Matches 'const foo = "bar";'
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "foo.*bar" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain('L1: const foo = "bar";');
    });

    it('should be case-insensitive by default (JS fallback)', async () => {
      const params: GrepToolParams = { pattern: 'HELLO' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Found 2 matches for pattern "HELLO" in the workspace directory:',
      );
      expect(result.llmContent).toContain('File: fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('File: fileB.js');
      expect(result.llmContent).toContain(
        'L2: function baz() { return "hello"; }',
      );
    });

    it('should throw an error if params are invalid', async () => {
      const params = { path: '.' } as unknown as GrepToolParams; // Invalid: pattern missing
      expect(() => grepTool.build(params)).toThrow(
        /params must have required property 'pattern'/,
      );
    });

    it('should return a GREP_EXECUTION_ERROR on failure', async () => {
      vi.mocked(glob.globStream).mockRejectedValue(new Error('Glob failed'));
      const params: GrepToolParams = { pattern: 'hello' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.GREP_EXECUTION_ERROR);
      vi.mocked(glob.globStream).mockReset();
    });
  });

  describe('multi-directory workspace', () => {
    it('should search across all workspace directories when no path is specified', async () => {
      // The new implementation searches only in the target directory (first workspace directory)
      // when no path is specified, not across all workspace directories
      const params: GrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches in the target directory only
      expect(result.llmContent).toContain(
        'Found 3 matches for pattern "world" in the workspace directory',
      );

      // Matches from target directory
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).toContain('L1: hello world');
      expect(result.llmContent).toContain('L2: second line with world');
      expect(result.llmContent).toContain('fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');
    });

    it('should search only specified path within workspace directories', async () => {
      // Create additional directory
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.mkdir(path.join(secondDir, 'sub'));
      await fs.writeFile(
        path.join(secondDir, 'sub', 'test.txt'),
        'hello from second sub directory',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
      } as unknown as Config;

      const multiDirGrepTool = new GrepTool(multiDirConfig);

      // Search only in the 'sub' directory of the first workspace
      const params: GrepToolParams = { pattern: 'world', path: 'sub' };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should only find matches in the specified sub directory
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in path "sub"',
      );
      expect(result.llmContent).toContain('File: fileC.txt');
      expect(result.llmContent).toContain('L1: another world in sub dir');

      // Should not contain matches from second directory
      expect(result.llmContent).not.toContain('test.txt');

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe('getDescription', () => {
    it('should generate correct description with pattern only', () => {
      const params: GrepToolParams = { pattern: 'testPattern' };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in path './'");
    });

    it('should generate correct description with pattern and glob', () => {
      const params: GrepToolParams = {
        pattern: 'testPattern',
        glob: '*.ts',
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe(
        "'testPattern' in path './' (filter: '*.ts')",
      );
    });

    it('should generate correct description with pattern and path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        pattern: 'testPattern',
        path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain(
        "'testPattern' in path 'src",
      );
      expect(invocation.getDescription()).toContain("app'");
    });

    it('should indicate searching workspace directory when no path specified', () => {
      const params: GrepToolParams = { pattern: 'testPattern' };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in path './'");
    });

    it('should generate correct description with pattern, glob, and path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: GrepToolParams = {
        pattern: 'testPattern',
        glob: '*.ts',
        path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain(
        "'testPattern' in path 'src",
      );
      expect(invocation.getDescription()).toContain("(filter: '*.ts')");
    });

    it('should use ./ for root path in description', () => {
      const params: GrepToolParams = { pattern: 'testPattern', path: '.' };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' in path '.'");
    });
  });

  describe('Result limiting', () => {
    beforeEach(async () => {
      // Create many test files with matches to test limiting
      for (let i = 1; i <= 30; i++) {
        const fileName = `test${i}.txt`;
        const content = `This is test file ${i} with the pattern testword in it.`;
        await fs.writeFile(path.join(tempRootDir, fileName), content);
      }
    });

    it('should show all results when no limit is specified', async () => {
      const params: GrepToolParams = { pattern: 'testword' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // New implementation shows all matches when limit is not specified
      expect(result.llmContent).toContain('Found 30 matches');
      expect(result.llmContent).not.toContain('truncated');
      expect(result.returnDisplay).toBe('Found 30 matches');
    });

    it('should respect custom limit parameter', async () => {
      const params: GrepToolParams = { pattern: 'testword', limit: 5 };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find 30 total but limit to 5
      expect(result.llmContent).toContain('Found 30 matches');
      expect(result.llmContent).toContain('25 lines truncated');
      expect(result.returnDisplay).toContain('Found 30 matches (truncated)');
    });

    it('should not show truncation warning when all results fit', async () => {
      const params: GrepToolParams = { pattern: 'testword', limit: 50 };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Found 30 matches');
      expect(result.llmContent).not.toContain('truncated');
      expect(result.returnDisplay).toBe('Found 30 matches');
    });

    it('should not validate limit parameter', () => {
      // limit parameter has no validation constraints in the new implementation
      const params = { pattern: 'test', limit: 5 };
      const error = grepTool.validateToolParams(params as GrepToolParams);
      expect(error).toBeNull();
    });

    it('should accept valid limit parameter', () => {
      const validParams = [
        { pattern: 'test', limit: 1 },
        { pattern: 'test', limit: 50 },
        { pattern: 'test', limit: 100 },
      ];

      validParams.forEach((params) => {
        const error = grepTool.validateToolParams(params);
        expect(error).toBeNull();
      });
    });
  });
});
