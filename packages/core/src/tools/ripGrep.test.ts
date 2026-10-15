/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import type { RipGrepToolParams } from './ripGrep.js';
import { _resetRipGrepCachesForTest, RipGrepTool } from './ripGrep.js';
import path from 'node:path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os, { EOL } from 'node:os';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { tildeifyPath } from '../utils/paths.js';
import { spawn } from 'node:child_process';
import { runRipgrep } from '../utils/ripgrepUtils.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../utils/file-filtering-options.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { logRipgrepRuntimeRecovery } from '../telemetry/loggers.js';
import type { ToolResult } from './tools.js';

// Mock ripgrepUtils
vi.mock('../utils/ripgrepUtils.js', () => ({
  runRipgrep: vi.fn(),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logRipgrepRuntimeRecovery: vi.fn(),
}));

// Mock child_process for ripgrep calls
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);
const rg = runRipgrep as Mock;
const INCOMPLETE_NOTE =
  '[Search did not complete: the results above may not include all matches.]';

function expectLlm(result: ToolResult, has: string[], lacks: string[] = []) {
  for (const s of has) expect(result.llmContent).toContain(s);
  for (const s of lacks) expect(result.llmContent).not.toContain(s);
}

describe('RipGrepTool', () => {
  let tempRootDir: string;
  let grepTool: RipGrepTool;
  let fileExclusionsMock: { getGlobExcludes: () => string[] };
  let fileReadCache: FileReadCache;
  const abortSignal = new AbortController().signal;
  const sep = '\x1f';

  const mockConfig = {
    getTargetDir: () => tempRootDir,
    getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
    getWorkingDir: () => tempRootDir,
    getDebugMode: () => false,
    getUseBuiltinRipgrep: () => true,
    getUsageStatisticsEnabled: () => false,
    getTruncateToolOutputThreshold: () => 25000,
    getTruncateToolOutputLines: () => 1000,
  } as unknown as Config;

  /** One match line in the separator format the tool parses. */
  const hit = (file: string, line: number, text: string) =>
    `${file}${sep}${line}${sep}${text}${EOL}`;
  const jsonLine = (event: object) => `${JSON.stringify(event)}${EOL}`;
  /** Plain ripgrep result: not truncated, no error unless `extra` overrides. */
  const rgReturns = (stdout: string, extra: object = {}) =>
    rg.mockResolvedValue({
      stdout,
      truncated: false,
      error: undefined,
      ...extra,
    });
  /** Result with runtime-recovery details; an `error` marks it incomplete. */
  const rgRecovered = (stdout: string, recovery: object, error?: Error) =>
    rg.mockResolvedValue(
      error
        ? { stdout, incomplete: true, error, recovery }
        : { stdout, incomplete: false, recovery },
    );
  const search = (params: RipGrepToolParams, tool = grepTool) =>
    tool.build(params).execute(abortSignal);
  const searchWith = (
    stdout: string,
    params: RipGrepToolParams,
    tool = grepTool,
  ) => {
    rgReturns(stdout);
    return search(params, tool);
  };
  const write = (rel: string, content: string) =>
    fs.writeFile(path.join(tempRootDir, rel), content);
  /** `--ignore-file` values in `rgArgs` (default: the first ripgrep call). */
  const ignoreFileArgs = (rgArgs: string[] = rg.mock.calls[0][0]) =>
    rgArgs.filter((_, i) => i > 0 && rgArgs[i - 1] === '--ignore-file');
  const setFiltering = (options: object) =>
    Object.assign(mockConfig, {
      getFileFilteringOptions: () => ({ ...options }),
    });
  const withCustomIgnores = (...customIgnoreFiles: string[]) =>
    setFiltering({
      respectGitIgnore: true,
      respectQwenIgnore: true,
      customIgnoreFiles,
    });
  const multiDirTool = (...dirs: string[]) =>
    new RipGrepTool({
      ...mockConfig,
      getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir, dirs),
    } as unknown as Config);
  const makeSecondDir = () =>
    fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-second-'));

  /** Only `kept` survives filtering API_KEY hits in `dropped` then `kept`. */
  async function expectOnlyKept(
    kept: string,
    dropped: string,
    tool = grepTool,
  ) {
    const result = await searchWith(
      hit(dropped, 1, 'API_KEY=1') + hit(kept, 1, 'API_KEY=2'),
      { pattern: 'API_KEY' },
      tool,
    );
    expectLlm(result, ['Found 1 match', `${kept}:1:API_KEY=2`], [dropped]);
    expect(result.returnDisplay).toBe('Found 1 match');
    expect(result.resultFilePaths).toEqual([path.join(tempRootDir, kept)]);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(logRipgrepRuntimeRecovery).mockReset();
    mockSpawn.mockReset();
    _resetRipGrepCachesForTest();
    Object.assign(mockConfig, {
      getTruncateToolOutputThreshold: () => 25000,
    });
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-root-'));
    fileExclusionsMock = {
      getGlobExcludes: vi.fn().mockReturnValue([]),
    };
    fileReadCache = new FileReadCache();
    Object.assign(mockConfig, {
      getFileExclusions: () => fileExclusionsMock,
      getFileFilteringOptions: () => DEFAULT_FILE_FILTERING_OPTIONS,
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: () => false,
    });
    grepTool = new RipGrepTool(mockConfig);

    // Create some test files and directories
    await write('fileA.txt', 'hello world\nsecond line with world');
    await write(
      'fileB.js',
      'const foo = "bar";\nfunction baz() { return "hello"; }',
    );
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await write('sub/fileC.txt', 'another world in sub dir');
    await write('sub/fileD.md', '# Markdown file\nThis is a test.');
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('validateToolParams', () => {
    it.each([
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
    ])('%s', (_title, params: RipGrepToolParams) => {
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it.each([
      [0, 'params/limit must be >= 1'],
      [-1, 'params/limit must be >= 1'],
      [1.5, 'params/limit must be integer'],
    ])('should return error for invalid limit %s', (limit, expectedError) => {
      const params: RipGrepToolParams = { pattern: 'hello', limit };
      expect(grepTool.validateToolParams(params)).toBe(expectedError);
    });

    it('should return error if pattern is missing', () => {
      const params = { path: '.' } as unknown as RipGrepToolParams;
      expect(grepTool.validateToolParams(params)).toBe(
        `params must have required property 'pattern'`,
      );
    });

    it('should surface an error for invalid regex pattern', () => {
      expect(grepTool.validateToolParams({ pattern: '[[' })).toContain(
        'Invalid regular expression pattern: [[',
      );
    });

    it('should return error if path does not exist', () => {
      const params = { pattern: 'hello', path: 'nonexistent' };
      // Check for the core error message, as the full path might vary
      expect(grepTool.validateToolParams(params)).toContain(
        'Path does not exist:',
      );
      expect(grepTool.validateToolParams(params)).toContain('nonexistent');
    });

    it('should allow path to be a file', () => {
      const filePath = path.join(tempRootDir, 'fileA.txt');
      const params: RipGrepToolParams = { pattern: 'hello', path: filePath };
      expect(grepTool.validateToolParams(params)).toBeNull();
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped path',
      async () => {
        // Create a directory with a space so the unescaped path exists
        const dirWithSpace = path.join(tempRootDir, 'sub dir');
        await fs.mkdir(dirWithSpace);
        const params: RipGrepToolParams = {
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
      const result = await searchWith(
        hit('fileA.txt', 1, 'hello world') +
          hit('fileA.txt', 2, 'second line with world') +
          hit('sub/fileC.txt', 1, 'another world in sub dir'),
        { pattern: 'world' },
      );
      expectLlm(result, [
        'Found 3 matches for pattern "world" in the workspace directory',
        'fileA.txt:1:hello world',
        'fileA.txt:2:second line with world',
        'sub/fileC.txt:1:another world in sub dir',
      ]);
      expect(result.returnDisplay).toBe('Found 3 matches');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, 'fileA.txt'),
        path.join(tempRootDir, 'sub/fileC.txt'),
      ]);

      for (const rel of ['fileA.txt', 'sub/fileC.txt']) {
        const read = fileReadCache.check(
          await fs.stat(path.join(tempRootDir, rel)),
        );
        expect(read.state).toBe('fresh');
        if (read.state === 'fresh') {
          expect(read.entry.lastReadWasFull).toBe(false);
          expect(read.entry.lastReadCacheable).toBe(true);
        }
      }
    });

    it('should treat summary-only JSON output as no matches', async () => {
      const result = await searchWith(
        jsonLine({ type: 'summary', data: { stats: { matches: 0 } } }),
        { pattern: 'missing' },
      );

      expect(result.llmContent).toBe(
        'No matches found for pattern "missing" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('parses JSON match events and records result paths', async () => {
      const result = await searchWith(
        jsonLine({
          type: 'match',
          data: {
            path: { text: 'src/foo.ts' },
            lines: { text: 'content\n' },
            line_number: 5,
          },
        }),
        { pattern: 'content' },
      );

      expect(result.llmContent).toContain('src/foo.ts:5:content');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, 'src/foo.ts'),
      ]);
    });

    it('parses JSON match events with byte-encoded paths', async () => {
      const bytePath = 'src/byte-path.ts';
      const bytes = Buffer.from(bytePath, 'utf8').toString('base64');
      const result = await searchWith(
        jsonLine({
          type: 'match',
          data: {
            path: { bytes },
            lines: { text: 'content\n' },
            line_number: 3,
          },
        }),
        { pattern: 'content' },
      );

      expect(result.llmContent).toContain('src/byte-path.ts:3:content');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, bytePath),
      ]);
    });

    it('handles JSON match events without a lines field', async () => {
      const result = await searchWith(
        jsonLine({
          type: 'match',
          data: { path: { text: 'fileA.txt' }, line_number: 1 },
        }),
        { pattern: 'hello' },
      );

      expect(result.llmContent).toContain('fileA.txt:1:');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, 'fileA.txt'),
      ]);
    });

    it('surfaces incomplete ripgrep execution without reporting display truncation', async () => {
      rgRecovered(
        hit('fileA.txt', 1, 'hello world'),
        {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'max_buffer',
        },
        new Error('stdout maxBuffer length exceeded'),
      );

      const result = await search({ pattern: 'hello' });

      expect(result.returnDisplay).toBe('Found 1 match (incomplete)');
      expectLlm(result, [INCOMPLETE_NOTE], ['lines truncated']);
    });

    it('logs runtime recovery telemetry after a successful EAGAIN retry', async () => {
      rgRecovered(hit('fileA.txt', 1, 'hello world'), {
        selectionMode: 'builtin',
        retryTriggered: true,
        retrySucceeded: true,
        failureKind: 'eagain',
      });

      const result = await search({ pattern: 'hello' });

      expect(result.returnDisplay).toBe('Found 1 match');
      expect(logRipgrepRuntimeRecovery).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          selection_mode: 'builtin',
          retry_triggered: true,
          retry_succeeded: true,
          failure_kind: 'eagain',
        }),
      );
    });

    it('does not emit telemetry for a clean successful search', async () => {
      rgRecovered(hit('fileA.txt', 1, 'hello world'), {
        selectionMode: 'builtin',
        retryTriggered: false,
      });

      const result = await search({ pattern: 'hello' });

      expect(result.returnDisplay).toBe('Found 1 match');
      expect(logRipgrepRuntimeRecovery).not.toHaveBeenCalled();
    });

    it('logs runtime recovery telemetry for a non-retry timeout failure', async () => {
      rgRecovered(
        hit('fileA.txt', 1, 'hello world'),
        {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'timeout',
        },
        new Error('Command timed out'),
      );

      await search({ pattern: 'hello' });

      expect(logRipgrepRuntimeRecovery).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          selection_mode: 'builtin',
          retry_triggered: false,
          failure_kind: 'timeout',
        }),
      );
    });

    it('does not report incomplete unparseable output as no matches', async () => {
      rgRecovered(
        '{"type":"match"',
        {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'exit',
        },
        new Error('ripgrep exited before JSON completed'),
      );

      const result = await search({ pattern: 'hello' });

      expect(result.returnDisplay).toBe('Error: Search incomplete');
      expectLlm(
        result,
        ['No valid matches were returned; do not treat this as no matches.'],
        ['No matches found'],
      );
    });

    it('can show display truncation and incomplete execution together', async () => {
      Object.assign(mockConfig, { getTruncateToolOutputThreshold: () => 30 });
      rgRecovered(
        hit('fileA.txt', 1, 'hello world') + hit('fileB.js', 1, 'hello again'),
        {
          selectionMode: 'system',
          retryTriggered: false,
          failureKind: 'timeout',
        },
        new Error('Command timed out'),
      );

      const result = await search({ pattern: 'hello' });

      expect(result.returnDisplay).toBe(
        'Found 2 matches (truncated, incomplete)',
      );
      expectLlm(result, ['line truncated', INCOMPLETE_NOTE]);
    });

    it('should preserve absolute result paths reported by ripgrep', async () => {
      const absoluteMatchPath = path.join(
        tempRootDir,
        'packages/core/src/skills/target.ts',
      );
      const result = await searchWith(
        hit(absoluteMatchPath, 1, 'CORE_HELPER_TARGET_MARKER'),
        { pattern: 'CORE_HELPER_TARGET_MARKER', glob: '**/*.ts' },
      );

      expect(result.resultFilePaths).toEqual([absoluteMatchPath]);
    });

    it('should parse Windows-style absolute result paths reported by ripgrep', async () => {
      const absoluteMatchPath =
        'C:\\repo\\packages\\core\\src\\skills\\target.ts';
      const result = await searchWith(
        hit(absoluteMatchPath, 12, 'CORE_HELPER_TARGET_MARKER'),
        { pattern: 'CORE_HELPER_TARGET_MARKER', glob: '**/*.ts' },
      );

      expect(result.resultFilePaths).toEqual([absoluteMatchPath]);
    });

    it('includes result paths for partially rendered long file paths', async () => {
      Object.assign(mockConfig, { getTruncateToolOutputThreshold: () => 30 });
      const longPath = 'packages/core/src/skills/very-long-named-file.ts';
      const result = await searchWith(hit(longPath, 1, 'visible marker'), {
        pattern: 'marker',
        glob: '**/*.ts',
      });

      expect(result.returnDisplay).toContain('truncated');
      expect(result.llmContent).toContain('packages/core/src/skills/very');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, longPath),
      ]);
    });

    it('only reports result paths for lines reached before character truncation', async () => {
      Object.assign(mockConfig, { getTruncateToolOutputThreshold: () => 25 });
      const visiblePath = 'a.ts';
      const hiddenPath = 'hidden-file-with-long-name.ts';
      const result = await searchWith(
        hit(visiblePath, 1, 'visible marker') +
          hit(hiddenPath, 1, 'hidden marker'),
        { pattern: 'marker', glob: '**/*.ts' },
      );

      expect(result.returnDisplay).toContain('truncated');
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, visiblePath),
        path.join(tempRootDir, hiddenPath),
      ]);
    });

    it('should find matches in a specific path', async () => {
      // Searching in 'sub' returns only matches from that directory.
      const result = await searchWith(
        `fileC.txt:1:another world in sub dir${EOL}`,
        { pattern: 'world', path: 'sub' },
      );
      expectLlm(result, [
        'Found 1 match for pattern "world" in path "sub"',
        'fileC.txt:1:another world in sub dir',
      ]);
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should use target directory when path is not provided', async () => {
      const result = await searchWith(`fileA.txt:1:hello world${EOL}`, {
        pattern: 'world',
      });
      expect(result.llmContent).toContain(
        'Found 1 match for pattern "world" in the workspace directory',
      );
    });

    it('should find matches with a glob filter', async () => {
      const result = await searchWith(
        `fileB.js:2:function baz() { return "hello"; }${EOL}`,
        { pattern: 'hello', glob: '*.js' },
      );
      expectLlm(result, [
        'Found 1 match for pattern "hello" in the workspace directory (filter: "*.js"):',
        'fileB.js:2:function baz() { return "hello"; }',
      ]);
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should find matches with a glob filter and path', async () => {
      await write('sub/another.js', 'const greeting = "hello";');

      // Searching for 'hello' in 'sub' with the '*.js' filter.
      const result = await searchWith(
        `another.js:1:const greeting = "hello";${EOL}`,
        { pattern: 'hello', path: 'sub', glob: '*.js' },
      );
      expectLlm(result, [
        'Found 1 match for pattern "hello" in path "sub" (filter: "*.js")',
        'another.js:1:const greeting = "hello";',
      ]);
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should pass .qwenignore to ripgrep when respected', async () => {
      await write('.qwenignore', 'ignored.txt\n');

      const result = await searchWith('', { pattern: 'secret' });
      expect(result.llmContent).toContain(
        'No matches found for pattern "secret" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should include .qwenignore matches when disabled in config', async () => {
      await write('.qwenignore', 'kept.txt\n');
      await write('kept.txt', 'keep me');
      setFiltering({ respectGitIgnore: true, respectQwenIgnore: false });

      const result = await searchWith(`kept.txt:1:keep me${EOL}`, {
        pattern: 'keep',
      });
      expectLlm(result, [
        'Found 1 match for pattern "keep" in the workspace directory:',
        'kept.txt:1:keep me',
      ]);
      expect(result.returnDisplay).toBe('Found 1 match');
    });

    it('should disable gitignore when configured', async () => {
      setFiltering({ respectGitIgnore: false, respectQwenIgnore: true });

      await searchWith('', { pattern: 'ignored' });
    });

    it('should truncate llm content when exceeding maximum length', async () => {
      const longMatch = 'fileA.txt:1:' + 'a'.repeat(30_000);

      const result = await searchWith(`${longMatch}${EOL}`, { pattern: 'a+' });

      expect(String(result.llmContent).length).toBeLessThanOrEqual(26_000);
      expect(result.llmContent).toMatch(/\[\d+ lines? truncated\] \.\.\./);
      expect(result.returnDisplay).toContain('truncated');
    });

    it('should return "No matches found" when pattern does not exist', async () => {
      const result = await searchWith('', { pattern: 'nonexistentpattern' });
      expect(result.llmContent).toContain(
        'No matches found for pattern "nonexistentpattern" in the workspace directory.',
      );
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should throw validation error for invalid regex pattern', async () => {
      expect(() => grepTool.build({ pattern: '[[' })).toThrow(
        'Invalid regular expression pattern: [[',
      );
    });

    it('should handle regex special characters correctly', async () => {
      // 'foo.*bar' matches 'const foo = "bar";'
      const result = await searchWith(`fileB.js:1:const foo = "bar";${EOL}`, {
        pattern: 'foo.*bar',
      });
      expectLlm(result, [
        'Found 1 match for pattern "foo.*bar" in the workspace directory:',
        'fileB.js:1:const foo = "bar";',
      ]);
    });

    it('should be case-insensitive by default (JS fallback)', async () => {
      const result = await searchWith(
        `fileA.txt:1:hello world${EOL}fileB.js:2:function baz() { return "hello"; }${EOL}`,
        { pattern: 'HELLO' },
      );
      expectLlm(result, [
        'Found 2 matches for pattern "HELLO" in the workspace directory:',
        'fileA.txt:1:hello world',
        'fileB.js:2:function baz() { return "hello"; }',
      ]);
    });

    it('should throw an error if params are invalid', async () => {
      const params = { path: '.' } as unknown as RipGrepToolParams; // Invalid: pattern missing
      expect(() => grepTool.build(params)).toThrow(
        /params must have required property 'pattern'/,
      );
    });

    it('should search within a single file when path is a file', async () => {
      const result = await searchWith(
        `fileA.txt:1:hello world${EOL}fileA.txt:2:second line with world${EOL}`,
        { pattern: 'world', path: path.join(tempRootDir, 'fileA.txt') },
      );
      expectLlm(result, [
        'Found 2 matches',
        'fileA.txt:1:hello world',
        'fileA.txt:2:second line with world',
      ]);
      expect(result.returnDisplay).toBe('Found 2 matches');
    });

    it('should throw an error if ripgrep is not available', async () => {
      rgReturns('', { error: new Error('ripgrep binary not found.') });

      expect(await search({ pattern: 'world' })).toStrictEqual({
        llmContent:
          'Error during grep search operation: ripgrep binary not found.',
        returnDisplay: 'Error: ripgrep binary not found.',
      });
    });

    it('should pass useBuiltinRipgrep setting to ripgrep execution', async () => {
      const systemOnlyGrepTool = new RipGrepTool({
        ...mockConfig,
        getUseBuiltinRipgrep: () => false,
      } as unknown as Config);

      await searchWith(
        hit('fileA.txt', 1, 'hello world'),
        { pattern: 'hello' },
        systemOnlyGrepTool,
      );

      expect(runRipgrep).toHaveBeenCalledWith(
        expect.any(Array),
        abortSignal,
        false,
      );
    });
  });

  describe('multi-directory workspace', () => {
    it('should search across all workspace directories when no path is specified', async () => {
      const secondDir = await makeSecondDir();
      await fs.writeFile(
        path.join(secondDir, 'extra.txt'),
        'hello from second dir',
      );

      const result = await searchWith(
        hit('fileA.txt', 1, 'hello world') +
          hit(`${secondDir}${path.sep}extra.txt`, 1, 'hello from second dir'),
        { pattern: 'hello' },
        multiDirTool(secondDir),
      );

      expectLlm(result, ['across 2 workspace directories', 'Found 2 matches']);
      expect(result.resultFilePaths).toEqual([
        path.join(tempRootDir, 'fileA.txt'),
        path.join(secondDir, 'extra.txt'),
      ]);

      // Verify both paths were passed to runRipgrep
      expect(runRipgrep).toHaveBeenCalledWith(
        expect.arrayContaining([
          '--json',
          '--no-messages',
          tempRootDir,
          secondDir,
        ]),
        expect.anything(),
        true,
      );

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should search only specified path when path is given (ignoring multi-dir)', async () => {
      const secondDir = await makeSecondDir();
      await fs.writeFile(path.join(secondDir, 'other.txt'), 'other content');

      const result = await searchWith(
        `fileC.txt:1:another world in sub dir${EOL}`,
        { pattern: 'world', path: 'sub' },
        multiDirTool(secondDir),
      );

      expectLlm(result, ['in path "sub"'], ['across']);

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should load .qwenignore from each workspace directory', async () => {
      const secondDir = await makeSecondDir();
      await fs.writeFile(path.join(secondDir, '.qwenignore'), 'ignored.txt\n');
      await write('.qwenignore', 'other-ignored.txt\n');

      await searchWith('', { pattern: 'test' }, multiDirTool(secondDir));

      // Verify both .qwenignore files were passed
      const ignoreFiles = ignoreFileArgs();
      expect(ignoreFiles).toContain(path.join(tempRootDir, '.qwenignore'));
      expect(ignoreFiles).toContain(path.join(secondDir, '.qwenignore'));

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should pass .agentignore and .aiignore to ripgrep when respected', async () => {
      await write('.agentignore', 'agent-secret.txt\n');
      await write('.aiignore', 'ai-secret.txt\n');

      await searchWith('', { pattern: 'secret' });

      const ignoreFiles = ignoreFileArgs();
      expect(ignoreFiles).toContain(path.join(tempRootDir, '.agentignore'));
      expect(ignoreFiles).toContain(path.join(tempRootDir, '.aiignore'));
    });

    it('should pass non-qwen ignore files unchanged so ripgrep preserves negations', async () => {
      const qwenIgnorePath = path.join(tempRootDir, '.qwenignore');
      const agentIgnorePath = path.join(tempRootDir, '.agentignore');

      await fs.writeFile(qwenIgnorePath, '*.env\n');
      await write('.agentignore', '*.env\n!allowed.env\n\\!literal.txt\n');

      rg.mockImplementation(async (rgArgs: string[]) => {
        const ignoreFiles = ignoreFileArgs(rgArgs);
        expect(ignoreFiles).toContain(qwenIgnorePath);
        expect(ignoreFiles).toContain(agentIgnorePath);
        expect(ignoreFiles.indexOf(agentIgnorePath)).toBeLessThan(
          ignoreFiles.indexOf(qwenIgnorePath),
        );

        const agentIgnoreContent = await fs.readFile(agentIgnorePath, 'utf8');
        expect(agentIgnoreContent).toContain('!allowed.env');

        return { stdout: '', truncated: false, error: undefined };
      });

      await search({ pattern: 'API_KEY' });
    });

    it('should preserve negation semantics within the same non-qwen ignore file', async () => {
      await write('.agentignore', '*.env\n!allowed.env\n');
      await write('blocked.env', 'API_KEY=1');
      await write('allowed.env', 'API_KEY=2');

      await expectOnlyKept('allowed.env', 'blocked.env');
    });

    it('should not let a custom ignore negation expose .qwenignore matches in grep output', async () => {
      const qwenIgnorePath = path.join(tempRootDir, '.qwenignore');
      const agentIgnorePath = path.join(tempRootDir, '.agentignore');
      await fs.writeFile(qwenIgnorePath, '*.env\n');
      await fs.writeFile(agentIgnorePath, '!*.env\n');
      await write('allowed.env', 'API_KEY=2');

      const result = await searchWith(hit('allowed.env', 1, 'API_KEY=2'), {
        pattern: 'API_KEY',
      });

      expect(result.llmContent).toContain('No matches found');
      expect(result.returnDisplay).toBe('No matches found');
      expect(ignoreFileArgs()).toEqual([agentIgnorePath, qwenIgnorePath]);
    });

    it('should post-filter matches ignored by another workspace .qwenignore', async () => {
      const secondDir = await makeSecondDir();
      await write('.qwenignore', '*.env\n');
      await fs.writeFile(path.join(secondDir, '.qwenignore'), '!*.env\n');
      await write('secret.env', 'API_KEY=1');
      await write('visible.txt', 'API_KEY=2');

      await expectOnlyKept(
        'visible.txt',
        'secret.env',
        multiDirTool(secondDir),
      );

      await fs.rm(secondDir, { recursive: true, force: true });
    });

    it('should preserve negation semantics within the same .qwenignore', async () => {
      await write('.qwenignore', '*.env\n!allowed.env\n');
      await write('blocked.env', 'API_KEY=1');
      await write('allowed.env', 'API_KEY=2');

      await expectOnlyKept('allowed.env', 'blocked.env');
    });

    it('should post-filter matches unignored by a custom nested .qwenignore', async () => {
      await fs.mkdir(path.join(tempRootDir, 'nested'));
      await write('.qwenignore', '*.env\n');
      await write('nested/.qwenignore', '!*.env\n');
      await write('secret.env', 'API_KEY=1');
      await write('visible.txt', 'API_KEY=2');
      withCustomIgnores('nested/.qwenignore');

      await expectOnlyKept('visible.txt', 'secret.env');

      expect(ignoreFileArgs()).toEqual([
        path.join(tempRootDir, 'nested', '.qwenignore'),
        path.join(tempRootDir, '.qwenignore'),
      ]);
    });

    it('should pass configured custom ignore files to ripgrep', async () => {
      await write('.cursorignore', 'cursor-secret.txt\n');
      await write('.agentignore', 'agent-secret.txt\n');
      withCustomIgnores('.cursorignore');

      await searchWith('', { pattern: 'secret' });

      const ignoreFiles = ignoreFileArgs();
      expect(ignoreFiles).toContain(path.join(tempRootDir, '.cursorignore'));
      expect(ignoreFiles).not.toContain(path.join(tempRootDir, '.agentignore'));
    });

    it('should resolve ignore files from the workspace root for subdirectory searches', async () => {
      await write('.cursorignore', 'cursor-secret.txt\n');
      await write('sub/.cursorignore', 'sub-secret.txt\n');
      withCustomIgnores('.cursorignore');

      await searchWith('', { pattern: 'secret', path: 'sub' });

      const ignoreFiles = ignoreFileArgs();
      expect(ignoreFiles).toContain(path.join(tempRootDir, '.cursorignore'));
      expect(ignoreFiles).not.toContain(
        path.join(tempRootDir, 'sub', '.cursorignore'),
      );
    });

    it('should not load ignore files from relative external search paths', async () => {
      const testCwd = await fs.mkdtemp(
        path.join(os.tmpdir(), 'grep-tool-cwd-'),
      );
      const outsideDir = path.join(testCwd, 'outside');
      const originalCwd = process.cwd();

      try {
        await fs.mkdir(outsideDir);
        await fs.writeFile(
          path.join(outsideDir, '.cursorignore'),
          'cursor-secret.txt\n',
        );
        withCustomIgnores('.cursorignore');
        rgReturns('');

        process.chdir(testCwd);

        const invocation = grepTool.build({
          pattern: 'secret',
        }) as unknown as {
          performRipgrepSearch(options: {
            pattern: string;
            paths: string[];
            signal: AbortSignal;
          }): Promise<{ stdout: string; truncated: boolean }>;
        };
        await invocation.performRipgrepSearch({
          pattern: 'secret',
          paths: ['outside'],
          signal: abortSignal,
        });

        expect(ignoreFileArgs()).toEqual([]);
      } finally {
        process.chdir(originalCwd);
        await fs.rm(testCwd, { recursive: true, force: true });
      }
    });

    it('should cache resolved relative result paths across filtering and result metadata', async () => {
      const existsSyncSpy = vi.spyOn(fsSync, 'existsSync');
      const repeatedLine = hit('fileA.txt', 1, 'hello world');

      await searchWith(repeatedLine.repeat(3), { pattern: 'hello' });

      const fileAPath = path.join(tempRootDir, 'fileA.txt');
      const fileAProbeCount = existsSyncSpy.mock.calls.filter(
        ([candidate]) => String(candidate) === fileAPath,
      ).length;
      expect(fileAProbeCount).toBe(1);
    });

    it('should deduplicate matches from overlapping workspace directories', async () => {
      // Guards the dedup fix: with overlapping search paths (e.g. /parent and
      // /parent/sub) ripgrep may report the same file:line once per root.
      const subDir = path.join(tempRootDir, 'sub');
      const dupLine = hit(path.join(subDir, 'fileC.txt'), 1, 'hello world');

      const result = await searchWith(
        dupLine + dupLine,
        { pattern: 'hello' },
        multiDirTool(subDir),
      );

      // Despite two identical lines in the raw output, only 1 match should be reported.
      expect(result.llmContent).toContain('Found 1 match');
    });
  });

  describe('abort signal handling', () => {
    it('should handle AbortSignal during search', async () => {
      const controller = new AbortController();
      const invocation = grepTool.build({ pattern: 'world' });

      controller.abort();

      const result = await invocation.execute(controller.signal);
      expect(result).toBeDefined();
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle workspace boundary violations', async () => {
      // External paths are allowed; permission is deferred to getDefaultPermission()
      const invocation = grepTool.build({
        pattern: 'test',
        path: '../outside',
      });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    });

    it('should handle empty directories gracefully', async () => {
      await fs.mkdir(path.join(tempRootDir, 'empty'));

      const result = await searchWith('', { pattern: 'test', path: 'empty' });

      expect(result.llmContent).toContain('No matches found');
      expect(result.returnDisplay).toBe('No matches found');
    });

    it('should handle empty files correctly', async () => {
      await write('empty.txt', '');

      const result = await searchWith('', { pattern: 'anything' });

      expect(result.llmContent).toContain('No matches found');
    });

    it('should handle special characters in file names', async () => {
      const specialFileName = 'file with spaces & symbols!.txt';
      await write(specialFileName, 'hello world with special chars');

      const result = await searchWith(
        `file with spaces & symbols!.txt:1:hello world with special chars${EOL}`,
        { pattern: 'world' },
      );

      expectLlm(result, [specialFileName, 'hello world with special chars']);
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = path.join(tempRootDir, 'a', 'b', 'c', 'd', 'e');
      await fs.mkdir(deepPath, { recursive: true });
      await write('a/b/c/d/e/deep.txt', 'content in deep directory');

      const result = await searchWith(
        `a/b/c/d/e/deep.txt:1:content in deep directory${EOL}`,
        { pattern: 'deep' },
      );

      expectLlm(result, ['deep.txt', 'content in deep directory']);
    });
  });

  // The ripgrep mock returns what a real run would, so these check how the
  // tool reports matches rather than rg's own regex and glob handling.
  describe('regex pattern validation', () => {
    it('should handle complex regex patterns', async () => {
      await write(
        'code.js',
        'function getName() { return "test"; }\nconst getValue = () => "value";',
      );

      const result = await searchWith(
        `code.js:1:function getName() { return "test"; }${EOL}`,
        { pattern: 'function\\s+\\w+\\s*\\(' },
      );

      expectLlm(result, ['function getName()'], ['const getValue']);
    });

    it('should handle case sensitivity correctly in JS fallback', async () => {
      await write('case.txt', 'Hello World\nhello world\nHELLO WORLD');

      const result = await searchWith(
        `case.txt:1:Hello World${EOL}case.txt:2:hello world${EOL}case.txt:3:HELLO WORLD${EOL}`,
        { pattern: 'hello' },
      );

      expectLlm(result, ['Hello World', 'hello world', 'HELLO WORLD']);
    });

    it('should handle escaped regex special characters', async () => {
      await write(
        'special.txt',
        'Price: $19.99\nRegex: [a-z]+ pattern\nEmail: test@example.com',
      );

      const result = await searchWith(`special.txt:1:Price: $19.99${EOL}`, {
        pattern: '\\$\\d+\\.\\d+',
      });

      expectLlm(result, ['Price: $19.99'], ['Email: test@example.com']);
    });
  });

  describe('glob pattern filtering', () => {
    it('should handle multiple file extensions in glob pattern', async () => {
      await write('test.ts', 'typescript content');
      await write('test.tsx', 'tsx content');
      await write('test.js', 'javascript content');
      await write('test.txt', 'text content');

      const result = await searchWith(
        `test.ts:1:typescript content${EOL}test.tsx:1:tsx content${EOL}`,
        { pattern: 'content', glob: '*.{ts,tsx}' },
      );

      expectLlm(result, ['test.ts', 'test.tsx'], ['test.js', 'test.txt']);
    });

    it('should handle directory patterns in glob', async () => {
      await fs.mkdir(path.join(tempRootDir, 'src'), { recursive: true });
      await write('src/main.ts', 'source code');
      await write('other.ts', 'other code');

      const result = await searchWith(`src/main.ts:1:source code${EOL}`, {
        pattern: 'code',
        glob: 'src/**',
      });

      expectLlm(result, ['main.ts'], ['other.ts']);
    });
  });

  describe('getDescription', () => {
    const appDir = path.join('src', 'app');
    const outside = path.resolve(os.tmpdir());

    // Rows: title, params, description. Rows naming `appDir` need it to exist.
    it.each([
      [
        'should generate correct description with pattern only',
        { pattern: 'testPattern' },
        "'testPattern'",
      ],
      [
        'should generate correct description with pattern and glob',
        { pattern: 'testPattern', glob: '*.ts' },
        "'testPattern' (filter: '*.ts')",
      ],
      [
        'should generate correct description with pattern and path',
        { pattern: 'testPattern', path: appDir },
        `'testPattern' in ${appDir}`,
      ],
      [
        'should generate correct description with pattern, glob, and path',
        { pattern: 'testPattern', glob: '*.ts', path: appDir },
        `'testPattern' in ${appDir} (filter: '*.ts')`,
      ],
      [
        'should use path when specified in description',
        { pattern: 'testPattern', path: '.' },
        "'testPattern' in .",
      ],
      [
        'should keep paths outside the project absolute (never project-relative)',
        { pattern: 'testPattern', path: outside },
        `'testPattern' in ${tildeifyPath(outside)}`,
      ],
    ])('%s', async (_title, params: RipGrepToolParams, expected) => {
      if (params.path === appDir) {
        await fs.mkdir(path.join(tempRootDir, appDir), { recursive: true });
      }
      expect(grepTool.build(params).getDescription()).toBe(expected);
    });
  });

  describe('getDefaultPermission', () => {
    it.each([
      [
        'should return allow when no path is specified',
        { pattern: 'hello' },
        'allow',
      ],
      [
        'should return allow for paths within workspace',
        { pattern: 'hello', path: '.' },
        'allow',
      ],
      [
        'should return allow for subdirectories within workspace',
        { pattern: 'hello', path: 'sub' },
        'allow',
      ],
      [
        'should return ask for paths outside workspace',
        { pattern: 'hello', path: '/tmp' },
        'ask',
      ],
      [
        'should return ask for tilde paths outside workspace',
        { pattern: 'hello', path: '~/outside-workspace' },
        'ask',
      ],
    ])('%s', async (_title, params: RipGrepToolParams, expected) => {
      const permission = await grepTool.build(params).getDefaultPermission();
      expect(permission).toBe(expected);
    });
  });
});
