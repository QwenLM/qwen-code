/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `createUserWorktree({ carryDirtyState })` — the
 * Codex-parity overlay that applies the source checkout's uncommitted
 * changes (tracked staged + unstaged, and untracked files) to a new
 * session worktree. Real git invocations against a temp repo, mirroring
 * gitWorktreeService.symlinks.integ.test.ts.
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

async function initRepo(dir: string): Promise<void> {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), 'readme-base\n');
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'clean\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init', '--no-verify');
}

/** Makes the source checkout dirty in all three shapes. */
async function makeDirty(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), 'dirty-unstaged\n');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'dirty-staged\n');
  git(root, 'add', 'tracked.txt');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'dirty-untracked\n');
}

const read = (p: string) => fs.readFile(p, 'utf8');

describe('GitWorktreeService.createUserWorktree() — carryDirtyState', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-dirty-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    await initRepo(repoRoot);
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function create(slug: string, carryDirtyState?: boolean) {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main', {
      carryDirtyState,
    });
    expect(result.success).toBe(true);
    return result.worktree!;
  }

  it('carries unstaged, staged, and untracked changes into the worktree', async () => {
    await makeDirty(repoRoot);
    const worktree = await create('carried', true);

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
    expect(await read(path.join(worktree.path, 'tracked.txt'))).toBe(
      'dirty-staged\n',
    );
    expect(await read(path.join(worktree.path, 'untracked.txt'))).toBe(
      'dirty-untracked\n',
    );
  });

  it('leaves the source checkout and index untouched', async () => {
    await makeDirty(repoRoot);
    // createUserWorktree itself adds .qwen/worktrees + a .gitignore to the
    // source repo; exclude that mechanism-owned entry from the comparison.
    const statusOf = () =>
      git(repoRoot, 'status', '--porcelain')
        .split('\n')
        .filter((line) => line !== '?? .qwen/')
        .join('\n');
    const statusBefore = statusOf();
    const stashBefore = git(repoRoot, 'stash', 'list');

    await create('source-intact', true);

    expect(statusOf()).toBe(statusBefore);
    expect(git(repoRoot, 'stash', 'list')).toBe(stashBefore);
    expect(await read(path.join(repoRoot, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
  });

  it('keeps the worktree HEAD at the base commit (no baseline commit)', async () => {
    await makeDirty(repoRoot);
    const sourceHead = git(repoRoot, 'rev-parse', 'HEAD');
    const worktree = await create('no-baseline', true);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(sourceHead);
  });

  it('without the option the worktree holds only committed state', async () => {
    await makeDirty(repoRoot);
    const worktree = await create('opt-out');

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'readme-base\n',
    );
    expect(await read(path.join(worktree.path, 'tracked.txt'))).toBe('clean\n');
    await expect(
      read(path.join(worktree.path, 'untracked.txt')),
    ).rejects.toThrow();
  });

  it('places untracked files at the repository offset when rooted at a subdirectory', async () => {
    const sub = path.join(repoRoot, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 't.txt'), 'clean\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'sub', '--no-verify');
    await fs.writeFile(path.join(sub, 't.txt'), 'dirty-staged\n');
    git(repoRoot, 'add', 'sub/t.txt');
    await fs.writeFile(path.join(sub, 'u.txt'), 'dirty-untracked\n');

    const service = new GitWorktreeService(sub);
    const result = await service.createUserWorktree('subdir', 'main', {
      carryDirtyState: true,
    });
    expect(result.success).toBe(true);
    const wtPath = result.worktree!.path;
    expect(await read(path.join(wtPath, 'sub', 't.txt'))).toBe(
      'dirty-staged\n',
    );
    expect(await read(path.join(wtPath, 'sub', 'u.txt'))).toBe(
      'dirty-untracked\n',
    );
  });

  it('fails open when an untracked file cannot be copied', async () => {
    await makeDirty(repoRoot);
    // A dangling symlink is listed by ls-files --others but copyFile fails;
    // creation must still succeed with the remaining overlay applied.
    await fs.symlink(
      path.join(repoRoot, 'missing-target'),
      path.join(repoRoot, 'broken-link'),
    );

    const worktree = await create('fail-open', true);

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
    expect(await read(path.join(worktree.path, 'untracked.txt'))).toBe(
      'dirty-untracked\n',
    );
  });
});
