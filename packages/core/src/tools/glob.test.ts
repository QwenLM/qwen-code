/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GlobToolParams, GlobPath } from './glob.js';
import { GlobTool, sortFileEntries } from './glob.js';
import type { ToolResult } from './tools.js';
import { partListUnionToString } from '../core/llm-request.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { tildeifyPath } from '../utils/paths.js';
import { ToolErrorType } from './tool-error.js';
import * as glob from 'glob';
import type { Path as GlobResultPath } from 'glob';

vi.mock('glob', { spy: true });

describe('GlobTool', () => {
  let tempRootDir: string; // This will be the rootDirectory for the GlobTool instance
  let globTool: GlobTool;
  const abortSignal = new AbortController().signal;

  // Mock config for testing
  const mockConfig = {
    getFileService: () => new FileDiscoveryService(tempRootDir),
    getFileFilteringRespectGitIgnore: () => true,
    getFileFilteringOptions: () => ({
      respectGitIgnore: true,
      respectQwenIgnore: true,
    }),
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getFileExclusions: () => ({
      getGlobExcludes: () => [],
    }),
    getTruncateToolOutputLines: () => 1000,
  } as unknown as Config;

  /** A GlobTool over `mockConfig` with some getters overridden. */
  const toolWith = (overrides: Record<string, unknown>) =>
    new GlobTool({ ...mockConfig, ...overrides } as unknown as Config);
  const workspaceTool = (extraDirs: string[]) =>
    toolWith({
      getWorkspaceContext: () =>
        createMockWorkspaceContext(tempRootDir, extraDirs),
    });
  const run = (params: GlobToolParams, tool: GlobTool = globTool) =>
    tool.build(params).execute(abortSignal);
  /** Runs on a tool built now, so it sees ignore files the test just wrote. */
  const runFresh = (params: GlobToolParams) =>
    run(params, new GlobTool(mockConfig));
  const validate = (params: GlobToolParams) =>
    globTool.validateToolParams(params);
  /** Writes a file under the root; `rel` may contain `/`. */
  const put = (rel: string, content = 'x') =>
    fs.writeFile(path.join(tempRootDir, rel), content);
  const mkdirp = (rel: string) =>
    fs.mkdir(path.join(tempRootDir, rel), { recursive: true });
  const expectFound = (
    result: ToolResult,
    count: number,
    ...rels: string[]
  ) => {
    expect(result.llmContent).toContain(`Found ${count} file(s)`);
    for (const rel of rels) {
      expect(result.llmContent).toContain(path.join(tempRootDir, rel));
    }
  };

  beforeEach(async () => {
    // Create a unique root directory for each test run
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-tool-root-'));
    await put('.git', ''); // Fake git repo
    globTool = new GlobTool(mockConfig);

    // Top-level files; FileB.TXT and FileD.MD differ in case for testing
    await put('fileA.txt', 'contentA');
    await put('FileB.TXT', 'contentB');
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await put('sub/fileC.md', 'contentC');
    await put('sub/FileD.MD', 'contentD');
    await fs.mkdir(path.join(tempRootDir, 'sub', 'deep'));
    await put('sub/deep/fileE.log', 'contentE');

    // Files for mtime sorting test, with a noticeable mtime difference
    await put('older.sortme', 'older_content');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await put('newer.sortme', 'newer_content');

    // For type coercion testing
    await fs.mkdir(path.join(tempRootDir, '123'));
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  const mockGlobStreamResults = (
    prefix: string,
    count: number,
    extension = 'streamlimit',
  ) => {
    const baseMtimeMs = Date.now();
    let yielded = 0;

    async function* streamEntries() {
      for (let index = 0; index < count; index++) {
        yielded++;
        const fileNumber = index + 1;
        yield {
          fullpath: () =>
            path.join(tempRootDir, `${prefix}${fileNumber}.${extension}`),
          mtimeMs: baseMtimeMs + fileNumber,
        } as unknown as GlobResultPath;
      }
    }

    const iterator = streamEntries();
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
      destroy: vi.fn(() => {
        void iterator.return?.();
      }),
    };

    vi.mocked(glob.globStream).mockReturnValueOnce(
      stream as unknown as ReturnType<typeof glob.globStream>,
    );

    return { getYielded: () => yielded, destroy: stream.destroy };
  };

  const mockTruncationGlobResults = (prefix: string, count: number) => {
    mockGlobStreamResults(prefix, count, 'trunctest');
  };

  describe('execute', () => {
    it('should find files matching a simple pattern in the root', async () => {
      const result = await run({ pattern: '*.txt' });
      expectFound(result, 2, 'fileA.txt', 'FileB.TXT');
      expect(result.returnDisplay).toBe('Found 2 matching file(s)');
      expect(result.resultFilePaths).toHaveLength(2);
      for (const name of ['fileA.txt', 'FileB.TXT']) {
        expect(result.resultFilePaths).toContain(path.join(tempRootDir, name));
      }
    });

    it('should find files case-insensitively by default (pattern: *.TXT)', async () => {
      expectFound(await run({ pattern: '*.TXT' }), 2, 'fileA.txt', 'FileB.TXT');
    });

    it('should find files using a pattern that includes a subdirectory', async () => {
      const result = await run({ pattern: 'sub/*.md' });
      expectFound(result, 2, 'sub/fileC.md', 'sub/FileD.MD');
    });

    it('should find files in a specified relative path (relative to rootDir)', async () => {
      const result = await run({ pattern: '*.md', path: 'sub' });
      expectFound(result, 2, 'sub/fileC.md', 'sub/FileD.MD');
    });

    it('should find files using a deep globstar pattern (e.g., **/*.log)', async () => {
      expectFound(await run({ pattern: '**/*.log' }), 1, 'sub/deep/fileE.log');
    });

    it('should return "No files found" message when pattern matches nothing', async () => {
      const result = await run({ pattern: '*.nonexistent' });
      expect(result.llmContent).toContain(
        'No files found matching pattern "*.nonexistent"',
      );
      expect(result.returnDisplay).toBe('No files found');
    });

    it('should find files with special characters in the name', async () => {
      await put('file[1].txt', 'content');
      expectFound(await run({ pattern: 'file[1].txt' }), 1, 'file[1].txt');
    });

    it('should find files with special characters like [] and () in the path', async () => {
      const rel = 'src/app/[test]/(dashboard)/testing/components/code.tsx';
      await mkdirp(path.dirname(rel));
      await put(rel, 'content');

      expectFound(await run({ pattern: rel }), 1, rel);
    });

    it('should correctly sort files by modification time (newest first)', async () => {
      const result = await run({ pattern: '*.sortme' });
      const llmContent = partListUnionToString(result.llmContent);

      expect(llmContent).toContain('Found 2 file(s)');
      // Ensure llmContent is a string for TypeScript type checking
      expect(typeof llmContent).toBe('string');

      const filesListed = llmContent
        .trim()
        .split(/\r?\n/)
        .slice(2)
        .map((line) => line.trim())
        .filter(Boolean);

      expect(filesListed).toHaveLength(2);
      expect(path.resolve(filesListed[0])).toBe(
        path.resolve(tempRootDir, 'newer.sortme'),
      );
      expect(path.resolve(filesListed[1])).toBe(
        path.resolve(tempRootDir, 'older.sortme'),
      );
    });

    it('should find files even if workspace path casing differs from glob results (Windows/macOS)', async () => {
      // Only relevant for Windows and macOS
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        return;
      }

      let mismatchedRootDir = tempRootDir;

      if (process.platform === 'win32') {
        // Lower-case the drive letter, e.g. "C:\Users\..." -> "c:\Users\..."
        const drive = path.parse(tempRootDir).root;
        if (!drive || !drive.match(/^[A-Z]:\\/)) {
          // Skip if we can't determine/manipulate the drive letter easily
          return;
        }
        mismatchedRootDir =
          drive.toLowerCase() + tempRootDir.substring(drive.length);
      } else {
        // macOS: change the casing of the path
        mismatchedRootDir =
          tempRootDir === tempRootDir.toLowerCase()
            ? tempRootDir.toUpperCase()
            : tempRootDir.toLowerCase();
      }

      const mismatchedGlobTool = toolWith({
        getTargetDir: () => mismatchedRootDir,
        getWorkspaceContext: () =>
          createMockWorkspaceContext(mismatchedRootDir),
      });
      const result = await run({ pattern: '*.txt' }, mismatchedGlobTool);

      expect(result.llmContent).toContain('Found 2 file(s)');
    });

    it('should allow path outside workspace (external path support)', async () => {
      // Shared /tmp made this walk time out on loaded runners — keep this
      // dir dedicated. Seed a real file: with an EMPTY dir the assertions
      // below were vacuous — any outcome, including "found nothing at
      // all", passed them.
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'glob-external-'),
      );
      await fs.writeFile(path.join(outside, 'external.txt'), 'x');
      try {
        // External path is now allowed - it should not return a workspace error
        const result = await run({ pattern: '*.txt', path: outside });
        expect(result.error).toBeUndefined();
        expect(result.returnDisplay).not.toContain(
          'Path is not within workspace',
        );
        // The glob really walked the external path: the seeded file comes
        // back (a regression to "nothing found" now fails, not passes).
        // Count AND identity: a walk redirected to any OTHER single *.txt
        // satisfies the count alone.
        expect(result.llmContent).toContain('Found 1 file(s)');
        expect(result.llmContent).toContain(path.join(outside, 'external.txt'));
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('should return a GLOB_EXECUTION_ERROR on glob failure', async () => {
      vi.mocked(glob.globStream).mockReturnValueOnce({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('Glob failed');
          },
        }),
      } as unknown as ReturnType<typeof glob.globStream>);
      const result = await run({ pattern: '*.txt' });
      expect(result.error?.type).toBe(ToolErrorType.GLOB_EXECUTION_ERROR);
      expect(result.llmContent).toContain(
        'Error during glob search operation: Glob failed',
      );
    });
  });

  describe('validateToolParams', () => {
    it('should return null for valid parameters (pattern only)', () => {
      expect(validate({ pattern: '*.js' })).toBeNull();
    });

    it('should return null for valid parameters (pattern and path)', () => {
      expect(validate({ pattern: '*.js', path: 'sub' })).toBeNull();
    });

    it('should return error if pattern is missing (schema validation)', () => {
      const params = { path: '.' };
      // @ts-expect-error - We're intentionally creating invalid params for testing
      expect(validate(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should return error if pattern is an empty string', () => {
      expect(validate({ pattern: '' })).toContain(
        "The 'pattern' parameter cannot be empty.",
      );
    });

    it('should return error if pattern is only whitespace', () => {
      expect(validate({ pattern: '   ' })).toContain(
        "The 'pattern' parameter cannot be empty.",
      );
    });

    it('should return error if path is provided but is not a string', () => {
      const params = {
        pattern: '*.ts',
        path: {},
      } as unknown as GlobToolParams; // Force incorrect type (object, not coercible)
      expect(validate(params)).toBe('params/path must be string');
    });

    it("should return error if search path resolves outside the tool's root directory", () => {
      // A tool with a deeper root, and a path that climbs far above it
      tempRootDir = path.join(tempRootDir, 'sub');
      const specificGlobTool = new GlobTool(mockConfig);
      const paramsOutside: GlobToolParams = {
        pattern: '*.txt',
        path: '../../../../../../../../../../tmp', // Definitely outside
      };
      // External paths are now allowed (permission handled at runtime)
      expect(specificGlobTool.validateToolParams(paramsOutside)).toBeNull();
    });

    it('should return error if specified search path does not exist', async () => {
      expect(
        validate({
          pattern: '*.txt',
          path: 'nonexistent_subdir',
        }),
      ).toContain('Path does not exist');
    });

    it('should return error if specified search path is a file, not a directory', async () => {
      expect(validate({ pattern: '*.txt', path: 'fileA.txt' })).toContain(
        'Path is not a directory',
      );
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped path',
      async () => {
        // Create a directory with a space so the unescaped path exists
        const dirWithSpace = path.join(tempRootDir, 'sub dir');
        await fs.mkdir(dirWithSpace);
        const params: GlobToolParams = {
          pattern: '*.ts',
          path: path.join(tempRootDir, 'sub\\ dir'),
        };
        expect(validate(params)).toBeNull();
        // Path should be normalized in place
        expect(params.path).toBe(dirWithSpace);
      },
    );
  });

  describe('workspace boundary validation', () => {
    it('should validate search paths are within workspace boundaries', () => {
      const validPath = { pattern: '*.ts', path: 'sub' };
      const invalidPath = { pattern: '*.ts', path: '../..' };

      expect(validate(validPath)).toBeNull();
      // External paths are now allowed (permission handled at runtime)
      expect(validate(invalidPath)).toBeNull();
    });

    it('should work with paths in workspace subdirectories', async () => {
      const result = await run({ pattern: '*.md', path: 'sub' });

      expect(result.llmContent).toContain('Found 2 file(s)');
      expect(result.llmContent).toContain('fileC.md');
      expect(result.llmContent).toContain('FileD.MD');
    });
  });

  describe('multi-directory workspace', () => {
    /** A second workspace dir holding a fake git repo plus `files`. */
    const makeSecondDir = async (files: Record<string, string> = {}) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-tool-second-'));
      await fs.writeFile(path.join(dir, '.git'), '');
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content);
      }
      return dir;
    };

    it('should search across all workspace directories when no path is specified', async () => {
      const secondDir = await makeSecondDir({
        'extra.txt': 'extra content',
        'bonus.txt': 'bonus content',
      });

      const result = await run(
        { pattern: '*.txt' },
        workspaceTool([secondDir]),
      );

      // Should find files from both directories
      expect(result.llmContent).toContain(path.join(tempRootDir, 'fileA.txt'));
      expect(result.llmContent).toContain(path.join(secondDir, 'extra.txt'));
      expect(result.llmContent).toContain(path.join(secondDir, 'bonus.txt'));
      expect(result.llmContent).toContain('across 2 workspace directories');

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should deduplicate entries across overlapping directories', async () => {
      // The same directory twice: still only 2 txt files (fileA.txt,
      // FileB.TXT), not doubled
      const result = await run(
        { pattern: '*.txt' },
        workspaceTool([tempRootDir]),
      );
      expect(result.llmContent).toContain('Found 2 file(s)');
    });

    it('should not scan later workspace directories after hitting the collection limit', async () => {
      const secondDir = await makeSecondDir();
      const globStreamCallsBefore = vi.mocked(glob.globStream).mock.calls
        .length;
      const stream = mockGlobStreamResults('limit', 10_005);
      const multiDirTool = workspaceTool([secondDir]);

      try {
        const result = await run({ pattern: '*.streamlimit' }, multiDirTool);
        const llmContent = partListUnionToString(result.llmContent);

        expect(vi.mocked(glob.globStream).mock.calls.length).toBe(
          globStreamCallsBefore + 1,
        );
        expect(stream.getYielded()).toBeLessThan(10_005);
        expect(llmContent).toContain('Found at least');
        expect(llmContent).toContain('Narrow the pattern or path');
      } finally {
        await fs.rm(secondDir, { recursive: true, force: true });
      }
    });

    it('should use single directory description when only one workspace dir', async () => {
      const result = await run({ pattern: '*.txt' });

      expect(result.llmContent).toContain('in the workspace directory');
      expect(result.llmContent).not.toContain('across');
    });

    it('should search only the specified path when path is provided (ignoring multi-dir)', async () => {
      const secondDir = await makeSecondDir({ 'other.txt': 'other' });

      const result = await run(
        { pattern: '*.txt', path: 'sub' },
        workspaceTool([secondDir]),
      );

      // Should NOT find files from secondDir
      expect(result.llmContent).not.toContain('other.txt');

      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe('ignore file handling', () => {
    /** Writes node_modules/pkg/dep.keep (gitignored) and app/main.keep. */
    const writeNodeModulesTree = async () => {
      await put('.gitignore', 'node_modules/\n');
      await mkdirp('node_modules/pkg');
      await put('node_modules/pkg/dep.keep');
      await mkdirp('app');
      await put('app/main.keep');
    };

    it('should respect .gitignore files by default', async () => {
      await put('.gitignore', '*.ignored.txt');
      await put('a.ignored.txt', 'ignored content');
      await put('b.notignored.txt', 'not ignored content');

      const result = await run({ pattern: '*.txt' });

      expect(result.llmContent).toContain('Found 3 file(s)'); // fileA.txt, FileB.TXT, b.notignored.txt
      expect(result.llmContent).not.toContain('a.ignored.txt');
    });

    it('should respect .qwenignore files by default', async () => {
      await put('.qwenignore', '*.qwenignored.txt');
      await put('a.qwenignored.txt', 'ignored content');
      await put('b.notignored.txt', 'not ignored content');

      // Recreate the tool to pick up the new .qwenignore file
      globTool = new GlobTool(mockConfig);

      const result = await run({ pattern: '*.txt' });

      expect(result.llmContent).toContain('Found 3 file(s)'); // fileA.txt, FileB.TXT, b.notignored.txt
      expect(result.llmContent).not.toContain('a.qwenignored.txt');
    });

    it('should respect .agentignore and .aiignore files by default', async () => {
      await put('.agentignore', '*.agentignored.txt');
      await put('.aiignore', '*.aiignored.txt');
      await put('a.agentignored.txt', 'ignored content');
      await put('b.aiignored.txt', 'ignored content');
      await put('c.notignored.txt', 'not ignored content');

      const result = await run({ pattern: '*.txt' });

      expect(result.llmContent).toContain('c.notignored.txt');
      expect(result.llmContent).not.toContain('a.agentignored.txt');
      expect(result.llmContent).not.toContain('b.aiignored.txt');
    });

    it('should respect configured custom qwen ignore files', async () => {
      await put('.cursorignore', '*.cursorignored.txt');
      await put('.agentignore', '*.agentignored.txt');
      await put('a.cursorignored.txt', 'ignored content');
      await put('b.agentignored.txt', 'not ignored by this config');
      await put('c.notignored.txt', 'not ignored content');

      const customGlobTool = toolWith({
        getFileService: () =>
          new FileDiscoveryService(tempRootDir, ['.cursorignore']),
        getFileFilteringOptions: () => ({
          respectGitIgnore: true,
          respectQwenIgnore: true,
          customIgnoreFiles: ['.cursorignore'],
        }),
      });

      const result = await run({ pattern: '*.txt' }, customGlobTool);

      expect(result.llmContent).toContain('b.agentignored.txt');
      expect(result.llmContent).toContain('c.notignored.txt');
      expect(result.llmContent).not.toContain('a.cursorignored.txt');
    });

    it('should respect .gitignore when searching a subdirectory (path option)', async () => {
      // Regression fix: relativePaths must be computed relative to
      // projectRoot, not searchDir, so that gitignore rules rooted at
      // projectRoot are evaluated against the correct paths.
      await put('.gitignore', '*.secret');
      await put('sub/visible.txt', 'ok');
      await put('sub/hidden.secret', 'should be ignored');

      const result = await runFresh({ pattern: '*', path: 'sub' });

      expect(result.llmContent).toContain('visible.txt');
      expect(result.llmContent).not.toContain('hidden.secret');
    });

    it('should respect .qwenignore when searching a subdirectory (path option)', async () => {
      await put('.qwenignore', '*.secret');
      await put('sub/visible.txt', 'ok');
      await put('sub/hidden.secret', 'should be ignored');

      // Recreate to pick up .qwenignore
      const result = await runFresh({ pattern: '*', path: 'sub' });

      expect(result.llmContent).toContain('visible.txt');
      expect(result.llmContent).not.toContain('hidden.secret');
    });

    it('does not over-ignore nested dirs for a root-anchored gitignore pattern', async () => {
      // Regression: `/dist` is anchored to the repo root and must NOT exclude
      // a nested `src/dist`. Traversal pruning delegates to the real gitignore
      // logic, so anchoring is preserved (a lossy `/dist` -> `**/dist/**`
      // conversion would wrongly prune src/dist while walking).
      await put('.gitignore', '/dist\n');
      await mkdirp('dist');
      await put('dist/root.keep');
      await mkdirp('src/dist');
      await put('src/dist/nested.keep');

      const result = await runFresh({ pattern: '**/*.keep' });

      expect(result.llmContent).toContain('nested.keep');
      expect(result.llmContent).not.toContain('root.keep');
    });

    it('prunes a gitignored directory (e.g. node_modules) during traversal', async () => {
      await writeNodeModulesTree();

      const result = await runFresh({ pattern: '**/*.keep' });

      expect(result.llmContent).toContain('main.keep');
      expect(result.llmContent).not.toContain('dep.keep');
    });

    it('passes ignore callbacks to glob for traversal pruning', async () => {
      await put('.gitignore', 'node_modules/\n');
      await mkdirp('node_modules');

      vi.mocked(glob.globStream).mockClear();

      await runFresh({ pattern: '**/*.keep' });

      const lastCall = vi.mocked(glob.globStream).mock.calls.at(-1);
      const globOptions = lastCall?.[1] as
        | { ignore?: { ignored?: unknown; childrenIgnored?: unknown } }
        | undefined;
      expect(globOptions?.ignore).toBeDefined();
      expect(globOptions?.ignore?.ignored).toBeTypeOf('function');
      expect(globOptions?.ignore?.childrenIgnored).toBeTypeOf('function');
    });

    it('does not prune during traversal when respectGitIgnore is false', async () => {
      await writeNodeModulesTree();

      const noGitIgnoreTool = toolWith({
        getFileFilteringOptions: () => ({
          respectGitIgnore: false,
          respectQwenIgnore: true,
        }),
      });
      const result = await run({ pattern: '**/*.keep' }, noGitIgnoreTool);

      // gitignore disabled → the gitignored dir is not pruned; its file appears.
      expect(result.llmContent).toContain('dep.keep');
      expect(result.llmContent).toContain('main.keep');
    });

    it('does not prune entries outside the project root during traversal', async () => {
      // Root gitignores *.log; an external search dir containing a matching
      // file must NOT be pruned — ignore rules only apply within the root.
      await put('.gitignore', '*.log\n');
      const externalDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'glob-external-'),
      );
      try {
        await fs.writeFile(path.join(externalDir, 'outside.log'), 'x');

        const result = await runFresh({ pattern: '*.log', path: externalDir });

        expect(result.llmContent).toContain('outside.log');
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });

    it('honors gitignore negation re-inclusion during traversal', async () => {
      // `!build/keep.keep` re-includes a file under an otherwise-ignored path.
      // Dropping negations (as a pattern conversion must) would wrongly prune
      // it; delegating to the real ignore logic preserves re-inclusion.
      await put('.gitignore', 'build/**\n!build/keep.keep\n');
      await mkdirp('build');
      await put('build/keep.keep');
      await put('build/skip.keep');

      const result = await runFresh({ pattern: '**/*.keep' });

      expect(result.llmContent).toContain('keep.keep');
      expect(result.llmContent).not.toContain('skip.keep');
    });
  });

  describe('file count truncation', () => {
    it('stops collecting glob results at a bounded scan limit', async () => {
      const totalResults = 10_005;
      const stream = mockGlobStreamResults('limit', totalResults);

      const result = await run({ pattern: '*.streamlimit' });
      const llmContent = partListUnionToString(result.llmContent);

      expect(stream.getYielded()).toBeLessThan(totalResults);
      expect(stream.destroy).toHaveBeenCalled();
      expect(llmContent).toContain('Found at least');
      expect(llmContent).toContain('Narrow the pattern or path');
      expect(result.returnDisplay).toContain('(truncated)');
    });

    it('should truncate results when more than 100 files are found', async () => {
      mockTruncationGlobResults('file', 150);

      const result = await run({ pattern: '*.trunctest' });
      const llmContent = partListUnionToString(result.llmContent);

      // Reports all 150 files found, with a truncation notice
      expect(llmContent).toContain('Found 150 file(s)');
      expect(llmContent).toContain('[50 files truncated] ...');

      // Only 100 .trunctest files are listed
      const fileMatches = llmContent.match(/file\d+\.trunctest/g);
      expect(fileMatches).toBeDefined();
      expect(fileMatches?.length).toBe(100);

      expect(result.returnDisplay).toBe(
        'Found 150 matching file(s) (truncated)',
      );
    });

    it('should not truncate when exactly 100 files are found', async () => {
      mockTruncationGlobResults('exact', 100);

      const result = await run({ pattern: '*.trunctest' });

      expect(result.llmContent).toContain('Found 100 file(s)');
      expect(result.llmContent).not.toContain('truncated');
      // Should show all 100 files
      expect(result.llmContent).toContain('exact1.trunctest');
      expect(result.llmContent).toContain('exact100.trunctest');
      expect(result.returnDisplay).toBe('Found 100 matching file(s)');
    });

    it('should not truncate when fewer than 100 files are found', async () => {
      mockTruncationGlobResults('small', 50);

      const result = await run({ pattern: '*.trunctest' });

      expect(result.llmContent).toContain('Found 50 file(s)');
      expect(result.llmContent).not.toContain('truncated');
      expect(result.returnDisplay).toBe('Found 50 matching file(s)');
    });

    it('should use correct singular/plural in truncation message for 1 file truncated', async () => {
      mockTruncationGlobResults('singular', 101);

      const result = await run({ pattern: '*.trunctest' });

      // Should use singular "file" for 1 truncated file
      expect(result.llmContent).toContain('[1 file truncated] ...');
      expect(result.llmContent).not.toContain('[1 files truncated]');
    });

    it('should use correct plural in truncation message for multiple files truncated', async () => {
      mockTruncationGlobResults('plural', 105);

      const result = await run({ pattern: '*.trunctest' });

      // Should use plural "files" for multiple truncated files
      expect(result.llmContent).toContain('[5 files truncated] ...');
    });
  });

  describe('getDescription', () => {
    const descriptionOf = (params: GlobToolParams) =>
      globTool.build(params).getDescription();

    it('should generate correct description with pattern only', () => {
      expect(descriptionOf({ pattern: '*.ts' })).toBe("'*.ts'");
    });

    it('should show project-internal paths relative to the project root', () => {
      expect(descriptionOf({ pattern: '*.ts', path: 'sub' })).toBe(
        "'*.ts' in sub",
      );
    });

    it('should show . for the project root itself', () => {
      expect(descriptionOf({ pattern: '*.ts', path: '.' })).toBe("'*.ts' in .");
    });

    it('should keep paths outside the project absolute (never project-relative)', () => {
      const outside = path.resolve(os.tmpdir());
      expect(descriptionOf({ pattern: '*.ts', path: outside })).toBe(
        `'*.ts' in ${tildeifyPath(outside)}`,
      );
    });
  });

  describe('getDefaultPermission', () => {
    it('should return allow for paths within workspace', async () => {
      const permission = await globTool
        .build({ pattern: '*', path: 'sub' })
        .getDefaultPermission();
      expect(permission).toBe('allow');
    });

    it('should return ask for tilde paths outside workspace', async () => {
      const permission = await globTool
        .build({ pattern: '*', path: '~/outside-workspace' })
        .getDefaultPermission();
      expect(permission).toBe('ask');
    });
  });
});

describe('sortFileEntries', () => {
  const nowTimestamp = new Date('2024-01-15T12:00:00.000Z').getTime();
  const oneDayInMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;

  /** An entry last modified `agoMs` before `nowTimestamp`. */
  const entry = (fullpath: string, agoMs: number): GlobPath => ({
    fullpath: () => fullpath,
    mtimeMs: nowTimestamp - agoMs,
  });
  const sortedPaths = (entries: GlobPath[], thresholdMs = oneDayInMs) =>
    sortFileEntries(entries, nowTimestamp, thresholdMs).map((e) =>
      e.fullpath(),
    );

  it('should sort a mix of recent and older files correctly', () => {
    const older1 = oneDayInMs + hourMs; // 25 hours ago
    const older2 = oneDayInMs + 2 * hourMs; // 26 hours ago

    expect(
      sortedPaths([
        entry('older_zebra.txt', older2),
        entry('recent_alpha.txt', hourMs),
        entry('older_apple.txt', older1),
        entry('recent_beta.txt', 2 * hourMs),
        entry('older_banana.txt', older1), // Same mtime as apple
      ]),
    ).toEqual([
      'recent_alpha.txt', // Recent, newest
      'recent_beta.txt', // Recent, older
      'older_apple.txt', // Older, alphabetical
      'older_banana.txt', // Older, alphabetical
      'older_zebra.txt', // Older, alphabetical
    ]);
  });

  it('should sort only recent files by mtime descending', () => {
    // b is the newest, a the oldest recent
    expect(
      sortedPaths([
        entry('c.txt', 2000),
        entry('a.txt', 3000),
        entry('b.txt', 1000),
      ]),
    ).toEqual(['b.txt', 'c.txt', 'a.txt']);
  });

  it('should sort only older files alphabetically by path', () => {
    const olderMs = 2 * oneDayInMs; // All equally old
    expect(
      sortedPaths([
        entry('zebra.txt', olderMs),
        entry('apple.txt', olderMs),
        entry('banana.txt', olderMs),
      ]),
    ).toEqual(['apple.txt', 'banana.txt', 'zebra.txt']);
  });

  it('should handle an empty array', () => {
    expect(sortFileEntries([], nowTimestamp, oneDayInMs)).toEqual([]);
  });

  it('should correctly sort files when mtimes are identical for older files', () => {
    const olderMs = 2 * oneDayInMs;
    expect(
      sortedPaths([entry('b.txt', olderMs), entry('a.txt', olderMs)]),
    ).toEqual(['a.txt', 'b.txt']);
  });

  it('should correctly sort files when mtimes are identical for recent files (maintaining mtime sort)', () => {
    const paths = sortedPaths([entry('b.txt', 1000), entry('a.txt', 1000)]);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('b.txt');
    expect(paths.length).toBe(2);
  });

  it('should use recencyThresholdMs parameter correctly', () => {
    const customThresholdMs = 1000; // 1 second
    expect(
      sortedPaths(
        [
          entry('older_file.txt', 1000 + 1), // Barely older
          entry('recent_file.txt', 1000 - 1), // Barely recent
        ],
        customThresholdMs,
      ),
    ).toEqual(['recent_file.txt', 'older_file.txt']);
  });
});
