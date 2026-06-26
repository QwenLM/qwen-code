/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAutoMemoryRootCache,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
  isTeamAutoMemPath,
  TEAM_AUTO_MEMORY_DIRNAME,
} from './paths.js';
describe('team auto-memory paths', () => {
  let projectRoot: string;

  beforeEach(() => {
    // A temp dir with a .git directory so it reads as the canonical git root.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-team-'));
    fs.mkdirSync(path.join(projectRoot, '.git'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    clearAutoMemoryRootCache();
  });

  it('anchors the team root inside the repo .qwen directory', () => {
    expect(getTeamAutoMemoryRoot(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
    );
  });

  it('uses the current linked worktree root instead of the common git root', () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-main-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-wt-'));
    try {
      const worktreeGitDir = path.join(main, '.git', 'worktrees', 'qwen-wt');
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktree, '.git'),
        `gitdir: ${worktreeGitDir}`,
      );
      fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..');
      fs.writeFileSync(
        path.join(worktreeGitDir, 'gitdir'),
        path.join(worktree, '.git'),
      );

      expect(getTeamAutoMemoryRoot(worktree)).toBe(
        path.join(worktree, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
      );
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('places MEMORY.md at the team root', () => {
    expect(getTeamAutoMemoryIndexPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', TEAM_AUTO_MEMORY_DIRNAME, 'MEMORY.md'),
    );
  });

  it('contains paths inside the team root and rejects escapes', () => {
    const root = getTeamAutoMemoryRoot(projectRoot);
    expect(isTeamAutoMemPath(root, projectRoot)).toBe(true);
    expect(
      isTeamAutoMemPath(path.join(root, 'feedback/x.md'), projectRoot),
    ).toBe(true);
    expect(
      isTeamAutoMemPath(path.join(root, '..', 'escape.md'), projectRoot),
    ).toBe(false);
  });

  it('recognizes a first-ever write before the team-memory dir exists', () => {
    const root = getTeamAutoMemoryRoot(projectRoot);
    // Normal first-write state: nothing under .qwen has been created yet, so
    // realpathNearestExisting must walk up to an existing ancestor (the repo
    // root) and still classify the not-yet-created file as a team path.
    expect(fs.existsSync(root)).toBe(false);
    expect(
      isTeamAutoMemPath(path.join(root, 'feedback', 'new.md'), projectRoot),
    ).toBe(true);
  });

  it('recognizes new files under a symlinked team-memory directory', () => {
    const root = getTeamAutoMemoryRoot(projectRoot);
    fs.mkdirSync(root, { recursive: true });
    const alias = path.join(projectRoot, 'alias');
    fs.symlinkSync(root, alias, 'dir');

    expect(isTeamAutoMemPath(path.join(alias, 'leak.md'), projectRoot)).toBe(
      true,
    );
  });

  it('clearAutoMemoryRootCache invalidates the team root cache', () => {
    // A fresh dir with no git ancestor, so the first resolution falls back to
    // the nested path itself; adding a `.git` later changes the canonical root.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cache-'));
    const nested = path.join(fresh, 'pkg');
    fs.mkdirSync(nested, { recursive: true });
    try {
      // Primes the cache with the no-git fallback (nested itself).
      expect(getTeamAutoMemoryRoot(nested)).toBe(
        path.join(nested, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
      );
      fs.mkdirSync(path.join(fresh, '.git'));
      clearAutoMemoryRootCache();
      // After clearing, it must re-resolve to the new git root.
      expect(getTeamAutoMemoryRoot(nested)).toBe(
        path.join(fresh, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
      );
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
