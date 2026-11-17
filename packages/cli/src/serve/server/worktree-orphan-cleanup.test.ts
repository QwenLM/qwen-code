/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Delegation coverage for `executeWorktreeCleanup`'s has-work gate
 * (#12758): the daemon reaper must consult the shared core predicate
 * (`worktreeHasWork`), so a checkout whose only content is git-ignored
 * is preserved while one holding only disposable build output stays
 * reaping. Real git fixture — the behavior under test is the exact
 * status argv, which a mocked stand-in cannot see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  readWorktreeSnapshotMeta,
  restoreWorktreeSnapshot,
  writeWorktreeSessionMarker,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import {
  executeWorktreeCleanup,
  type WorktreeCleanupPlan,
} from './worktree-orphan-cleanup.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('executeWorktreeCleanup — has-work gate (#12758)', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // Repo sits one level down so afterEach removes the worktrees dir and
  // any siblings wholesale.
  let repoParent: string;
  let repoRoot: string;

  beforeEach(() => {
    repoParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-orphan-cleanup-')),
    );
    repoRoot = path.join(repoParent, 'repo');
    fs.mkdirSync(repoRoot);
    git(repoRoot, 'init', '-q');
    // Name the initial branch without `git init -b` (git < 2.28 lacks it).
    git(repoRoot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(repoRoot, 'config', 'user.email', 't@e.com');
    git(repoRoot, 'config', 'user.name', 't');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    const emptyExcludes = path.join(repoParent, 'empty-excludes');
    fs.writeFileSync(emptyExcludes, '');
    git(repoRoot, 'config', 'core.excludesFile', emptyExcludes);
    fs.writeFileSync(
      path.join(repoRoot, '.gitignore'),
      'secret.env\nnode_modules/\n',
    );
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'init', '--no-verify');
  });

  afterEach(() => {
    fs.rmSync(repoParent, { recursive: true, force: true });
  });

  async function planFor(slug: string): Promise<WorktreeCleanupPlan> {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main');
    expect(result.success).toBe(true);
    const worktreePath = fs.realpathSync(result.worktree!.path);
    const sessionId = `session-${slug}`;
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const sidecar: WorktreeSession = {
      slug,
      worktreePath,
      worktreeBranch: result.worktree!.branch,
      originalCwd: repoRoot,
      originalBranch: 'main',
      originalHeadCommit: '',
    };
    return {
      sessionId,
      sidecar,
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };
  }

  it('snapshots then deletes a checkout whose only content is git-ignored (P6 U3)', async () => {
    const plan = await planFor('agent-aabbccd');
    fs.writeFileSync(path.join(plan.lockKey, 'secret.env'), 'AWS_KEY=x\n');

    await executeWorktreeCleanup(plan);

    // P6: the ignored work is preserved in a snapshot, then the checkout is
    // deleted (snapshot-then-delete replaces the old permanent preserve).
    expect(fs.existsSync(plan.lockKey)).toBe(false);
    const snapBase = path.join(
      repoParent,
      'session-agent-aabbccd.worktree-snapshot',
    );
    expect(fs.existsSync(`${snapBase}.tar.gz`)).toBe(true);
    expect(fs.existsSync(`${snapBase}.json`)).toBe(true);
  });

  it('still removes a checkout holding only disposable build output', async () => {
    const plan = await planFor('agent-aabbccd');
    fs.mkdirSync(path.join(plan.lockKey, 'node_modules', 'x'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(plan.lockKey, 'node_modules', 'x', 'i.js'),
      '//\n',
    );

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
  });

  it('judges unmerged commits against worktreeBase, not originalHeadCommit (R5-4)', async () => {
    // The branch-route shape: a detached worktree created at a sibling
    // checkout's HEAD records originalHeadCommit = repo top HEAD. The
    // reaper must pass the CREATION base to removeUserWorktree — with the
    // repo top HEAD the clean checkout reads as unmerged and is preserved
    // forever after the session record is already gone.
    const service = new GitWorktreeService(repoRoot);
    const rootHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const sibling = await service.createUserWorktree('sibling', 'main', {
      detached: true,
    });
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    fs.writeFileSync(path.join(siblingPath, 'ahead.txt'), 'ahead\n');
    git(siblingPath, 'add', 'ahead.txt');
    git(siblingPath, 'commit', '-qm', 'sibling work', '--no-verify');
    const siblingHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: siblingPath,
      encoding: 'utf8',
    }).trim();
    expect(siblingHead).not.toBe(rootHead);
    const created = await service.createUserWorktree('task-base', siblingHead, {
      detached: true,
    });
    expect(created.success).toBe(true);
    const worktreePath = fs.realpathSync(created.worktree!.path);
    const sessionId = 'session-task-base';
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const plan: WorktreeCleanupPlan = {
      sessionId,
      sidecar: {
        slug: 'task-base',
        worktreePath,
        worktreeBranch: '',
        originalCwd: repoRoot,
        originalBranch: 'main',
        originalHeadCommit: rootHead,
        worktreeBase: siblingHead,
      },
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  async function carriedPlan(
    slug: string,
    recordOverlay: boolean,
  ): Promise<WorktreeCleanupPlan> {
    // A dirty source: a tracked edit plus an untracked file, both carried
    // into a detached session worktree. The overlay is the checkout's only
    // content (no commit was added inside it).
    fs.writeFileSync(path.join(repoRoot, 'carry.txt'), 'carried-untracked\n');
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), 'extra-rule\n');
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(result.success).toBe(true);
    const carriedEntries = result.carriedEntries!;
    expect(carriedEntries.length).toBeGreaterThan(0);
    const worktreePath = fs.realpathSync(result.worktree!.path);
    const sessionId = `session-${slug}`;
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const sidecar: WorktreeSession = {
      slug,
      worktreePath,
      worktreeBranch: '',
      originalCwd: repoRoot,
      originalBranch: 'main',
      originalHeadCommit: '',
      ...(recordOverlay ? { carriedEntries } : {}),
    };
    return {
      sessionId,
      sidecar,
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };
  }

  it('collects a carried-only checkout when the sidecar records the overlay (R9-6)', async () => {
    const plan = await carriedPlan('carried-collect', true);

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    // A pristine carried overlay is collected WITHOUT a snapshot — the source
    // checkout still holds it. Dropping the gate's carriedEntries argument
    // would read the overlay as work and write an archive instead.
    expect(
      fs.existsSync(
        path.join(
          repoParent,
          'session-carried-collect.worktree-snapshot.tar.gz',
        ),
      ),
    ).toBe(false);
  });

  it('snapshots then deletes a carried-only checkout with no recorded overlay (R9-6 legacy + P6 U3)', async () => {
    // A legacy sidecar names no carriedPaths, so the carried copy reads as
    // the session's own work (the R9-6 exemption does not apply). P6 U3 then
    // snapshots that work and deletes the checkout instead of stranding it.
    const plan = await carriedPlan('carried-legacy', false);

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    const snapBase = path.join(
      repoParent,
      'session-carried-legacy.worktree-snapshot',
    );
    expect(fs.existsSync(`${snapBase}.tar.gz`)).toBe(true);
  });

  it('preserves a dirty checkout when the snapshot capture fails (P6 U3 fail-closed)', async () => {
    // A worktree with genuine work whose git state cannot be read for the
    // snapshot meta: capture rejects, so the checkout must be preserved —
    // never delete without a durable snapshot. Removing the worktree's .git
    // makes rev-parse fail while the directory still holds work.
    const plan = await planFor('snapfail');
    fs.writeFileSync(path.join(plan.lockKey, 'work.txt'), 'mine\n');
    fs.rmSync(path.join(plan.lockKey, '.git'), {
      recursive: true,
      force: true,
    });

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.existsSync(path.join(plan.lockKey, 'work.txt'))).toBe(true);
    // The preserve must come from the capture refusal itself, not from a
    // later removal failure: no archive may have been written.
    expect(
      fs.existsSync(
        path.join(repoParent, 'session-snapfail.worktree-snapshot.tar.gz'),
      ),
    ).toBe(false);
  });

  it('snapshots a no-carry checkout whose edit is hidden under assume-unchanged (F6 default path)', async () => {
    const plan = await planFor('hidden-nocarry');
    // A tracked file edited under a hidden index bit: git status omits it, so
    // the base predicate (no carriedEntries) must still refuse via ls-files -v
    // rather than read clean and delete the work bare.
    fs.writeFileSync(path.join(plan.lockKey, '.gitignore'), 'hidden-edit\n');
    git(plan.lockKey, 'update-index', '--assume-unchanged', '.gitignore');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          repoParent,
          'session-hidden-nocarry.worktree-snapshot.tar.gz',
        ),
      ),
    ).toBe(true);
  });

  it('snapshots a session edit to a carried path instead of deleting it bare (F1)', async () => {
    const plan = await carriedPlan('carried-reedit', true);
    // The session keeps editing a carried untracked file: new work the
    // source checkout does not hold. The gate must read it as work, so the
    // reaper snapshots before deleting and the edit survives in the archive.
    fs.writeFileSync(path.join(plan.lockKey, 'carry.txt'), 'session-edit\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    const snapBase = path.join(
      repoParent,
      'session-carried-reedit.worktree-snapshot',
    );
    expect(fs.existsSync(`${snapBase}.tar.gz`)).toBe(true);
    const restored = path.join(repoParent, 'restored-reedit');
    git(repoRoot, 'worktree', 'add', '--detach', restored, 'HEAD');
    const meta = await readWorktreeSnapshotMeta(`${snapBase}.json`);
    await restoreWorktreeSnapshot(`${snapBase}.tar.gz`, restored, meta);
    expect(fs.readFileSync(path.join(restored, 'carry.txt'), 'utf8')).toBe(
      'session-edit\n',
    );
  });

  it('preserves a checkout whose staged content differs from the worktree (N1)', async () => {
    const plan = await planFor('mm-preserve');
    // Stage A then edit the worktree to B (status AM/MM): the staged A lives
    // only in the index, which the worktree tar cannot represent. The capture
    // must refuse so the checkout (and its index) is preserved, not deleted.
    fs.writeFileSync(path.join(plan.lockKey, 'file.txt'), 'staged-A\n');
    git(plan.lockKey, 'add', 'file.txt');
    fs.writeFileSync(path.join(plan.lockKey, 'file.txt'), 'worktree-B\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.existsSync(path.join(plan.lockKey, 'file.txt'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoParent, 'session-mm-preserve.worktree-snapshot.tar.gz'),
      ),
    ).toBe(false);
  });
});
