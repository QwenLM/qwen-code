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
import { randomBytes } from 'node:crypto';
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
  checkoutChangeDigestForTesting,
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

  function archives(sessionId: string): string[] {
    return fs
      .readdirSync(repoParent)
      .filter(
        (n) =>
          n.startsWith(`${sessionId}.`) &&
          n.endsWith('.worktree-snapshot.tar.gz'),
      )
      .map((n) => path.join(repoParent, n));
  }

  function archiveMetas(sessionId: string): string[] {
    return fs
      .readdirSync(repoParent)
      .filter(
        (n) =>
          n.startsWith(`${sessionId}.`) &&
          n.endsWith('.worktree-snapshot.json'),
      )
      .map((n) => path.join(repoParent, n));
  }

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

  function editAtCaptureStart(sessionId: string, edit: () => void) {
    let edited = false;
    const timer = setInterval(() => {
      const name = fs
        .readdirSync(repoParent)
        .find(
          (entry) =>
            entry.startsWith(`${sessionId}.`) &&
            entry.includes('.worktree-snapshot.tar.gz.') &&
            entry.endsWith('.tmp'),
        );
      let captureStarted = false;
      try {
        // Wait until the large payload is streaming, not just creation of the
        // temp output: the small edited entries have then already been read.
        captureStarted =
          name !== undefined &&
          fs.statSync(path.join(repoParent, name)).size >= 1024 * 1024;
      } catch {
        return;
      }
      if (!captureStarted) return;
      clearInterval(timer);
      edit();
      edited = true;
    }, 5);
    return {
      edited: () => edited,
      stop: () => clearInterval(timer),
    };
  }

  it('snapshots then deletes a checkout whose only content is git-ignored (P6 U3)', async () => {
    // A longer session id keeps the archive path ABOVE safeLogValue's 82-char
    // budget, so the no-truncation assertion stays load-bearing (M37). The
    // agent- prefix is reserved for the agent-<7hex> shape, so use a plain
    // longer slug.
    const slug = 'snapshot-pointer-long';
    const plan = await planFor(slug);
    fs.writeFileSync(path.join(plan.lockKey, 'secret.env'), 'AWS_KEY=x\n');

    // The snapshot log line is the only durable pointer to the archive until
    // U5 lands: pin that it names the FULL archive path (round-7).
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let logged = '';
    try {
      await executeWorktreeCleanup(plan);
    } finally {
      // Read the calls BEFORE mockRestore — restore resets the mock state.
      logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      stderrSpy.mockRestore();
    }
    expect(logged).toContain(
      `worktree cleanup snapshotted checkout action=delete`,
    );
    expect(logged).toContain(
      `snapshot=${JSON.stringify(archives(plan.sessionId)[0])}`,
    );

    // P6: the ignored work is preserved in a snapshot, then the checkout is
    // deleted (snapshot-then-delete replaces the old permanent preserve).
    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
    expect(archiveMetas(plan.sessionId).length > 0).toBe(true);
    const restored = path.join(repoParent, 'restored-ignored-work');
    git(repoRoot, 'worktree', 'add', '--detach', restored, 'HEAD');
    const snapshotMeta = await readWorktreeSnapshotMeta(
      archiveMetas(plan.sessionId)[0],
    );
    await restoreWorktreeSnapshot(
      archives(plan.sessionId)[0],
      restored,
      snapshotMeta,
    );
    expect(fs.readFileSync(path.join(restored, 'secret.env'), 'utf8')).toBe(
      'AWS_KEY=x\n',
    );
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
    expect(archives('session-carried-collect').length > 0).toBe(false);
  });

  it('snapshots then deletes a carried-only checkout with no recorded overlay (R9-6 legacy + P6 U3)', async () => {
    // A legacy sidecar names no carriedPaths, so the carried copy reads as
    // the session's own work (the R9-6 exemption does not apply). P6 U3 then
    // snapshots that work and deletes the checkout instead of stranding it.
    const plan = await carriedPlan('carried-legacy', false);

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'preserves a dirty checkout when the snapshot capture fails (P6 U3 fail-closed)',
    async () => {
      // .GIT is real work on a case-sensitive volume, not the git link. It
      // passes the earlier has-work probes but capture refuses a protected
      // case variant, so the preserve comes from the capture refusal itself.
      const plan = await planFor('snapfail');
      fs.writeFileSync(path.join(plan.lockKey, '.GIT'), 'real work\n');

      await executeWorktreeCleanup(plan);

      expect(fs.existsSync(plan.lockKey)).toBe(true);
      expect(fs.readFileSync(path.join(plan.lockKey, '.GIT'), 'utf8')).toBe(
        'real work\n',
      );
      expect(archives('session-snapfail')).toHaveLength(0);
    },
  );

  it('preserves a no-carry checkout whose edit is hidden under assume-unchanged (F6 default path)', async () => {
    const plan = await planFor('hidden-nocarry');
    // A tracked file edited under a hidden index bit: git status omits it, so
    // the base predicate (no carriedEntries) refuses via ls-files -v rather
    // than read clean and delete bare. The hidden version also cannot be
    // faithfully snapshotted, so the capture refuses and the checkout is kept.
    fs.writeFileSync(path.join(plan.lockKey, '.gitignore'), 'hidden-edit\n');
    git(plan.lockKey, 'update-index', '--assume-unchanged', '.gitignore');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.existsSync(path.join(plan.lockKey, '.gitignore'))).toBe(true);
    expect(archives('session-hidden-nocarry').length > 0).toBe(false);
  });

  it('snapshots a session edit to a carried path instead of deleting it bare (F1)', async () => {
    const plan = await carriedPlan('carried-reedit', true);
    // The session keeps editing a carried untracked file: new work the
    // source checkout does not hold. The gate must read it as work, so the
    // reaper snapshots before deleting and the edit survives in the archive.
    fs.writeFileSync(path.join(plan.lockKey, 'carry.txt'), 'session-edit\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
    const restored = path.join(repoParent, 'restored-reedit');
    git(repoRoot, 'worktree', 'add', '--detach', restored, 'HEAD');
    const meta = await readWorktreeSnapshotMeta(
      archiveMetas(plan.sessionId)[0],
    );
    await restoreWorktreeSnapshot(archives(plan.sessionId)[0], restored, meta);
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
    expect(archives('session-mm-preserve').length > 0).toBe(false);
  });

  it('preserves a checkout with an initialized submodule (P1)', async () => {
    const plan = await planFor('submodule-preserve');
    // A populated gitlink models an initialized submodule whose object database
    // can hold unpushed commits; neither the tar nor the removal preserves it,
    // so the whole checkout must be kept (no snapshot, no deletion).
    const subSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    git(
      plan.lockKey,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${subSha},lib`,
    );
    fs.mkdirSync(path.join(plan.lockKey, 'lib'));
    fs.writeFileSync(path.join(plan.lockKey, 'lib', 'file.txt'), 'sub work\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.existsSync(path.join(plan.lockKey, 'lib', 'file.txt'))).toBe(
      true,
    );
    expect(archives('session-submodule-preserve').length > 0).toBe(false);
  });

  it('snapshots a pristine carried-only checkout when the source moved on (R5-2)', async () => {
    const plan = await carriedPlan('carried-source-gone', true);
    // The worktree side is pristine, but the source re-edited the carried
    // untracked file after creation: the worktree now holds the only copy of
    // the carry-time content, so collecting it bare would lose that content.
    fs.writeFileSync(path.join(repoRoot, 'carry.txt'), 'source-moved-on\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
    const restored = path.join(repoParent, 'restored-source-gone');
    git(repoRoot, 'worktree', 'add', '--detach', restored, 'HEAD');
    const meta = await readWorktreeSnapshotMeta(
      archiveMetas(plan.sessionId)[0],
    );
    await restoreWorktreeSnapshot(archives(plan.sessionId)[0], restored, meta);
    expect(fs.readFileSync(path.join(restored, 'carry.txt'), 'utf8')).toBe(
      'carried-untracked\n',
    );
  });

  it('verifies the recorded carry source, not originalCwd, when they differ (R5-14)', async () => {
    // A session /cd'd into a sibling checkout: the carry comes from the
    // sibling (carriedFrom) while originalCwd stays the workspace root. The
    // workspace root is a decoy that still holds the carry-time content, so
    // verifying IT would wrongly authorize the no-archive delete after the
    // true source moved on — the worktree holds the overlay's last copy.
    fs.writeFileSync(path.join(repoRoot, 'carry.txt'), 'carried-untracked\n');
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), 'extra-rule\n');
    const sibling = path.join(repoParent, 'sibling');
    git(repoRoot, 'worktree', 'add', '--detach', sibling, 'HEAD');
    fs.writeFileSync(path.join(sibling, 'carry.txt'), 'carried-untracked\n');
    fs.appendFileSync(path.join(sibling, '.gitignore'), 'extra-rule\n');
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(
      'carried-divergent',
      'main',
      {
        detached: true,
        carryDirtyState: true,
        dirtyStateSource: sibling,
      },
    );
    expect(result.success).toBe(true);
    const worktreePath = fs.realpathSync(result.worktree!.path);
    const sessionId = 'session-carried-divergent';
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const plan: WorktreeCleanupPlan = {
      sessionId,
      sidecar: {
        slug: 'carried-divergent',
        worktreePath,
        worktreeBranch: '',
        originalCwd: repoRoot,
        originalBranch: 'main',
        originalHeadCommit: '',
        carriedFrom: sibling,
        carriedEntries: result.carriedEntries!,
      },
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };
    // The true source moves on; the decoy workspace root still matches.
    fs.writeFileSync(path.join(sibling, 'carry.txt'), 'sibling-moved-on\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
    const restored = path.join(repoParent, 'restored-divergent');
    git(repoRoot, 'worktree', 'add', '--detach', restored, 'HEAD');
    const meta = await readWorktreeSnapshotMeta(
      archiveMetas(plan.sessionId)[0],
    );
    await restoreWorktreeSnapshot(archives(plan.sessionId)[0], restored, meta);
    expect(fs.readFileSync(path.join(restored, 'carry.txt'), 'utf8')).toBe(
      'carried-untracked\n',
    );
  });

  it('snapshots when the session deleted a carried untracked file (R5-8)', async () => {
    const plan = await carriedPlan('carried-del-untracked', true);
    // An untracked deletion leaves no status record; only the content-only
    // verification catches it, so the reaper must snapshot rather than read
    // the checkout clean and delete it bare.
    fs.rmSync(path.join(plan.lockKey, 'carry.txt'));

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(plan.sessionId).length > 0).toBe(true);
  });

  it('preserves a checkout whose submodule was initialized then deinited (R5-3)', async () => {
    // A real submodule: init inside the worktree leaves its object database
    // under the per-worktree <git-dir>/modules even after deinit empties the
    // working directory. That store can hold the only copy of unpushed
    // commits, so the whole checkout must be kept (no snapshot, no deletion).
    const subRoot = path.join(repoParent, 'subrepo');
    fs.mkdirSync(subRoot);
    git(subRoot, 'init', '-q');
    git(subRoot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(subRoot, 'config', 'user.email', 't@e.com');
    git(subRoot, 'config', 'user.name', 't');
    git(subRoot, 'config', 'commit.gpgsign', 'false');
    git(subRoot, 'commit', '-qm', 'sub', '--allow-empty', '--no-verify');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        subRoot,
        'lib',
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    git(repoRoot, 'commit', '-qm', 'add submodule', '--no-verify');
    const plan = await planFor('deinit-preserve');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '-q',
        'lib',
      ],
      { cwd: plan.lockKey, stdio: 'pipe' },
    );
    git(plan.lockKey, 'submodule', 'deinit', '-q', '-f', 'lib');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(archives('session-deinit-preserve').length > 0).toBe(false);
  });

  it('preserves a checkout with a paused merge and a clean status (P1)', async () => {
    git(repoRoot, 'checkout', '-q', '-b', 'topic');
    git(repoRoot, 'commit', '-qm', 'empty', '--allow-empty', '--no-verify');
    git(repoRoot, 'checkout', '-q', 'main');
    const slug = 'merge-autostash';
    const plan = await planFor(slug);
    // --no-commit pauses with MERGE_HEAD and no working-tree changes: only
    // the pending-operation gate can preserve this checkout.
    execFileSync('git', ['merge', '--no-commit', '--no-ff', 'topic'], {
      cwd: plan.lockKey,
      stdio: 'pipe',
    });
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: plan.lockKey,
        encoding: 'utf8',
      }),
    ).toBe('');
    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(
      execFileSync('git', ['rev-parse', 'MERGE_HEAD'], {
        cwd: plan.lockKey,
        encoding: 'utf8',
      }).trim(),
    ).not.toBe('');
    expect(archives(plan.sessionId).length).toBe(0);
  });

  it('preserves same-path untracked and ignored rewrites during capture without running textconv (R8-1/R8-2)', async () => {
    const plan = await planFor('late-save');
    // Both files already exist before the first digest: seeing their names is
    // not enough. secret.env is ignored but NOT disposable, so it is part of
    // the archive and its rewritten bytes must participate in the digest.
    fs.writeFileSync(path.join(plan.lockKey, 'late.txt'), 'before\n');
    fs.writeFileSync(path.join(plan.lockKey, 'secret.env'), 'before\n');
    // The old status+`git diff HEAD` implementation could execute an external
    // diff driver. Keep the sentinel outside the checkout being removed.
    const textconvRan = path.join(repoParent, 'textconv-ran');
    const textconvScript = path.join(repoParent, 'textconv.cjs');
    fs.writeFileSync(
      textconvScript,
      `require('node:fs').writeFileSync(${JSON.stringify(textconvRan)}, 'ran');\n`,
    );
    git(
      plan.lockKey,
      'config',
      'diff.trap.textconv',
      `"${process.execPath}" "${textconvScript}"`,
    );
    fs.writeFileSync(
      path.join(plan.lockKey, '.gitattributes'),
      '.gitignore diff=trap\n',
    );
    fs.appendFileSync(path.join(plan.lockKey, '.gitignore'), 'tracked-edit\n');
    // Positive control: the configured driver really runs when textconv is
    // requested. Clear its marker before the production path so the final
    // absence pins the implementation rather than a malformed configuration.
    execFileSync('git', ['diff', '--textconv', 'HEAD'], {
      cwd: plan.lockKey,
      stdio: 'pipe',
    });
    expect(fs.existsSync(textconvRan)).toBe(true);
    fs.rmSync(textconvRan);
    // Incompressible payload keeps the tar window open long enough for an
    // editor autosave to land mid-capture.
    fs.writeFileSync(
      path.join(plan.lockKey, 'payload.bin'),
      randomBytes(256 * 1024 * 1024),
    );
    const lateEdit = editAtCaptureStart(plan.sessionId, () => {
      fs.writeFileSync(
        path.join(plan.lockKey, 'late.txt'),
        'after-untracked\n',
      );
      fs.writeFileSync(
        path.join(plan.lockKey, 'secret.env'),
        'after-ignored\n',
      );
    });
    try {
      await executeWorktreeCleanup(plan);
    } finally {
      lateEdit.stop();
    }
    // Removal is conditional on the checkout still matching the capture:
    // late bytes must force preservation, and no diff driver may have run.
    expect(lateEdit.edited()).toBe(true);
    expect(archives(plan.sessionId)).toHaveLength(1);
    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.readFileSync(path.join(plan.lockKey, 'late.txt'), 'utf8')).toBe(
      'after-untracked\n',
    );
    expect(fs.readFileSync(path.join(plan.lockKey, 'secret.env'), 'utf8')).toBe(
      'after-ignored\n',
    );
    expect(fs.existsSync(textconvRan)).toBe(false);
  });

  it('preserves edits inside a collapsed ignored directory during capture (R8-1)', async () => {
    const plan = await planFor('late-ignored-directory');
    fs.appendFileSync(path.join(plan.lockKey, '.gitignore'), 'private/\n');
    fs.mkdirSync(path.join(plan.lockKey, 'private'));
    fs.writeFileSync(
      path.join(plan.lockKey, 'private', 'late.txt'),
      'before\n',
    );
    expect(
      execFileSync(
        'git',
        [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignored=matching',
        ],
        { cwd: plan.lockKey, encoding: 'utf8' },
      ),
    ).toContain('!! private/');
    fs.writeFileSync(
      path.join(plan.lockKey, 'payload.bin'),
      randomBytes(256 * 1024 * 1024),
    );
    const lateEdit = editAtCaptureStart(plan.sessionId, () => {
      fs.writeFileSync(
        path.join(plan.lockKey, 'private', 'late.txt'),
        'after-ignored-directory\n',
      );
    });
    try {
      await executeWorktreeCleanup(plan);
    } finally {
      lateEdit.stop();
    }
    expect(lateEdit.edited()).toBe(true);
    expect(archives(plan.sessionId)).toHaveLength(1);
    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(
      fs.readFileSync(path.join(plan.lockKey, 'private', 'late.txt'), 'utf8'),
    ).toBe('after-ignored-directory\n');
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a symlink retargeted while the archive is being written (R8-1)',
    async () => {
      const plan = await planFor('late-symlink');
      fs.symlinkSync('before-target', path.join(plan.lockKey, 'late-link'));
      fs.writeFileSync(
        path.join(plan.lockKey, 'payload.bin'),
        randomBytes(256 * 1024 * 1024),
      );
      const link = path.join(plan.lockKey, 'late-link');
      const lateEdit = editAtCaptureStart(plan.sessionId, () => {
        fs.rmSync(link);
        fs.symlinkSync('after-target', link);
      });
      try {
        await executeWorktreeCleanup(plan);
      } finally {
        lateEdit.stop();
      }
      expect(lateEdit.edited()).toBe(true);
      expect(archives(plan.sessionId)).toHaveLength(1);
      expect(fs.existsSync(plan.lockKey)).toBe(true);
      expect(fs.readlinkSync(link)).toBe('after-target');
    },
  );

  it.each(['delete', 'rename'] as const)(
    'archives and deletes after a tracked %s (audit digest)',
    async (kind) => {
      const plan = await planFor(`tracked-${kind}`);
      if (kind === 'delete') {
        fs.rmSync(path.join(plan.lockKey, '.gitignore'));
      } else {
        git(plan.lockKey, 'mv', '.gitignore', 'renamed.txt');
      }
      const digest = await checkoutChangeDigestForTesting(plan.lockKey);
      expect(digest).not.toBeNull();
      if (kind === 'delete') {
        expect(digest?.includes('.gitignore\0 D\0\0')).toBe(true);
        expect(digest?.includes('\0absent')).toBe(true);
      } else {
        // The source-path NUL record is not a status row and must not turn
        // into a phantom path losing its first three characters.
        expect(digest?.includes('tignore\0')).toBe(false);
        expect(digest?.includes('renamed.txt\0R \0')).toBe(true);
      }
      await executeWorktreeCleanup(plan);
      expect(archives(plan.sessionId)).toHaveLength(1);
      expect(fs.existsSync(plan.lockKey)).toBe(false);
      const meta = await readWorktreeSnapshotMeta(
        archiveMetas(plan.sessionId)[0],
      );
      expect(meta.dirty.deleted).toContain('.gitignore');
    },
  );

  it.each(['nested-disposable', 'nested-tmp', 'bisect'] as const)(
    'preserves late audit state during capture: %s',
    async (kind) => {
      const plan = await planFor(`late-${kind}`);
      if (kind === 'nested-disposable') {
        fs.appendFileSync(path.join(plan.lockKey, '.gitignore'), 'private/\n');
        fs.mkdirSync(path.join(plan.lockKey, 'private', 'node_modules'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(plan.lockKey, 'private', 'node_modules', 'result.txt'),
          'before\n',
        );
      } else if (kind === 'nested-tmp') {
        fs.mkdirSync(path.join(plan.lockKey, '.qwen-session.notes'));
        fs.writeFileSync(
          path.join(plan.lockKey, '.qwen-session.notes', 'draft.tmp'),
          'before\n',
        );
      }
      fs.writeFileSync(
        path.join(plan.lockKey, 'payload.bin'),
        randomBytes(256 * 1024 * 1024),
      );
      const late = editAtCaptureStart(plan.sessionId, () => {
        if (kind === 'nested-disposable') {
          fs.writeFileSync(
            path.join(plan.lockKey, 'private', 'node_modules', 'result.txt'),
            'after\n',
          );
        } else if (kind === 'nested-tmp') {
          fs.writeFileSync(
            path.join(plan.lockKey, '.qwen-session.notes', 'draft.tmp'),
            'after\n',
          );
        } else {
          git(plan.lockKey, 'bisect', 'start');
        }
      });
      try {
        await executeWorktreeCleanup(plan);
      } finally {
        late.stop();
      }
      expect(late.edited()).toBe(true);
      expect(archives(plan.sessionId)).toHaveLength(1);
      expect(fs.existsSync(plan.lockKey)).toBe(true);
      if (kind === 'nested-disposable') {
        expect(
          fs.readFileSync(
            path.join(plan.lockKey, 'private', 'node_modules', 'result.txt'),
            'utf8',
          ),
        ).toBe('after\n');
      } else if (kind === 'nested-tmp') {
        expect(
          fs.readFileSync(
            path.join(plan.lockKey, '.qwen-session.notes', 'draft.tmp'),
            'utf8',
          ),
        ).toBe('after\n');
      } else {
        const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
          cwd: plan.lockKey,
          encoding: 'utf8',
        }).trim();
        expect(
          fs.existsSync(path.resolve(plan.lockKey, gitDir, 'BISECT_START')),
        ).toBe(true);
      }
    },
  );

  it('preserves a clean tracked protected case-variant (audit capture)', async () => {
    fs.writeFileSync(path.join(repoRoot, '.QWEN-SESSION'), 'tracked variant\n');
    git(repoRoot, 'add', '.QWEN-SESSION');
    git(repoRoot, 'commit', '-qm', 'track marker variant', '--no-verify');
    const plan = await planFor('tracked-case-variant');
    fs.writeFileSync(path.join(plan.lockKey, 'unique-work.txt'), 'unique\n');
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.QWEN-SESSION'], {
        cwd: plan.lockKey,
        encoding: 'utf8',
      }),
    ).toBe('');
    await executeWorktreeCleanup(plan);
    expect(fs.existsSync(plan.lockKey)).toBe(true);
    expect(fs.existsSync(path.join(plan.lockKey, 'unique-work.txt'))).toBe(
      true,
    );
    expect(archives(plan.sessionId)).toHaveLength(0);
  });

  it('snapshots rather than deleting when the source is an unrelated repository (S6-1)', async () => {
    fs.writeFileSync(path.join(repoRoot, 'carry.txt'), 'carried-untracked\n');
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), 'extra-rule\n');
    const outer = path.join(repoParent, 'outer');
    fs.mkdirSync(outer);
    git(outer, 'init', '-q');
    git(outer, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(outer, 'config', 'user.email', 't@e.com');
    git(outer, 'config', 'user.name', 't');
    git(outer, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(outer, 'README.md'), 'readme-base\n');
    git(outer, 'add', '.');
    git(outer, 'commit', '-qm', 'init', '--no-verify');
    const checkout = path.join(outer, 'sub');
    git(outer, 'worktree', 'add', '--detach', checkout, 'HEAD');
    // The decoy source carries the overlay content byte-for-byte, so without
    // the same-repository check the waiver would be wrongly granted.
    fs.writeFileSync(path.join(checkout, 'carry.txt'), 'carried-untracked\n');
    fs.writeFileSync(
      path.join(checkout, '.gitignore'),
      'secret.env\nnode_modules/\nextra-rule\n',
    );
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('unrelated-decoy', 'main', {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: checkout,
    });
    expect(result.success).toBe(true);
    const worktreePath = fs.realpathSync(result.worktree!.path);
    // Premise of the decoy: the overlay really came from this different
    // checkout, not from originalCwd. Without this assertion the test could
    // pass by never exercising the sibling-source branch at all (S6-1).
    expect(fs.realpathSync(checkout)).not.toBe(fs.realpathSync(repoRoot));
    expect(fs.readFileSync(path.join(worktreePath, 'carry.txt'), 'utf8')).toBe(
      'carried-untracked\n',
    );
    expect(
      result.carriedEntries?.some((entry) => entry.path === 'carry.txt'),
    ).toBe(true);
    const sessionId = 'session-unrelated-decoy';
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const plan: WorktreeCleanupPlan = {
      sessionId,
      sidecar: {
        slug: 'unrelated-decoy',
        worktreePath,
        worktreeBranch: '',
        originalCwd: repoRoot,
        originalBranch: 'main',
        originalHeadCommit: '',
        carriedFrom: checkout,
        carriedEntries: result.carriedEntries!,
      },
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };
    await executeWorktreeCleanup(plan);
    expect(fs.existsSync(plan.lockKey)).toBe(false);
    expect(archives(sessionId).length).toBeGreaterThan(0);
  });
});
