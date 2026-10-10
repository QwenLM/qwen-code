/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  afterEach,
  vi,
  beforeEach,
  type MockInstance,
} from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as cache from './crawlCache.js';
import type { CrawlOptions } from './crawler.js';
import {
  crawl,
  __setCommandRunnerForTests,
  __resetCrawlerStateForTests,
} from './crawler.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../../test-utils/file-system-test-helpers.js';
import type { Ignore } from './ignore.js';
import { loadIgnoreRules } from './ignore.js';

async function runExecFile(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      { cwd, windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

const gitCommit = (dir: string, message: string) =>
  runExecFile(
    'git',
    [
      '-c',
      'user.name=Qwen Test',
      '-c',
      'user.email=qwen-test@example.com',
      'commit',
      '--no-gpg-sign',
      '-m',
      message,
    ],
    dir,
  );

async function initGitRepo(dir: string): Promise<void> {
  await runExecFile('git', ['init'], dir);
  await runExecFile('git', ['add', '.'], dir);
  await gitCommit(dir, 'init');
}

/** loadIgnoreRules for `projectRoot`, every source off unless enabled. */
const rules = (
  projectRoot: string,
  useGitignore = false,
  useQwenignore = false,
  ignoreDirs: string[] = [],
) => loadIgnoreRules({ projectRoot, useGitignore, useQwenignore, ignoreDirs });

/** crawl() options for `dir` (also the cwd) with caching off. */
const opts = (
  dir: string,
  ignore: Ignore,
  extra: Partial<CrawlOptions> = {},
): CrawlOptions => ({
  crawlDirectory: dir,
  cwd: dir,
  ignore,
  cache: false,
  cacheTtl: 0,
  ...extra,
});

const fail = () => ({ success: false, lines: [] as string[] });

/** A command runner under which git and rg both fail (the fdir fallback). */
const failAllCommands = () => __setCommandRunnerForTests(async () => fail());

/**
 * A fake git repo at `root`: rev-parse reports it, ls-files --others and
 * --deleted list nothing, and ls-files --cached lists `cached` (null: that
 * command fails). rg lists `rg` when given, and everything else fails.
 * `calls` records the args of every command run.
 */
function fakeGitRepo(
  root: string,
  cached: string[] | null,
  { rg, calls }: { rg?: string[]; calls?: string[][] } = {},
) {
  __setCommandRunnerForTests(async (command, args) => {
    calls?.push(args);
    if (command === 'git') {
      if (args.includes('rev-parse') && args.includes('--show-toplevel')) {
        return { success: true, lines: [root] };
      }
      if (args.includes('ls-files') && args.includes('--others')) {
        return { success: true, lines: [] };
      }
      if (args.includes('ls-files') && args.includes('--deleted')) {
        return { success: true, lines: [] };
      }
      if (args.includes('ls-files') && args.includes('--cached')) {
        return cached ? { success: true, lines: [...cached] } : fail();
      }
    }
    if (command === 'rg' && rg) {
      return { success: true, lines: [...rg] };
    }
    return fail();
  });
}

/** git fails; rg answers `respond(args)` and its args are recorded. */
function fakeRipgrepOnly(respond: (args: string[]) => string[]) {
  const rgArgsSeen: string[][] = [];
  __setCommandRunnerForTests(async (command, args) => {
    if (command !== 'rg') return fail();
    rgArgsSeen.push(args);
    return { success: true, lines: respond(args) };
  });
  return rgArgsSeen;
}

/** The crawler's "falling back to …" warnings, in order. */
const degradations = (warnSpy: MockInstance) =>
  warnSpy.mock.calls
    .map((c) => c[0])
    .filter(
      (m): m is string =>
        typeof m === 'string' && m.startsWith('[crawler] falling back to'),
    );

describe('crawler', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
    }
    __setCommandRunnerForTests();
    __resetCrawlerStateForTests();
    vi.restoreAllMocks();
  });

  /** Crawls tmpDir with caching off. */
  const crawlTmp = (ignore: Ignore, extra?: Partial<CrawlOptions>) =>
    crawl(opts(tmpDir, ignore, extra));

  it('should use .qwenignore rules', async () => {
    tmpDir = await createTmpDir({
      '.qwenignore': 'dist/',
      dist: ['ignored.js'],
      src: ['not-ignored.js'],
    });

    const results = await crawlTmp(rules(tmpDir, false, true));

    expect(results).toEqual(
      expect.arrayContaining([
        '.',
        'src/',
        '.qwenignore',
        'src/not-ignored.js',
      ]),
    );
  });

  it('should combine .gitignore and .qwenignore rules', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': 'dist/',
      '.qwenignore': 'build/',
      dist: ['ignored-by-git.js'],
      build: ['ignored-by-gemini.js'],
      src: ['not-ignored.js'],
    });

    const results = await crawlTmp(rules(tmpDir, true, true));

    expect(results).toEqual(
      expect.arrayContaining([
        '.',
        'src/',
        '.qwenignore',
        '.gitignore',
        'src/not-ignored.js',
      ]),
    );
  });

  it('should use ignoreDirs option', async () => {
    tmpDir = await createTmpDir({
      logs: ['some.log'],
      src: ['main.js'],
    });

    const results = await crawlTmp(rules(tmpDir, false, false, ['logs']));

    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', 'src/main.js']),
    );
  });

  it('should handle negated directories', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': ['build/**', '!build/public', '!build/public/**'].join(
        '\n',
      ),
      build: {
        'private.js': '',
        public: ['index.html'],
      },
      src: ['main.js'],
    });

    const results = await crawlTmp(rules(tmpDir, true));

    expect(results).toEqual(
      expect.arrayContaining([
        '.',
        'build/',
        'build/public/',
        'src/',
        '.gitignore',
        'build/public/index.html',
        'src/main.js',
      ]),
    );
  });

  it('should handle root-level file negation', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': ['*.mk', '!Foo.mk'].join('\n'),
      'bar.mk': '',
      'Foo.mk': '',
    });

    const results = await crawlTmp(rules(tmpDir, true));

    expect(results).toEqual(
      expect.arrayContaining(['.', '.gitignore', 'Foo.mk']),
    );
    // bar.mk matches *.mk and is not negated, so it should be filtered out
    expect(results).not.toContain('bar.mk');
  });

  it('should handle directory negation with glob', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': [
        'third_party/**',
        '!third_party/foo',
        '!third_party/foo/bar',
        '!third_party/foo/bar/baz_buffer',
      ].join('\n'),
      third_party: {
        foo: {
          bar: {
            baz_buffer: '',
          },
        },
        ignore_this: '',
      },
    });

    const results = await crawlTmp(rules(tmpDir, true));

    expect(results).toEqual(
      expect.arrayContaining([
        '.',
        'third_party/',
        'third_party/foo/',
        'third_party/foo/bar/',
        '.gitignore',
        'third_party/foo/bar/baz_buffer',
      ]),
    );
  });

  it('should correctly handle negated patterns in .gitignore', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': ['dist/**', '!dist/keep.js'].join('\n'),
      dist: ['ignore.js', 'keep.js'],
      src: ['main.js'],
    });

    const results = await crawlTmp(rules(tmpDir, true));

    expect(results).toEqual(
      expect.arrayContaining([
        '.',
        'dist/',
        'src/',
        '.gitignore',
        'dist/keep.js',
        'src/main.js',
      ]),
    );
  });

  it('should initialize correctly when ignore files are missing', async () => {
    tmpDir = await createTmpDir({
      src: ['file1.js'],
    });

    const results = await crawlTmp(rules(tmpDir, true, true));
    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', 'src/file1.js']),
    );
  });

  it('should handle empty or commented-only ignore files', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': '# This is a comment\n\n   \n',
      src: ['main.js'],
    });

    const results = await crawlTmp(rules(tmpDir, true));

    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', '.gitignore', 'src/main.js']),
    );
  });

  it('should always ignore the .git directory', async () => {
    tmpDir = await createTmpDir({
      '.git': ['config', 'HEAD'],
      src: ['main.js'],
    });

    const results = await crawlTmp(rules(tmpDir));

    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', 'src/main.js']),
    );
  });

  describe('with in-memory cache', () => {
    beforeEach(() => {
      cache.clear();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should hit the cache for subsequent crawls', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const options = opts(tmpDir, rules(tmpDir), {
        cache: true,
        cacheTtl: 10,
      });

      const crawlSpy = vi.spyOn(cache, 'read');

      await crawl(options);
      expect(crawlSpy).toHaveBeenCalledTimes(1);

      await crawl(options);
      expect(crawlSpy).toHaveBeenCalledTimes(2);
      // fdir should not have been called a second time. We can't spy on it
      // directly, but we can check the cache was hit.
      const canonicalDir = path
        .resolve(options.crawlDirectory)
        .split(path.sep)
        .join('/');
      const cacheKey = cache.getCacheKey(
        canonicalDir,
        options.ignore.getFingerprint(),
        undefined,
      );
      expect(cache.read(cacheKey)).toBeDefined();
    });

    it('should miss the cache when ignore rules change', async () => {
      tmpDir = await createTmpDir({
        '.gitignore': 'a.txt',
        'a.txt': '',
        'b.txt': '',
      });
      const crawlCached = () =>
        crawl(
          opts(tmpDir, rules(tmpDir, true), { cache: true, cacheTtl: 10000 }),
        );

      // Initial crawl to populate the cache
      const results1 = await crawlCached();
      expect(results1).toEqual(
        expect.arrayContaining(['.', '.gitignore', 'b.txt']),
      );

      // Modify the ignore file
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'b.txt');

      // Second crawl should miss the cache and trigger a recrawl
      const results2 = await crawlCached();
      expect(results2).toEqual(
        expect.arrayContaining(['.', '.gitignore', 'a.txt']),
      );
    });

    it('should miss the cache after TTL expires', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const options = opts(tmpDir, rules(tmpDir), {
        cache: true,
        cacheTtl: 10, // 10 seconds
      });

      const readSpy = vi.spyOn(cache, 'read');
      const writeSpy = vi.spyOn(cache, 'write');

      await crawl(options);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // Advance time past the TTL
      await vi.advanceTimersByTimeAsync(11000);

      await crawl(options);
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(writeSpy).toHaveBeenCalledTimes(2);
    });

    it('should miss the cache when maxDepth changes', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const ignore = rules(tmpDir);
      const getOptions = (maxDepth?: number) =>
        opts(tmpDir, ignore, { cache: true, cacheTtl: 10000, maxDepth });

      const readSpy = vi.spyOn(cache, 'read');
      const writeSpy = vi.spyOn(cache, 'write');

      // 1. First crawl with maxDepth: 1
      await crawl(getOptions(1));
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // 2. Second crawl with maxDepth: 2, should be a cache miss
      await crawl(getOptions(2));
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(writeSpy).toHaveBeenCalledTimes(2);

      // 3. Third crawl with maxDepth: 1 again, should be a cache hit.
      await crawl(getOptions(1));
      expect(readSpy).toHaveBeenCalledTimes(3);
      expect(writeSpy).toHaveBeenCalledTimes(2); // No new write
    });

    it('should hit cache when crawling a git repo twice', async () => {
      tmpDir = await createTmpDir({ 'tracked.js': '' });
      await initGitRepo(tmpDir);

      cache.clear();
      const options = opts(tmpDir, rules(tmpDir), {
        cache: true,
        cacheTtl: 3600,
      });

      const writeSpy = vi.spyOn(cache, 'write');

      const first = await crawl(options);
      expect(first.length).toBeGreaterThan(0);
      expect(first).toContain('tracked.js');

      const second = await crawl(options);
      expect(second).toEqual(first);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });

    it('should hit cache for ripgrep path when not a git repo', async () => {
      tmpDir = await createTmpDir({ 'only.js': '' });

      cache.clear();
      const options = opts(tmpDir, rules(tmpDir), {
        cache: true,
        cacheTtl: 3600,
      });

      const writeSpy = vi.spyOn(cache, 'write');

      const first = await crawl(options);
      expect(first).toContain('only.js');

      await crawl(options);

      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('with maxDepth', () => {
    beforeEach(async () => {
      tmpDir = await createTmpDir({
        'file-root.txt': '',
        level1: {
          'file-level1.txt': '',
          level2: {
            'file-level2.txt': '',
            level3: {
              'file-level3.txt': '',
            },
          },
        },
      });
    });

    const getCrawlResults = (maxDepth?: number) =>
      crawlTmp(rules(tmpDir), { maxDepth });

    it('should only crawl top-level files when maxDepth is 0', async () => {
      const results = await getCrawlResults(0);
      expect(results).toEqual(
        expect.arrayContaining(['.', 'level1/', 'file-root.txt']),
      );
    });

    it('should crawl one level deep when maxDepth is 1', async () => {
      const results = await getCrawlResults(1);
      expect(results).toEqual(
        expect.arrayContaining([
          '.',
          'level1/',
          'level1/level2/',
          'file-root.txt',
          'level1/file-level1.txt',
        ]),
      );
    });

    it('should crawl two levels deep when maxDepth is 2', async () => {
      const results = await getCrawlResults(2);
      expect(results).toEqual(
        expect.arrayContaining([
          '.',
          'level1/',
          'level1/level2/',
          'level1/level2/level3/',
          'file-root.txt',
          'level1/file-level1.txt',
          'level1/level2/file-level2.txt',
        ]),
      );
    });

    it('should perform a full recursive crawl when maxDepth is undefined', async () => {
      const results = await getCrawlResults(undefined);
      expect(results).toEqual(
        expect.arrayContaining([
          '.',
          'level1/',
          'level1/level2/',
          'level1/level2/level3/',
          'file-root.txt',
          'level1/file-level1.txt',
          'level1/level2/file-level2.txt',
          'level1/level2/level3/file-level3.txt',
        ]),
      );
    });

    it('should treat maxDepth as relative to the crawl directory', async () => {
      await initGitRepo(tmpDir);
      tmpDir = await fs.realpath(tmpDir);

      const results = await crawlTmp(rules(tmpDir), {
        crawlDirectory: path.join(tmpDir, 'level1'),
        maxDepth: 0,
      });

      expect(results).toEqual(
        expect.arrayContaining([
          '.',
          'level1/',
          'level1/file-level1.txt',
          'level1/level2/',
        ]),
      );
      expect(results).not.toContain('level1/level2/file-level2.txt');
      expect(results).not.toContain('level1/level2/level3/');
    });
  });

  describe('with maxFiles', () => {
    it('should truncate results when maxFiles is exceeded', async () => {
      tmpDir = await createTmpDir({
        'a.txt': '',
        'b.txt': '',
        'c.txt': '',
        sub: ['d.txt', 'e.txt'],
      });

      const ignore = rules(tmpDir);
      const allResults = await crawlTmp(ignore);
      const limitedResults = await crawlTmp(ignore, { maxFiles: 3 });

      expect(allResults.length).toBeGreaterThan(3);
      expect(limitedResults.length).toBe(3);
    });

    it('should not count file-ignored entries toward maxFiles budget', async () => {
      tmpDir = await createTmpDir({
        '.gitignore': '*.log',
        'a.txt': '',
        'b.txt': '',
        'noise1.log': '',
        'noise2.log': '',
        'noise3.log': '',
      });

      // Valid entries: '.', '.gitignore', 'a.txt', 'b.txt' = 4
      // Ignored entries: 'noise1.log', 'noise2.log', 'noise3.log'
      // With maxFiles=4, all valid entries should fit because
      // .log files are filtered out before the cap is applied.
      const results = await crawlTmp(rules(tmpDir, true), { maxFiles: 4 });

      expect(results).toEqual(
        expect.arrayContaining(['.', '.gitignore', 'a.txt', 'b.txt']),
      );
      for (const r of results) {
        expect(r).not.toMatch(/\.log$/);
      }
    });

    it('should not truncate when maxFiles exceeds total entries', async () => {
      tmpDir = await createTmpDir({
        'a.txt': '',
        'b.txt': '',
      });

      const results = await crawlTmp(rules(tmpDir), { maxFiles: 1000 });

      expect(results.length).toBeLessThanOrEqual(1000);
      expect(results).toEqual(expect.arrayContaining(['.', 'a.txt', 'b.txt']));
    });
  });

  describe('two-tier strategy: git ls-files + ripgrep fallback', () => {
    it('should use git ls-files in a git repo', async () => {
      tmpDir = await createTmpDir({
        'file1.js': '',
        src: ['file2.js'],
      });
      await initGitRepo(tmpDir);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toEqual(
        expect.arrayContaining(['.', 'src/', 'file1.js', 'src/file2.js']),
      );
    });

    it('should preserve non-ASCII tracked paths from git output', async () => {
      tmpDir = await createTmpDir({
        'café.txt': '',
        '文档.md': '',
        plain: ['nested.txt'],
      });
      await initGitRepo(tmpDir);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toEqual(
        expect.arrayContaining(['café.txt', '文档.md', 'plain/nested.txt']),
      );
    });

    it('should recurse into tracked submodules on the git path', async () => {
      tmpDir = await createTmpDir({});
      const parentRepo = path.join(tmpDir, 'parent');
      const submoduleSource = path.join(tmpDir, 'submodule-source');

      await fs.mkdir(parentRepo);
      await fs.mkdir(submoduleSource);
      await fs.writeFile(path.join(submoduleSource, 'inner.txt'), 'submodule');
      await initGitRepo(submoduleSource);

      await fs.writeFile(path.join(parentRepo, 'root.txt'), 'root');
      await initGitRepo(parentRepo);
      await runExecFile(
        'git',
        [
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          submoduleSource,
          'vendor/lib',
        ],
        parentRepo,
      );
      await gitCommit(parentRepo, 'add submodule');

      const results = await crawl(opts(parentRepo, rules(parentRepo)));

      expect(results).toContain('vendor/lib/inner.txt');
    }, 15_000);

    it('should skip missing tracked paths from submodule indexes', async () => {
      tmpDir = await createTmpDir({});
      await fs.mkdir(path.join(tmpDir, 'vendor', 'lib'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'vendor', 'lib', 'alive.txt'), '');
      fakeGitRepo(tmpDir, [
        'H vendor/lib/alive.txt',
        'H vendor/lib/deleted.txt',
      ]);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain('vendor/lib/alive.txt');
      expect(results).not.toContain('vendor/lib/deleted.txt');
    });

    it('should skip cached gitlink directories from uninitialized submodules', async () => {
      tmpDir = await createTmpDir({});
      await fs.mkdir(path.join(tmpDir, 'vendor', 'lib'), { recursive: true });
      fakeGitRepo(tmpDir, ['H vendor/lib']);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).not.toContain('vendor/lib');
      expect(results).not.toContain('vendor/lib/');
    });

    it('should resolve the git root from a subdirectory crawl', async () => {
      tmpDir = await createTmpDir({
        src: ['file2.js'],
      });
      await initGitRepo(tmpDir);
      tmpDir = await fs.realpath(tmpDir);

      const results = await crawlTmp(rules(tmpDir), {
        crawlDirectory: path.join(tmpDir, 'src'),
      });

      expect(results).toContain('src/file2.js');
      expect(results).toContain('src/');
    });

    it('should not include tracked files deleted from the working tree', async () => {
      tmpDir = await createTmpDir({
        'alive.txt': '',
        'deleted.txt': '',
      });
      await initGitRepo(tmpDir);
      await fs.unlink(path.join(tmpDir, 'deleted.txt'));

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain('alive.txt');
      expect(results).not.toContain('deleted.txt');
    });

    it('should ignore sparse-checkout skip-worktree tracked entries', async () => {
      tmpDir = await createTmpDir({ 'keep.txt': '', 'skip.txt': '' });
      fakeGitRepo(tmpDir, ['S skip.txt', 'H keep.txt']);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain('keep.txt');
      expect(results).not.toContain('skip.txt');
    });

    it('should preserve leading and trailing spaces in tracked filenames', async () => {
      tmpDir = await createTmpDir({
        ' leading.txt': '',
        'trailing.txt ': '',
      });
      fakeGitRepo(tmpDir, ['H  leading.txt', 'H trailing.txt ']);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain(' leading.txt');
      expect(results).toContain('trailing.txt ');
    });

    it('should fall back to fdir when not in a git repo and ripgrep unavailable', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      failAllCommands();
      tmpDir = await createTmpDir({
        'index.js': '',
        lib: ['util.js'],
      });

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toEqual(
        expect.arrayContaining(['.', 'lib/', 'index.js', 'lib/util.js']),
      );
      expect(degradations(warnSpy)).toEqual([
        '[crawler] falling back to fdir (ripgrep unavailable)',
      ]);
      warnSpy.mockRestore();
    });

    it('should respect maxDepth on git ls-files path', async () => {
      tmpDir = await createTmpDir({
        root: ['top.js'],
        nested: {
          deep: ['file.js'],
        },
      });
      await initGitRepo(tmpDir);

      const results = await crawlTmp(rules(tmpDir), { maxDepth: 0 });

      expect(results).toEqual(
        expect.arrayContaining(['.', 'root/', 'nested/']),
      );
      expect(results).not.toContain('root/top.js');
      expect(results).not.toContain('nested/deep/');
      expect(results).not.toContain('nested/deep/file.js');
    });

    it('should avoid enumerating gitignored untracked files on git path', async () => {
      tmpDir = await createTmpDir({
        '.gitignore': '*.log',
        'keep.log': '',
        'keep.txt': '',
      });
      await initGitRepo(tmpDir);

      const withoutGitignoreResults = await crawlTmp(rules(tmpDir), {
        useGitignore: false,
      });
      expect(withoutGitignoreResults).toContain('keep.log');
      expect(withoutGitignoreResults).toContain('keep.txt');

      const withGitignoreResults = await crawlTmp(rules(tmpDir, true), {
        useGitignore: true,
      });
      expect(withGitignoreResults).not.toContain('keep.log');
      expect(withGitignoreResults).toContain('keep.txt');
    });

    it('should not drop files after directory expansion when maxFiles is small', async () => {
      tmpDir = await createTmpDir({
        nested: ['deep.txt'],
      });
      await initGitRepo(tmpDir);

      const results = await crawlTmp(rules(tmpDir), {
        useGitignore: false,
        maxFiles: 1,
      });

      expect(results).toContain('nested/deep.txt');
    });

    it('should include gitignored files in non-git rg fallback when useGitignore is false', async () => {
      const rgArgsSeen = fakeRipgrepOnly((args) =>
        args.includes('--no-ignore') ? ['keep.log', 'keep.txt'] : ['keep.txt'],
      );
      tmpDir = await createTmpDir({
        '.gitignore': '*.log',
        'keep.log': '',
        'keep.txt': '',
      });

      const results = await crawlTmp(rules(tmpDir), { useGitignore: false });

      expect(results).toContain('keep.log');
      expect(results).toContain('keep.txt');
      expect(rgArgsSeen).toHaveLength(1);
      expect(rgArgsSeen[0]).toContain('--no-ignore');
    });

    it('should omit --no-ignore on ripgrep when useGitignore is true (default)', async () => {
      const rgArgsSeen = fakeRipgrepOnly(() => ['keep.txt']);
      tmpDir = await createTmpDir({
        '.gitignore': '*.log',
        'keep.log': '',
        'keep.txt': '',
      });

      await crawlTmp(rules(tmpDir, true), { useGitignore: true });

      expect(rgArgsSeen).toHaveLength(1);
      expect(rgArgsSeen[0]).not.toContain('--no-ignore');
    });

    it('should not run git ls-files --cached on second crawl when throttled and working tree unchanged', async () => {
      tmpDir = await createTmpDir({ 'tracked.js': '' });
      const gitCalls: string[][] = [];
      fakeGitRepo(tmpDir, ['tracked.js'], { calls: gitCalls });
      const options = opts(tmpDir, rules(tmpDir));

      await crawl(options);
      const callsAfterFirst = gitCalls.length;
      expect(gitCalls.filter((a) => a.includes('--cached'))).toHaveLength(1);
      expect(
        gitCalls.some(
          (a) =>
            a.includes('-z') &&
            a.includes('ls-files') &&
            (a.includes('--others') || a.includes('--deleted')),
        ),
      ).toBe(true);

      await crawl(options);

      const newCalls = gitCalls.slice(callsAfterFirst);
      expect(newCalls.some((a) => a.includes('--cached'))).toBe(false);
    });

    it('should fall back to ripgrep when git ls-files --cached fails inside a git repo', async () => {
      tmpDir = await createTmpDir({ 'via-rg.js': '' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fakeGitRepo(tmpDir, null, { rg: ['via-rg.js'] });

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain('via-rg.js');
      expect(degradations(warnSpy)).toContain(
        '[crawler] falling back to ripgrep (git ls-files unavailable)',
      );
      warnSpy.mockRestore();
    });

    it('should warn on git→rg→fdir degradation when git listing then rg fail', async () => {
      tmpDir = await createTmpDir({ 'only-fdir.js': '' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fakeGitRepo(tmpDir, null);

      const results = await crawlTmp(rules(tmpDir));

      expect(results).toContain('only-fdir.js');
      expect(degradations(warnSpy)).toEqual([
        '[crawler] falling back to ripgrep (git ls-files unavailable)',
        '[crawler] falling back to fdir (ripgrep unavailable)',
      ]);
      warnSpy.mockRestore();
    });
  });

  describe('throttling', () => {
    beforeEach(() => {
      cache.clear();
    });

    it('should not re-crawl within throttle window', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const options = opts(tmpDir, rules(tmpDir));

      const results1 = await crawl(options);
      expect(results1).toContain('file1.js');

      const results2 = await crawl(options);
      expect(results2).toContain('file1.js');
    });

    it('should refresh untracked files before reusing throttled git results', async () => {
      tmpDir = await createTmpDir({
        'tracked.js': '',
      });
      await initGitRepo(tmpDir);
      const options = opts(tmpDir, rules(tmpDir));

      const first = await crawl(options);
      expect(first).toContain('tracked.js');
      expect(first).not.toContain('new-untracked.js');

      await fs.writeFile(path.join(tmpDir, 'new-untracked.js'), '');

      const second = await crawl(options);
      expect(second).toContain('tracked.js');
      expect(second).toContain('new-untracked.js');
    });

    it('should throttle re-crawl on non-git fallback paths until the window expires', async () => {
      failAllCommands();
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const options = opts(tmpDir, rules(tmpDir));

      vi.useFakeTimers();
      try {
        const first = await crawl(options);
        expect(first).toContain('file1.js');

        await fs.writeFile(path.join(tmpDir, 'file2.js'), '');

        const second = await crawl(options);
        expect(second).toContain('file1.js');
        expect(second).not.toContain('file2.js');

        await vi.advanceTimersByTimeAsync(6000);

        const third = await crawl(options);
        expect(third).toContain('file1.js');
        expect(third).toContain('file2.js');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should preserve maxFiles cap on throttled non-git fallback reads', async () => {
      failAllCommands();
      tmpDir = await createTmpDir({
        'file1.js': '',
        'file2.js': '',
        'file3.js': '',
      });
      const options = opts(tmpDir, rules(tmpDir), { maxFiles: 1 });

      const first = await crawl(options);
      expect(first).toHaveLength(2);
      expect(first).toEqual(expect.arrayContaining(['.', 'file1.js']));

      await fs.writeFile(path.join(tmpDir, 'file4.js'), '');

      const second = await crawl(options);
      expect(second).toHaveLength(2);
      expect(second).toEqual(first);
    });
  });

  describe('mtime-based change detection', () => {
    beforeEach(() => {
      cache.clear();
    });

    it('should re-crawl when git index mtime changes', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      await initGitRepo(tmpDir);
      const options = opts(tmpDir, rules(tmpDir));

      const results1 = await crawl(options);
      expect(results1.length).toBeGreaterThan(0);

      await fs.writeFile(path.join(tmpDir, 'file2.js'), '');
      const futureTime = new Date(Date.now() + 60_000);
      await fs.utimes(
        path.join(tmpDir, '.git', 'index'),
        futureTime,
        futureTime,
      );

      const results2 = await crawl(options);
      expect(results2).toContain('file2.js');
      expect(results2).not.toEqual(results1);
    });

    it('should re-crawl git worktrees when the gitdir index changes', async () => {
      tmpDir = await createTmpDir({});
      const worktreeDir = path.join(tmpDir, 'worktree');
      const gitDir = path.join(tmpDir, 'gitdir');

      await fs.mkdir(worktreeDir, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(path.join(gitDir, 'index'), 'initial');
      await fs.writeFile(path.join(worktreeDir, '.git'), 'gitdir: ../gitdir\n');
      await fs.writeFile(path.join(worktreeDir, 'tracked.txt'), '');

      let includeExtraFile = false;
      __setCommandRunnerForTests(
        async (
          command: string,
          args: string[],
          cwd: string,
        ): Promise<{ success: boolean; lines: string[] }> => {
          if (command !== 'git') {
            return { success: false, lines: [] };
          }

          if (args.includes('rev-parse') && args.includes('--show-toplevel')) {
            expect(cwd).toBe(worktreeDir);
            return { success: true, lines: [worktreeDir] };
          }

          if (args.includes('ls-files') && args.includes('--cached')) {
            return {
              success: true,
              lines: includeExtraFile
                ? ['tracked.txt', 'new-file.txt']
                : ['tracked.txt'],
            };
          }

          if (args.includes('ls-files') && args.includes('--others')) {
            return { success: true, lines: [] };
          }

          return { success: false, lines: [] };
        },
      );

      const options = opts(worktreeDir, rules(worktreeDir));

      const first = await crawl(options);
      expect(first).toEqual(expect.arrayContaining(['.', 'tracked.txt']));
      expect(first).not.toContain('new-file.txt');

      includeExtraFile = true;
      await fs.writeFile(path.join(worktreeDir, 'new-file.txt'), '');
      const futureTime = new Date(Date.now() + 60_000);
      await fs.utimes(path.join(gitDir, 'index'), futureTime, futureTime);

      const second = await crawl(options);
      expect(second).toEqual(
        expect.arrayContaining(['.', 'tracked.txt', 'new-file.txt']),
      );
    });
  });
}, 30_000);
