/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTmpDir,
  createTmpDir,
} from '../../test-utils/file-system-test-helpers.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { FileSearchFactory, type FileSearch } from './fileSearch.js';
import * as gitFileList from './gitFileList.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function waitForSearchResult(
  search: FileSearch,
  pattern: string,
  expectedPath: string,
): Promise<string[]> {
  const deadline = Date.now() + 3000;
  let results: string[] = [];
  do {
    results = await search.search(pattern);
    if (results.includes(expectedPath)) return results;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return results;
}

describe('FileSearch Git integration', () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) await cleanupTmpDir(repoRoot);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses tracked files first, merges untracked files, and keeps workspace boundaries', async () => {
    repoRoot = await createTmpDir({
      '.gitignore': 'workspace/Ignored*.kt',
      '.ignore': '/workspace/RootHidden.kt',
      sibling: ['Sibling.kt'],
      workspace: {
        '.rgignore': 'LocalHidden.kt',
        'PreviewFragment.kt': '',
        'IgnoredTracked.kt': '',
        'IgnoredUntracked.kt': '',
        'UntrackedVisible.kt': '',
        'RootHidden.kt': '',
        'LocalHidden.kt': '',
      },
    });
    const workspaceRoot = path.join(repoRoot, 'workspace');

    await git(repoRoot, ['init', '-q']);
    await git(repoRoot, [
      'add',
      '.gitignore',
      '.ignore',
      'sibling/Sibling.kt',
      'workspace/.rgignore',
      'workspace/PreviewFragment.kt',
      'workspace/RootHidden.kt',
      'workspace/LocalHidden.kt',
    ]);
    await git(repoRoot, ['add', '-f', 'workspace/IgnoredTracked.kt']);
    vi.stubEnv('GIT_DIR', path.join(repoRoot, 'missing-git-dir'));
    vi.stubEnv('GIT_WORK_TREE', path.join(repoRoot, 'missing-worktree'));

    const search = FileSearchFactory.create({
      projectRoot: workspaceRoot,
      fileDiscoveryService: new FileDiscoveryService(workspaceRoot, {
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

    await search.initialize();

    expect(await search.search('PreviewFragment')).toContain(
      'PreviewFragment.kt',
    );
    expect(await search.search('IgnoredTracked')).toContain(
      'IgnoredTracked.kt',
    );
    expect(await search.search('RootHidden')).toEqual([]);
    expect(await search.search('LocalHidden')).toEqual([]);
    expect(await search.search('Sibling')).toEqual([]);

    expect(
      await waitForSearchResult(
        search,
        'UntrackedVisible',
        'UntrackedVisible.kt',
      ),
    ).toContain('UntrackedVisible.kt');
    expect(await search.search('IgnoredUntracked')).toEqual([]);

    const realListGitFiles = gitFileList.listGitFiles;
    const listSpy = vi
      .spyOn(gitFileList, 'listGitFiles')
      .mockImplementation((options) =>
        options.args.includes('--others')
          ? Promise.reject(new Error('untracked refresh failed'))
          : realListGitFiles(options),
      );
    await search.search('PreviewFragment');
    expect(
      listSpy.mock.calls.filter(([options]) =>
        options.args.includes('--recurse-submodules'),
      ),
    ).toHaveLength(0);

    vi.unstubAllEnvs();
    await fs.writeFile(path.join(workspaceRoot, 'AddedLater.kt'), '');
    await git(repoRoot, ['add', 'workspace/AddedLater.kt']);
    await Promise.all([
      search.search('AddedLater'),
      search.search('AddedLater'),
    ]);
    expect(
      await waitForSearchResult(search, 'AddedLater', 'AddedLater.kt'),
    ).toContain('AddedLater.kt');
    expect(await search.search('UntrackedVisible')).toContain(
      'UntrackedVisible.kt',
    );
    expect(
      listSpy.mock.calls.filter(([options]) =>
        options.args.includes('--recurse-submodules'),
      ),
    ).toHaveLength(1);
    expect(
      listSpy.mock.calls.filter(([options]) =>
        options.args.includes('--others'),
      ),
    ).toHaveLength(1);
  });

  it('includes gitignored untracked files when respectGitIgnore is false', async () => {
    repoRoot = await createTmpDir({
      '.gitignore': 'workspace/IgnoredUntracked.kt',
      workspace: {
        'Tracked.kt': '',
        'IgnoredUntracked.kt': '',
      },
    });
    const workspaceRoot = path.join(repoRoot, 'workspace');

    await git(repoRoot, ['init', '-q']);
    await git(repoRoot, ['add', '.gitignore', 'workspace/Tracked.kt']);

    const search = FileSearchFactory.create({
      projectRoot: workspaceRoot,
      fileDiscoveryService: new FileDiscoveryService(workspaceRoot, {
        respectGitIgnore: false,
        respectBrandIgnore: false,
      }),
      ignoreDirs: [],
      cache: false,
      cacheTtl: 0,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
      respectGitIgnore: false,
    });

    await search.initialize();

    expect(
      await waitForSearchResult(
        search,
        'IgnoredUntracked',
        'IgnoredUntracked.kt',
      ),
    ).toContain('IgnoredUntracked.kt');
  });
});
