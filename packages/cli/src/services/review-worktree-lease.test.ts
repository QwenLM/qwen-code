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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupReviewWorktreeLeases,
  clearReviewWorktreeLease,
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  isReviewLeaseFile,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
  type ReviewWorktreeLease,
} from './review-worktree-lease.js';

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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  it('removes only the superseded legacy lease, directory or not', () => {
    const root = createRepository();
    const legacy = (t: string) =>
      join(root, '.qwen', 'tmp', `qwen-review-lease-${t}.json`);
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(legacy('pr-1'), '{}');
    writeFileSync(legacy('pr-2'), '{}');
    // The wedge shape: a DIRECTORY where the old lease file was. `force` alone
    // only swallows ENOENT, so a non-recursive remove throws EISDIR out of
    // acquisition and every later review of that PR fails on this machine.
    rmSync(legacy('pr-1'), { force: true });
    mkdirSync(legacy('pr-1'), { recursive: true });

    createReviewWorktreeLease({
      sessionId: 's',
      promptId: 'p',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    expect(existsSync(legacy('pr-1'))).toBe(false);
    // Scoped: another target's legacy lease is not this call's to remove.
    expect(existsSync(legacy('pr-2'))).toBe(true);
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
    const legacy = join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json');
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({
        sessionId: 'older-build-session',
        promptId: 'older-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      })}\n`,
    );

    const read = readReviewWorktreeLease(root, 'pr-1');
    expect(read?.sessionId).toBe('older-build-session');
    expect(reviewLeaseHeldByAnotherSession(read)).toBe(true);
    // Acquisition refuses rather than leaving two leases for one target, which
    // is what deleting this one and writing a new one would have done.
    expect(() =>
      createReviewWorktreeLease({
        sessionId: 'newer-build-session',
        promptId: 'newer-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      }),
    ).toThrow(/held by another/);
    expect(existsSync(legacy)).toBe(true);
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
