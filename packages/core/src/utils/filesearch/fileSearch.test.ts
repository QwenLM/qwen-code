/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  FileSearchFactory,
  AbortError,
  filter,
  type FileSearchOptions,
} from './fileSearch.js';
import {
  createTmpDir,
  cleanupTmpDir,
  type FileSystemStructure,
} from '../../test-utils/file-system-test-helpers.js';

describe('FileSearch', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
    }
    vi.restoreAllMocks();
  });

  /** Writes `files` to a fresh tmpDir and creates an uninitialized search over it. */
  const create = async (
    files: FileSystemStructure,
    options: Partial<FileSearchOptions> = {},
  ) => {
    tmpDir = await createTmpDir(files);
    return FileSearchFactory.create({
      projectRoot: tmpDir,
      useGitignore: false,
      useQwenignore: false,
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
      ...options,
    });
  };
  const init = async (
    files: FileSystemStructure,
    options?: Partial<FileSearchOptions>,
  ) => {
    const fileSearch = await create(files, options);
    await fileSearch.initialize();
    return fileSearch;
  };
  const search = async (
    files: FileSystemStructure,
    pattern: string,
    options?: Partial<FileSearchOptions>,
  ) => (await init(files, options)).search(pattern);

  it('should use .qwenignore rules', async () => {
    const results = await search(
      { '.qwenignore': 'dist/', dist: ['ignored.js'], src: ['not-ignored.js'] },
      '',
      { useQwenignore: true },
    );
    expect(results).toEqual(['src/', '.qwenignore', 'src/not-ignored.js']);
  });

  it('should combine .gitignore and .qwenignore rules', async () => {
    const results = await search(
      {
        '.gitignore': 'dist/',
        '.qwenignore': 'build/',
        dist: ['ignored-by-git.js'],
        build: ['ignored-by-gemini.js'],
        src: ['not-ignored.js'],
      },
      '',
      { useGitignore: true, useQwenignore: true },
    );
    expect(results).toEqual([
      'src/',
      '.gitignore',
      '.qwenignore',
      'src/not-ignored.js',
    ]);
  });

  it('should use ignoreDirs option', async () => {
    const results = await search({ logs: ['some.log'], src: ['main.js'] }, '', {
      ignoreDirs: ['logs'],
    });
    expect(results).toEqual(['src/', 'src/main.js']);
  });

  it('should handle negated directories', async () => {
    const results = await search(
      {
        '.gitignore': ['build/**', '!build/public', '!build/public/**'].join(
          '\n',
        ),
        build: { 'private.js': '', public: ['index.html'] },
        src: ['main.js'],
      },
      '',
      { useGitignore: true },
    );
    expect(results).toEqual([
      'build/',
      'build/public/',
      'src/',
      '.gitignore',
      'build/public/index.html',
      'src/main.js',
    ]);
  });

  it('should filter results with a search pattern', async () => {
    const results = await search(
      { src: { 'main.js': '', 'util.ts': '', 'style.css': '' } },
      '**/*.js',
    );
    expect(results).toEqual(['src/main.js']);
  });

  it('should handle root-level file negation', async () => {
    const results = await search(
      {
        '.gitignore': ['*.mk', '!Foo.mk'].join('\n'),
        'bar.mk': '',
        'Foo.mk': '',
      },
      '',
      { useGitignore: true },
    );
    expect(results).toEqual(['.gitignore', 'Foo.mk']);
  });

  it('should handle directory negation with glob', async () => {
    const results = await search(
      {
        '.gitignore': [
          'third_party/**',
          '!third_party/foo',
          '!third_party/foo/bar',
          '!third_party/foo/bar/baz_buffer',
        ].join('\n'),
        third_party: { foo: { bar: { baz_buffer: '' } }, ignore_this: '' },
      },
      '',
      { useGitignore: true },
    );
    expect(results).toEqual([
      'third_party/',
      'third_party/foo/',
      'third_party/foo/bar/',
      '.gitignore',
      'third_party/foo/bar/baz_buffer',
    ]);
  });

  it('should correctly handle negated patterns in .gitignore', async () => {
    const results = await search(
      {
        '.gitignore': ['dist/**', '!dist/keep.js'].join('\n'),
        dist: ['ignore.js', 'keep.js'],
        src: ['main.js'],
      },
      '',
      { useGitignore: true },
    );
    expect(results).toEqual([
      'dist/',
      'src/',
      '.gitignore',
      'dist/keep.js',
      'src/main.js',
    ]);
  });

  it('should initialize correctly when ignore files are missing', async () => {
    const fileSearch = await create(
      { src: ['file1.js'] },
      { useGitignore: true, useQwenignore: true },
    );
    // No errors are thrown during initialization.
    await expect(fileSearch.initialize()).resolves.toBeUndefined();
    const results = await fileSearch.search('');
    expect(results).toEqual(['src/', 'src/file1.js']);
  });

  it('should respect maxResults option in search', async () => {
    const fileSearch = await init({
      src: { 'file1.js': '', 'file2.js': '', 'file3.js': '', 'file4.js': '' },
    });
    const results = await fileSearch.search('**/*.js', { maxResults: 2 });
    expect(results).toEqual(['src/file1.js', 'src/file2.js']); // Assuming alphabetical sort
  });

  it('should use fzf for fuzzy matching when pattern does not contain wildcards', async () => {
    const results = await search(
      { src: { 'main.js': '', 'util.ts': '', 'style.css': '' } },
      'sst',
    );
    expect(results).toEqual(['src/style.css']);
  });

  const fuzzyFiles = {
    src: { 'file1.js': '', 'flexible.js': '', 'other.ts': '' },
  };

  it('should not use fzf for fuzzy matching when enableFuzzySearch is false', async () => {
    const results = await search(fuzzyFiles, 'fle', {
      enableFuzzySearch: false,
    });
    expect(results).toEqual(['src/flexible.js']);
  });

  it('should use fzf for fuzzy matching when enableFuzzySearch is true', async () => {
    const results = await search(fuzzyFiles, 'fle');
    expect(results).toEqual(
      expect.arrayContaining(['src/file1.js', 'src/flexible.js']),
    );
  });

  it('should return empty array when no matches are found', async () => {
    const results = await search({ src: ['file1.js'] }, 'nonexistent-file.xyz');
    expect(results).toEqual([]);
  });

  it('should throw AbortError when filter is aborted', async () => {
    const controller = new AbortController();
    const dummyPaths = Array.from({ length: 5000 }, (_, i) => `file${i}.js`); // Large array to ensure yielding

    const filterPromise = filter(dummyPaths, '*.js', controller.signal);

    // Abort after a short delay to ensure filter has started
    setTimeout(() => controller.abort(), 1);

    await expect(filterPromise).rejects.toThrow(AbortError);
  });

  it('should throw an error if search is called before initialization', async () => {
    const fileSearch = await create({});
    await expect(fileSearch.search('')).rejects.toThrow(
      'Engine not initialized. Call initialize() first.',
    );
  });

  it('should handle empty or commented-only ignore files', async () => {
    const results = await search(
      { '.gitignore': '# This is a comment\n\n   \n', src: ['main.js'] },
      '',
      { useGitignore: true },
    );
    expect(results).toEqual(['src/', '.gitignore', 'src/main.js']);
  });

  it('should always ignore the .git directory', async () => {
    const results = await search(
      { '.git': ['config', 'HEAD'], src: ['main.js'] },
      '',
      { useGitignore: false }, // Explicitly disable .gitignore to isolate this rule
    );
    expect(results).toEqual(['src/', 'src/main.js']);
  });

  it('should be cancellable via AbortSignal', async () => {
    const largeDir: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      largeDir[`file${i}.js`] = '';
    }
    const fileSearch = await init(largeDir);

    const controller = new AbortController();
    const searchPromise = fileSearch.search('**/*.js', {
      signal: controller.signal,
    });

    // Yield to allow the search to start before aborting.
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();

    await expect(searchPromise).rejects.toThrow(AbortError);
  });

  it('should leverage ResultCache for bestBaseQuery optimization', async () => {
    const fileSearch = await init(
      { src: { 'foo.js': '', 'bar.ts': '', nested: { 'baz.js': '' } } },
      { cache: true },
    );

    // Perform a broad search to prime the cache
    const broadResults = await fileSearch.search('src/**');
    expect(broadResults).toEqual([
      'src/',
      'src/nested/',
      'src/bar.ts',
      'src/foo.js',
      'src/nested/baz.js',
    ]);

    // A more specific search reuses the broad search's cached results. We
    // can't inspect ResultCache.hits/misses here, but correct results after a
    // broad search imply the caching, including bestBaseQuery, works.
    const specificResults = await fileSearch.search('src/**/*.js');
    expect(specificResults).toEqual(['src/foo.js', 'src/nested/baz.js']);
  });

  it('should be case-insensitive by default', async () => {
    const fileSearch = await init({
      'File1.Js': '',
      'file2.js': '',
      'FILE3.JS': '',
      'other.txt': '',
    });

    // Lowercase, uppercase and mixed-case patterns.
    for (const pattern of ['file*.js', 'FILE*.JS', 'FiLe*.Js']) {
      const results = await fileSearch.search(pattern);
      expect(results).toHaveLength(3);
      expect(results).toEqual(
        expect.arrayContaining(['File1.Js', 'file2.js', 'FILE3.JS']),
      );
    }
  });

  it('should respect maxResults even when the cache returns an exact match', async () => {
    const fileSearch = await init(
      {
        'file1.js': '',
        'file2.js': '',
        'file3.js': '',
        'file4.js': '',
        'file5.js': '',
      },
      { cache: true, cacheTtl: 10000 },
    );

    // 1. Perform a broad search to populate the cache with an exact match.
    const initialResults = await fileSearch.search('*.js');
    expect(initialResults).toEqual([
      'file1.js',
      'file2.js',
      'file3.js',
      'file4.js',
      'file5.js',
    ]);

    // 2. Perform the same search again, but this time with a maxResults limit.
    const limitedResults = await fileSearch.search('*.js', { maxResults: 2 });

    // 3. Assert that the maxResults limit was respected, even with a cache hit.
    expect(limitedResults).toEqual(['file1.js', 'file2.js']);
  });

  it.skipIf(process.platform === 'win32')(
    'should handle file paths with special characters that need escaping',
    async () => {
      // The pattern escapes the special characters; `unescapePath` must
      // handle the escaped path correctly.
      const results = await search(
        {
          src: { 'file with (special) chars.txt': '', 'another-file.txt': '' },
        },
        'src/file with \\(special\\) chars.txt',
      );
      expect(results).toEqual(['src/file with (special) chars.txt']);
    },
  );

  describe('DirectoryFileSearch', () => {
    const dirSearch = (
      files: FileSystemStructure,
      pattern: string,
      options?: Partial<FileSearchOptions>,
    ) =>
      search(files, pattern, { enableRecursiveFileSearch: false, ...options });

    it('should search for files in the current directory', async () => {
      const results = await dirSearch(
        { 'file1.js': '', 'file2.ts': '', 'file3.js': '' },
        '*.js',
      );
      expect(results).toEqual(['file1.js', 'file3.js']);
    });

    const nested = { 'file1.js': '', src: { 'file2.js': '', 'file3.ts': '' } };

    it('should search for files in a subdirectory', async () => {
      const results = await dirSearch(nested, 'src/*.js');
      expect(results).toEqual(['src/file2.js']);
    });

    it('should list all files in a directory', async () => {
      const results = await dirSearch(nested, 'src/');
      expect(results).toEqual(['src/file2.js', 'src/file3.ts']);
    });

    it('should respect ignore rules', async () => {
      const results = await dirSearch(
        { '.gitignore': '*.js', 'file1.js': '', 'file2.ts': '' },
        '*',
        { useGitignore: true },
      );
      expect(results).toEqual(['.gitignore', 'file2.ts']);
    });
  });

  describe('dispose()', () => {
    it('should release fzf handle on dispose', async () => {
      const fileSearch = await init({ src: ['a.ts', 'b.ts'] });
      await expect(fileSearch.dispose?.()).resolves.toBeUndefined();
      // Idempotent
      await expect(fileSearch.dispose?.()).resolves.toBeUndefined();
    });

    it('should be a no-op for DirectoryFileSearch', async () => {
      const fileSearch = await init(
        { src: ['a.ts'] },
        { enableRecursiveFileSearch: false },
      );
      // DirectoryFileSearch has no dispose — should be undefined.
      expect(fileSearch.dispose).toBeUndefined();
    });
  });
});
