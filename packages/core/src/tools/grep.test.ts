/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { GrepToolParams } from './grep.js';
import { GrepTool } from './grep.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { tildeifyPath } from '../utils/paths.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolResult } from './tools.js';
import * as glob from 'glob';
import { FileReadCache } from '../services/fileReadCache.js';

vi.mock('glob', { spy: true });

// Mock the child_process module to control grep/git grep behavior
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      // Create a proper mock EventEmitter-like child process
      const listeners: Map<
        string,
        Set<(...args: unknown[]) => void>
      > = new Map();

      const createStream = () => ({
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const key = `stream:${event}`;
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)!.add(cb);
        }),
        removeListener: vi.fn(
          (event: string, cb: (...args: unknown[]) => void) => {
            const key = `stream:${event}`;
            listeners.get(key)?.delete(cb);
          },
        ),
      });

      return {
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const key = `child:${event}`;
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)!.add(cb);

          // Simulate command not found or error for git grep and system grep
          // to force it to fall back to JS implementation.
          if (event === 'error') {
            setTimeout(() => cb(new Error('Command not found')), 0);
          } else if (event === 'close') {
            setTimeout(() => cb(1), 0); // Exit code 1 for error
          }
        }),
        removeListener: vi.fn(
          (event: string, cb: (...args: unknown[]) => void) => {
            const key = `child:${event}`;
            listeners.get(key)?.delete(cb);
          },
        ),
        stdout: createStream(),
        stderr: createStream(),
        connected: false,
        disconnect: vi.fn(),
      };
    }),
    exec: vi.fn(
      (
        cmd: string,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        // Mock exec to fail for git grep commands
        callback(new Error('Command not found'), '', '');
      },
    ),
  };
});

describe('GrepTool', () => {
  let tempRootDir: string;
  let grepTool: GrepTool;
  let fileReadCache: FileReadCache;
  const abortSignal = new AbortController().signal;

  const mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getFileExclusions: () => ({
      getGlobExcludes: () => [],
    }),
    getTruncateToolOutputThreshold: () => 25000,
    getTruncateToolOutputLines: () => 1000,
  } as unknown as Config;

  const run = (params: GrepToolParams, tool = grepTool) =>
    tool.build(params).execute(abortSignal);
  const expectContent = (result: ToolResult, ...parts: string[]) => {
    for (const part of parts) expect(result.llmContent).toContain(part);
  };
  const multiDirTool = (extraDirs: string[]) =>
    new GrepTool({
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () =>
        createMockWorkspaceContext(tempRootDir, extraDirs),
      getFileExclusions: () => ({
        getGlobExcludes: () => [],
      }),
      getTruncateToolOutputThreshold: () => 25000,
      getTruncateToolOutputLines: () => 1000,
    } as unknown as Config);
  const setThreshold = (threshold: number) =>
    Object.assign(mockConfig, {
      getTruncateToolOutputThreshold: () => threshold,
    });

  beforeEach(async () => {
    fileReadCache = new FileReadCache();
    Object.assign(mockConfig, {
      getTruncateToolOutputThreshold: () => 25000,
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: () => false,
    });
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    grepTool = new GrepTool(mockConfig);

    await fs.mkdir(path.join(tempRootDir, 'sub'));
    for (const [file, text] of [
      ['fileA.txt', 'hello world\nsecond line with world'],
      ['fileB.js', 'const foo = "bar";\nfunction baz() { return "hello"; }'],
      ['sub/fileC.txt', 'another world in sub dir'],
      ['sub/fileD.md', '# Markdown file\nThis is a test.'],
    ]) {
      await fs.writeFile(path.join(tempRootDir, file), text);
    }
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it.each<[string, GrepToolParams]>([
      [
        'should return null for valid params (pattern only)',
        { pattern: 'hello' },
      ],
      [
        'should return null for valid params (pattern and path)',
        { pattern: 'hello', path: '.' },
      ],
      [
        'should return null for valid params (pattern, path, and glob)',
        { pattern: 'hello', path: '.', glob: '*.txt' },
      ],
      [
        'should return null for a positive integer limit',
        { pattern: 'hello', limit: 2 },
      ],
    ])('%s', (_title, params) => {
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it.each([
      [0, 'params/limit must be >= 1'],
      [-1, 'params/limit must be >= 1'],
      [1.5, 'params/limit must be integer'],
    ])('should return error for invalid limit %s', (limit, expectedError) => {
      const params: GrepToolParams = { pattern: 'hello', limit };
      expect(grepTool.validateToolParams(params)).toBe(expectedError);
    });

    it('should return error if pattern is missing', () => {
      const params = { path: '.' } as unknown as GrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should return error for invalid regex pattern', () => {
      expect(grepTool.validateToolParams({ pattern: '[[' })).toContain(
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
      expect(
        grepTool.validateToolParams({ pattern: 'hello', path: filePath }),
      ).toContain(`Path is not a directory: ${filePath}`);
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped path',
      async () => {
        // Create a directory with a space so the unescaped path exists
        const dirWithSpace = path.join(tempRootDir, 'sub dir');
        await fs.mkdir(dirWithSpace);
        const params: GrepToolParams = {
          pattern: 'hello',
          path: path.join(tempRootDir, 'sub\\ dir'),
        };
        expect(grepTool.validateToolParams(params)).toBeNull();
        expect(params.path).toBe(dirWithSpace);
      },
    );
  });

  describe('execute', () => {
    it('should find matches for a simple pattern in all files', async () => {
      const result = await run({ pattern: 'world' });
      expectContent(
        result,
        'Found 3 matches for pattern "world" in the workspace directory',
        'File: fileA.txt',
        'L1: hello world',
        'L2: second line with world',
        `File: ${path.join('sub', 'fileC.txt')}`,
        'L1: another world in sub dir',
      );
      expect(result.returnDisplay).toBe('Found 3 matches');
      const fileA = path.join(tempRootDir, 'fileA.txt');
      const fileC = path.join(tempRootDir, 'sub', 'fileC.txt');
      expect(result.resultFilePaths).toEqual([fileA, fileC]);

      for (const file of [fileA, fileC]) {
        const read = fileReadCache.check(await fs.stat(file));
        expect(read.state).toBe('fresh');
        if (read.state === 'fresh') {
          expect(read.entry.lastReadWasFull).toBe(false);
          expect(read.entry.lastReadCacheable).toBe(true);
        }
      }
    });

    // parseGrepOutput is private. A match is written as its expected
    // [filePath, line, lineNumber]; absoluteFilePath is derived from it.
    type Match = [string, string, number];
    const parse = (output: string) =>
      (
        grepTool.build({ pattern: 'world' }) as unknown as {
          parseGrepOutput: (output: string, basePath: string) => unknown[];
        }
      ).parseGrepOutput(output, tempRootDir);
    const matchOf = ([filePath, line, lineNumber]: Match) => ({
      absoluteFilePath: path.join(tempRootDir, filePath),
      filePath,
      line,
      lineNumber,
    });

    // These cases check only the first parsed match.
    it.each<[string, string, Match]>([
      [
        'normalizes CRLF fallback grep output without dropping result paths',
        'crlf.txt:1:hello world\r\n',
        ['crlf.txt', 'hello world', 1],
      ],
      [
        'parses plain grep output for paths containing colons',
        `${path.join('dir:name', 'file.txt')}:1:hello: world\n`,
        [path.join('dir:name', 'file.txt'), 'hello: world', 1],
      ],
      [
        'parses git grep -z output for paths containing colons',
        `${path.join('notes', '2026-06-19T09:20:00.txt')}\0${12}\0hello: world\n`,
        [path.join('notes', '2026-06-19T09:20:00.txt'), 'hello: world', 12],
      ],
      [
        'parses system grep --null output for paths containing colons',
        `${path.join('dir:123:file.txt')}\0${12}:hello: world\n`,
        [path.join('dir:123:file.txt'), 'hello: world', 12],
      ],
    ])('%s', (_title, output, first) => {
      expect(parse(output)[0]).toMatchObject(matchOf(first));
    });

    it.each<[string, string, Match[]]>([
      [
        'parses multiple git grep -z matches',
        `first.txt\0${1}\0hello world\nsecond.txt\0${2}\0world again\n`,
        [
          ['first.txt', 'hello world', 1],
          ['second.txt', 'world again', 2],
        ],
      ],
      [
        'parses git grep -z output without a trailing newline',
        `tail.txt\0${3}\0world at eof`,
        [['tail.txt', 'world at eof', 3]],
      ],
      [
        'skips unframed binary notices in git grep -z output',
        `Binary file binary.bin matches\nnormal.txt\0${7}\0hello world\n`,
        [['normal.txt', 'hello world', 7]],
      ],
      [
        'parses multiple system grep --null matches',
        `first.txt\0${1}:hello world\nsecond.txt\0${2}:world again\n`,
        [
          ['first.txt', 'hello world', 1],
          ['second.txt', 'world again', 2],
        ],
      ],
      [
        'parses system grep --null output without a trailing newline',
        `tail.txt\0${3}:world at eof`,
        [['tail.txt', 'world at eof', 3]],
      ],
      [
        'skips malformed system grep --null records and keeps following matches',
        `broken.txt\0missing-separator\nvalid.txt\0${4}:world after malformed\n`,
        [['valid.txt', 'world after malformed', 4]],
      ],
      [
        'skips unframed binary notices in system grep --null output',
        `Binary file ./binary.bin matches\nnormal.txt\0${7}:hello world\n`,
        [['normal.txt', 'hello world', 7]],
      ],
    ])('%s', (_title, output, expected) => {
      const matches = parse(output);
      expect(matches).toHaveLength(expected.length);
      expected.forEach((match, i) => {
        expect(matches[i]).toMatchObject(matchOf(match));
      });
    });

    it('includes result paths for partially rendered match lines', async () => {
      setThreshold(22);
      const partial = path.join(tempRootDir, 'partial.ts');
      await fs.writeFile(partial, 'partial marker');

      const result = await run({ pattern: 'marker', glob: '*.ts' });

      expect(result.returnDisplay).toContain('truncated');
      expect(result.resultFilePaths).toEqual([partial]);
    });

    it('only reports result paths for matches visible before character truncation', async () => {
      setThreshold(30);
      const allResultPaths = [
        path.join(tempRootDir, 'a.ts'),
        path.join(tempRootDir, 'z.ts'),
      ];
      await fs.writeFile(allResultPaths[0], 'visible marker');
      await fs.writeFile(allResultPaths[1], 'hidden marker');

      const result = await run({ pattern: 'marker', glob: '*.ts' });

      expect(result.returnDisplay).toContain('truncated');
      expect(result.resultFilePaths?.length).toBeLessThan(
        allResultPaths.length,
      );
      for (const resultPath of result.resultFilePaths ?? []) {
        expect(allResultPaths).toContain(resultPath);
      }
    });

    it('declares its raw size unknown once it bounds its own output', async () => {
      // The scheduler measures an undeclared producer body itself. A bounded
      // render must not be offered as its own pre-reduction size (#13652 R2-5).
      const whole = await run({ pattern: 'world' });
      expect(whole.llmContent).not.toContain('truncated');
      expect(whole.rawOutputSize).toBeUndefined();

      const bounded = await run({ pattern: 'world', limit: 1 });
      expect(bounded.llmContent).toContain('truncated');
      expect(bounded.rawOutputSize).toBeNull();
      expect(bounded.truncatedByProducer).toBe(true);
      expect(whole.truncatedByProducer).toBeUndefined();
    });

    it('should find matches in a specific path', async () => {
      const result = await run({ pattern: 'world', path: 'sub' });
      expectContent(
        result,
        'Found 1 match for pattern "world" in path "sub"',
        'File: fileC.txt', // Path relative to 'sub'
        'L1: another world in sub dir',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with a glob filter', async () => {
      const result = await run({ pattern: 'hello', glob: '*.js' });
      expectContent(
        result,
        'Found 1 match for pattern "hello" in the workspace directory (filter: "*.js"):',
        'File: fileB.js',
        'L2: function baz() { return "hello"; }',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with a glob filter and path', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'sub', 'another.js'),
        'const greeting = "hello";',
      );
      const result = await run({ pattern: 'hello', path: 'sub', glob: '*.js' });
      expectContent(
        result,
        'Found 1 match for pattern "hello" in path "sub" (filter: "*.js")',
        'File: another.js',
        'L1: const greeting = "hello";',
      );
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should return "No matches found" when pattern does not exist', async () => {
      const result = await run({ pattern: 'nonexistentpattern' });
      expectContent(
        result,
        'No matches found for pattern "nonexistentpattern" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle regex special characters correctly', async () => {
      // Matches 'const foo = "bar";'
      expectContent(
        await run({ pattern: 'foo.*bar' }),
        'Found 1 match for pattern "foo.*bar" in the workspace directory:',
        'File: fileB.js',
        'L1: const foo = "bar";',
      );
    });

    it('should be case-insensitive by default (JS fallback)', async () => {
      expectContent(
        await run({ pattern: 'HELLO' }),
        'Found 2 matches for pattern "HELLO" in the workspace directory:',
        'File: fileA.txt',
        'L1: hello world',
        'File: fileB.js',
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
      const result = await run({ pattern: 'hello' });
      expect(result.error?.type).toBe(ToolErrorType.GREP_EXECUTION_ERROR);
      vi.mocked(glob.globStream).mockReset();
    });
  });

  describe('multi-directory workspace', () => {
    it('should search across all workspace directories when no path is specified', async () => {
      // Despite the title, with no path the search covers only the target
      // directory (first workspace directory), not every workspace directory.
      expectContent(
        await run({ pattern: 'world' }),
        'Found 3 matches for pattern "world" in the workspace directory',
        'fileA.txt',
        'L1: hello world',
        'L2: second line with world',
        'fileC.txt',
        'L1: another world in sub dir',
      );
    });

    it('should search only specified path within workspace directories', async () => {
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.mkdir(path.join(secondDir, 'sub'));
      await fs.writeFile(
        path.join(secondDir, 'sub', 'test.txt'),
        'hello from second sub directory',
      );

      // Search only in the 'sub' directory of the first workspace
      const result = await run(
        { pattern: 'world', path: 'sub' },
        multiDirTool([secondDir]),
      );

      expectContent(
        result,
        'Found 1 match for pattern "world" in path "sub"',
        'File: fileC.txt',
        'L1: another world in sub dir',
      );
      // Should not contain matches from second directory
      expect(result.llmContent).not.toContain('test.txt');

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should convert relative paths to absolute when searching multiple directories', async () => {
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-second-'),
      );
      await fs.writeFile(
        path.join(secondDir, 'extra.txt'),
        'world content in second dir',
      );

      // Paths from both directories are absolute.
      expectContent(
        await run({ pattern: 'world' }, multiDirTool([secondDir])),
        'across 2 workspace directories',
        `File: ${path.resolve(secondDir, 'extra.txt')}`,
        `File: ${path.resolve(tempRootDir, 'fileA.txt')}`,
      );

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should deduplicate matches from overlapping workspace directories', async () => {
      // Overlapping workspace dirs (parent + child) must list each file once.
      // 'sub dir' exists only in sub/fileC.txt, which lives under both
      // tempRootDir and subDir, so without deduplication it would appear twice.
      const subDir = path.join(tempRootDir, 'sub');
      const result = await run({ pattern: 'sub dir' }, multiDirTool([subDir]));
      expect(result.llmContent).toContain('Found 1 match');
    });
  });

  describe('search binary arguments', () => {
    // The pattern reaches git grep and system grep as an argv entry, so a
    // pattern that begins with a dash is indistinguishable from an option
    // unless it is introduced by `-e`. `validateToolParams` accepts it --
    // `new RegExp('-n')` is a perfectly good regex -- so the tool has to be the
    // one to disambiguate it.
    const argsFor = (bin: string): string[][] =>
      vi
        .mocked(spawn)
        .mock.calls.filter((call) => call[0] === bin)
        .map((call) => call[1] as string[]);

    // True only when `b` directly follows `a`, which is what distinguishes the
    // pattern from the identically-spelled `-n` flag git grep already passes.
    const hasAdjacent = (args: string[], a: string, b: string): boolean =>
      args.some((value, i) => value === a && args[i + 1] === b);

    const expectDashGuard = (bin: string) => async (pattern: string) => {
      await grepTool.build({ pattern }).execute(abortSignal);

      // git is also spawned for `ls-files` (fallback corpus); only grep
      // subcommand invocations carry the search pattern.
      const calls = argsFor(bin).filter(
        (args) => bin !== 'git' || args[4] === 'grep',
      );
      expect(calls).not.toHaveLength(0);
      for (const args of calls) {
        expect(hasAdjacent(args, '-e', pattern)).toBe(true);
      }
    };

    beforeEach(async () => {
      vi.mocked(spawn).mockClear();
      // isGitRepository only looks for a .git entry, so this is enough to make
      // the git grep strategy run before the system grep fallback.
      await fs.mkdir(path.join(tempRootDir, '.git'), { recursive: true });
    });

    it.each([['-n'], ['-i'], ['--color']])(
      'introduces the pattern "%s" with -e for git grep',
      expectDashGuard('git'),
    );

    it.skipIf(process.platform === 'win32').each([['-n'], ['-i'], ['--color']])(
      'introduces the pattern "%s" with -e for system grep',
      expectDashGuard('grep'),
    );

    // Guards against over-correcting: the surrounding argv has to keep its
    // shape. These assertions hold both before and after the fix.
    it('leaves the rest of the argument list unchanged', async () => {
      await grepTool
        .build({ pattern: 'world', glob: '*.ts' })
        .execute(abortSignal);

      for (const args of argsFor('git').filter((a) => a[4] === 'grep')) {
        // Git only reads `-c` before the subcommand, so the guard has to stay
        // ahead of it.
        expect(args.slice(0, 5)).toEqual([
          '-c',
          'core.fsmonitor=',
          '-c',
          'log.showSignature=false',
          'grep',
        ]);
        expect(args).toEqual(
          expect.arrayContaining(['--untracked', '-z', '-E']),
        );
        // The glob stays a pathspec, behind the `--` separator.
        expect(hasAdjacent(args, '--', '*.ts')).toBe(true);
      }
      for (const args of argsFor('grep')) {
        expect(args).toEqual(
          expect.arrayContaining(['-r', '-n', '-H', '-E', '--null']),
        );
        expect(args).toContain('--include=*.ts');
        // The search path stays the final operand.
        expect(args[args.length - 1]).toBe('.');
      }
    });

    it('scopes the system-grep fallback to the git-aware corpus', async () => {
      const okChild = (out: string, code: number) =>
        ({
          on: (event: string, cb: (...a: unknown[]) => void) => {
            if (event === 'close') setTimeout(() => cb(code), 0);
          },
          removeListener: () => {},
          stdout: {
            on: (event: string, cb: (c: Buffer) => void) => {
              if (event === 'data') setTimeout(() => cb(Buffer.from(out)), 0);
            },
          },
          stderr: { on: () => {} },
          kill: () => {},
          connected: false,
          disconnect: () => {},
        }) as unknown as ReturnType<typeof spawn>;
      const previousSpawnImpl = vi.mocked(spawn).getMockImplementation();
      vi.mocked(spawn).mockImplementation(
        (cmd: string, args: readonly string[]) => {
          if (cmd === 'git' && args[4] === 'ls-files') {
            // the corpus is lstat-filtered, so the entry has to be a real file
            return okChild('fileA.txt' + '\0', 0);
          }
          // git grep errors out so the fallback strategies run
          if (cmd === 'git') return okChild('', 2);
          if (cmd === 'grep') {
            return okChild('fileA.txt' + '\0' + '1:hello world\n', 0);
          }
          return okChild('', 2);
        },
      );

      try {
        const result = await grepTool
          .build({ pattern: 'hello' })
          .execute(abortSignal);

        const gitCalls = argsFor('git');
        const lsFiles = gitCalls.find((a) => a[4] === 'ls-files');
        expect(lsFiles).toEqual(
          expect.arrayContaining([
            '--cached',
            '--others',
            '--exclude-standard',
          ]),
        );
        const grepCalls = argsFor('grep');
        expect(grepCalls).not.toHaveLength(0);
        for (const args of grepCalls) {
          // explicit corpus, not a recursive walk over ignored build output
          expect(args).not.toContain('-r');
          expect(args).toContain('fileA.txt');
          expect(hasAdjacent(args, '-e', 'hello')).toBe(true);
        }
        expect(result.llmContent).toContain('Found 1 match');
      } finally {
        // the override must not leak into later describes
        if (previousSpawnImpl) {
          vi.mocked(spawn).mockImplementation(previousSpawnImpl);
        }
      }
    });
  });

  // Each test here pins one way the scoped corpus can fail without the search
  // noticing: a child that rejects, a child that never settles, an operand grep
  // resolves outside the search root, and a corpus entry whose spelling
  // diverges from the one the filesystem walk reports.
  describe('fallback corpus failures', () => {
    const spawnMock = vi.mocked(spawn);
    let previousSpawnImpl: ReturnType<typeof spawnMock.getMockImplementation>;
    let realSpawn: typeof spawn;
    // Per fake child: did anything attach a reader to its stderr? An unread
    // pipe is what blocks the child forever.
    let stderrDrained: boolean[];

    const fakeChild = (out: string, code: number, err = '') => {
      stderrDrained.push(false);
      const index = stderrDrained.length - 1;
      return {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'close') setTimeout(() => cb(code), 0);
        },
        removeListener: () => {},
        stdout: {
          on: (event: string, cb: (c: Buffer) => void) => {
            if (event === 'data') setTimeout(() => cb(Buffer.from(out)), 0);
          },
        },
        stderr: {
          on: (event: string, cb: (c: Buffer) => void) => {
            if (event !== 'data') return;
            stderrDrained[index] = true;
            if (err) setTimeout(() => cb(Buffer.from(err)), 0);
          },
        },
        kill: () => {},
        connected: false,
        disconnect: () => {},
      } as unknown as ReturnType<typeof spawn>;
    };

    // `git grep` fails so the fallbacks run and `git ls-files` reports `corpus`.
    // `grep` then either really runs, fails the way an unsupported pattern does,
    // or exits 2 after printing a match with only tolerated diagnostics.
    const stubGit = (
      corpus: string[],
      { grep = 'real' }: { grep?: 'real' | 'fail' | 'benign' } = {},
    ) => {
      spawnMock.mockImplementation(
        (cmd: string, args: readonly string[], options?: unknown) => {
          if (cmd === 'git' && args[4] === 'ls-files') {
            return fakeChild(corpus.map((f) => `${f}\0`).join(''), 0);
          }
          if (cmd === 'git') return fakeChild('', 2);
          if (grep === 'fail') {
            return fakeChild(
              '',
              2,
              'grep: repetition-operator operand invalid',
            );
          }
          if (grep === 'benign') {
            return fakeChild(
              'fileA.txt' + '\0' + '1:hello world\n',
              2,
              'grep: gone.txt: Is a directory',
            );
          }
          return realSpawn(
            cmd,
            args,
            options as Parameters<typeof realSpawn>[2],
          );
        },
      );
    };

    const grepArgv = (): string[][] =>
      spawnMock.mock.calls
        .filter((call) => call[0] === 'grep')
        .map((call) => call[1] as string[]);

    beforeEach(async () => {
      previousSpawnImpl = spawnMock.getMockImplementation();
      spawnMock.mockClear();
      stderrDrained = [];
      realSpawn = (
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        )
      ).spawn;
      // isGitRepository only looks for a .git entry
      await fs.mkdir(path.join(tempRootDir, '.git'), { recursive: true });
    });

    afterEach(() => {
      if (previousSpawnImpl) spawnMock.mockImplementation(previousSpawnImpl);
    });

    it.skipIf(process.platform === 'win32')(
      'recovers into the JavaScript strategy when the scoped grep rejects a pattern',
      async () => {
        stubGit(['fileA.txt']);

        // grep -E rejects the lookahead; the JavaScript strategy accepts it.
        const result = await grepTool
          .build({ pattern: '(?=world)' })
          .execute(abortSignal);

        expect(result.llmContent).toContain('fileA.txt');
      },
    );

    // Root reads mode-000 files, so there would be no stderr to overflow.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'settles when grep writes more than a pipe of stderr',
      async () => {
        const dir = path.join(tempRootDir, 'unreadable');
        await fs.mkdir(dir);
        // One diagnostic per operand, ~133 bytes each: 1500 of them fill a
        // batch of the argument budget with ~160KB of stderr, which is over the
        // pipe capacity on both Linux (64KB) and macOS (128KB).
        const longName = 'u'.repeat(90);
        const corpus: string[] = [];
        await Promise.all(
          Array.from({ length: 1500 }, async (_, i) => {
            const rel = path.join('unreadable', `${i}-${longName}.txt`);
            const abs = path.join(tempRootDir, rel);
            await fs.writeFile(abs, 'needle\n');
            await fs.chmod(abs, 0o000);
            corpus.push(rel);
          }),
        );
        stubGit(corpus);

        const settled = await Promise.race([
          grepTool
            .build({ pattern: 'needle' })
            .execute(abortSignal)
            .then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 10_000),
          ),
        ]);

        expect(settled).toBe(true);
      },
      30_000,
    );

    it.skipIf(process.platform === 'win32')(
      'does not search through a symlink the corpus lists',
      async () => {
        const outside = await fs.mkdtemp(
          path.join(os.tmpdir(), 'grep-corpus-outside-'),
        );
        try {
          await fs.writeFile(
            path.join(outside, 'secret.txt'),
            'leaked-target-content',
          );
          await fs.symlink(
            path.join(outside, 'secret.txt'),
            path.join(tempRootDir, 'allowed-link.txt'),
          );
          stubGit(['allowed-link.txt']);

          const result = await grepTool
            .build({ pattern: 'leaked-target' })
            .execute(abortSignal);

          // The no-match message echoes the pattern, so assert on the target's
          // content, which only a dereferenced symlink could surface.
          expect(result.llmContent).not.toContain('leaked-target-content');
          expect(grepArgv().flat()).not.toContain('allowed-link.txt');
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      },
    );

    it('searches a case-divergent corpus entry only where the filesystem folds case', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'needle.txt'),
        'case-divergent-content',
      );
      // `fileA.txt` keeps the corpus non-empty on a case-sensitive filesystem,
      // where `Needle.txt` resolves to nothing and is dropped.
      stubGit(['fileA.txt', 'Needle.txt'], { grep: 'fail' });

      const result = await grepTool
        .build({ pattern: 'case-divergent' })
        .execute(abortSignal);

      // The no-match message echoes the pattern, so assert on the file content,
      // which only appears if the divergent entry was actually searched.
      if (process.platform === 'darwin' || process.platform === 'win32') {
        // git reports the index spelling while the walk reports the on-disk one,
        // and `--others` lists only the first because git treats them as one file.
        expect(result.llmContent).toContain('case-divergent-content');
      } else {
        // The spellings are distinct paths here, so an entry git did not list
        // must stay outside the corpus.
        expect(result.llmContent).not.toContain('case-divergent-content');
      }
    });

    it('keeps the matches grep printed when it exits 2 on tolerated diagnostics', async () => {
      stubGit(['fileA.txt'], { grep: 'benign' });

      // Nothing on disk matches this pattern, so a result at all proves the
      // batch was resolved with the stdout grep produced instead of rejected.
      const result = await grepTool
        .build({ pattern: 'absent-from-disk' })
        .execute(abortSignal);

      expect(result.llmContent).toContain('hello world');
      expect(result.llmContent).not.toContain('No matches found');
    });

    it('attaches a stderr reader to every child it spawns', async () => {
      stubGit(['fileA.txt']);

      await grepTool.build({ pattern: 'hello' }).execute(abortSignal);

      expect(stderrDrained).not.toHaveLength(0);
      expect(stderrDrained).not.toContain(false);
    });

    it('searches the corpus case-insensitively, as the tool description promises', async () => {
      stubGit(['fileA.txt']);

      const result = await grepTool
        .build({ pattern: 'HELLO WORLD' })
        .execute(abortSignal);

      const argv = grepArgv();
      expect(argv).not.toHaveLength(0);
      for (const args of argv) {
        expect(args).toContain('--ignore-case');
      }
      expect(result.llmContent).toContain('hello world');
    });

    it('drops excluded directories from the corpus, which --exclude-dir cannot', async () => {
      const previousExclusions = mockConfig.getFileExclusions;
      Object.assign(mockConfig, {
        getFileExclusions: () => ({
          getGlobExcludes: () => ['**/node_modules/**'],
        }),
      });
      try {
        await fs.mkdir(path.join(tempRootDir, 'node_modules'));
        await fs.writeFile(
          path.join(tempRootDir, 'node_modules', 'dep.js'),
          'needle',
        );
        stubGit(['node_modules/dep.js', 'fileA.txt']);

        await grepTool.build({ pattern: 'needle' }).execute(abortSignal);

        const argv = grepArgv();
        expect(argv).not.toHaveLength(0);
        for (const args of argv) {
          expect(args).not.toContain('node_modules/dep.js');
          expect(args).toContain('fileA.txt');
        }
      } finally {
        Object.assign(mockConfig, {
          getFileExclusions: previousExclusions,
        });
      }
    });

    it('passes the glob to the corpus branch as --include and never as -r', async () => {
      stubGit(['fileA.txt', 'fileB.js']);

      await grepTool
        .build({ pattern: 'hello', glob: '*.txt' })
        .execute(abortSignal);

      const argv = grepArgv();
      expect(argv).not.toHaveLength(0);
      for (const args of argv) {
        expect(args).toContain('--include=*.txt');
        expect(args).not.toContain('-r');
      }
    });

    it('batches the corpus over the argument budget and merges the matches', async () => {
      const dir = path.join(tempRootDir, 'batch');
      await fs.mkdir(dir);
      // 600 operands of ~255 bytes exceed the 128KiB budget, so this needs two
      // grep runs and has to merge what they return.
      const longName = 'u'.repeat(240);
      const corpus: string[] = [];
      await Promise.all(
        Array.from({ length: 600 }, async (_, i) => {
          const rel = path.join('batch', `${i}-${longName}.txt`);
          await fs.writeFile(path.join(tempRootDir, rel), 'needle');
          corpus.push(rel);
        }),
      );
      stubGit(corpus, { grep: 'benign' });

      const result = await grepTool
        .build({ pattern: 'needle' })
        .execute(abortSignal);

      expect(grepArgv().length).toBeGreaterThan(1);
      expect(result.llmContent).toContain('hello world');
    });

    it('excludes from the JavaScript strategy what the corpus does not list', async () => {
      await fs.writeFile(
        path.join(tempRootDir, 'not-in-corpus.txt'),
        'corpus-only-needle',
      );
      stubGit(['fileA.txt'], { grep: 'fail' });

      const result = await grepTool
        .build({ pattern: 'corpus-only-needle' })
        .execute(abortSignal);

      expect(result.llmContent).not.toContain('not-in-corpus.txt');
      expect(result.llmContent).toContain('No matches found');
    });

    it('reports an abort instead of falling back to the recursive walk', async () => {
      const controller = new AbortController();
      controller.abort();
      stubGit(['fileA.txt']);

      const result = await grepTool
        .build({ pattern: 'hello' })
        .execute(controller.signal);

      expect(grepArgv()).toHaveLength(0);
      // The corpus lookup is the first thing strategy 2 does, so a spawn here
      // means the cancellation was swallowed instead of propagated.
      expect(
        spawnMock.mock.calls.filter(
          (call) =>
            call[0] === 'git' && (call[1] as string[])[4] === 'ls-files',
        ),
      ).toHaveLength(0);
      expect(String(result.llmContent)).toMatch(/abort/i);
    });
  });

  describe('getDescription', () => {
    const describeParams = (params: GrepToolParams) =>
      grepTool.build(params).getDescription();
    const srcApp = path.join('src', 'app');

    it.each<[string, GrepToolParams, string]>([
      [
        'should generate correct description with pattern only',
        { pattern: 'testPattern' },
        "'testPattern' in .",
      ],
      [
        'should generate correct description with pattern and glob',
        { pattern: 'testPattern', glob: '*.ts' },
        "'testPattern' in . (filter: '*.ts')",
      ],
      [
        'should indicate searching workspace directory when no path specified',
        { pattern: 'testPattern' },
        "'testPattern' in .",
      ],
      [
        'should use . for root path in description',
        { pattern: 'testPattern', path: '.' },
        "'testPattern' in .",
      ],
    ])('%s', (_title, params, expected) => {
      expect(describeParams(params)).toBe(expected);
    });

    it.each<[string, string | undefined, string]>([
      [
        'should generate correct description with pattern and path',
        undefined,
        `'testPattern' in ${srcApp}`,
      ],
      [
        'should generate correct description with pattern, glob, and path',
        '*.ts',
        `'testPattern' in ${srcApp} (filter: '*.ts')`,
      ],
    ])('%s', async (_title, filter, expected) => {
      await fs.mkdir(path.join(tempRootDir, srcApp), { recursive: true });
      const params: GrepToolParams = { pattern: 'testPattern', path: srcApp };
      if (filter) params.glob = filter;
      expect(describeParams(params)).toBe(expected);
    });

    it('should keep paths outside the project absolute (never project-relative)', () => {
      const outside = path.resolve(os.tmpdir());
      expect(describeParams({ pattern: 'testPattern', path: outside })).toBe(
        `'testPattern' in ${tildeifyPath(outside)}`,
      );
    });
  });

  describe('getDefaultPermission', () => {
    it.each([
      ['should return allow for paths within workspace', 'sub', 'allow'],
      [
        'should return ask for tilde paths outside workspace',
        '~/outside-workspace',
        'ask',
      ],
    ])('%s', async (_title, dir, expected) => {
      const invocation = grepTool.build({ pattern: 'hello', path: dir });
      expect(await invocation.getDefaultPermission()).toBe(expected);
    });
  });

  describe('Result limiting', () => {
    beforeEach(async () => {
      // Create many test files with matches to test limiting
      for (let i = 1; i <= 30; i++) {
        await fs.writeFile(
          path.join(tempRootDir, `test${i}.txt`),
          `This is test file ${i} with the pattern testword in it.`,
        );
      }
    });

    // No limit shows every match; a limit above the match count truncates nothing.
    it.each<[string, number | undefined]>([
      ['should show all results when no limit is specified', undefined],
      ['should not show truncation warning when all results fit', 50],
    ])('%s', async (_title, limit) => {
      const params: GrepToolParams = { pattern: 'testword' };
      if (limit !== undefined) params.limit = limit;
      const result = await run(params);

      expect(result.llmContent).toContain('Found 30 matches');
      expect(result.llmContent).not.toContain('truncated');
      expect(result.returnDisplay).toBe('Found 30 matches');
    });

    it('should respect custom limit parameter', async () => {
      const result = await run({ pattern: 'testword', limit: 5 });

      // Should find 30 total but limit to 5
      expect(result.llmContent).toContain('Found 30 matches');
      expect(result.llmContent).toContain('25 lines truncated');
      expect(result.returnDisplay).toContain('Found 30 matches (truncated)');
    });

    it('should validate a positive limit parameter', () => {
      expect(
        grepTool.validateToolParams({ pattern: 'test', limit: 5 }),
      ).toBeNull();
    });

    it('should accept valid limit parameter', () => {
      for (const limit of [1, 50, 100]) {
        expect(
          grepTool.validateToolParams({ pattern: 'test', limit }),
        ).toBeNull();
      }
    });
  });
});
