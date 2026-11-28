/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { FileSearchFactory, AbortError, filter } from './fileSearch.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../../test-utils/file-system-test-helpers.js';
import * as gitFileList from './gitFileList.js';
import { BRAND_IGNORE_FILE_NAME } from '../../config/constants.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { escapePath } from '../paths.js';

describe('FileSearch', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
    }
    vi.restoreAllMocks();
  });

  it('should use .geminiignore rules', async () => {
    tmpDir = await createTmpDir({
      [BRAND_IGNORE_FILE_NAME]: 'dist/',
      dist: ['ignored.js'],
      src: ['not-ignored.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: true,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual([
      'src/',
      BRAND_IGNORE_FILE_NAME,
      'src/not-ignored.js',
    ]);
  });

  it('should combine .gitignore and .geminiignore rules', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': 'dist/',
      [BRAND_IGNORE_FILE_NAME]: 'build/',
      dist: ['ignored-by-git.js'],
      build: ['ignored-by-gemini.js'],
      src: ['not-ignored.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: true,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual([
      'src/',
      '.gitignore',
      BRAND_IGNORE_FILE_NAME,
      'src/not-ignored.js',
    ]);
  });

  it('should use ignoreDirs option', async () => {
    tmpDir = await createTmpDir({
      logs: ['some.log'],
      src: ['main.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: ['logs'],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual(['src/', 'src/main.js']);
  });

  it('should handle negated directories', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': ['build/**', '!build/public', '!build/public/**'].join(
        '\n',
      ),
      build: {
        'private.js': '',
        public: ['index.html'],
      },
      src: ['main.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

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
    tmpDir = await createTmpDir({
      src: {
        'main.js': '',
        'util.ts': '',
        'style.css': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('**/*.js');

    expect(results).toEqual(['src/main.js']);
  });

  it('should handle root-level file negation', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': ['*.mk', '!Foo.mk'].join('\n'),
      'bar.mk': '',
      'Foo.mk': '',
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual(['.gitignore', 'Foo.mk']);
  });

  it('should handle directory negation with glob', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
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

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual([
      'third_party/',
      'third_party/foo/',
      'third_party/foo/bar/',
      '.gitignore',
      'third_party/foo/bar/baz_buffer',
    ]);
  });

  it('should correctly handle negated patterns in .gitignore', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': ['dist/**', '!dist/keep.js'].join('\n'),
      dist: ['ignore.js', 'keep.js'],
      src: ['main.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual([
      'dist/',
      'src/',
      '.gitignore',
      'dist/keep.js',
      'src/main.js',
    ]);
  });

  // New test cases start here

  it('should initialize correctly when ignore files are missing', async () => {
    tmpDir = await createTmpDir({
      src: ['file1.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: true,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    // Expect no errors to be thrown during initialization
    await expect(fileSearch.initialize()).resolves.toBeUndefined();
    const results = await fileSearch.search('');
    expect(results).toEqual(['src/', 'src/file1.js']);
  });

  it('should respect maxResults option in search', async () => {
    tmpDir = await createTmpDir({
      src: {
        'file1.js': '',
        'file2.js': '',
        'file3.js': '',
        'file4.js': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('**/*.js', { maxResults: 2 });

    expect(results).toEqual(['src/file1.js', 'src/file2.js']); // Assuming alphabetical sort
  });

  it('should use fzf for fuzzy matching when pattern does not contain wildcards', async () => {
    tmpDir = await createTmpDir({
      src: {
        'main.js': '',
        'util.ts': '',
        'style.css': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('sst');

    expect(results).toEqual(['src/style.css']);
  });

  it('should not use fzf for fuzzy matching when enableFuzzySearch is false', async () => {
    tmpDir = await createTmpDir({
      src: {
        'file1.js': '',
        'flexible.js': '',
        'other.ts': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: false,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('fle');

    expect(results).toEqual(['src/flexible.js']);
  });

  it('should use fzf for fuzzy matching when enableFuzzySearch is true', async () => {
    tmpDir = await createTmpDir({
      src: {
        'file1.js': '',
        'flexible.js': '',
        'other.ts': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('fle');

    expect(results).toEqual(
      expect.arrayContaining(['src/file1.js', 'src/flexible.js']),
    );
  });

  it('should prioritize filenames closer to the end of the path and shorter paths', async () => {
    tmpDir = await createTmpDir({
      src: {
        'hooks.ts': '',
        hooks: {
          'index.ts': '',
        },
        utils: {
          'hooks.tsx': '',
        },
        'hooks-dev': {
          'test.ts': '',
        },
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('hooks');

    // The order should prioritize matches closer to the end and shorter strings.
    // FZF matches right-to-left.
    expect(results[0]).toBe('src/hooks/');
    expect(results[1]).toBe('src/hooks.ts');
    expect(results[2]).toBe('src/utils/hooks.tsx');
    expect(results[3]).toBe('src/hooks-dev/');
    expect(results[4]).toBe('src/hooks/index.ts');
    expect(results[5]).toBe('src/hooks-dev/test.ts');
  });
  it('should return empty array when no matches are found', async () => {
    tmpDir = await createTmpDir({
      src: ['file1.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('nonexistent-file.xyz');

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
    tmpDir = await createTmpDir({});
    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await expect(fileSearch.search('')).rejects.toThrow(
      'Engine not initialized. Call initialize() first.',
    );
  });

  it('should handle empty or commented-only ignore files', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': '# This is a comment\n\n   \n',
      src: ['main.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual(['src/', '.gitignore', 'src/main.js']);
  });

  it('should always ignore the .git directory', async () => {
    tmpDir = await createTmpDir({
      '.git': ['config', 'HEAD'],
      src: ['main.js'],
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false, // Explicitly disable .gitignore to isolate this rule
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();
    const results = await fileSearch.search('');

    expect(results).toEqual(['src/', 'src/main.js']);
  });

  it.each([
    new Error('git ls-files exited with code 128'),
    Object.assign(new Error('git ls-files timed out'), {
      name: 'AbortError',
    }),
  ])(
    'should fall back to ripgrep when tracked Git listing fails',
    async (error) => {
      tmpDir = await createTmpDir({
        '.git': {},
        'PreviewFragment.kt': '',
      });
      vi.spyOn(gitFileList, 'listGitFiles').mockRejectedValue(error);

      const fileSearch = FileSearchFactory.create({
        projectRoot: tmpDir,
        fileDiscoveryService: new FileDiscoveryService(tmpDir, {
          respectGitIgnore: true,
          respectBrandIgnore: false,
        }),
        ignoreDirs: [],
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: true,
        enableFuzzySearch: true,
        respectGitIgnore: true,
      });

      await fileSearch.initialize();

      expect(await fileSearch.search('PreviewFragment')).toContain(
        'PreviewFragment.kt',
      );
    },
  );

  it('should keep the tracked index when background untracked listing fails', async () => {
    tmpDir = await createTmpDir({ '.git': {}, 'Tracked.kt': '' });
    vi.spyOn(gitFileList, 'listGitFiles').mockImplementation(
      async ({ args }) => {
        if (args.includes('--others')) {
          throw new Error('untracked listing failed');
        }
        return ['Tracked.kt'];
      },
    );

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: true,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
      respectGitIgnore: true,
    });

    await fileSearch.initialize();
    await new Promise((resolve) => setImmediate(resolve));

    expect(await fileSearch.search('Tracked')).toContain('Tracked.kt');
    expect(gitFileList.listGitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--others', '--exclude-standard'] }),
    );
  });

  it('should index 100000 candidates without honoring maxFiles', async () => {
    const trackedFiles = Array.from(
      { length: 100000 },
      (_, index) => `generated/file-${index}.xml`,
    );
    trackedFiles.push('src/main/PreviewFragment.kt');
    vi.spyOn(gitFileList, 'listGitFiles').mockImplementation(
      async ({ args }) => (args.includes('--others') ? [] : trackedFiles),
    );

    tmpDir = await createTmpDir({ '.git': {} });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
      maxFiles: 1,
      respectGitIgnore: false,
    });

    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });
    await fileSearch.initialize();
    const results = await fileSearch.search('PreviewFragment');

    expect(eventLoopYielded).toBe(true);
    expect(results).toContain('src/main/PreviewFragment.kt');
    expect(gitFileList.listGitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--recurse-submodules'] }),
    );
  });

  it('should be cancellable via AbortSignal', async () => {
    const largeDir: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      largeDir[`file${i}.js`] = '';
    }
    tmpDir = await createTmpDir(largeDir);

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();

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
    tmpDir = await createTmpDir({
      src: {
        'foo.js': '',
        'bar.ts': '',
        nested: {
          'baz.js': '',
        },
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: true, // Enable caching for this test
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();

    // Perform a broad search to prime the cache
    const broadResults = await fileSearch.search('src/**');
    expect(broadResults).toEqual([
      'src/',
      'src/nested/',
      'src/bar.ts',
      'src/foo.js',
      'src/nested/baz.js',
    ]);

    // Perform a more specific search that should leverage the broad search's cached results
    const specificResults = await fileSearch.search('src/**/*.js');
    expect(specificResults).toEqual(['src/foo.js', 'src/nested/baz.js']);

    // Although we can't directly inspect ResultCache.hits/misses from here,
    // the correctness of specificResults after a broad search implicitly
    // verifies that the caching mechanism, including bestBaseQuery, is working.
  });

  it('should use smart-case matching', async () => {
    tmpDir = await createTmpDir({
      'PreviewFragment.kt': '',
      'play_preview_fragment.xml': '',
      'previewfragment.txt': '',
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();

    let results = await fileSearch.search('previewfragment');
    expect(results).toHaveLength(3);
    expect(results).toEqual(
      expect.arrayContaining([
        'PreviewFragment.kt',
        'play_preview_fragment.xml',
        'previewfragment.txt',
      ]),
    );

    results = await fileSearch.search('PreviewFragment');
    expect(results).toEqual(['PreviewFragment.kt']);

    results = await fileSearch.search('Preview*.kt');
    expect(results).toEqual(['PreviewFragment.kt']);
  });

  it('should respect maxResults even when the cache returns an exact match', async () => {
    tmpDir = await createTmpDir({
      'file1.js': '',
      'file2.js': '',
      'file3.js': '',
      'file4.js': '',
      'file5.js': '',
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: true, // Ensure caching is enabled
      cacheTtl: 10000,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();

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

  it('should handle file paths with special characters that need escaping', async () => {
    tmpDir = await createTmpDir({
      src: {
        'file with (special) chars.txt': '',
        'another-file.txt': '',
      },
    });

    const fileSearch = FileSearchFactory.create({
      projectRoot: tmpDir,
      fileDiscoveryService: new FileDiscoveryService(tmpDir, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
    });

    await fileSearch.initialize();

    // Search for the file using a pattern that contains special characters.
    // The `unescapePath` function should handle the escaped path correctly.
    const searchPattern = escapePath('src/file with (special) chars.txt');
    const results = await fileSearch.search(searchPattern);

    expect(results.map((r) => path.normalize(r))).toEqual([
      path.normalize('src/file with (special) chars.txt'),
    ]);
  });

  describe('DirectoryFileSearch', () => {
    it('should search for files in the current directory', async () => {
      tmpDir = await createTmpDir({
        'file1.js': '',
        'file2.ts': '',
        'file3.js': '',
      });

      const fileSearch = FileSearchFactory.create({
        projectRoot: tmpDir,
        fileDiscoveryService: new FileDiscoveryService(tmpDir, {
          respectGitIgnore: false,
          respectBrandIgnore: false,
        }),
        ignoreDirs: [],
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: false,
        enableFuzzySearch: true,
      });

      await fileSearch.initialize();
      const results = await fileSearch.search('*.js');
      expect(results).toEqual(['file1.js', 'file3.js']);
    });

    it('should search for files in a subdirectory', async () => {
      tmpDir = await createTmpDir({
        'file1.js': '',
        src: {
          'file2.js': '',
          'file3.ts': '',
        },
      });

      const fileSearch = FileSearchFactory.create({
        projectRoot: tmpDir,
        fileDiscoveryService: new FileDiscoveryService(tmpDir, {
          respectGitIgnore: false,
          respectBrandIgnore: false,
        }),
        ignoreDirs: [],
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: false,
        enableFuzzySearch: true,
      });

      await fileSearch.initialize();
      const results = await fileSearch.search('src/*.js');
      expect(results).toEqual(['src/file2.js']);
    });

    it('should list all files in a directory', async () => {
      tmpDir = await createTmpDir({
        'file1.js': '',
        src: {
          'file2.js': '',
          'file3.ts': '',
        },
      });

      const fileSearch = FileSearchFactory.create({
        projectRoot: tmpDir,
        fileDiscoveryService: new FileDiscoveryService(tmpDir, {
          respectGitIgnore: false,
          respectBrandIgnore: false,
        }),
        ignoreDirs: [],
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: false,
        enableFuzzySearch: true,
      });

      await fileSearch.initialize();
      const results = await fileSearch.search('src/');
      expect(results).toEqual(['src/file2.js', 'src/file3.ts']);
    });

    it('should respect ignore rules', async () => {
      tmpDir = await createTmpDir({
        '.git': {},
        '.gitignore': '*.js',
        'file1.js': '',
        'file2.ts': '',
      });

      const fileSearch = FileSearchFactory.create({
        projectRoot: tmpDir,
        fileDiscoveryService: new FileDiscoveryService(tmpDir, {
          respectGitIgnore: true,
          respectBrandIgnore: false,
        }),
        ignoreDirs: [],
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: false,
        enableFuzzySearch: true,
      });

      await fileSearch.initialize();
      const results = await fileSearch.search('*');
      expect(results).toEqual(['.gitignore', 'file2.ts']);
    });
  });
});
