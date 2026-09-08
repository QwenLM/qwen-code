// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { PathOrFileDescriptor, WriteFileOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupReviewWorktreeLeases,
  clearReviewWorktreeLease,
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  isReviewLeaseFile,
  LEGACY_LEASE_CUTOFF_MS,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
  type ReviewWorktreeLease,
} from './review-worktree-lease.js';

// Set from exactly one test: plants an honored pre-move lease at the legacy
// path at the moment the new-path lease write happens — the "appears between
// the gate read and the mirror write" interleaving the mirror's EEXIST arm
// exists for, which no in-process fixture can otherwise produce because the
// acquisition sequence is synchronous.
const fsMockState = vi.hoisted(() => ({
  plantBeforeNewPathWrite: null as {
    newLeasePath: string;
    plantDir: string;
    plantPath: string;
    plantContents: string;
    plantMtime: Date;
  } | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (
      path: PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: WriteFileOptions,
    ) => {
      const plant = fsMockState.plantBeforeNewPathWrite;
      if (plant && String(path) === plant.newLeasePath) {
        fsMockState.plantBeforeNewPathWrite = null;
        actual.mkdirSync(plant.plantDir, { recursive: true });
        actual.writeFileSync(plant.plantPath, plant.plantContents);
        actual.utimesSync(plant.plantPath, plant.plantMtime, plant.plantMtime);
      }
      return actual.writeFileSync(path, data, options);
    },
  };
});

const roots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-lease-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'init']);
  return root;
}

afterEach(() => {
  fsMockState.plantBeforeNewPathWrite = null;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write a lease at the pre-move path, optionally backdating its mtime. */
function writeLegacyLease(lease: ReviewWorktreeLease, mtime?: Date): string {
  const path = join(
    lease.repositoryRoot,
    '.qwen',
    'tmp',
    `qwen-review-lease-${lease.target}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lease)}\n`);
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe('review worktree leases', () => {
  it('protects a worktree created after the lease is registered', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
  });

  it('falls back to removing an unregistered worktree directory', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'marker'), 'remove');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
  });

  it('keeps the lease when fallback pruning fails', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    renameSync(join(root, '.git'), join(root, '.git-hidden'));

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('removes only worktrees owned by the completed session', () => {
    const root = createRepository();
    const owned = join(root, '.qwen', 'tmp', 'review-pr-1');
    const other = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      owned,
      'qwen-review/pr-1',
    ]);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      other,
      'qwen-review/pr-2',
    ]);

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: owned,
      branch: 'qwen-review/pr-1',
    });
    createReviewWorktreeLease({
      sessionId: 'session-b',
      promptId: 'prompt-parent',
      target: 'pr-2',
      repositoryRoot: root,
      worktreePath: other,
      branch: 'qwen-review/pr-2',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      readFileSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-2.json'),
        'utf8',
      ),
    ).toContain('session-b');
  });

  it('does not let a child prompt clean up its parent review lease', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-child',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('does not remove a path outside the review temp directory', () => {
    const root = createRepository();
    const outside = join(root, 'keep-me');
    mkdirSync(outside);
    writeFileSync(join(outside, 'marker'), 'keep');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: outside,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('keep');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('ignores a lease whose branch does not match its PR target', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'keep-me']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'keep-me',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'keep-me',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('does not derive lease paths from invalid targets', () => {
    const root = createRepository();
    const marker = join(root, 'keep.json');
    writeFileSync(marker, 'keep');

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: '../../../keep',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    clearReviewWorktreeLease(root, '../../../keep');

    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(existsSync(join(root, '.qwen', 'tmp'))).toBe(false);
  });

  it('lets explicit review cleanup disarm the finalizer', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    clearReviewWorktreeLease(root, 'pr-1');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-1');
  });
});

describe('the move out of the mounted directory', () => {
  it('replaces the superseded legacy lease with the mirror, directory or not', () => {
    const root = createRepository();
    const legacy = (t: string) =>
      join(root, '.qwen', 'tmp', `qwen-review-lease-${t}.json`);
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(legacy('pr-2'), '{}');
    // The wedge shape: a DIRECTORY where the old lease file was. A
    // non-recursive remove throws EISDIR out of acquisition, and nothing
    // else removes it — the sweep skips the lease shape and `rm -f` cannot
    // remove a directory — so every review of that PR used to fail on this
    // machine.
    mkdirSync(legacy('pr-1'), { recursive: true });

    createReviewWorktreeLease({
      sessionId: 's',
      promptId: 'p',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    // The wedge directory is gone, replaced by this session's mirror so
    // pre-move builds can see the lock.
    const mirror = JSON.parse(readFileSync(legacy('pr-1'), 'utf8')) as {
      sessionId?: string;
    };
    expect(mirror.sessionId).toBe('s');
    // Scoped: another target's legacy lease is not this call's to touch.
    expect(readFileSync(legacy('pr-2'), 'utf8')).toBe('{}');
    // ...and the new one is written where nothing mounts.
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });
});

describe('a pre-move lease another session is still holding', () => {
  it('is read by the gate and left in place by acquisition', () => {
    // The move changed where the gate READS with no fallback for the population
    // already on disk, so for the length of a rollout an older build's live lock
    // was invisible: `reviewLeaseHeldByAnotherSession(null)` answers false, the
    // newer run proceeds, its acquisition deletes the lock, and `cleanStale`
    // force-removes the older session's worktree and deletes its branch mid-run.
    // That is #9205 — the incident this lease exists to prevent — with the older
    // session's rollback then clearing nothing, so the destruction goes
    // unannounced. Unread is not inert when the file IS another session's lock.
    const root = createRepository();
    const worktreePath = join(root, '.qwen', 'tmp', 'review-pr-1');
    const legacy = writeLegacyLease(
      {
        sessionId: 'older-build-session',
        promptId: 'older-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath,
        branch: 'qwen-review/pr-1',
      },
      // Written before the first build carrying the move shipped: the bound
      // honors it as a genuine pre-move lock.
      new Date(LEGACY_LEASE_CUTOFF_MS - 60_000),
    );

    const read = readReviewWorktreeLease(root, 'pr-1');
    expect(read?.sessionId).toBe('older-build-session');
    expect(reviewLeaseHeldByAnotherSession(read)).toBe(true);
    // Acquisition refuses rather than leaving two leases for one target, which
    // is what deleting this one and writing a new one would have done.
    let thrown: Error | null = null;
    try {
      createReviewWorktreeLease({
        sessionId: 'newer-build-session',
        promptId: 'newer-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath,
        branch: 'qwen-review/pr-1',
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(/held by another/);
    // The refusal must name the path the lease was actually found at: a
    // recovery instruction citing only the new path deletes a file that does
    // not exist and leaves this wedge in place.
    expect(thrown?.message).toContain(legacy);
    expect(existsSync(legacy)).toBe(true);
  });
});

describe('the one-release rollout window', () => {
  const acquire = (root: string) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
  });
  const legacyPathFor = (root: string) =>
    join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json');

  it('mirrors the lease at the legacy path for pre-move builds', () => {
    // A build from before the move reads ONLY `.qwen/tmp`; without the mirror
    // it passes its own gate over this live lease for the whole rollout
    // window, and its cleanStale force-removes this session's worktree and
    // deletes its branch mid-run — #9205 in the mirrored direction, and
    // unannounced, because this session's rollback clears only the new path.
    const root = createRepository();
    createReviewWorktreeLease(acquire(root));

    const mirror = JSON.parse(
      readFileSync(legacyPathFor(root), 'utf8'),
    ) as ReviewWorktreeLease;
    expect(mirror.sessionId).toBe('session-a');
    expect(mirror.promptId).toBe('prompt-a');
    expect(mirror.worktreePath).toBe(join(root, '.qwen', 'tmp', 'review-pr-1'));
  });

  it('backs out the acquisition when an older build takes the legacy path mid-acquisition', () => {
    // An honored pre-move lease (foreign session, mtime predating the cutoff)
    // appearing between the gate read and the mirror write — an old build
    // that cannot see the new path at all — must fail the acquisition and
    // release the new-path lease: never clobber the older build's lock,
    // never leave two sessions each believing they hold the target.
    const root = createRepository();
    const legacy = legacyPathFor(root);
    fsMockState.plantBeforeNewPathWrite = {
      newLeasePath: reviewLeasePath(root, 'pr-1'),
      plantDir: dirname(legacy),
      plantPath: legacy,
      plantContents: `${JSON.stringify({
        sessionId: 'older-build-session',
        promptId: 'older-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      })}\n`,
      plantMtime: new Date(LEGACY_LEASE_CUTOFF_MS - 60_000),
    };

    let thrown: Error | null = null;
    try {
      createReviewWorktreeLease(acquire(root));
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toMatch(/held by another/);
    expect(thrown?.message).toContain(legacy);
    // The new-path lease was released...
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(false);
    // ...and the older build's lock was not clobbered.
    const surviving = JSON.parse(
      readFileSync(legacy, 'utf8'),
    ) as ReviewWorktreeLease;
    expect(surviving.sessionId).toBe('older-build-session');
  });

  it('grants a fresh-mtime legacy plant no gate authority and replaces it', () => {
    // A lease-shaped file written inside the mounted directory AFTER the move
    // (mtime past the cutoff) cannot be told apart from a plant naming a
    // foreign session, so it must not block acquisition — that refusal would
    // be a denial of service delivered from the writable surface the move
    // exists to escape. Acquisition proceeds and the mirror overwrites the
    // plant with the winner's own lease.
    const root = createRepository();
    const legacy = writeLegacyLease(
      {
        sessionId: 'planted-foreign-session',
        promptId: 'planted-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      },
      // "Now" once the first build carrying the move has shipped — this test
      // runs before that release date, so the fresh mtime is set explicitly.
      new Date(LEGACY_LEASE_CUTOFF_MS + 60_000),
    );

    createReviewWorktreeLease(acquire(root));

    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
    const mirror = JSON.parse(
      readFileSync(legacy, 'utf8'),
    ) as ReviewWorktreeLease;
    expect(mirror.sessionId).toBe('session-a');
  });

  it.skipIf(process.platform === 'win32')(
    'treats a FIFO planted at the legacy lease path as no lease instead of hanging',
    { timeout: 10_000 },
    () => {
      // `readFileSync` blocks in open(2) on a FIFO with no timeout, so
      // without the lstat guard every host-side gate read of this target —
      // acquisition, cleanup's holder check — would hang forever.
      const root = createRepository();
      const legacy = legacyPathFor(root);
      mkdirSync(dirname(legacy), { recursive: true });
      execFileSync('mkfifo', [legacy]);

      expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
      // Removed, not merely ignored: nothing else ever would.
      expect(existsSync(legacy)).toBe(false);

      createReviewWorktreeLease(acquire(root));
      expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe(
        'session-a',
      );
    },
  );

  it('clearReviewWorktreeLeaseIfOwned removes an owned pre-move lease', () => {
    // Before the dual-location clear this deleted only the nonexistent
    // new-path file and left the legacy wedge in place. The ownership rule
    // still gates the legacy delete — a foreign pre-move lease is covered by
    // 'a pre-move lease another session is still holding'.
    const root = createRepository();
    const legacy = writeLegacyLease(
      {
        sessionId: 'session-a',
        promptId: 'prompt-a',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      },
      new Date(LEGACY_LEASE_CUTOFF_MS - 60_000),
    );

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-a',
      promptId: 'prompt-a',
    });
    expect(existsSync(legacy)).toBe(false);
  });

  it("the finalizer sweep finalizes this session's own mirror at the pre-move path", () => {
    // The acquisition mirror is content-identical to the new-path lease, so
    // the sweep's mirror check passes and the legacy copy is finalized
    // together with it.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const mirror = legacyPathFor(root);

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(mirror)).toBe(false);
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
  });

  it("never acts on a planted legacy lease that copies the mirror's credentials", () => {
    // The mirror is READABLE inside the mounted directory, so reviewed code
    // can learn this session's sessionId/promptId from it and plant a lease
    // passing every ownership check — but naming a victim worktreePath.
    // Only content-equality with the new-path lease (outside the mount)
    // proves acquisition wrote a legacy lease, so the plant must be left
    // inert: the victim and its branch survive. The plant file itself is
    // left in place — ignoring it is enough, and acquisition overwrites it
    // with the real mirror if the target is ever genuinely taken.
    const root = createRepository();
    // The copy source: this session's genuine lease + mirror for pr-1.
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    // The victim: another review tree under the same temp dir.
    const victim = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      victim,
      'qwen-review/pr-2',
    ]);
    const plant = writeLegacyLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-2',
      repositoryRoot: root,
      worktreePath: victim,
      branch: 'qwen-review/pr-2',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(victim)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-2'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-2');
    expect(existsSync(plant)).toBe(true);
  });
});

describe('readReviewWorktreeLease', () => {
  it('returns the lease createReviewWorktreeLease wrote', () => {
    const root = createRepository();
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    const lease = readReviewWorktreeLease(root, 'pr-1');
    expect(lease?.sessionId).toBe('session-a');
    expect(lease?.promptId).toBe('prompt-parent');
    expect(lease?.worktreePath).toBe(join(root, '.qwen', 'tmp', 'review-pr-1'));
    expect(reviewLeasePath(root, 'pr-1')).toBe(
      join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
    );
  });

  it('returns null for a missing lease and for non-PR targets', () => {
    const root = createRepository();
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
    expect(readReviewWorktreeLease(root, '../../evil')).toBeNull();
    expect(readReviewWorktreeLease(root, 'local')).toBeNull();
  });
});

describe('lease acquisition is atomic (#9205)', () => {
  const leaseParams = (
    root: string,
    over: Partial<Parameters<typeof createReviewWorktreeLease>[0]> = {},
  ) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
    ...over,
  });

  it('refuses to overwrite a lease another session acquired first', () => {
    // Two concurrent fetch-prs can both pass the gate's read; the second
    // writer must not clobber the winner's lease, or the loser's rollback
    // then deletes a lock it never owned.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));

    expect(() =>
      createReviewWorktreeLease(
        leaseParams(root, { sessionId: 'session-b', promptId: 'prompt-b' }),
      ),
    ).toThrow(/session-a/);

    const lease = readReviewWorktreeLease(root, 'pr-1');
    expect(lease?.sessionId).toBe('session-a');
    expect(lease?.promptId).toBe('prompt-a');
  });

  it('lets the owning session refresh its own lease on a re-fetch', () => {
    // Ownership is per session, not per prompt: a drift restart rewrites
    // its own lease with the new prompt id.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    expect(readReviewWorktreeLease(root, 'pr-1')?.promptId).toBe('prompt-b');
  });

  it('heals an unreadable lease file instead of wedging on it', () => {
    // Every reader treats a torn/unparseable lease as no lease, so the
    // writer rewriting it is self-heal, not clobber.
    const root = createRepository();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    mkdirSync(join(root, '.qwen', 'review-leases'), { recursive: true });
    writeFileSync(reviewLeasePath(root, 'pr-1'), '{"truncated');
    createReviewWorktreeLease(leaseParams(root));
    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
  });
});

describe('clearReviewWorktreeLeaseIfOwned', () => {
  it('removes the lease only when the caller wrote it', () => {
    // The manual-recovery shape: a session that acquired while a stuck run
    // was being recovered must survive that stuck run's failure rollback.
    const root = createRepository();
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-b',
      promptId: 'prompt-b',
    });
    expect(readReviewWorktreeLease(root, 'pr-1')).not.toBeNull();

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-a',
      promptId: 'prompt-a',
    });
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
  });
});

describe('isReviewLeaseFile', () => {
  it('accepts exactly the filenames the lease writer can produce', () => {
    expect(isReviewLeaseFile('qwen-review-lease-pr-1.json')).toBe(true);
    expect(isReviewLeaseFile('qwen-review-lease-pr-99999.json')).toBe(true);
  });

  it('rejects near-misses the cleanup sweep must not skip', () => {
    // A file-review target named `lease` flattens to the bare prefix; its
    // side files must stay sweepable, and nothing else is a lease.
    expect(isReviewLeaseFile('qwen-review-lease-diff.txt')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-.json')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-local.json')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-pr-1.json.bak')).toBe(false);
    expect(isReviewLeaseFile('xqwen-review-lease-pr-1.json')).toBe(false);
  });
});

describe('cleanupReviewWorktreeLeases scan', () => {
  it('skips files outside the writer target grammar even with lease content', () => {
    // The scan shares its lease shape with the writer (isReviewLeaseFile):
    // a hand-shaped file the writer could never produce is not swept, so the
    // finalizer's destructive path cannot ride a non-lease name.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    const stray = join(
      root,
      '.qwen',
      'review-leases',
      'qwen-review-lease-local.json',
    );
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(
      stray,
      JSON.stringify({
        sessionId: 'session-a',
        promptId: 'prompt-parent',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      }),
    );

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });
});

describe('reviewLeaseHeldByAnotherSession', () => {
  const lease: ReviewWorktreeLease = {
    sessionId: 'session-a',
    promptId: 'prompt-parent',
    target: 'pr-1',
    repositoryRoot: '/repo',
    worktreePath: '/repo/.qwen/tmp/review-pr-1',
    branch: 'qwen-review/pr-1',
  };
  let savedSessionId: string | undefined;

  beforeEach(() => {
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
  });

  afterEach(() => {
    if (savedSessionId === undefined) {
      delete process.env['QWEN_CODE_SESSION_ID'];
    } else {
      process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
    }
  });

  it('returns false when there is no lease', () => {
    delete process.env['QWEN_CODE_SESSION_ID'];
    expect(reviewLeaseHeldByAnotherSession(null)).toBe(false);
  });

  it('lets the owning session pass regardless of prompt', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(false);
    // One session reviews a PR across several prompts (rounds, drift
    // restarts); a later prompt of the holder must not be locked out.
    expect(
      reviewLeaseHeldByAnotherSession({
        ...lease,
        promptId: 'prompt-later',
      }),
    ).toBe(false);
  });

  it('blocks another session', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(true);
  });

  it('blocks a process that has no session id to prove ownership', () => {
    delete process.env['QWEN_CODE_SESSION_ID'];
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(true);
  });
});
