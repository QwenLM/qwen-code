/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git`. The bug these lock down only exists in git's own bookkeeping —
// a mocked child_process would happily "pass" against a fiction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseWorktree } from './git.js';

let repo: string;
let cwd: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-wt-'));
  git('init', '-q', '.');
  git(
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  cwd = process.cwd();
  // `releaseWorktree` shells out to `git` with no cwd, so it acts on the
  // process's directory. Point that at the fixture.
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('releaseWorktree', () => {
  it('removes a live worktree and reports that it was there', () => {
    git('worktree', 'add', '-q', 'wt', '-b', 'topic');
    expect(existsSync(join(repo, 'wt'))).toBe(true);

    expect(releaseWorktree(join(repo, 'wt'))).toBe(true);

    expect(existsSync(join(repo, 'wt'))).toBe(false);
    // Not `.not.toContain('wt')` — the fixture's own path holds that substring.
    expect(git('worktree', 'list')).not.toContain(join(repo, 'wt'));
  });

  it('frees a path whose directory was deleted by hand', () => {
    // What `rm -rf .qwen/tmp` does to a review worktree.
    git('worktree', 'add', '-q', 'wt', '-b', 'topic');
    rmSync(join(repo, 'wt'), { recursive: true, force: true });

    // Negative control: without the prune, git refuses to reuse the path.
    expect(() => git('worktree', 'add', 'wt', 'topic')).toThrow(
      /missing but already registered/,
    );

    expect(releaseWorktree(join(repo, 'wt'))).toBe(false); // nothing to remove
    expect(() => git('worktree', 'add', '-q', 'wt', 'topic')).not.toThrow();
  });

  it('unlocks the branch a phantom worktree still holds checked out', () => {
    // The other half of the deadlock: `cleanStale` deletes the review branch
    // after freeing the worktree, and `branch -D` fails while the phantom
    // registration claims it.
    git('worktree', 'add', '-q', 'wt', '-b', 'qwen-review/pr-1');
    rmSync(join(repo, 'wt'), { recursive: true, force: true });

    expect(() => git('branch', '-D', 'qwen-review/pr-1')).toThrow(
      /used by worktree|checked out/,
    );

    releaseWorktree(join(repo, 'wt'));
    expect(() => git('branch', '-D', 'qwen-review/pr-1')).not.toThrow();
  });

  it('is a no-op when there is nothing registered', () => {
    expect(releaseWorktree(join(repo, 'never-existed'))).toBe(false);
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('does not throw when git itself fails', () => {
    // `releaseWorktree` is called on the cleanup path, where throwing would
    // mask the error that got us there.
    process.chdir(tmpdir()); // not a repo
    expect(() => releaseWorktree('/nonexistent/wt')).not.toThrow();
  });
});
