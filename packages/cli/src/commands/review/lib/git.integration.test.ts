/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git`. The bug these lock down only exists in git's own bookkeeping —
// a mocked child_process would happily "pass" against a fiction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRawTolerateDiff, releaseWorktree } from './git.js';
import { NULL_DEVICE } from './diff-flags.js';

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

describe('gitRawTolerateDiff', () => {
  it('returns the diff when git exits 1 because the inputs differ', () => {
    writeFileSync(join(repo, 'new.ts'), 'export const a = 1;\n');
    const out = gitRawTolerateDiff(
      '-C',
      repo,
      'diff',
      '--no-index',
      '--',
      NULL_DEVICE,
      'new.ts',
    );
    expect(out.toString('utf8')).toContain('+++ b/new.ts');
  });

  it('throws when git exits 1 with NO output — that is a failure, not a diff', () => {
    // The distinction this whole helper turns on. `git diff --no-index` against
    // a **directory** — which is what an embedded git repo or a symlink to one
    // looks like coming out of `ls-files --others` — also exits 1, but with
    // empty stdout and an error on stderr.
    //
    // An empty `Buffer` is a truthy object. A guard of `e.status === 1 &&
    // e.stdout` therefore accepted that as a successful diff of nothing, and the
    // caller went on to record the path as reviewed. Exit 1 with no output must
    // fail loudly so the caller can record the truth instead.
    mkdirSync(join(repo, 'subdir'));
    writeFileSync(join(repo, 'subdir', 'inner.ts'), 'export const b = 2;\n');
    expect(() =>
      gitRawTolerateDiff(
        '-C',
        repo,
        'diff',
        '--no-index',
        '--',
        NULL_DEVICE,
        'subdir',
      ),
    ).toThrow();
  });
});
