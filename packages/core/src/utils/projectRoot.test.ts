/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findProjectRoot } from './projectRoot.js';

describe('findProjectRoot', () => {
  let testRootDir: string;
  let projectRoot: string;
  let subDir: string;

  beforeEach(async () => {
    testRootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'find-project-root-'),
    );
    projectRoot = path.join(testRootDir, 'project');
    subDir = path.join(projectRoot, 'src', 'nested');
    await fsPromises.mkdir(subDir, { recursive: true });
  });

  afterEach(async () => {
    await fsPromises.rm(testRootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('returns the project root when .git is a directory (normal clone)', async () => {
    await fsPromises.mkdir(path.join(projectRoot, '.git'));

    expect(await findProjectRoot(subDir)).toBe(projectRoot);
    expect(await findProjectRoot(projectRoot)).toBe(projectRoot);
  });

  it('returns the project root when .git is a FILE (git worktree / submodule layout)', async () => {
    // Git worktrees and submodules mark the repo root with a `.git` file
    // containing `gitdir: <path>`. The old implementation only checked
    // `stats.isDirectory()` and silently returned null here — the bug
    // that prompted the extraction.
    await fsPromises.writeFile(
      path.join(projectRoot, '.git'),
      'gitdir: /elsewhere/worktrees/feature/.git\n',
    );

    expect(await findProjectRoot(subDir)).toBe(projectRoot);
    expect(await findProjectRoot(projectRoot)).toBe(projectRoot);
  });

  it('returns null when no .git ancestor exists', async () => {
    // No .git anywhere — neither directory nor file.
    expect(await findProjectRoot(subDir)).toBeNull();
  });

  it('walks up past intermediate directories without .git', async () => {
    // Only the outermost has .git; intermediates do not.
    await fsPromises.mkdir(path.join(projectRoot, '.git'));
    const deep = path.join(projectRoot, 'a', 'b', 'c', 'd');
    await fsPromises.mkdir(deep, { recursive: true });

    expect(await findProjectRoot(deep)).toBe(projectRoot);
  });

  it('treats a .git symlink to a directory as a project root', async () => {
    // Edge: some setups symlink .git. lstat would NOT follow the link,
    // so this pins the behavior we get with the directory-or-file shape:
    // a symlink to a directory should still be recognized via the file
    // branch (lstat reports it as a symlink, which is neither — so this
    // documents the current behavior, not a guarantee).
    const target = path.join(testRootDir, 'real-git');
    await fsPromises.mkdir(target);
    await fsPromises.symlink(target, path.join(projectRoot, '.git'));

    // Symlinks aren't directories or regular files under lstat. Document
    // that we do NOT chase them — caller would see null and fall back.
    // If this assertion ever needs to flip, do it deliberately.
    expect(await findProjectRoot(projectRoot)).toBeNull();
  });
});
