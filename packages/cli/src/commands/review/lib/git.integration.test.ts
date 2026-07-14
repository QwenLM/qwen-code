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
let home: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-wt-'));
  home = mkdtempSync(join(tmpdir(), 'review-wt-home-'));
  writeFileSync(join(home, '.gitconfig'), '');

  // Isolate the fixture from the developer's git environment. Without this,
  // `git init` loads their templates and the commit below runs their
  // `core.hooksPath` hooks — a targeted run visibly executed configured
  // pre-commit, prepare-commit-msg, commit-msg, post-commit and post-checkout
  // hooks — and a global `commit.gpgsign=true` fails the suite for want of a key.
  // The wrappers under test read `process.env` per call, so setting it here
  // reaches them.
  savedEnv = { ...process.env };
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
  process.env['HOME'] = home;

  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
  git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'init');
  cwd = process.cwd();
  // `releaseWorktree` shells out to `git` with no cwd, so it acts on the
  // process's directory. Point that at the fixture.
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  process.env = savedEnv;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('releaseWorktree', () => {
  it('removes a live worktree and reports that it was there', () => {
    git('worktree', 'add', '-q', 'wt', '-b', 'topic');
    expect(existsSync(join(repo, 'wt'))).toBe(true);

    expect(releaseWorktree(join(repo, 'wt'))).toMatchObject({
      existed: true,
      freed: true,
    });

    expect(existsSync(join(repo, 'wt'))).toBe(false);
    // Not `.not.toContain('wt')` — the fixture's own path holds that substring.
    expect(git('worktree', 'list')).not.toContain(join(repo, 'wt'));
  });

  it('removes an unregistered non-empty leftover git no longer tracks', () => {
    // A crashed run can leave a directory at the worktree path that git does not
    // track as a worktree. `git worktree remove` says "not a working tree" and
    // leaves it, and a non-empty one then blocks the next `worktree add` with
    // `already exists`. releaseWorktree must still leave the path gone.
    mkdirSync(join(repo, 'wt', 'junk'), { recursive: true });
    writeFileSync(join(repo, 'wt', 'junk', 'f'), 'x');
    // Negative control: it is not a registered worktree.
    expect(git('worktree', 'list')).not.toContain(join(repo, 'wt'));

    expect(releaseWorktree(join(repo, 'wt'))).toMatchObject({
      existed: true,
      freed: true,
    });

    expect(existsSync(join(repo, 'wt'))).toBe(false);
    // And the path is reusable — the `already exists` wedge is gone.
    expect(() =>
      git('worktree', 'add', '-q', 'wt', '-b', 'topic'),
    ).not.toThrow();
  });

  it('frees a path whose directory was deleted by hand', () => {
    // What `rm -rf .qwen/tmp` does to a review worktree.
    git('worktree', 'add', '-q', 'wt', '-b', 'topic');
    rmSync(join(repo, 'wt'), { recursive: true, force: true });

    // Negative control: without the prune, git refuses to reuse the path.
    expect(() => git('worktree', 'add', 'wt', 'topic')).toThrow(
      /missing but already registered/,
    );

    // Nothing was there: not an existence, and nothing to free.
    expect(releaseWorktree(join(repo, 'wt'))).toMatchObject({
      existed: false,
      freed: false,
    });
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
    expect(releaseWorktree(join(repo, 'never-existed'))).toMatchObject({
      existed: false,
      freed: false,
    });
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
