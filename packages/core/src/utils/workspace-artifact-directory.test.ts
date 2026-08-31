/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  chmod,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  collectRecordableWorkspaceFiles,
  pathHasSkippedDirectoryComponent,
} from './workspace-artifact-directory.js';

describe('collectRecordableWorkspaceFiles', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function workspace() {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'artifact-dir-')),
    );
    dirs.push(root);
    return root;
  }

  it('skips junk directories, lock files, hidden names, and symlink entries', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'junk.txt'), 'x');
    await mkdir(path.join(root, 'keep'), { recursive: true });
    await writeFile(path.join(root, 'keep', 'report.xlsx'), 'xlsx');
    await writeFile(path.join(root, '.hidden.xlsx'), 'hidden');
    await writeFile(path.join(root, '~$lock.xlsx'), 'lock');
    await writeFile(path.join(root, 'real.txt'), 'real');
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'));

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files.sort()).toEqual(['keep/report.xlsx', 'real.txt']);
    expect(collected.truncated).toBe(false);
    expect(collected.depthLimited).toBe(false);
    expect(collected.unreadable).toBe(false);
    expect(collected.skippedUnrecordable).toBe(0);
  });

  it('counts files rejected by the recordable predicate', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'keep.txt'), 'ok');
    await writeFile(path.join(root, 'draft.txt'), 'bad');

    const collected = await collectRecordableWorkspaceFiles(
      root,
      '',
      root,
      (relativePath) => relativePath !== 'draft.txt',
    );
    expect(collected.files).toEqual(['keep.txt']);
    expect(collected.skippedUnrecordable).toBe(1);
  });

  it('does not treat a worktree-prefixed subdirectory as skipped', () => {
    expect(
      pathHasSkippedDirectoryComponent('.qwen/worktrees/my-feature/reports'),
    ).toBe(false);
    expect(
      pathHasSkippedDirectoryComponent(
        '.qwen/worktrees/my-feature/node_modules',
      ),
    ).toBe(true);
    expect(pathHasSkippedDirectoryComponent('.qwen/skills')).toBe(true);
  });

  it('records a regular file named after a skipped directory', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'dist'), 'plain');
    await writeFile(path.join(root, 'keep.xlsx'), 'xlsx');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files.sort()).toEqual(['dist', 'keep.xlsx']);
  });

  it('does not flag depth limits for an empty over-deep directory chain', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    await writeFile(path.join(root, 'shallow.xlsx'), 'xlsx');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files).toEqual(['shallow.xlsx']);
    expect(collected.depthLimited).toBe(false);
  });

  it('does not flag depth limits when the over-deep directory only has skipped names', async () => {
    const root = await workspace();
    const deepDir = path.join(root, 'a', 'b', 'c', 'd', 'e');
    await mkdir(deepDir, { recursive: true });
    await writeFile(path.join(deepDir, '.DS_Store'), 'junk');
    await writeFile(path.join(root, 'shallow.xlsx'), 'xlsx');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files).toEqual(['shallow.xlsx']);
    expect(collected.depthLimited).toBe(false);
  });

  it('does not flag depth limits for an empty directory nested below a skipped-empty parent', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'a', 'b', 'c', 'd', 'e', 'f'), {
      recursive: true,
    });
    await writeFile(path.join(root, 'shallow.xlsx'), 'xlsx');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files).toEqual(['shallow.xlsx']);
    expect(collected.depthLimited).toBe(false);
  });

  it('signals depth-limited truncation instead of silently dropping deep files', async () => {
    const root = await workspace();
    const deepParts = Array.from(
      { length: MAX_DIRECTORY_ARTIFACT_DEPTH + 2 },
      (_, index) => `d${index}`,
    );
    const deepDir = path.join(root, ...deepParts);
    await mkdir(deepDir, { recursive: true });
    await writeFile(path.join(deepDir, 'deep.xlsx'), 'deep');
    await writeFile(path.join(root, 'shallow.xlsx'), 'shallow');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files).toEqual(['shallow.xlsx']);
    expect(collected.truncated).toBe(false);
    expect(collected.depthLimited).toBe(true);
  });

  it('treats an unreadable over-depth directory as depth-limited', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return;
    }
    const root = await workspace();
    const deepParts = Array.from(
      { length: MAX_DIRECTORY_ARTIFACT_DEPTH + 1 },
      (_, index) => `d${index}`,
    );
    const deepDir = path.join(root, ...deepParts);
    await mkdir(deepDir, { recursive: true });
    await writeFile(path.join(root, 'shallow.xlsx'), 'shallow');
    await chmod(deepDir, 0o000);
    try {
      const collected = await collectRecordableWorkspaceFiles(root, '', root);
      expect(collected.files).toEqual(['shallow.xlsx']);
      expect(collected.depthLimited).toBe(true);
    } finally {
      await chmod(deepDir, 0o755);
    }
  });
});
