/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sparse-checkout coverage for worktree creation.
 *
 * This file deliberately does not mock `node:child_process`: the behaviour under
 * test is what Git actually materializes on disk, which a stubbed `git` cannot
 * demonstrate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  getOrCreateWorktree,
  getWorktreePath,
  worktreeBranchName,
} from './worktreeService.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    // Repository-level hooks would otherwise run against these fixtures.
    env: { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

describe('getOrCreateWorktree sparsePaths (real git)', { timeout: 60_000 }, () => {
  let root: string;
  let repoRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-sparse-'));
    repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });

    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'sparse@test.invalid');
    git(repoRoot, 'config', 'user.name', 'Sparse Test');
    git(repoRoot, 'config', 'core.hooksPath', '/dev/null');

    for (const dir of ['pkg-a', 'pkg-b', 'docs']) {
      await fs.mkdir(path.join(repoRoot, dir), { recursive: true });
      await fs.writeFile(path.join(repoRoot, dir, 'file.txt'), `${dir}\n`);
    }
    await fs.writeFile(path.join(repoRoot, 'root.txt'), 'root\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-qm', 'initial');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('checks out only the selected directories', async () => {
    const result = await getOrCreateWorktree(repoRoot, 'sparse-one', {
      baseRef: 'head',
      sparsePaths: ['pkg-a'],
    });

    expect(result.existed).toBe(false);
    expect(await exists(path.join(result.worktreePath, 'pkg-a/file.txt'))).toBe(
      true,
    );
    expect(await exists(path.join(result.worktreePath, 'pkg-b'))).toBe(false);
    expect(await exists(path.join(result.worktreePath, 'docs'))).toBe(false);
    // Cone mode always materializes top-level files.
    expect(await exists(path.join(result.worktreePath, 'root.txt'))).toBe(true);
  });

  it('leaves the sparse worktree with a clean Git status', async () => {
    const result = await getOrCreateWorktree(repoRoot, 'sparse-status', {
      baseRef: 'head',
      sparsePaths: ['pkg-a'],
    });

    expect(git(result.worktreePath, 'status', '--porcelain').trim()).toBe('');
  });

  it('supports several selected directories', async () => {
    const result = await getOrCreateWorktree(repoRoot, 'sparse-many', {
      baseRef: 'head',
      sparsePaths: ['pkg-a', 'docs'],
    });

    expect(await exists(path.join(result.worktreePath, 'pkg-a/file.txt'))).toBe(
      true,
    );
    expect(await exists(path.join(result.worktreePath, 'docs/file.txt'))).toBe(
      true,
    );
    expect(await exists(path.join(result.worktreePath, 'pkg-b'))).toBe(false);
  });

  it('accepts a directory written with a trailing separator', async () => {
    // `pkg-a/` is how directories are written in gitignore and sparse-checkout,
    // so it must not be rejected as an empty path segment.
    const result = await getOrCreateWorktree(repoRoot, 'sparse-trailing', {
      baseRef: 'head',
      sparsePaths: ['pkg-a/'],
    });

    expect(await exists(path.join(result.worktreePath, 'pkg-a/file.txt'))).toBe(
      true,
    );
    expect(await exists(path.join(result.worktreePath, 'pkg-b'))).toBe(false);
  });

  it('checks out the whole tree when no sparsePaths are configured', async () => {
    const result = await getOrCreateWorktree(repoRoot, 'sparse-none', {
      baseRef: 'head',
    });

    for (const dir of ['pkg-a', 'pkg-b', 'docs']) {
      expect(await exists(path.join(result.worktreePath, dir, 'file.txt'))).toBe(
        true,
      );
    }
  });

  it.each([false, true])(
    'repairs an interrupted sparse checkout with persisted sparse config: %s',
    async (configured) => {
      const slug = 'sparse-resume';
      const worktreePath = getWorktreePath(repoRoot, slug);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      git(
        repoRoot,
        'worktree',
        'add',
        '--no-track',
        '--no-checkout',
        '-B',
        worktreeBranchName(slug),
        worktreePath,
        'HEAD',
      );
      if (configured) {
        // sparse-checkout 在写入索引前先保存配置；两步之间中断不能被判定为检出完成。
        git(worktreePath, 'config', 'core.sparseCheckout', 'true');
      }
      expect(await exists(path.join(worktreePath, 'pkg-a/file.txt'))).toBe(false);

      const resumed = await getOrCreateWorktree(repoRoot, slug, {
        baseRef: 'head',
        sparsePaths: ['pkg-a'],
      });

      expect(resumed.existed).toBe(true);
      expect(await exists(path.join(worktreePath, 'pkg-a/file.txt'))).toBe(true);
      expect(await exists(path.join(worktreePath, 'pkg-b'))).toBe(false);
    },
  );

  it('does not rewrite the cone of a completed sparse worktree on resume', async () => {
    const initial = await getOrCreateWorktree(repoRoot, 'sparse-stable', {
      baseRef: 'head',
      sparsePaths: ['pkg-a'],
    });

    const resumed = await getOrCreateWorktree(repoRoot, 'sparse-stable', {
      baseRef: 'head',
      sparsePaths: ['pkg-b'],
    });

    expect(resumed.existed).toBe(true);
    expect(await exists(path.join(initial.worktreePath, 'pkg-a/file.txt'))).toBe(
      true,
    );
    expect(await exists(path.join(initial.worktreePath, 'pkg-b'))).toBe(false);
  });

  it.each([
    ['an absolute path', '/etc'],
    ['a parent traversal', '../outside'],
    ['a nested parent traversal', 'pkg-a/../../outside'],
    ['a bare dot', '.'],
    ['an empty entry', ''],
  ])('rejects %s without creating a worktree', async (_label, candidate) => {
    const slug = 'sparse-invalid';

    await expect(
      getOrCreateWorktree(repoRoot, slug, {
        baseRef: 'head',
        sparsePaths: [candidate],
      }),
    ).rejects.toThrow(/Invalid worktree sparsePaths entry/);

    expect(await exists(getWorktreePath(repoRoot, slug))).toBe(false);
    expect(git(repoRoot, 'worktree', 'list')).not.toContain(slug);
  });

  it('leaves no worktree or orphan branch when creation fails', async () => {
    const slug = 'sparse-broken';
    // An occupied target makes `git worktree add` fail, but `-B` has already
    // created the branch by then.
    await fs.mkdir(getWorktreePath(repoRoot, slug), { recursive: true });
    await fs.writeFile(
      path.join(getWorktreePath(repoRoot, slug), 'occupied.txt'),
      'in the way\n',
    );

    await expect(
      getOrCreateWorktree(repoRoot, slug, {
        baseRef: 'head',
        sparsePaths: ['pkg-a'],
      }),
    ).rejects.toThrow(/Failed to create worktree/);

    expect(git(repoRoot, 'worktree', 'list')).not.toContain(slug);
    expect(git(repoRoot, 'branch', '--list')).not.toContain(
      worktreeBranchName(slug),
    );
  });

  it('preserves a pre-existing branch when creation fails', async () => {
    // Git validates the target path before `-B` takes effect, so a branch that
    // already carries user commits must survive a failed creation.
    const slug = 'sparse-existing';
    const branch = worktreeBranchName(slug);

    git(repoRoot, 'branch', branch);
    await fs.writeFile(path.join(repoRoot, 'user-work.txt'), 'precious\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-qm', 'user work');
    git(repoRoot, 'branch', '-f', branch, 'HEAD');
    const preservedSha = git(repoRoot, 'rev-parse', branch).trim();

    await fs.mkdir(getWorktreePath(repoRoot, slug), { recursive: true });
    await fs.writeFile(
      path.join(getWorktreePath(repoRoot, slug), 'occupied.txt'),
      'in the way\n',
    );

    await expect(
      getOrCreateWorktree(repoRoot, slug, {
        baseRef: 'head',
        sparsePaths: ['pkg-a'],
      }),
    ).rejects.toThrow(/Failed to create worktree/);

    expect(git(repoRoot, 'rev-parse', branch).trim()).toBe(preservedSha);
  });

  it('refuses to reset a pre-existing branch with committed work', async () => {
    const slug = 'sparse-committed';
    const branch = worktreeBranchName(slug);

    git(repoRoot, 'switch', '-q', '-c', branch);
    await fs.writeFile(path.join(repoRoot, 'precious.txt'), 'keep me\n');
    git(repoRoot, 'add', 'precious.txt');
    git(repoRoot, 'commit', '-qm', 'precious worktree commit');
    const preservedSha = git(repoRoot, 'rev-parse', 'HEAD').trim();
    git(repoRoot, 'switch', '-q', 'main');

    await expect(
      getOrCreateWorktree(repoRoot, slug, {
        baseRef: 'head',
        sparsePaths: ['pkg-a'],
      }),
    ).rejects.toThrow(/Refusing to reset existing worktree branch/);

    expect(git(repoRoot, 'rev-parse', branch).trim()).toBe(preservedSha);
    expect(await exists(getWorktreePath(repoRoot, slug))).toBe(false);
  });
});
