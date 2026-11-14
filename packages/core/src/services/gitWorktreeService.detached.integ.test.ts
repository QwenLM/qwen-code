/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for detached managed worktrees (Codex parity, P3):
 * creation without a branch, lifecycle gates that judge by HEAD, and
 * coexistence with named-branch worktrees. Real git against a temp repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function initRepo(dir: string): Promise<void> {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init', '--no-verify');
}

describe('GitWorktreeService — detached managed worktrees', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;
  let service: GitWorktreeService;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-detached-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    await initRepo(repoRoot);
    service = new GitWorktreeService(repoRoot);
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function createDetached(slug: string) {
    const result = await service.createUserWorktree(slug, 'main', {
      detached: true,
    });
    expect(result.success).toBe(true);
    return result.worktree!;
  }

  it('creates a worktree in detached HEAD without a branch', async () => {
    const baseHead = git(repoRoot, 'rev-parse', 'HEAD');
    const worktree = await createDetached('sess-a');

    expect(worktree.branch).toBe('');
    expect(gitOk(worktree.path, 'symbolic-ref', 'HEAD')).toBe(false);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(baseHead);
    expect(git(repoRoot, 'branch', '--list', 'worktree-*')).toBe('');
  });

  it('coexists with named-branch worktrees', async () => {
    await createDetached('sess-detached');
    const named = await service.createUserWorktree('sess-named', 'main');
    expect(named.success).toBe(true);
    expect(named.worktree!.branch).toBe('worktree-sess-named');
    expect(
      git(
        repoRoot,
        'branch',
        '--list',
        'worktree-*',
        '--format=%(refname:short)',
      ),
    ).toBe('worktree-sess-named');
  });

  it('carries dirty state while staying detached at the base commit', async () => {
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty\n');
    await fs.writeFile(path.join(repoRoot, 'extra.txt'), 'untracked\n');
    const baseHead = git(repoRoot, 'rev-parse', 'HEAD');

    const result = await service.createUserWorktree('sess-dirty', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(result.success).toBe(true);
    const wt = result.worktree!;
    expect(await fs.readFile(path.join(wt.path, 'README.md'), 'utf8')).toBe(
      'dirty\n',
    );
    expect(await fs.readFile(path.join(wt.path, 'extra.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(baseHead);
    expect(gitOk(wt.path, 'symbolic-ref', 'HEAD')).toBe(false);
  });

  it('removeUserWorktree deletes a detached worktree without branchPreserved', async () => {
    const worktree = await createDetached('sess-remove');
    const result = await service.removeUserWorktree('sess-remove', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.branchPreserved).toBeFalsy();
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('hasUnmergedWorktreeCommits judges a detached worktree by HEAD', async () => {
    const worktree = await createDetached('sess-unmerged');

    // At the base commit: HEAD is reachable from main — nothing unique.
    expect(await service.hasUnmergedWorktreeCommits('sess-unmerged')).toBe(
      false,
    );

    // A commit made inside the detached worktree is unique.
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-q', '-m', 'session work', '--no-verify');
    expect(await service.hasUnmergedWorktreeCommits('sess-unmerged')).toBe(
      true,
    );

    // Once main contains the commit, it is covered again.
    const tip = git(worktree.path, 'rev-parse', 'HEAD');
    git(repoRoot, 'merge', '-q', '--no-edit', tip);
    expect(await service.hasUnmergedWorktreeCommits('sess-unmerged')).toBe(
      false,
    );
  });

  it('removePreparedUserWorktree removes a clean detached worktree at base', async () => {
    const worktree = await createDetached('sess-prepared');
    const baseCommit = git(repoRoot, 'rev-parse', 'HEAD');

    const result = await service.removePreparedUserWorktree(
      'sess-prepared',
      null,
      baseCommit,
    );
    expect(result.success).toBe(true);
    expect(result.branchPreserved).toBeFalsy();
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('removePreparedUserWorktree refuses a detached worktree with commits', async () => {
    const worktree = await createDetached('sess-prepared-dirty');
    const baseCommit = git(repoRoot, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-q', '-m', 'session work', '--no-verify');

    const result = await service.removePreparedUserWorktree(
      'sess-prepared-dirty',
      null,
      baseCommit,
    );
    expect(result.success).toBe(false);
    await expect(fs.lstat(worktree.path)).resolves.toBeTruthy();
  });

  it('getRegisteredWorktreeBranch reports a detached worktree with empty branch', async () => {
    const worktree = await createDetached('sess-registered');
    const info = await service.getRegisteredWorktreeBranch(worktree.path);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('');
    expect(info!.headCommit).toBe(git(repoRoot, 'rev-parse', 'HEAD'));
  });

  it('createWorktreeBranch branches a detached worktree at its HEAD', async () => {
    const worktree = await createDetached('sess-branch');
    const head = git(worktree.path, 'rev-parse', 'HEAD');

    await service.createWorktreeBranch(worktree.path, 'feat/from-detached');

    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/from-detached',
    );
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('createWorktreeBranch refuses a named worktree and a taken name', async () => {
    const named = await service.createUserWorktree('sess-named-2', 'main');
    expect(named.success).toBe(true);
    await expect(
      service.createWorktreeBranch(named.worktree!.path, 'feat/x'),
    ).rejects.toThrow(/not detached/);

    const detached = await createDetached('sess-branch-2');
    git(repoRoot, 'branch', 'feat/taken');
    await expect(
      service.createWorktreeBranch(detached.path, 'feat/taken'),
    ).rejects.toThrow(/already exists/);
  });

  it('removeUserWorktree refuses a detached worktree carrying unmerged commits', async () => {
    const worktree = await createDetached('sess-loss');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'precious\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');
    const tip = git(worktree.path, 'rev-parse', 'HEAD');

    const result = await service.removeUserWorktree('sess-loss', {
      deleteBranch: true,
    });

    expect(result.success).toBe(false);
    expect(result.branchPreserved).toBe(true);
    await expect(fs.lstat(worktree.path)).resolves.toBeTruthy();
    // The commit survives and stays reachable from the worktree HEAD.
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('removeUserWorktree deletes a detached worktree at base without commits', async () => {
    const worktree = await createDetached('sess-clean');
    const result = await service.removeUserWorktree('sess-clean', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('removeUserWorktree force delete opts out of the detached protection', async () => {
    const worktree = await createDetached('sess-force');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');

    const result = await service.removeUserWorktree('sess-force', {
      deleteBranch: true,
      forceDeleteBranch: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('removeUserWorktree deletes a detached worktree once its commits are merged', async () => {
    const worktree = await createDetached('sess-merged');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');
    const tip = git(worktree.path, 'rev-parse', 'HEAD');
    git(repoRoot, 'merge', '-q', '--no-edit', tip);

    const result = await service.removeUserWorktree('sess-merged', {
      deleteBranch: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });
});
