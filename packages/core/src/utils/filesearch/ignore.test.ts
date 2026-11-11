/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { Ignore, loadIgnoreRules } from './ignore.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../../test-utils/file-system-test-helpers.js';
import { BRAND_IGNORE_FILE_NAME } from '../../config/constants.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';

describe('Ignore', () => {
  describe('getDirectoryFilter', () => {
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

  describe('getPathFilter', () => {
    it('should apply directory patterns to contained files', () => {
      const pathFilter = new Ignore().add('dist/').getPathFilter();

      expect(pathFilter('dist/index.js')).toBe(true);
      expect(pathFilter('src/index.js')).toBe(false);
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
});

describe('loadIgnoreRules', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
    }
  });

  it('should load rules from .gitignore', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': '*.log',
    });
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: true,
      respectBrandIgnore: false,
    });
    const ignore = loadIgnoreRules(service, []);
    const fileFilter = ignore.getFileFilter();
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(false);
  });

  it('should load rules from .geminiignore', async () => {
    tmpDir = await createTmpDir({
      [BRAND_IGNORE_FILE_NAME]: '*.log',
    });
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: false,
      respectBrandIgnore: true,
    });
    const ignore = loadIgnoreRules(service, []);
    const fileFilter = ignore.getFileFilter();
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(false);
  });

  it('should combine rules from .gitignore and .geminiignore', async () => {
    tmpDir = await createTmpDir({
      '.git': {},
      '.gitignore': '*.log',
      [BRAND_IGNORE_FILE_NAME]: '*.txt',
    });
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: true,
      respectBrandIgnore: true,
    });
    const ignore = loadIgnoreRules(service, []);
    const fileFilter = ignore.getFileFilter();
    expect(fileFilter('test.log')).toBe(true);
    expect(fileFilter('test.txt')).toBe(true);
    expect(fileFilter('test.md')).toBe(false);
  });

  it('should add ignoreDirs', async () => {
    tmpDir = await createTmpDir({});
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: false,
      respectBrandIgnore: false,
    });
    const ignore = loadIgnoreRules(service, ['logs/']);
    const dirFilter = ignore.getDirectoryFilter();
    expect(dirFilter('logs/')).toBe(true);
    expect(dirFilter('src/')).toBe(false);
  });

  it('should handle missing ignore files gracefully', async () => {
    tmpDir = await createTmpDir({});
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: true,
      respectBrandIgnore: true,
    });
    const ignore = loadIgnoreRules(service, []);
    const fileFilter = ignore.getFileFilter();
    expect(fileFilter('anyfile.txt')).toBe(false);
  });

  it('should always add .git to the ignore list', async () => {
    tmpDir = await createTmpDir({});
    const service = new FileDiscoveryService(tmpDir, {
      respectGitIgnore: false,
      respectBrandIgnore: false,
    });
    const ignore = loadIgnoreRules(service, []);
    const dirFilter = ignore.getDirectoryFilter();
    expect(dirFilter('.git/')).toBe(true);
  });

  it('should load .ignore and .rgignore from each standard root', async () => {
    tmpDir = await createTmpDir({
      '.ignore': ['/workspace/root-only.txt', '/sibling/sibling-only.txt'].join(
        '\n',
      ),
      workspace: {
        '.rgignore': '/workspace-only.txt',
      },
    });
    const workspaceRoot = path.join(tmpDir, 'workspace');
    const service = new FileDiscoveryService(workspaceRoot, {
      respectGitIgnore: false,
      respectBrandIgnore: false,
    });

    const ignore = loadIgnoreRules(service, [], {
      includeGitIgnore: false,
      standardIgnoreRoots: [tmpDir, workspaceRoot],
      candidateRoot: workspaceRoot,
    });
    const pathFilter = ignore.getPathFilter();

    expect(pathFilter('root-only.txt')).toBe(true);
    expect(pathFilter('workspace-only.txt')).toBe(true);
    expect(pathFilter('sibling-only.txt')).toBe(false);
    expect(pathFilter('visible.txt')).toBe(false);
  });
});
