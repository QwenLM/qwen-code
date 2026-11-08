/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import { getFolderStructure } from './getFolderStructure.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import * as path from 'node:path';

describe('getFolderStructure', () => {
  let testRootDir: string;

  async function createEmptyDir(...pathSegments: string[]) {
    const fullPath = path.join(testRootDir, ...pathSegments);
    await fsPromises.mkdir(fullPath, { recursive: true });
  }

  // Creates an empty file at each path, given as segments under the root.
  async function createTestFiles(...files: string[][]) {
    for (const pathSegments of files) {
      const fullPath = path.join(testRootDir, ...pathSegments);
      await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
      await fsPromises.writeFile(fullPath, '');
    }
  }

  // The lines every rendering starts with: the item budget, then the root.
  const treeHeader = (maxItems: number) =>
    `Showing up to ${maxItems} items:\n\n${testRootDir}${path.sep}`;

  beforeEach(async () => {
    testRootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'folder-structure-test-'),
    );
  });

  afterEach(async () => {
    await fsPromises.rm(testRootDir, { recursive: true, force: true });
  });

  const createABFiles = () =>
    createTestFiles(['fileA1.ts'], ['fileA2.js'], ['subfolderB', 'fileB1.md']);

  it('should return basic folder structure', async () => {
    await createABFiles();

    const structure = await getFolderStructure(testRootDir);
    expect(structure.trim()).toBe(`${treeHeader(20)}
├───fileA1.ts
├───fileA2.js
└───subfolderB${path.sep}
    └───fileB1.md`);
  });

  it('should handle an empty folder', async () => {
    const structure = await getFolderStructure(testRootDir);
    expect(structure.trim()).toBe(treeHeader(20));
  });

  it('should ignore folders specified in ignoredFolders (default)', async () => {
    await createTestFiles(['.hiddenfile'], ['file1.txt']);
    await createEmptyDir('emptyFolder');
    await createTestFiles(
      ['node_modules', 'somepackage', 'index.js'],
      ['subfolderA', 'fileA1.ts'],
      ['subfolderA', 'fileA2.js'],
      ['subfolderA', 'subfolderB', 'fileB1.md'],
    );

    const structure = await getFolderStructure(testRootDir);
    expect(structure.trim()).toBe(`${treeHeader(20)}
├───.hiddenfile
├───file1.txt
├───emptyFolder${path.sep}
├───node_modules${path.sep}...
└───subfolderA${path.sep}
    ├───fileA1.ts
    ├───fileA2.js
    └───subfolderB${path.sep}
        └───fileB1.md`);
  });

  it('should ignore folders specified in custom ignoredFolders', async () => {
    await createTestFiles(['.hiddenfile'], ['file1.txt']);
    await createEmptyDir('emptyFolder');
    await createTestFiles(
      ['node_modules', 'somepackage', 'index.js'],
      ['subfolderA', 'fileA1.ts'],
    );

    const structure = await getFolderStructure(testRootDir, {
      ignoredFolders: new Set(['subfolderA', 'node_modules']),
    });
    expect(structure.trim()).toBe(`${treeHeader(20)}
├───.hiddenfile
├───file1.txt
├───emptyFolder${path.sep}
├───node_modules${path.sep}...
└───subfolderA${path.sep}...`);
  });

  it('should filter files by fileIncludePattern', async () => {
    await createABFiles();

    const structure = await getFolderStructure(testRootDir, {
      fileIncludePattern: /\.ts$/,
    });
    expect(structure.trim()).toBe(`${treeHeader(20)}
├───fileA1.ts
└───subfolderB${path.sep}`);
  });

  it('should handle maxItems truncation for files within a folder', async () => {
    await createABFiles();

    const structure = await getFolderStructure(testRootDir, { maxItems: 3 });
    expect(structure.trim()).toBe(`${treeHeader(3)}
├───fileA1.ts
├───fileA2.js
└───subfolderB${path.sep}
    └───...`);
  });

  it('should handle maxItems truncation for subfolders', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestFiles([`folder-${i}`, 'child.txt']);
    }

    const structure = await getFolderStructure(testRootDir, { maxItems: 4 });
    expect(structure.trim()).toBe(`${treeHeader(4)}
├───folder-0${path.sep}
│   └───...
├───folder-1${path.sep}
│   └───...
├───folder-2${path.sep}
│   └───...
├───folder-3${path.sep}
│   └───...
└───...`);
  });

  it('should handle maxItems that only allows the root folder itself', async () => {
    await createTestFiles(
      ['fileA1.ts'],
      ['fileA2.ts'],
      ['subfolderB', 'fileB1.ts'],
    );

    const structure = await getFolderStructure(testRootDir, { maxItems: 1 });
    expect(structure.trim()).toBe(`${treeHeader(1)}
├───fileA1.ts
├───...
└───...`);
  });

  it('should handle non-existent directory', async () => {
    const nonExistentPath = path.join(testRootDir, 'non-existent');
    const structure = await getFolderStructure(nonExistentPath);
    expect(structure).toContain(
      `Error: Could not read directory "${nonExistentPath}". Check path and permissions.`,
    );
  });

  it('should handle deep folder structure within limits', async () => {
    await createTestFiles(['level1', 'level2', 'level3', 'file.txt']);

    const structure = await getFolderStructure(testRootDir, { maxItems: 10 });
    expect(structure.trim()).toBe(`${treeHeader(10)}
└───level1${path.sep}
    └───level2${path.sep}
        └───level3${path.sep}
            └───file.txt`);
  });

  it('should truncate deep folder structure if maxItems is small', async () => {
    await createTestFiles(['level1', 'level2', 'level3', 'file.txt']);

    const structure = await getFolderStructure(testRootDir, { maxItems: 3 });
    expect(structure.trim()).toBe(`${treeHeader(3)}
└───level1${path.sep}
    └───level2${path.sep}
        └───level3${path.sep}
            └───...`);
  });

  // A folder queued but never expanded was rendered as a bare leaf, exactly
  // like a genuinely empty folder, so the same tree described `withContents`
  // as empty or not depending only on the budget.
  it('marks a folder whose contents the budget never reached', async () => {
    await createTestFiles(['a.txt'], ['withContents', 'hidden.txt']);

    const truncated = await getFolderStructure(testRootDir, { maxItems: 2 });
    const complete = await getFolderStructure(testRootDir, { maxItems: 50 });

    expect(truncated).toContain(`withContents${path.sep}`);
    expect(truncated).toContain('...');
    // The file is out of budget either way; what matters is that the folder is
    // not presented as fully known.
    expect(truncated).not.toContain('hidden.txt');

    // Guard against over-correcting: given room, the folder expands and no
    // truncation indicator appears anywhere.
    expect(complete).toContain('hidden.txt');
    expect(complete).not.toContain('...');
  });

  // The other direction: a folder that really is empty and really was read
  // must not gain a marker suggesting there is more to see.
  it('does not mark an empty folder that was fully read', async () => {
    await createEmptyDir('genuinelyEmpty');

    const structure = await getFolderStructure(testRootDir, { maxItems: 50 });

    expect(structure).toContain(`genuinelyEmpty${path.sep}`);
    expect(structure).not.toContain('...');
  });

  // Writes `ignoreFile` with `rules`, then files the rules may hide or keep.
  async function createIgnoreFixture(ignoreFile: string, rules: string) {
    await fsPromises.writeFile(path.join(testRootDir, ignoreFile), rules);
    await createTestFiles(
      ['file1.txt'],
      ['node_modules', 'some-package', 'index.js'],
      ['ignored.txt'],
      ['.gemini', 'config.yaml'],
      ['.gemini', 'logs.json'],
    );
  }

  const structureWithFileService = (
    options: Parameters<typeof getFolderStructure>[1] = {},
  ) =>
    getFolderStructure(testRootDir, {
      fileService: new FileDiscoveryService(testRootDir),
      ...options,
    });

  describe('with gitignore', () => {
    beforeEach(async () => {
      await createEmptyDir('.git');
    });

    it('should ignore files and folders specified in .gitignore', async () => {
      await createIgnoreFixture(
        '.gitignore',
        'ignored.txt\nnode_modules/\n.gemini/*\n!/.gemini/config.yaml',
      );

      const structure = await structureWithFileService();

      expect(structure).not.toContain('ignored.txt');
      expect(structure).toContain(`node_modules${path.sep}...`);
      expect(structure).not.toContain('logs.json');
      expect(structure).toContain('config.yaml');
      expect(structure).toContain('file1.txt');
    });

    it('should not ignore files if respectGitIgnore is false', async () => {
      await fsPromises.writeFile(
        path.join(testRootDir, '.gitignore'),
        'ignored.txt',
      );
      await createTestFiles(['file1.txt'], ['ignored.txt']);

      const structure = await structureWithFileService({
        fileFilteringOptions: {
          respectQwenIgnore: false,
          respectGitIgnore: false,
        },
      });

      expect(structure).toContain('ignored.txt');
      expect(structure).toContain('file1.txt');
    });
  });

  describe('with qwenignore', () => {
    const qwenignoreRules =
      'ignored.txt\nnode_modules/\n.gemini/\n!/.gemini/config.yaml';

    it('should ignore qwenignore files by default', async () => {
      await createIgnoreFixture('.qwenignore', qwenignoreRules);

      const structure = await structureWithFileService();
      expect(structure).not.toContain('ignored.txt');
      expect(structure).toContain(`node_modules${path.sep}...`);
      expect(structure).not.toContain('logs.json');
    });

    it('should not ignore files if respectQwenIgnore is false', async () => {
      await createIgnoreFixture('.qwenignore', qwenignoreRules);

      const structure = await structureWithFileService({
        fileFilteringOptions: {
          respectQwenIgnore: false,
          respectGitIgnore: true, // Explicitly disable gemini ignore only
        },
      });
      expect(structure).toContain('ignored.txt');
      // node_modules is still ignored by default
      expect(structure).toContain(`node_modules${path.sep}...`);
    });
  });
});
