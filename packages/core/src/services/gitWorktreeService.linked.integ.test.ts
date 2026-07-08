/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';

// Real git invocations (plus any user-global hooks) can take 10–20s per setup
// on slower runners; bump per-test and per-hook timeouts so the suite isn't
// flaky on CI, matching the sibling hooks/symlinks integration suites.
describe('GitWorktreeService.isRegisteredLinkedWorktree() (real git)', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function commitInitial(tree: string): void {
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: tree });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tree });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tree });
    fs.writeFileSync(path.join(tree, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: tree });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: tree,
    });
  }

  function initRepo(prefix: string): string {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    );
    tmpDirs.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    commitInitial(repo);
    return repo;
  }

  it('returns false for the repository primary working tree', async () => {
    const repo = initRepo('qwen-linked-main-');
    const svc = new GitWorktreeService(repo);
    expect(await svc.isRegisteredLinkedWorktree(repo)).toBe(false);
  });

  it('returns true for a linked worktree created via `git worktree add`', async () => {
    const repo = initRepo('qwen-linked-wt-');
    const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'], {
      cwd: repo,
    });
    const svc = new GitWorktreeService(repo);
    expect(await svc.isRegisteredLinkedWorktree(wt)).toBe(true);
  });

  it('returns false for a main tree whose .git is a FILE (separate-git-dir)', async () => {
    // `git init --separate-git-dir` leaves the main working tree carrying a
    // `.git` FILE rather than a directory — the exact case a "`.git` is a
    // file ⟹ linked worktree" heuristic would misclassify. Its --git-dir and
    // --git-common-dir still coincide, so it is correctly the main tree.
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-linked-sep-')),
    );
    tmpDirs.push(base);
    const tree = path.join(base, 'tree');
    const gitdir = path.join(base, 'gitdir');
    execFileSync('git', [
      'init',
      '-q',
      '-b',
      'main',
      `--separate-git-dir=${gitdir}`,
      tree,
    ]);
    commitInitial(tree);

    // Sanity: the heuristic this replaces would have been fooled here.
    expect(fs.statSync(path.join(tree, '.git')).isFile()).toBe(true);

    const svc = new GitWorktreeService(tree);
    expect(await svc.isRegisteredLinkedWorktree(tree)).toBe(false);
  });

  it('returns false (fail-closed) for a path that is not a git repository', async () => {
    // rev-parse throws here, exercising the catch block that backs the
    // fail-closed contract: an unverifiable path is treated as "not linked"
    // so callers reject rather than mis-isolate.
    const plain = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-linked-plain-')),
    );
    tmpDirs.push(plain);
    const svc = new GitWorktreeService(plain);
    expect(await svc.isRegisteredLinkedWorktree(plain)).toBe(false);
  });

  it('matches a registered worktree through a symlinked input path', async () => {
    // The input path is canonicalized before matching against the registry,
    // so a symlinked path to a real linked worktree still resolves to it —
    // the macOS `/var → /private/var` case, reproduced with an explicit
    // symlink so it runs everywhere. Without the realpath the symlink path
    // would not match the registry's canonical entry and this would be false.
    const repo = initRepo('qwen-linked-symlink-');
    const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'], {
      cwd: repo,
    });
    const linkParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-linked-symlink-lnk-')),
    );
    tmpDirs.push(linkParent);
    const link = path.join(linkParent, 'wt-link');
    fs.symlinkSync(wt, link, 'dir');

    const svc = new GitWorktreeService(repo);
    expect(await svc.isRegisteredLinkedWorktree(link)).toBe(true);
  });

  it('returns false for a fake worktree carrying a copied .git file (not registered)', async () => {
    // A directory with a `.git` file copied from a real linked worktree passes
    // a bare --git-dir vs --git-common-dir heuristic: it reports a per-worktree
    // git dir. But that entry's `gitdir` pointer names the REAL worktree, not
    // this copy, so verifying the pointer rejects it.
    const repo = initRepo('qwen-linked-fake-');
    const realWt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
    fs.mkdirSync(path.dirname(realWt), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'review-pr-1', realWt, 'HEAD'],
      { cwd: repo },
    );
    const fake = path.join(repo, 'fake-wt');
    fs.mkdirSync(fake);
    fs.copyFileSync(path.join(realWt, '.git'), path.join(fake, '.git'));

    const svc = new GitWorktreeService(repo);
    expect(await svc.isRegisteredLinkedWorktree(fake)).toBe(false);
  });

  it('is not fooled by a worktree path containing a newline that fakes a registry entry', async () => {
    // A worktree whose path embeds "\nworktree <other>" would inject a bogus
    // record into any newline-split parse of `git worktree list --porcelain`.
    // Verifying the registry pointer for the one probed path sidesteps that
    // class of bug entirely — no list is parsed, on any git version.
    const repo = initRepo('qwen-linked-nl-');
    const fake = path.join(repo, 'fake');
    fs.mkdirSync(fake);
    const evil = `${path.join(repo, 'evil')}\nworktree ${fake}`;
    execFileSync('git', ['worktree', 'add', '-b', 'evil', evil, 'HEAD'], {
      cwd: repo,
    });

    const svc = new GitWorktreeService(repo);
    // The injected path must NOT be accepted as a registered worktree.
    expect(await svc.isRegisteredLinkedWorktree(fake)).toBe(false);
    // ...while the real (awkwardly named) worktree still validates.
    expect(await svc.isRegisteredLinkedWorktree(evil)).toBe(true);
  });
});
