/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Ignore, loadIgnoreRules } from './ignore.js';
import type { LoadIgnoreRulesOptions } from './ignore.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../../test-utils/file-system-test-helpers.js';

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
}));

vi.mock('../debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

describe('Ignore', () => {
  describe('getDirectoryFilter', () => {
    it('should return a fresh predicate for each call', () => {
      const ig = new Ignore();
      expect(ig.getDirectoryFilter()).not.toBe(ig.getDirectoryFilter());
    });

    it('should ignore directories matching directory patterns', () => {
      const ig = new Ignore().add(['foo/', 'bar/']);
      const dirFilter = ig.getDirectoryFilter();
      expect(dirFilter('foo/')).toBe(true);
      expect(dirFilter('bar/')).toBe(true);
      expect(dirFilter('baz/')).toBe(false);
    });

    it('should not ignore directories with file patterns', () => {
      const ig = new Ignore().add(['foo.js', '*.log']);
      const dirFilter = ig.getDirectoryFilter();
      expect(dirFilter('foo.js')).toBe(false);
      expect(dirFilter('foo.log')).toBe(false);
    });
  });

  describe('getFileFilter', () => {
    it('should not ignore files with directory patterns', () => {
      const ig = new Ignore().add(['foo/', 'bar/']);
      const fileFilter = ig.getFileFilter();
      expect(fileFilter('foo')).toBe(false);
      expect(fileFilter('foo/file.txt')).toBe(false);
    });

    it('should ignore files matching file patterns', () => {
      const ig = new Ignore().add(['*.log', 'foo.js']);
      const fileFilter = ig.getFileFilter();
      expect(fileFilter('foo.log')).toBe(true);
      expect(fileFilter('foo.js')).toBe(true);
      expect(fileFilter('bar.txt')).toBe(false);
    });
  });

  it('should accumulate patterns across multiple add() calls', () => {
    const ig = new Ignore().add('foo.js');
    ig.add('bar.js');
    const fileFilter = ig.getFileFilter();
    expect(fileFilter('foo.js')).toBe(true);
    expect(fileFilter('bar.js')).toBe(true);
    expect(fileFilter('baz.js')).toBe(false);
  });

  it('should return a stable and consistent fingerprint', () => {
    const ig1 = new Ignore().add(['foo', '!bar']);
    const ig2 = new Ignore().add('foo\n!bar');

    // Fingerprints should be identical for the same rules.
    expect(ig1.getFingerprint()).toBe(ig2.getFingerprint());

    // Adding a new rule should change the fingerprint.
    ig2.add('baz');
    expect(ig1.getFingerprint()).not.toBe(ig2.getFingerprint());
  });

  it('should include addSource patterns in the fingerprint', () => {
    const ig1 = new Ignore().addSource('build/');
    const ig2 = new Ignore().addSource('dist/');

    expect(ig1.getFingerprint()).not.toBe(ig2.getFingerprint());
  });
});

describe('loadIgnoreRules', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
    }
  });

  // Options for tmpDir: ignore-file flags off, ignoreDirs [], unless overridden.
  const optionsFor = (opts: Partial<LoadIgnoreRulesOptions> = {}) => ({
    projectRoot: tmpDir,
    useGitignore: false,
    useQwenignore: false,
    ignoreDirs: [],
    ...opts,
  });

  async function load(
    files: Record<string, string>,
    opts: Partial<LoadIgnoreRulesOptions> = {},
  ) {
    tmpDir = await createTmpDir(files);
    return loadIgnoreRules(optionsFor(opts));
  }

  const loadFileFilter = async (
    files: Record<string, string>,
    opts: Partial<LoadIgnoreRulesOptions>,
  ) => (await load(files, opts)).getFileFilter();

  // Makes fs.readFileSync throw `error` for paths ending in `suffix`.
  function failReadOf(suffix: string, error: Error) {
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: BufferEncoding | null,
    ) => {
      if (String(filePath).endsWith(suffix)) {
        throw error;
      }
      return originalReadFileSync(filePath, options);
    }) as typeof fs.readFileSync);
  }

  it('should load rules from .gitignore', async () => {
    const fileFilter = await loadFileFilter(
      { '.gitignore': '*.log' },
      { useGitignore: true },
    );
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(false);
  });

  it('should load rules from .qwenignore', async () => {
    const fileFilter = await loadFileFilter(
      { '.qwenignore': '*.log' },
      { useQwenignore: true },
    );
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(false);
  });

  it('should load rules from .agentignore and .aiignore with qwenignore enabled', async () => {
    const fileFilter = await loadFileFilter(
      { '.agentignore': 'agent-secret.txt', '.aiignore': 'ai-secret.txt' },
      { useQwenignore: true },
    );
    expect(fileFilter('agent-secret.txt')).toBe(true);
    expect(fileFilter('ai-secret.txt')).toBe(true);
    expect(fileFilter('visible.txt')).toBe(false);
  });

  it('should apply .agentignore directory patterns to directory filtering', async () => {
    const ignore = await load(
      { '.agentignore': 'build/' },
      { useQwenignore: true },
    );
    const dirFilter = ignore.getDirectoryFilter();
    expect(dirFilter('build/')).toBe(true);
    expect(dirFilter('src/')).toBe(false);
  });

  it('should not let custom ignore negations unignore .qwenignore matches', async () => {
    const fileFilter = await loadFileFilter(
      { '.qwenignore': 'secrets/**', '.agentignore': '!secrets/**' },
      { useQwenignore: true },
    );
    expect(fileFilter('secrets/token.txt')).toBe(true);
  });

  it('should keep negations scoped to the same ignore file', async () => {
    const fileFilter = await loadFileFilter(
      { '.qwenignore': 'secrets/**\n!secrets/public.txt' },
      { useQwenignore: true },
    );
    expect(fileFilter('secrets/token.txt')).toBe(true);
    expect(fileFilter('secrets/public.txt')).toBe(false);
  });

  it('should load rules from configured custom ignore files with qwenignore enabled', async () => {
    const fileFilter = await loadFileFilter(
      {
        '.cursorignore': 'cursor-secret.txt',
        '.agentignore': 'agent-secret.txt',
      },
      { useQwenignore: true, customIgnoreFiles: ['.cursorignore'] },
    );
    expect(fileFilter('cursor-secret.txt')).toBe(true);
    expect(fileFilter('agent-secret.txt')).toBe(false);
    expect(fileFilter('visible.txt')).toBe(false);
  });

  it('should combine rules from .gitignore and .qwenignore', async () => {
    const fileFilter = await loadFileFilter(
      { '.gitignore': '*.log', '.qwenignore': '*.txt' },
      { useGitignore: true, useQwenignore: true },
    );
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(true);
    expect(fileFilter('test.md')).toBe(false);
  });

  it('should add ignoreDirs', async () => {
    const dirFilter = (
      await load({}, { ignoreDirs: ['logs/'] })
    ).getDirectoryFilter();
    expect(dirFilter('logs/')).toBe(true);
    expect(dirFilter('src/')).toBe(false);
  });

  it('should handle missing ignore files gracefully', async () => {
    const ignore = await load({}, { useGitignore: true, useQwenignore: true });
    expect(ignore.getFileFilter()('anyfile.txt')).toBe(false);
  });

  it('should handle ignore files that cannot be read gracefully', async () => {
    tmpDir = await createTmpDir({ '.qwenignore': '*.log' });
    failReadOf('.qwenignore', new Error('ignore file disappeared'));
    expect(() =>
      loadIgnoreRules(optionsFor({ useQwenignore: true })),
    ).not.toThrow();
  });

  it('should warn when an existing ignore file cannot be read', async () => {
    tmpDir = await createTmpDir({ '.agentignore': '*.log' });
    const error = new Error('permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    failReadOf('.agentignore', error);
    expect(() =>
      loadIgnoreRules(optionsFor({ useQwenignore: true })),
    ).not.toThrow();
    expect(mockDebugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read'),
    );
  });

  it('should always add .git to the ignore list', async () => {
    expect((await load({})).getDirectoryFilter()('.git/')).toBe(true);
  });
});
