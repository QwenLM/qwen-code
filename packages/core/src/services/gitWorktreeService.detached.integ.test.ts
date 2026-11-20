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

  it('getRegisteredWorktreeBranch reports the bare branch when a same-named tag exists (R10-2)', async () => {
    const worktree = await createDetached('sess-tag-ambig');
    git(worktree.path, 'switch', '-qc', 'release/2.0');
    git(repoRoot, 'tag', 'release/2.0');
    // The short name really is ambiguous: --abbrev-ref qualifies it, which
    // is exactly what must NOT reach the sidecar comparison.
    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'heads/release/2.0',
    );
    const info = await service.getRegisteredWorktreeBranch(worktree.path);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('release/2.0');
    expect(info!.headCommit).toBe(git(worktree.path, 'rev-parse', 'HEAD'));
  });

  it('getRegisteredWorktreeBranch keeps a branch literally named heads/foo (R10-2)', async () => {
    // Guards the normalization against a naive "strip heads/" rewrite: the
    // branch name itself starts with heads/, and only the refs/heads/
    // namespace prefix may be dropped.
    const worktree = await createDetached('sess-heads-foo');
    git(worktree.path, 'switch', '-qc', 'heads/foo');
    const info = await service.getRegisteredWorktreeBranch(worktree.path);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('heads/foo');
  });

  // The post-checkout hook is a POSIX shell script; Windows has no sh.
  it.skipIf(process.platform === 'win32')(
    'createWorktreeBranch accepts a landed switch despite a failing hook when a same-named tag exists (R10-2)',
    async () => {
      const worktree = await createDetached('sess-hook-tag');
      git(repoRoot, 'tag', 'release/2.0');
      const hooksDir = path.join(repoParent, 'hooks-r102');
      await fs.mkdir(hooksDir);
      const marker = path.join(repoParent, 'hook-ran-r102');
      await fs.writeFile(
        path.join(hooksDir, 'post-checkout'),
        `#!/bin/sh\ntouch ${marker}\nexit 1\n`,
        { mode: 0o755 },
      );
      git(worktree.path, 'config', 'core.hooksPath', hooksDir);
      // switch -c moves the checkout BEFORE the hook runs; the hook then
      // fails. The recovery must compare on the bare name (a same-named tag
      // makes --abbrev-ref report heads/release/2.0) and accept the landing.
      await service.createWorktreeBranch(worktree.path, 'release/2.0');
      // The hook really ran (so the recovery path, not a clean switch, is
      // what this test exercises).
      await expect(fs.lstat(marker)).resolves.toBeTruthy();
      expect(git(worktree.path, 'branch', '--show-current')).toBe(
        'release/2.0',
      );
    },
  );

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

  it('hasUnmergedWorktreeCommits judges a branched detached checkout by the slug ref (R8-2)', async () => {
    // A commit B reachable only from a tag (main reset back below), so the
    // reachability test alone would misread it as unmerged work.
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repoRoot, 'tagged.txt'), 'b\n');
    git(repoRoot, 'add', 'tagged.txt');
    git(repoRoot, 'commit', '-qm', 'B', '--no-verify');
    const bCommit = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'tag', 'v1');
    git(repoRoot, 'reset', '--hard', base);
    // Detached creation at B, then "Create branch here" -> feat/x at B.
    const created = await service.createUserWorktree('sess-tag', bCommit, {
      detached: true,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    await service.createWorktreeBranch(wt, 'feat/x');
    // Zero commits at the creation base: the creation-base shortcut applies
    // to the named shape too, so removal loses nothing.
    expect(await service.hasUnmergedWorktreeCommits('sess-tag', bCommit)).toBe(
      false,
    );
    // A commit on feat/x survives removal — removal deletes the slug ref
    // (still at B), never feat/x — so removal still loses nothing.
    await fs.writeFile(path.join(wt, 'work.txt'), 'work\n');
    git(wt, 'add', 'work.txt');
    git(wt, 'commit', '-qm', 'agent work', '--no-verify');
    expect(await service.hasUnmergedWorktreeCommits('sess-tag', bCommit)).toBe(
      false,
    );
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

  it('removeUserWorktree keeps a pre-existing worktree-<slug> branch it never owned', async () => {
    // The detached checkout is created with `worktree add --detach`, so
    // the slug-derived branch name may already belong to the user.
    git(repoRoot, 'branch', 'worktree-sess-owned');
    const worktree = await createDetached('sess-owned');

    const result = await service.removeUserWorktree('sess-owned', {
      deleteBranch: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-owned')).toBe(
      'worktree-sess-owned',
    );
  });

  it('hasUnmergedWorktreeCommits does not block removal for commits on a surviving user branch (R8-2)', async () => {
    const worktree = await createDetached('sess-branched');
    await service.createWorktreeBranch(worktree.path, 'feat/from-detached');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');
    // The unique commit lives on feat/from-detached, a user branch removal
    // never deletes (the detached creation never owned the slug ref). The
    // commit survives the directory removal, so removal loses nothing —
    // the probe must not fail-closed on the checkout's current branch.
    expect(await service.hasUnmergedWorktreeCommits('sess-branched')).toBe(
      false,
    );
    // Merging into main keeps it covered.
    const tip = git(worktree.path, 'rev-parse', 'HEAD');
    git(repoRoot, 'merge', '-q', '--no-edit', tip);
    expect(await service.hasUnmergedWorktreeCommits('sess-branched')).toBe(
      false,
    );
  });

  it('removeUserWorktree keeps a merged slug branch after in-place branching', async () => {
    // A user branch at base, merged into HEAD; the session worktree is
    // branched in place, so it is no longer detached but never owned the
    // slug name. Removal must not delete the user's branch.
    git(repoRoot, 'branch', 'worktree-sess-renamed');
    const worktree = await createDetached('sess-renamed');
    await service.createWorktreeBranch(worktree.path, 'feat/x');
    const result = await service.removeUserWorktree('sess-renamed', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.branchSkipped).toBe(true);
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-renamed')).toBe(
      'worktree-sess-renamed',
    );
    expect(git(repoRoot, 'branch', '--list', 'feat/x')).toBe('feat/x');
  });

  it('removeUserWorktree reports branchSkipped when the agent switched branches', async () => {
    git(repoRoot, 'branch', 'worktree-sess-switched');
    const worktree = await createDetached('sess-switched');
    git(worktree.path, 'checkout', '-q', '-b', 'fix');
    const result = await service.removeUserWorktree('sess-switched', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.branchSkipped).toBe(true);
    expect(result.branchPreserved).toBeUndefined();
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-switched')).toBe(
      'worktree-sess-switched',
    );
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('removeUserWorktree reports branchSkipped when the directory is already gone', async () => {
    git(repoRoot, 'branch', 'worktree-sess-gone');
    const worktree = await createDetached('sess-gone');
    await fs.rm(worktree.path, { recursive: true, force: true });
    const result = await service.removeUserWorktree('sess-gone', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.branchSkipped).toBe(true);
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-gone')).toBe(
      'worktree-sess-gone',
    );
  });

  it('removeUserWorktree refuses a checkout whose .git link is missing (R11-18)', async () => {
    const worktree = await createDetached('sess-nogit');
    await fs.writeFile(path.join(worktree.path, 'work.txt'), 'precious\n');
    git(worktree.path, 'add', 'work.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');
    // Remove the .git link: git's upward discovery then answers for the
    // ENCLOSING repo, which would switch off the detached/unmerged guard and
    // let the fs.rm fallback destroy the checkout and its only-here commits.
    // The removal must fail closed while the directory exists.
    await fs.rm(path.join(worktree.path, '.git'));
    const result = await service.removeUserWorktree('sess-nogit', {
      deleteBranch: true,
    });
    expect(result.success).toBe(false);
    await expect(fs.lstat(worktree.path)).resolves.toBeTruthy();
    expect(
      await fs.readFile(path.join(worktree.path, 'work.txt'), 'utf8'),
    ).toBe('precious\n');
  });

  it('removeUserWorktree deletes the slug branch when a same-named tag exists', async () => {
    // A named worktree sits on worktree-<slug>; a same-named tag would make
    // --abbrev-ref report heads/worktree-<slug>, breaking the ownership
    // comparison and skipping the delete. The full-ref probe keeps the bare
    // name so the owned slug branch is still deleted.
    const created = await service.createUserWorktree('sess-tagbranch', 'main');
    expect(created.success).toBe(true);
    expect(created.worktree!.branch).toBe('worktree-sess-tagbranch');
    git(repoRoot, 'tag', 'worktree-sess-tagbranch');
    const result = await service.removeUserWorktree('sess-tagbranch', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.deletedBranch).toBe('worktree-sess-tagbranch');
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-tagbranch')).toBe(
      '',
    );
  });

  it('prepared finalize with branchOwned=false keeps a same-slug branch at base', async () => {
    git(repoRoot, 'branch', 'worktree-sess-fin');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const created = await service.createUserWorktree('sess-fin', 'main', {
      detached: true,
    });
    expect(created.success).toBe(true);
    const removed = await service.removePreparedUserWorktree(
      'sess-fin',
      null,
      base,
      undefined,
      false,
    );
    expect(removed.success).toBe(true);
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-fin')).toBe(
      'worktree-sess-fin',
    );
  });

  it('removeUserWorktree keeps an unrelated worktree-<slug> branch with its own commits', async () => {
    git(repoRoot, 'branch', 'worktree-sess-diverged');
    git(repoRoot, 'checkout', '-q', 'worktree-sess-diverged');
    await fs.writeFile(path.join(repoRoot, 'user.txt'), 'user work\n');
    git(repoRoot, 'add', 'user.txt');
    git(repoRoot, 'commit', '-qm', 'user work', '--no-verify');
    const userTip = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'checkout', '-q', 'main');
    const worktree = await createDetached('sess-diverged');

    const result = await service.removeUserWorktree('sess-diverged', {
      deleteBranch: true,
    });

    expect(result.success).toBe(true);
    expect(git(repoRoot, 'rev-parse', 'worktree-sess-diverged')).toBe(userTip);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('removeUserWorktree with branchOwned=false keeps a user worktree-<slug> branch the checkout was switched onto (6890579653)', async () => {
    // A detached session worktree later switched in place onto a user-created
    // worktree-<slug> branch: the recorded ownership (branchOwned=false, as
    // the sidecar-based callers pass for a detached creation) is authoritative.
    // The current branch must not infer ownership and delete the user's ref.
    git(repoRoot, 'branch', 'worktree-sess-inplace');
    const userTip = git(repoRoot, 'rev-parse', 'worktree-sess-inplace');
    const worktree = await createDetached('sess-inplace');
    git(worktree.path, 'checkout', '-q', 'worktree-sess-inplace');

    const result = await service.removeUserWorktree('sess-inplace', {
      deleteBranch: true,
      branchOwned: false,
      baseCommit: git(repoRoot, 'rev-parse', 'HEAD'),
    });

    expect(result.success).toBe(true);
    expect(result.deletedBranch).toBeUndefined();
    expect(result.keptBranch).toBe('worktree-sess-inplace');
    expect(git(repoRoot, 'rev-parse', 'worktree-sess-inplace')).toBe(userTip);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('createWorktreeBranch succeeds when the post-checkout hook fails after the switch', async () => {
    const worktree = await createDetached('sess-hooked');
    // The worktree inherits the repo's hooks (configureHooksPath). A
    // failing post-checkout hook throws AFTER `switch -c` moved the
    // checkout: the branch exists and the checkout sits on it, so the
    // operation must report success — treating it as "no branch" would
    // leave the sidecar naming a state that no longer exists.
    const hooksDir = path.join(repoRoot, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'post-checkout');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n');
    await fs.chmod(hook, 0o755);

    await service.createWorktreeBranch(worktree.path, 'feat/hooked');

    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feat/hooked',
    );
    expect(
      git(
        repoRoot,
        'branch',
        '--list',
        'feat/hooked',
        '--format=%(refname:short)',
      ),
    ).toBe('feat/hooked');
  });

  it('removes a zero-commit detached worktree whose base is unreachable', async () => {
    // The base sha is reachable from no branch (main moved past it via a
    // force-reset to an unrelated root): the plain reachability guard
    // would refuse a worktree with zero commits of its own. With the
    // creation base in hand, removal proceeds.
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const worktree = await createDetached('sess-unreachable');
    git(repoRoot, 'checkout', '-q', '--orphan', 'fresh');
    git(repoRoot, 'commit', '--allow-empty', '-qm', 'unrelated', '--no-verify');
    git(repoRoot, 'branch', '-M', 'fresh', 'main');
    // base is now unreachable from any branch.
    expect(
      git(
        repoRoot,
        'for-each-ref',
        '--contains',
        base,
        '--format=%(refname)',
        'refs/heads',
      ),
    ).toBe('');

    const withBase = await service.removeUserWorktree('sess-unreachable', {
      deleteBranch: true,
      baseCommit: base,
    });
    expect(withBase.success).toBe(true);
    await expect(fs.lstat(worktree.path)).rejects.toThrow();
  });

  it('still refuses a detached worktree with its own unmerged commits', async () => {
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const worktree = await createDetached('sess-agent-commits');
    await fs.writeFile(path.join(worktree.path, 'agent.txt'), 'work\n');
    git(worktree.path, 'add', 'agent.txt');
    git(worktree.path, 'commit', '-qm', 'agent work', '--no-verify');
    const result = await service.removeUserWorktree('sess-agent-commits', {
      deleteBranch: true,
      baseCommit: base,
    });
    expect(result.success).toBe(false);
    expect(result.branchPreserved).toBe(true);
    await expect(fs.lstat(worktree.path)).resolves.toBeDefined();
  });

  it('deletes the owned slug branch even when the checkout moved away', async () => {
    // A named creation owns its slug ref provably; switching branches
    // inside the worktree must not leak the ref (which would block a
    // later enter_worktree of the same name).
    const created = await service.createUserWorktree(
      'sess-named-drift',
      'main',
    );
    expect(created.success).toBe(true);
    git(created.worktree!.path, 'checkout', '-q', '-b', 'fix');
    const result = await service.removeUserWorktree('sess-named-drift', {
      deleteBranch: true,
      branchOwned: true,
    });
    expect(result.success).toBe(true);
    expect(result.deletedBranch).toBe('worktree-sess-named-drift');
    expect(result.keptBranch).toBe('fix');
    expect(git(repoRoot, 'branch', '--list', 'worktree-sess-named-drift')).toBe(
      '',
    );
  });

  it('reports the surviving branch for an in-place-branched detached worktree', async () => {
    // No slug ref was ever created: the removal deletes no branch and
    // must name the branch that survives (the handle to the work).
    const worktree = await createDetached('sess-inplace');
    await service.createWorktreeBranch(worktree.path, 'feat/x');
    const result = await service.removeUserWorktree('sess-inplace', {
      deleteBranch: true,
    });
    expect(result.success).toBe(true);
    expect(result.deletedBranch).toBeUndefined();
    expect(result.keptBranch).toBe('feat/x');
    expect(
      git(repoRoot, 'branch', '--list', 'feat/x', '--format=%(refname:short)'),
    ).toBe('feat/x');
  });
});
