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
import { gitProbe, gitRawTolerateDiff, releaseWorktree } from './git.js';
import { NULL_DEVICE } from './diff-flags.js';
import { isolateHostGitConfig } from './test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-wt-'));

  // Isolate the fixture from the developer's git environment (shared
  // helper — see isolateHostGitConfig for the incident class). Without it,
  // `git init` loads their templates and the commit below runs their
  // `core.hooksPath` hooks — a targeted run visibly executed configured
  // pre-commit, prepare-commit-msg, commit-msg, post-commit and post-checkout
  // hooks — and a global `commit.gpgsign=true` fails the suite for want of
  // a key. The wrappers under test read `process.env` per call, so setting
  // it here reaches them.
  gitIsolation = isolateHostGitConfig();

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
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
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

describe('gitProbe — the exit status the anchor taxonomy rests on', () => {
  // Every fetch-pr test mocks this module, so nothing else consumes the real
  // `status`. A rewrite returning `{status: 1}` for every failure, or
  // dropping the field, would reclassify every deterministic anchor refusal
  // as retryable infrastructure (and vice versa) with the whole suite green.
  it('reports 0, the predicate NO, and an error apart from each other', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gitprobe-'));
    try {
      execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'a']);
      writeFileSync(join(repo, 'f.txt'), 'x\n');
      execFileSync('git', ['-C', repo, 'add', 'f.txt'], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'one'], {
        stdio: 'pipe',
      });
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();

      // 0: the object is here.
      expect(gitProbe('-C', repo, 'cat-file', '-e', head).status).toBe(0);
      // 1: a well-formed FULL sha this history does not hold — the
      // definitive no.
      expect(
        gitProbe('-C', repo, 'cat-file', '-e', '0'.repeat(40)).status,
      ).toBe(1);
      // 128: not a valid object NAME — what git says for an abbreviation
      // that resolves to nothing. Deterministic too, which is why
      // `commitExists` treats it as absence rather than as a failure.
      expect(gitProbe('-C', repo, 'cat-file', '-e', '0000000').status).toBe(
        128,
      );
      // The predicate's own yes, its no, and its error — all three, from
      // real git. `--is-ancestor` is the one probe whose three answers the
      // reason taxonomy splits three ways, and this describe is the only
      // consumer of a REAL status anywhere (every fetch-pr test mocks
      // `./lib/git.js`), so a wrapper change that surfaced the predicate's
      // NO as an error status would rename every deterministic
      // `not-an-ancestor` refusal to the retryable `capture-failed` with
      // nothing red.
      writeFileSync(join(repo, 'f.txt'), 'y\n');
      execFileSync('git', ['-C', repo, 'add', 'f.txt'], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'two'], {
        stdio: 'pipe',
      });
      const newer = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();

      // 0: yes — a commit is its own ancestor, and the older is the newer's.
      expect(
        gitProbe('-C', repo, 'merge-base', '--is-ancestor', head, head).status,
      ).toBe(0);
      expect(
        gitProbe('-C', repo, 'merge-base', '--is-ancestor', head, newer).status,
      ).toBe(0);
      // 1: no — the newer commit is not an ancestor of the older.
      expect(
        gitProbe('-C', repo, 'merge-base', '--is-ancestor', newer, head).status,
      ).toBe(1);
      // 128: not a valid object name — an ERROR, not a no. This is the
      // status `commitExists`/`resolveCommit` must settle before ancestry is
      // ever asked, since the predicate cannot answer it.
      expect(
        gitProbe(
          '-C',
          repo,
          'merge-base',
          '--is-ancestor',
          '0'.repeat(40),
          head,
        ).status,
      ).toBe(128);

      // The `out` half, from real git. `resolveCommit` returns this value
      // verbatim as the anchor's `diffBase`, so the trim is load-bearing: a
      // refactor dropping it makes `resolved === fetchedSha` false and
      // `merge-base --is-ancestor "<sha>\n" <head>` exit 128 → the anchor is
      // called `capture-failed` and retried forever. On Windows, where
      // rev-parse output carries CRLF, that is the DEFAULT shape, not a mutant.
      expect(gitProbe('-C', repo, 'rev-parse', `${head}^{commit}`).out).toBe(
        head,
      );

      // `status: null` — no exit code at all, which is what a spawn failure
      // or a timeout kill leaves. It is the whole reason the probe returns a
      // nullable status instead of a number: this is the retryable half of
      // the split, and every fetch-pr test mocks `./lib/git.js`, so nothing
      // else exercises the real catch. A mutant returning a number here reads
      // a killed probe as the predicate's answer and permanently retires a
      // valid anchor on a transient fault.
      const savedPath = process.env['PATH'];
      try {
        process.env['PATH'] = join(repo, 'no-such-bin');
        expect(gitProbe('-C', repo, 'rev-parse', 'HEAD')).toEqual({
          out: null,
          status: null,
        });
      } finally {
        process.env['PATH'] = savedPath;
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
