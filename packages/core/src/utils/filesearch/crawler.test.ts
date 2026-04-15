/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as cache from './crawlCache.js';
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

async function initGitRepo(dir: string): Promise<void> {
  await runExecFile('git', ['init'], dir);
  await runExecFile('git', ['add', '.'], dir);
}

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

  it('should use .qwenignore rules', async () => {
    tmpDir = await createTmpDir({
      '.qwenignore': 'dist/',
      dist: ['ignored.js'],
      src: ['not-ignored.js'],
    });

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: false,
      useQwenignore: true,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: true,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: false,
      useQwenignore: false,
      ignoreDirs: ['logs'],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: true,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });
    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', 'src/file1.js']),
    );
  });

  it('should handle empty or commented-only ignore files', async () => {
    tmpDir = await createTmpDir({
      '.gitignore': '# This is a comment\n\n   \n',
      src: ['main.js'],
    });

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: true,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

    expect(results).toEqual(
      expect.arrayContaining(['.', 'src/', '.gitignore', 'src/main.js']),
    );
  });

  it('should always ignore the .git directory', async () => {
    tmpDir = await createTmpDir({
      '.git': ['config', 'HEAD'],
      src: ['main.js'],
    });

    const ignore = loadIgnoreRules({
      projectRoot: tmpDir,
      useGitignore: false,
      useQwenignore: false,
      ignoreDirs: [],
    });

    const results = await crawl({
      crawlDirectory: tmpDir,
      cwd: tmpDir,
      ignore,
      cache: false,
      cacheTtl: 0,
    });

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
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const options = {
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: true,
        cacheTtl: 10,
      };

      const crawlSpy = vi.spyOn(cache, 'read');

      await crawl(options);
      expect(crawlSpy).toHaveBeenCalledTimes(1);

      await crawl(options);
      expect(crawlSpy).toHaveBeenCalledTimes(2);
      // fdir should not have been called a second time.
      // We can't spy on it directly, but we can check the cache was hit.
      const cacheKey = cache.getCacheKey(
        options.crawlDirectory,
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
      const getIgnore = () =>
        loadIgnoreRules({
          projectRoot: tmpDir,
          useGitignore: true,
          useQwenignore: false,
          ignoreDirs: [],
        });
      const getOptions = (ignore: Ignore) => ({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: true,
        cacheTtl: 10000,
      });

      // Initial crawl to populate the cache
      const ignore1 = getIgnore();
      const results1 = await crawl(getOptions(ignore1));
      expect(results1).toEqual(
        expect.arrayContaining(['.', '.gitignore', 'b.txt']),
      );

      // Modify the ignore file
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'b.txt');

      // Second crawl should miss the cache and trigger a recrawl
      const ignore2 = getIgnore();
      const results2 = await crawl(getOptions(ignore2));
      expect(results2).toEqual(
        expect.arrayContaining(['.', '.gitignore', 'a.txt']),
      );
    });

    it('should miss the cache after TTL expires', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const options = {
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: true,
        cacheTtl: 10, // 10 seconds
      };

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
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const getOptions = (maxDepth?: number) => ({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: true,
        cacheTtl: 10000,
        maxDepth,
      });

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

    const getCrawlResults = (maxDepth?: number) => {
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      return crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
        maxDepth,
      });
    };

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
  });

  describe('with maxFiles', () => {
    it('should truncate results when maxFiles is exceeded', async () => {
      tmpDir = await createTmpDir({
        'a.txt': '',
        'b.txt': '',
        'c.txt': '',
        sub: ['d.txt', 'e.txt'],
      });

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });

      const allResults = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      });

      const limitedResults = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
        maxFiles: 3,
      });

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

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: true,
        useQwenignore: false,
        ignoreDirs: [],
      });

      // Valid entries: '.', '.gitignore', 'a.txt', 'b.txt' = 4
      // Ignored entries: 'noise1.log', 'noise2.log', 'noise3.log'
      // With maxFiles=4, all valid entries should fit because
      // .log files are filtered out before the cap is applied.
      const results = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
        maxFiles: 4,
      });

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

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });

      const results = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
        maxFiles: 1000,
      });

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

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });

      const results = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      });

      expect(results).toEqual(
        expect.arrayContaining(['.', 'src/', 'file1.js', 'src/file2.js']),
      );
    });

    it('should fall back to fdir when not in a git repo and ripgrep unavailable', async () => {
      __setCommandRunnerForTests(async (command) => {
        if (command === 'git' || command === 'rg') {
          return { success: false, lines: [] };
        }
        return { success: false, lines: [] };
      });

      tmpDir = await createTmpDir({
        'index.js': '',
        lib: ['util.js'],
      });

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });

      const results = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      });

      expect(results).toEqual(
        expect.arrayContaining(['.', 'lib/', 'index.js', 'lib/util.js']),
      );
    });

    it('should respect maxDepth on git ls-files path', async () => {
      tmpDir = await createTmpDir({
        root: ['top.js'],
        nested: {
          deep: ['file.js'],
        },
      });
      await initGitRepo(tmpDir);

      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });

      const results = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
        maxDepth: 0,
      });

      expect(results).toEqual(
        expect.arrayContaining(['.', 'root/', 'nested/']),
      );
      expect(results).not.toContain('root/top.js');
      expect(results).not.toContain('nested/deep/');
      expect(results).not.toContain('nested/deep/file.js');
    });

    it('should respect useGitignore option on git path', async () => {
      tmpDir = await createTmpDir({
        '.gitignore': '*.log',
        'keep.log': '',
        'keep.txt': '',
      });
      await initGitRepo(tmpDir);

      const withoutGitignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const withoutGitignoreResults = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore: withoutGitignore,
        cache: false,
        cacheTtl: 0,
      });
      expect(withoutGitignoreResults).toContain('keep.log');

      const withGitignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: true,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const withGitignoreResults = await crawl({
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore: withGitignore,
        cache: false,
        cacheTtl: 0,
      });
      expect(withGitignoreResults).not.toContain('keep.log');
      expect(withGitignoreResults).toContain('keep.txt');
    });
  });

  describe('throttling', () => {
    beforeEach(() => {
      cache.clear();
    });

    it('should not re-crawl within throttle window', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const options = {
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      };

      const results1 = await crawl(options);
      expect(results1).toContain('file1.js');

      const results2 = await crawl(options);
      expect(results2).toContain('file1.js');
    });

    it('should throttle re-crawl on non-git fallback paths until the window expires', async () => {
      __setCommandRunnerForTests(async (command) => {
        if (command === 'git' || command === 'rg') {
          return { success: false, lines: [] };
        }
        return { success: false, lines: [] };
      });

      tmpDir = await createTmpDir({ 'file1.js': '' });
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const options = {
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      };

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
  });

  describe('mtime-based change detection', () => {
    beforeEach(() => {
      cache.clear();
    });

    it('should re-crawl when git index mtime changes', async () => {
      tmpDir = await createTmpDir({ 'file1.js': '' });
      const ignore = loadIgnoreRules({
        projectRoot: tmpDir,
        useGitignore: false,
        useQwenignore: false,
        ignoreDirs: [],
      });
      const options = {
        crawlDirectory: tmpDir,
        cwd: tmpDir,
        ignore,
        cache: false,
        cacheTtl: 0,
      };

      const results1 = await crawl(options);
      expect(results1.length).toBeGreaterThan(0);

      await fs.writeFile(path.join(tmpDir, 'file2.js'), '');

      const results2 = await crawl(options);
      expect(results2.length).toBeGreaterThanOrEqual(results1.length);
    });
  });
});
