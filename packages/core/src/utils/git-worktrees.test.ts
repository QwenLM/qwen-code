/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listGitWorktrees,
  parseGitWorktreeList,
  pruneGitWorktrees,
  removeGitWorktree,
} from './git-worktrees.js';

const tmpRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitworktrees-'));
  tmpRoots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('parseGitWorktreeList', () => {
  it('reads main, branch, detached, locked, prunable, and bare entries', () => {
    const raw = [
      'worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0',
      'worktree /wt/feat\0HEAD bbb\0branch refs/heads/feat\0locked busy now\0\0',
      'worktree /wt/detached\0HEAD ccc\0detached\0prunable gitdir file points to non-existent location\0\0',
      'worktree /wt/bare\0bare\0locked\0\0',
    ].join('');
    expect(parseGitWorktreeList(raw)).toEqual([
      {
        path: '/repo',
        head: 'aaa',
        branch: 'main',
        detached: false,
        bare: false,
        isMain: true,
      },
      {
        path: '/wt/feat',
        head: 'bbb',
        branch: 'feat',
        detached: false,
        bare: false,
        locked: 'busy now',
        isMain: false,
      },
      {
        path: '/wt/detached',
        head: 'ccc',
        branch: null,
        detached: true,
        bare: false,
        prunable: 'gitdir file points to non-existent location',
        isMain: false,
      },
      {
        path: '/wt/bare',
        head: '',
        branch: null,
        detached: false,
        bare: true,
        locked: '',
        isMain: false,
      },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseGitWorktreeList('')).toEqual([]);
  });
});

describe('listGitWorktrees', () => {
  it('lists the main worktree first, then linked ones with their state', async () => {
    const repo = makeRepo();
    // Linked worktrees list in directory order, so name them to sort.
    const linked = path.join(path.dirname(repo), 'a-linked');
    const detached = path.join(path.dirname(repo), 'b-detached');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    git(repo, 'worktree', 'add', '-q', '--detach', detached);
    git(repo, 'worktree', 'lock', linked, '--reason', 'in use');

    const entries = await listGitWorktrees(linked);
    expect(entries.map((e) => [e.isMain, e.branch, e.detached])).toEqual([
      [true, 'main', false],
      [false, 'feat', false],
      [false, null, true],
    ]);
    expect(fs.realpathSync(entries[0].path)).toBe(fs.realpathSync(repo));
    expect(entries[1].locked).toBe('in use');
    expect(entries[1].head).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[2].prunable).toBeUndefined();
  });

  it('rejects outside a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-norepo-'));
    tmpRoots.push(dir);
    await expect(listGitWorktrees(dir)).rejects.toThrow();
  });
});

describe('removeGitWorktree', () => {
  it('removes a clean worktree and refuses a dirty one without force', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    fs.writeFileSync(path.join(linked, 'dirty.txt'), 'x\n');

    await expect(removeGitWorktree(repo, linked)).rejects.toThrow();
    expect(fs.existsSync(linked)).toBe(true);

    await removeGitWorktree(repo, linked, { force: true });
    expect(fs.existsSync(linked)).toBe(false);
    expect((await listGitWorktrees(repo)).map((e) => e.branch)).toEqual([
      'main',
    ]);
    // The branch survives; only the checkout is gone.
    expect(git(repo, 'branch', '--list', 'feat').trim()).toBe('feat');
  });

  it('force-removes a locked worktree', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'locked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    git(repo, 'worktree', 'lock', linked);

    await expect(removeGitWorktree(repo, linked)).rejects.toThrow();
    await removeGitWorktree(repo, linked, { force: true });
    expect(fs.existsSync(linked)).toBe(false);
  });
});

describe('pruneGitWorktrees', () => {
  it('drops entries whose directory is gone', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'gone');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    fs.rmSync(linked, { recursive: true, force: true });

    const before = await listGitWorktrees(repo);
    expect(before).toHaveLength(2);
    expect(before[1].prunable).toBeTruthy();

    await pruneGitWorktrees(repo);
    expect(await listGitWorktrees(repo)).toHaveLength(1);
  });
});
