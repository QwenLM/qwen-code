/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RipGrepTool, grepGetPath, type RipGrepToolParams } from './ripGrep.js';
import type { GrepResult } from './tools.js';
import path from 'node:path';
import { isSubpath } from '../utils/paths.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import { resetForTest as resetShellCwd } from '../utils/Shell.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { RipgrepTimeoutError } from '../utils/ripgrep.js';
import { ToolErrorType } from './tool-error.js';

const mockRipGrep = vi.hoisted(() => vi.fn());

// Encode the existing readable fixtures as ripgrep's wire protocol.
vi.mock('../utils/ripgrep.js', () => ({
  ripGrep: async (args: string[], ...rest: unknown[]) => {
    const lines: string[] = await mockRipGrep(args, ...rest);
    if (!lines.length) return [];
    if (args.includes('--json')) {
      return lines.flatMap((line) => {
        if (line === '--') return [];
        const match = /^(.*?)(?::|-)(?:(\d+)([:-]))?(.*)$/s.exec(line);
        if (!match) throw new Error(`Invalid content fixture: ${line}`);
        return [
          JSON.stringify({
            type: match[3] === '-' ? 'context' : 'match',
            data: {
              path: { text: match[1] },
              line_number: Number(match[2] ?? 1),
              lines: { text: match[4] + '\n' },
            },
          }),
        ];
      });
    }
    if (args.includes('-c'))
      return lines.map((line) => {
        const colon = line.lastIndexOf(':');
        return line.slice(0, colon) + '\0' + line.slice(colon + 1);
      });
    return [lines.join('\0') + '\0'];
  },
  RipgrepTimeoutError: class RipgrepTimeoutError extends Error {
    constructor(
      message: string,
      readonly partialResults: string[],
    ) {
      super(message);
      this.name = 'RipgrepTimeoutError';
    }
  },
}));

describe('RipGrepTool', () => {
  let tempRootDir: string;
  let grepTool: InstanceType<typeof RipGrepTool>;
  const abortSignal = new AbortController().signal;

  let mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getDebugMode: () => false,
    getFileExclusions: () => ({
      getGlobExcludes: () => [],
    }),
  } as unknown as Config;

  beforeEach(async () => {
    mockRipGrep.mockReset();
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    resetShellCwd(tempRootDir);

    mockConfig = {
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
      getDebugMode: () => false,
      getFileExclusions: () => ({
        getGlobExcludes: () => [],
      }),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
      },
      isPathAllowed(this: Config, absolutePath: string): boolean {
        const workspaceContext = this.getWorkspaceContext();
        if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
          return true;
        }
        const projectTempDir = this.storage.getProjectTempDir();
        return isSubpath(path.resolve(projectTempDir), absolutePath);
      },
      validatePathAccess(this: Config, absolutePath: string): string | null {
        if (this.isPathAllowed(absolutePath)) {
          return null;
        }
        const workspaceDirs = this.getWorkspaceContext().getDirectories();
        const projectTempDir = this.storage.getProjectTempDir();
        return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
      },
    } as unknown as Config;

    grepTool = new RipGrepTool(mockConfig);

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
    resetShellCwd();
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it.each([
      {
        name: 'pattern only',
        params: { pattern: 'hello' },
        expected: null,
      },
      {
        name: 'pattern and path',
        params: { pattern: 'hello', path: '.' },
        expected: null,
      },
      {
        name: 'pattern, path, and glob',
        params: { pattern: 'hello', path: '.', glob: '*.txt' },
        expected: null,
      },
    ])(
      'should return null for valid params ($name)',
      ({ params, expected }) => {
        expect(grepTool.validateToolParams(params)).toBe(expected);
      },
    );

    it('should defer regex validation to ripgrep', () => {
      const params: RipGrepToolParams = { pattern: '[[' };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should return error if pattern is missing', () => {
      const params = { path: '.' } as unknown as RipGrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should identify unsupported flags so the caller can correct them', () => {
      const params = {
        pattern: 'image blocks a tool returns are not shown',
        path: tempRootDir,
        glob: '*.snap',
        '-l': true,
      };
      expect(() => grepTool.build(params)).toThrow(
        'Grep tool parameter validation failed: An unexpected parameter `-l` was provided',
      );
      const { '-l': _unsupported, ...correctedParams } = params;
      expect(() => grepTool.build(correctedParams)).not.toThrow();
    });

    it('should return null for path that does not exist (validation only checks workspace)', () => {
      const params: RipGrepToolParams = {
        pattern: 'hello',
        path: 'nonexistent',
      };
      // validateToolParams only checks workspace boundaries, not existence
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it('should allow path to be a file', async () => {
      const filePath = path.join(tempRootDir, 'fileA.txt');
      const params: RipGrepToolParams = {
        pattern: 'hello',
        path: filePath,
      };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });
  });

  describe('execute', () => {
    it('should find matches for a simple pattern in content mode', async () => {
      // Mock plain-text output format: path:linenum:content
      mockRipGrep.mockResolvedValue([
        'fileA.txt:1:hello world',
        'fileA.txt:2:second line with world',
        'sub/fileC.txt:1:another world in sub dir',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'world',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Content mode: raw relativized lines
      expect(result.llmContent).toContain('fileA.txt:1:hello world');
      expect(result.llmContent).toContain('fileA.txt:2:second line with world');
      expect(result.llmContent).toContain(
        'sub/fileC.txt:1:another world in sub dir',
      );
      expect(result.returnDisplay).toMatchObject({
        mode: 'content',
        numLines: 3,
      });
      expect(result.returnDisplay as GrepResult).not.toHaveProperty('summary');
      expect(result.toolUseResult).toMatchObject({
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content:
          'fileA.txt:1:hello world\nfileA.txt:2:second line with world\nsub/fileC.txt:1:another world in sub dir',
        numLines: 3,
      });
    });

    it('should find matches in a specific path (content mode)', async () => {
      mockRipGrep.mockResolvedValue(['fileC.txt:1:another world in sub dir']);

      const params: RipGrepToolParams = {
        pattern: 'world',
        path: 'sub',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'fileC.txt:1:another world in sub dir',
      );
      expect(result.returnDisplay).toMatchObject({
        mode: 'content',
        numLines: 1,
      });
      expect(result.returnDisplay as GrepResult).not.toHaveProperty('summary');
    });

    it('should find matches with a glob filter (content mode)', async () => {
      mockRipGrep.mockResolvedValue([
        'fileB.js:2:function baz() { return "hello"; }',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        glob: '*.js',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'fileB.js:2:function baz() { return "hello"; }',
      );
      expect(result.returnDisplay).toMatchObject({
        mode: 'content',
        numLines: 1,
      });
      expect(result.returnDisplay as GrepResult).not.toHaveProperty('summary');

      // Verify --glob was passed to ripgrep
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('--glob');
      expect(args).toContain('*.js');
    });

    it('should return "No matches found" when pattern does not exist (content mode)', async () => {
      mockRipGrep.mockResolvedValue([]);

      const params: RipGrepToolParams = {
        pattern: 'nonexistentpattern',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('No matches found');
      expect(result.returnDisplay).toMatchObject({
        mode: 'content',
        numLines: 0,
      });
      expect(result.returnDisplay as GrepResult).not.toHaveProperty('summary');
    });

    it('should return "No files found" when pattern does not exist (files_with_matches mode)', async () => {
      mockRipGrep.mockResolvedValue([]);

      const params: RipGrepToolParams = { pattern: 'nonexistentpattern' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('No files found');
    });

    it('should defer invalid regex handling until execution', async () => {
      const params: RipGrepToolParams = { pattern: '[[' };
      expect(() => grepTool.build(params)).not.toThrow();
    });

    it('should return error when stat result is not a directory or file', async () => {
      const pathParam = 'special-path';
      const searchPath = path.join(tempRootDir, pathParam);
      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValueOnce({
        isDirectory: () => false,
        isFile: () => false,
      } as Awaited<ReturnType<typeof fs.stat>>);

      const params: RipGrepToolParams = { pattern: 'test', path: pathParam };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(statSpy).toHaveBeenCalledWith(searchPath);
      expect(result.llmContent).toBe(
        `Path is not a valid directory or file: ${searchPath}`,
      );
      expect(result.returnDisplay).toBe(
        'Error: Path is not a valid directory or file.',
      );
      expect(result.error).toEqual({
        message: `Path is not a valid directory or file: ${searchPath}`,
        type: ToolErrorType.GREP_EXECUTION_ERROR,
      });
      expect(mockRipGrep).not.toHaveBeenCalled();

      statSpy.mockRestore();
    });

    it('should return error when stat fails with non-ENOENT error', async () => {
      const pathParam = 'restricted-path';
      const searchPath = path.join(tempRootDir, pathParam);
      const statError = Object.assign(new Error('Permission denied'), {
        code: 'EACCES',
      });
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValueOnce(statError);

      const params: RipGrepToolParams = { pattern: 'test', path: pathParam };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(statSpy).toHaveBeenCalledWith(searchPath);
      expect(result.llmContent).toBe(
        `Failed to access path stats for ${searchPath}: Permission denied`,
      );
      expect(result.returnDisplay).toBe('Error: Failed to access path.');
      expect(result.error).toEqual({
        message: `Failed to access path stats for ${searchPath}: Permission denied`,
        type: ToolErrorType.GREP_EXECUTION_ERROR,
      });
      expect(mockRipGrep).not.toHaveBeenCalled();

      statSpy.mockRestore();
    });

    it('should handle timeout errors gracefully', async () => {
      mockRipGrep.mockRejectedValue(
        new RipgrepTimeoutError('Search timed out after 20 seconds', []),
      );

      const params: RipGrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Search timed out');
      expect(result.returnDisplay).toBe('Error: Search timed out.');
      expect(result.error).toEqual({
        message: 'Search timed out. Search timed out after 20 seconds',
        type: ToolErrorType.GREP_EXECUTION_ERROR,
      });
    });

    it('should return error when ripGrep throws a regular error', async () => {
      mockRipGrep.mockRejectedValue(new Error('ripgrep crashed'));

      const params: RipGrepToolParams = { pattern: 'test' };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toBe(
        'Error during grep search operation: ripgrep crashed',
      );
      expect(result.returnDisplay).toBe('Error: ripgrep crashed');
      expect(result.error).toEqual({
        message: 'Error during grep search operation: ripgrep crashed',
        type: ToolErrorType.GREP_EXECUTION_ERROR,
      });
    });

    it('should handle -i parameter (case insensitive)', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:1:hello world']);

      const params: RipGrepToolParams = {
        pattern: 'HELLO',
        '-i': true,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      // Should have been called with -i flag
      expect(mockRipGrep).toHaveBeenCalled();
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-i');
    });

    it('should be case sensitive by default (no -i flag)', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:1:HELLO world']);

      const params: RipGrepToolParams = {
        pattern: 'HELLO',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      // Should NOT have -i flag (case sensitive by default)
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).not.toContain('-i');
    });

    it('should handle context parameters (content mode)', async () => {
      // Context lines use - separator: path-linenum-content
      mockRipGrep.mockResolvedValue([
        'fileA.txt:1:hello world',
        'fileA.txt-2-second line with world',
        'fileA.txt-3-third line',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'world',
        context: 1,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-C');
      expect(args).toContain('1');

      // Content mode: raw lines
      expect(result.llmContent).toContain('fileA.txt:1:hello world');
      expect(result.llmContent).toContain('fileA.txt-2-second line with world');
    });

    it('should handle -B and -A parameters (content mode)', async () => {
      mockRipGrep.mockResolvedValue([
        'fileA.txt-1-before line',
        'fileA.txt:2:hello world',
        'fileA.txt-3-after line',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        '-B': 1,
        '-A': 1,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-B');
      expect(args).toContain('-A');
    });

    it('should default to files_with_matches mode', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt', 'fileB.js']);

      const params: RipGrepToolParams = {
        pattern: 'hello',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Found 2 files');
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).toContain('fileB.js');
      expect(result.toolUseResult).toMatchObject({
        mode: 'files_with_matches',
        filenames: expect.arrayContaining(['fileA.txt', 'fileB.js']),
        numFiles: 2,
      });

      // Verify -l flag was used
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-l');
    });

    it('should handle output_mode: files_with_matches explicitly', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt', 'fileB.js']);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        output_mode: 'files_with_matches',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Found 2 files');
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).toContain('fileB.js');
      expect(result.toolUseResult).toMatchObject({
        mode: 'files_with_matches',
        filenames: expect.arrayContaining(['fileA.txt', 'fileB.js']),
        numFiles: 2,
      });

      // Verify -l flag was used
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-l');
    });

    it('should bound structured filenames when head_limit is unlimited', async () => {
      const files = Array.from(
        { length: 600 },
        (_, index) =>
          `very/deep/path/${index.toString().padStart(4, '0')}-${'long-name-'.repeat(8)}.ts`,
      );
      mockRipGrep.mockResolvedValue(files);

      const params: RipGrepToolParams = {
        pattern: 'match',
        head_limit: 0,
        output_mode: 'files_with_matches',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      const toolUseResult = result.toolUseResult as GrepResult;

      expect(result.llmContent).toContain(files[599]);
      expect((result.returnDisplay as GrepResult).filenames).toHaveLength(600);
      expect(JSON.stringify(toolUseResult).length).toBeLessThanOrEqual(20_000);
      expect(toolUseResult).toMatchObject({
        mode: 'files_with_matches',
        numFiles: 600,
      });
      expect(toolUseResult.filenames.length).toBeLessThan(600);
      expect(toolUseResult).not.toHaveProperty('payload');
    });

    it('should handle output_mode: count', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:2', 'fileB.js:1']);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        output_mode: 'count',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should contain count data
      expect(result.llmContent).toContain('fileA.txt:2');
      expect(result.llmContent).toContain('fileB.js:1');
      expect(result.llmContent).toContain('3 total occurrences');
      expect(result.llmContent).toContain('2 files');
      expect(result.toolUseResult).toMatchObject({
        mode: 'count',
        numFiles: 2,
        filenames: [],
        content: 'fileA.txt:2\nfileB.js:1',
        numMatches: 3,
      });

      // Verify -c flag was used
      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-c');
    });

    it('should respect head_limit and truncate results (content mode)', async () => {
      // Return 3 matches, but set head_limit to 2
      mockRipGrep.mockResolvedValue([
        'fileA.txt:1:match 1',
        'fileA.txt:2:match 2',
        'fileA.txt:3:match 3',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'match',
        head_limit: 2,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('fileA.txt:1:match 1');
      expect(result.llmContent).toContain('fileA.txt:2:match 2');
      expect(result.llmContent).not.toContain('fileA.txt:3:match 3');
      expect(result.llmContent).toContain('pagination');
      expect(result.llmContent).toContain('limit: 2');
    });

    it('should bound structured content when head_limit is unlimited', async () => {
      const largeLine = 'x'.repeat(400);
      mockRipGrep.mockResolvedValue(
        Array.from(
          { length: 300 },
          (_, index) => `fileA.txt:${index + 1}:match ${index} ${largeLine}`,
        ),
      );

      const params: RipGrepToolParams = {
        pattern: 'match',
        head_limit: 0,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);
      const toolUseResult = result.toolUseResult as GrepResult;

      expect(result.llmContent).toContain(`fileA.txt:300:match 299`);
      expect(result.returnDisplay as GrepResult).not.toHaveProperty('matches');
      expect(JSON.stringify(toolUseResult).length).toBeLessThanOrEqual(20_000);
      expect(toolUseResult.mode).toBe('content');
      expect(toolUseResult.numLines).toBe(300);
      expect(toolUseResult.content!.length).toBeLessThan(
        (result.returnDisplay as GrepResult).content!.length,
      );
      expect(toolUseResult).not.toHaveProperty('matches');
      expect(toolUseResult).not.toHaveProperty('payload');
    });

    it('should respect offset parameter (content mode)', async () => {
      mockRipGrep.mockResolvedValue([
        'fileA.txt:1:match 1',
        'fileA.txt:2:match 2',
        'fileA.txt:3:match 3',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'match',
        offset: 1,
        head_limit: 1,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should skip first result and return second
      expect(result.llmContent).not.toContain('fileA.txt:1:match 1');
      expect(result.llmContent).toContain('fileA.txt:2:match 2');
      expect(result.llmContent).not.toContain('fileA.txt:3:match 3');
    });

    it('should handle patterns starting with dash using -e flag', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:1:-pattern match']);

      const params: RipGrepToolParams = {
        pattern: '-pattern',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-e');
      expect(args).toContain('-pattern');
    });

    it('should handle type filter', async () => {
      mockRipGrep.mockResolvedValue(['fileB.js:1:const foo']);

      const params: RipGrepToolParams = {
        pattern: 'foo',
        type: 'js',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('--type');
      expect(args).toContain('js');
    });

    it('should handle multiline mode', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:1:multi\nline match']);

      const params: RipGrepToolParams = {
        pattern: 'multi.*match',
        multiline: true,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-U');
      expect(args).toContain('--multiline-dotall');
    });

    it('should handle -n: false (no line numbers)', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:hello world']);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        '-n': false,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-n'); // JSON line numbers are removed only when rendering.
    });

    it('should add -n by default in content mode', async () => {
      mockRipGrep.mockResolvedValue(['fileA.txt:1:hello world']);

      const params: RipGrepToolParams = {
        pattern: 'hello',
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      expect(args).toContain('-n');
    });

    it('should split glob patterns on spaces while preserving braces', async () => {
      mockRipGrep.mockResolvedValue([]);

      const params: RipGrepToolParams = {
        pattern: 'test',
        glob: '*.ts *.{js,jsx}',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      // Should have 3 glob args: *.ts, *.{js,jsx} (brace pattern preserved)
      // Plus VCS exclusion globs
      const globArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (
          args[i] === '--glob' &&
          args[i + 1] &&
          !args[i + 1].startsWith('!')
        ) {
          globArgs.push(args[i + 1]);
        }
      }
      expect(globArgs).toContain('*.ts');
      expect(globArgs).toContain('*.{js,jsx}');
    });

    it('should split glob patterns on commas for non-brace patterns', async () => {
      mockRipGrep.mockResolvedValue([]);

      const params: RipGrepToolParams = {
        pattern: 'test',
        glob: '*.ts,*.js',
      };
      const invocation = grepTool.build(params);
      await invocation.execute(abortSignal);

      const args = mockRipGrep.mock.calls[0][0];
      const globArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (
          args[i] === '--glob' &&
          args[i + 1] &&
          !args[i + 1].startsWith('!')
        ) {
          globArgs.push(args[i + 1]);
        }
      }
      expect(globArgs).toContain('*.ts');
      expect(globArgs).toContain('*.js');
    });
  });

  describe('getDescription', () => {
    it.each([
      {
        name: 'pattern only',
        params: { pattern: 'testPattern' },
        expected: "'testPattern' within ./",
      },
      {
        name: 'pattern and glob',
        params: { pattern: 'testPattern', glob: '*.ts' },
        expected: "'testPattern' in *.ts within ./",
      },
      {
        name: 'root path in description',
        params: { pattern: 'testPattern', path: '.' },
        expected: "'testPattern' within ./",
      },
    ])(
      'should generate correct description with $name',
      ({ params, expected }) => {
        const invocation = grepTool.build(params);
        expect(invocation.getDescription()).toBe(expected);
      },
    );

    it('should generate correct description with pattern and path', async () => {
      const dirPath = path.join(tempRootDir, 'src', 'app');
      await fs.mkdir(dirPath, { recursive: true });
      const params: RipGrepToolParams = {
        pattern: 'testPattern',
        path: path.join('src', 'app'),
      };
      const invocation = grepTool.build(params);
      expect(invocation.getDescription()).toContain("'testPattern' within");
      expect(invocation.getDescription()).toContain(path.join('src', 'app'));
    });

    it('should use ./ when no path is specified (defaults to CWD)', () => {
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, ['/another/dir']),
        getDebugMode: () => false,
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
        storage: {
          getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
        },
        isPathAllowed(this: Config, absolutePath: string): boolean {
          const workspaceContext = this.getWorkspaceContext();
          if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
            return true;
          }
          const projectTempDir = this.storage.getProjectTempDir();
          return isSubpath(path.resolve(projectTempDir), absolutePath);
        },
        validatePathAccess(this: Config, absolutePath: string): string | null {
          if (this.isPathAllowed(absolutePath)) {
            return null;
          }
          const workspaceDirs = this.getWorkspaceContext().getDirectories();
          const projectTempDir = this.storage.getProjectTempDir();
          return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
        },
      } as unknown as Config;

      const multiDirGrepTool = new RipGrepTool(multiDirConfig);
      const params: RipGrepToolParams = { pattern: 'testPattern' };
      const invocation = multiDirGrepTool.build(params);
      expect(invocation.getDescription()).toBe("'testPattern' within ./");
    });
  });

  describe('multi-directory workspace', () => {
    it('should search only CWD when no path is specified (default behavior)', async () => {
      // Create additional directory with test files
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.writeFile(
        path.join(secondDir, 'other.txt'),
        'hello from second directory\nworld in second',
      );

      // Create a mock config with multiple directories
      const multiDirConfig = {
        getTargetDir: () => tempRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(tempRootDir, [secondDir]),
        getDebugMode: () => false,
        getFileExclusions: () => ({
          getGlobExcludes: () => [],
        }),
        storage: {
          getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
        },
        isPathAllowed(this: Config, absolutePath: string): boolean {
          const workspaceContext = this.getWorkspaceContext();
          if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
            return true;
          }
          const projectTempDir = this.storage.getProjectTempDir();
          return isSubpath(path.resolve(projectTempDir), absolutePath);
        },
        validatePathAccess(this: Config, absolutePath: string): string | null {
          if (this.isPathAllowed(absolutePath)) {
            return null;
          }
          const workspaceDirs = this.getWorkspaceContext().getDirectories();
          const projectTempDir = this.storage.getProjectTempDir();
          return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
        },
      } as unknown as Config;

      mockRipGrep.mockResolvedValue(['fileA.txt', 'sub/fileC.txt']);

      const multiDirGrepTool = new RipGrepTool(multiDirConfig);
      const params: RipGrepToolParams = { pattern: 'world' };
      const invocation = multiDirGrepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // Should find matches in CWD only (default behavior, files_with_matches mode)
      expect(result.llmContent).toContain('Found 2 files');

      // Verify ripgrep was called with the correct target directory
      const targetPath = mockRipGrep.mock.calls[0][1];
      expect(targetPath).toBe('.');
      expect(mockRipGrep.mock.calls[0][3]).toMatchObject({ cwd: tempRootDir });

      // Clean up
      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe('UNC search targets', () => {
    it.each(
      (['content', 'count', 'files_with_matches'] as const).flatMap((mode) =>
        ['//server/share/source/file.cpp', '//server/share/source'].map(
          (target) => ({ mode, target }),
        ),
      ),
    )('searches $target in $mode mode without using it as cwd', async ({ mode, target }) => {
      const file = '//server/share/source/file.cpp';
      const stat = vi.spyOn(fs, 'stat');
      mockRipGrep.mockImplementation(async (_args, searchTarget, _signal, options) => {
        // No network metadata probe should happen before spawning ripgrep.
        expect(stat).not.toHaveBeenCalled();
        expect(searchTarget).toBe(target);
        expect(options.cwd).toBe(tempRootDir);
        if (options.cwd === file) throw new Error('spawn rg ENOENT');
        return mode === 'content'
          ? [`${file}:7:hello`]
          : mode === 'count'
            ? [`${file}:2`]
            : [file];
      });
      // Result sorting may stat returned files; never touch a real network path.
      stat.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'ENOENT' }));
      try {
        const result = await grepTool.build({
          pattern: 'hello', path: target, output_mode: mode,
        }).execute(abortSignal);
        expect(mockRipGrep).toHaveBeenCalledOnce();
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('file.cpp');
        if (mode === 'content') expect(result.llmContent).toContain('7:hello');
        if (mode === 'count') expect(result.llmContent).toContain(':2');
        if (mode === 'files_with_matches') {
          expect((result.returnDisplay as GrepResult).numFiles).toBe(1);
          expect(stat).toHaveBeenCalledWith(file);
        }
      } finally {
        stat.mockRestore();
      }
    });
  });

  describe('abort signal handling', () => {
    it('should pass abort signal to ripGrep', async () => {
      mockRipGrep.mockResolvedValue([]);

      const controller = new AbortController();
      const params: RipGrepToolParams = { pattern: 'world' };
      const invocation = grepTool.build(params);

      await invocation.execute(controller.signal);

      // Verify abort signal was passed to ripGrep
      const signal = mockRipGrep.mock.calls[0][2];
      expect(signal).toBe(controller.signal);
    });
  });

  describe('Read deny result filtering', () => {
    // The deny rule must use the double-slash absolute form; a single leading
    // slash is project-relative semantics. cwd for rule matching is the
    // config's target directory ('/opt/workspace' here).
    const setupDenyScenario = (rules: string[]) => {
      mockConfig = Object.assign(
        Object.create(Object.getPrototypeOf(mockConfig)),
        mockConfig,
        {
          getTargetDir: () => '/opt/workspace',
          permission: {
            getRules: () => ({
              allow: {},
              deny: { projectSettings: rules },
              ask: {},
            }),
            getAdditionalDirectories: () => [],
                  getManagedRules: () => undefined,
          },
        },
      ) as Config;
      grepTool = new RipGrepTool(mockConfig);
    };

    it('should keep the search allowed but hide Read-denied files from results (files_with_matches)', async () => {
      setupDenyScenario(['Read(//opt/workspace/config/db.env)']);
      mockRipGrep.mockResolvedValue([
        '/opt/workspace/config/db.env',
        '/opt/workspace/config/app.conf',
      ]);

      const params: RipGrepToolParams = { pattern: 'DB', path: tempRootDir };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      // The search itself passes: no execution error, and ripgrep ran.
      expect(result.error).toBeUndefined();
      expect(mockRipGrep).toHaveBeenCalled();

      expect(result.llmContent).toContain('app.conf');
      expect(result.llmContent).not.toContain('db.env');
      expect((result.returnDisplay as GrepResult).numFiles).toBe(1);
    });

    it('should hide Read-denied matches in content mode', async () => {
      setupDenyScenario(['Read(//opt/workspace/config/db.env)']);
      mockRipGrep.mockResolvedValue([
        '/opt/workspace/config/db.env:1:DB_PASSWORD=hunter2',
        '/opt/workspace/config/app.conf:2:port=5432',
      ]);

      const params: RipGrepToolParams = {
        pattern: '.',
        path: tempRootDir,
        output_mode: 'content',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('port=5432');
      expect(result.llmContent).not.toContain('db.env');
      expect(result.llmContent).not.toContain('DB_PASSWORD');
    });

    it('should hide Read-denied matches in count mode', async () => {
      setupDenyScenario(['Read(//opt/workspace/config/db.env)']);
      mockRipGrep.mockResolvedValue([
        '/opt/workspace/config/db.env:3',
        '/opt/workspace/config/app.conf:1',
      ]);

      const params: RipGrepToolParams = {
        pattern: 'DB',
        path: tempRootDir,
        output_mode: 'count',
      };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('app.conf');
      expect(result.llmContent).not.toContain('db.env');
      expect((result.returnDisplay as GrepResult).numFiles).toBe(1);
    });

    it('should keep entries the deny rule does not hit', async () => {
      setupDenyScenario(['Read(//opt/workspace/other/secret.txt)']);
      mockRipGrep.mockResolvedValue([
        '/opt/workspace/config/db.env',
        '/opt/workspace/config/app.conf',
      ]);

      const params: RipGrepToolParams = { pattern: 'DB', path: tempRootDir };
      const invocation = grepTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('app.conf');
      expect(result.llmContent).toContain('db.env');
      expect((result.returnDisplay as GrepResult).numFiles).toBe(2);
    });
  });
});

describe('grepGetPath', () => {
  beforeEach(() => resetShellCwd('/session'));
  afterEach(() => resetShellCwd());

  it('expands home paths', () => {
    expect(grepGetPath({ pattern: '*', path: '~' })).toBe(os.homedir());
  });
  it('uses the current session directory by default', () => {
    expect(grepGetPath({ pattern: '*' })).toBe('/session');
  });
  it('resolves relative paths against the current directory', () => {
    expect(grepGetPath({ pattern: '*', path: 'sub/dir' })).toBe(
      path.resolve('/session', 'sub/dir'),
    );
  });
  it('preserves an explicit absolute search root', () => {
    expect(grepGetPath({ pattern: '*', path: '/abs/dir' })).toBe('/abs/dir');
  });
});
