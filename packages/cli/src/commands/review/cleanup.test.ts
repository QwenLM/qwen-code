// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn((_path: string): boolean => false),
  lstatSync: vi.fn(
    (): { isSymbolicLink: () => boolean; isDirectory: () => boolean } => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    }),
  ),
  // The return type is declared so `mockReturnValue` can take string arrays —
  // the sweep-retention tests hand it the tmp-dir listing.
  readdirSync: vi.fn((_path: string): string[] => []),
  readFileSync: vi.fn((_path: string): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // statSync drives retention's mtime signal (runEpochMs + the per-entry
  // comparison); unmocked it hit the REAL filesystem and the signal could
  // only ever fail open here (#9259). The default is the same fail-open
  // throw readFileSync carries.
  statSync: vi.fn((_path: string): { mtimeMs: number } => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  rmSync: vi.fn(),
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  clearReviewWorktreeLease: vi.fn(),
  readReviewWorktreeLease: vi.fn((): unknown => null),
  reviewLeaseHeldByAnotherSession: vi.fn((_lease: unknown): boolean => false),
  refExists: vi.fn(() => true),
  // The parameter is declared so `mock.calls` is typed `[string][]` rather than
  // `[][]` — the paths it was asked to free are the assertion in the sweep test.
  releaseWorktree: vi.fn((_path: string) => ({
    existed: false,
    freed: false,
    reason: undefined,
  })),
  ghApiAll: vi.fn((_path: string): unknown[] => []),
  currentUser: vi.fn(() => 'reviewer'),
  setGhHost: vi.fn(),
  getGhHost: vi.fn((): string | undefined => undefined),
  // Default 'github' keeps every pre-Aone test on the gh audit path — the
  // dispatch is only visible to tests that steer it.
  detectPlatformKind: vi.fn((): 'github' | 'aone' => 'github'),
  a1Json: vi.fn((..._args: string[]): unknown => []),
  aoneWhoamiAccount: vi.fn(() => 'reviewer'),
}));

// The fixtures below key on POSIX path literals (`/repo/.qwen/tmp/…`), but
// cleanup.ts and the helpers it calls (redirectedAncestor, promptRecordDir,
// the deadline readers) run those strings through node:path. On Windows that
// would spell them with a drive letter and backslashes, so no literal-keyed
// mock or assertion could ever match. Pin POSIX semantics for this module
// graph; on POSIX hosts this is the identity.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, ...actual.posix, default: actual.posix };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, execFileSync: mocks.execFileSync },
    execFileSync: mocks.execFileSync,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mocks.existsSync,
      lstatSync: mocks.lstatSync,
      readdirSync: mocks.readdirSync,
      readFileSync: mocks.readFileSync,
      statSync: mocks.statSync,
      rmSync: mocks.rmSync,
    },
    existsSync: mocks.existsSync,
    lstatSync: mocks.lstatSync,
    readdirSync: mocks.readdirSync,
    readFileSync: mocks.readFileSync,
    statSync: mocks.statSync,
    rmSync: mocks.rmSync,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.writeStdoutLine,
  writeStderrLine: mocks.writeStderrLine,
}));

vi.mock('../../services/review-worktree-lease.js', () => ({
  clearReviewWorktreeLease: mocks.clearReviewWorktreeLease,
  readReviewWorktreeLease: mocks.readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession: mocks.reviewLeaseHeldByAnotherSession,
  reviewLeasePath: (repositoryRoot: string, target: string) =>
    `${repositoryRoot}/.qwen/review-leases/qwen-review-lease-${target}.json`,
  isReviewLeaseFile: (fileName: string) =>
    /^qwen-review-lease-pr-\d+\.json$/.test(fileName),
}));

vi.mock('./lib/git.js', () => ({
  refExists: mocks.refExists,
  releaseWorktree: mocks.releaseWorktree,
}));

vi.mock('./lib/gh.js', () => ({
  ghApiAll: mocks.ghApiAll,
  currentUser: mocks.currentUser,
  setGhHost: mocks.setGhHost,
  getGhHost: mocks.getGhHost,
}));

// The audit's platform dispatch — steered per test; the registry's real
// detection probes git remotes, which do not exist under vitest.
vi.mock('./lib/platform/registry.js', () => ({
  detectPlatformKind: mocks.detectPlatformKind,
}));

// The a1 seams — mocked so no test reaches a real `a1` (a platform query is
// never a test fixture).
vi.mock('./lib/platform/aone-client.js', () => ({
  a1Json: mocks.a1Json,
  aoneWhoamiAccount: mocks.aoneWhoamiAccount,
}));

vi.mock('./lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/paths.js')>();
  return {
    ...actual,
    worktreePath: (prNumber: string) => `/repo/.qwen/tmp/review-pr-${prNumber}`,
    probeWorktreePath: (path: string) => `${path}-probe`,
    baseWorktreePath: (path: string) => `${path}-base`,
    scratchWorktreePrefix: (path: string) => `${path}-scratch-`,
    reviewBranch: (prNumber: string) => `qwen-review/pr-${prNumber}`,
    LEASE_PREFIX: 'qwen-review-lease-',
    REVIEW_TMP_DIR: '/repo/.qwen/tmp',
    tmpFile: (target: string, suffix: string) =>
      `/repo/.qwen/tmp/qwen-review-${target}-${suffix}`,
    tmpPrefix: (target: string) => `qwen-review-${target}-`,
  };
});

import {
  findUnsanctionedAoneComments,
  findUnsanctionedIssueComments,
  findUnsanctionedReviews,
  runCleanup,
  type RawAoneComment,
  type RawIssueComment,
  type RawReview,
} from './cleanup.js';

describe('runCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, not implementations: a `mockReturnValue`
    // set in one test would otherwise decide what the next one's directory
    // sweep sees.
    mocks.readdirSync.mockReturnValue([]);
    mocks.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    });
    mocks.existsSync.mockReturnValue(false);
    // Implementations survive clearAllMocks — restore the fail-open throw
    // so one retention test's mtimes cannot leak into the next test. The
    // readFileSync default is the same story (#9272): a leaked
    // marker-returning implementation short-circuits the retention `||`
    // on the marker signal, and the mtime/plan-missing branches under
    // test never even evaluate.
    mocks.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // Same leak class for the listing (#9272): the retention tests install
    // path-dependent implementations, and a later test reading the declared
    // `[]` default would otherwise inherit them.
    mocks.readdirSync.mockImplementation((_path: string): string[] => []);
    mocks.refExists.mockReturnValue(true);
    mocks.releaseWorktree.mockReturnValue({
      existed: false,
      freed: false,
      reason: undefined,
    });
    // clearAllMocks keeps implementations a prior test set — drop them so a
    // throwing rmSync cannot leak into tests that expect deletion to work.
    mocks.rmSync.mockReset();
  });

  it('spares THIS run\u2019s stop sidecar, sweeps a foreign one', () => {
    // The PR stop path writes the sidecar and runs cleanup in the same
    // breath, and the parent's first poll is up to 250 ms away — swept
    // here, no reader could ever observe the decision and a decided round
    // exited 1 (human review on #9659). Kept only under a matching runId;
    // foreign or unstamped residue sweeps as before.
    const prev = process.env['QWEN_REVIEW_RUN_ID'];
    process.env['QWEN_REVIEW_RUN_ID'] = 'run-A';
    try {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdirSync.mockImplementation((p: string): string[] =>
        String(p).endsWith('tmp') ? ['qwen-review-pr-9-stop.json'] : [],
      );
      mocks.readFileSync.mockImplementation((p: string) => {
        if (String(p).endsWith('qwen-review-pr-9-stop.json')) {
          return JSON.stringify({ reason: 'up-to-date', runId: 'run-A' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      runCleanup('pr-9');
      expect(mocks.rmSync).not.toHaveBeenCalledWith(
        expect.stringContaining('qwen-review-pr-9-stop.json'),
        expect.anything(),
      );

      mocks.rmSync.mockClear();
      process.env['QWEN_REVIEW_RUN_ID'] = 'run-B';
      runCleanup('pr-9');
      expect(mocks.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('qwen-review-pr-9-stop.json'),
        expect.anything(),
      );
    } finally {
      if (prev === undefined) delete process.env['QWEN_REVIEW_RUN_ID'];
      else process.env['QWEN_REVIEW_RUN_ID'] = prev;
    }
  });

  it('refuses the bare `pr` target — its prefix engulfs every PR family', () => {
    // R20-4 follow-up: `tmpPrefix('pr')` is `qwen-review-pr-`, a strict
    // prefix of EVERY PR round's family, and the lease guard lives inside
    // the `pr-<n>` branch a bare `pr` never enters — one `cleanup pr` swept
    // every PR's artifacts at once, unguarded. A repo-root file literally
    // named `pr` derives exactly this token.
    runCleanup('pr');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to clean target "pr"'),
    );
    expect(mocks.rmSync).not.toHaveBeenCalled();
    // The numbered form is untouched.
    expect(() => runCleanup('pr-123')).not.toThrow();
  });

  it('keeps the lease when branch deletion fails', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('branch is locked');
    });

    runCleanup('pr-123');

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'qwen-review/pr-123'],
      // The env is sanitized: the check that gates this delete resolves the
      // real repository, so the delete must not follow an exported `GIT_DIR`
      // into another one.
      expect.objectContaining({ stdio: 'pipe', env: expect.any(Object) }),
    );
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete branch qwen-review/pr-123'),
    );
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
  });

  it('clears the lease when cleanup succeeds', () => {
    mocks.execFileSync.mockReturnValue(Buffer.from(''));

    runCleanup('pr-123');

    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalledWith(
      process.cwd(),
      'pr-123',
    );
  });

  it('clears the lease when only a side file fails to delete', () => {
    // The lease guards the worktree and branch, not side files: once those
    // are freed, a residue a later sweep retries must not keep the lock held
    // — a leftover lease refuses every later fetch-pr of this PR and skips
    // every later cleanup, and nothing sweeps it automatically.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['qwen-review-pr-123-diff.txt']);
    mocks.rmSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    runCleanup('pr-123');

    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove'),
    );
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalledWith(
      process.cwd(),
      'pr-123',
    );
  });

  it('skips the whole target when another session holds the lease (#9205)', () => {
    // The incident shape: session B cleans up while session A is mid-review.
    // Nothing of A's may be touched — worktree, siblings, branch, side files,
    // audit window, or the lease itself.
    const lease = {
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-123',
      repositoryRoot: '/repo',
      worktreePath: '/repo/.qwen/tmp/review-pr-123',
      branch: 'qwen-review/pr-123',
    };
    mocks.readReviewWorktreeLease.mockReturnValueOnce(lease);
    mocks.reviewLeaseHeldByAnotherSession.mockImplementationOnce(
      (l: unknown) => l === lease,
    );
    // Populate the tmp dir so the per-target side-file sweep actually runs
    // once past the skip gate: a refactor that moves the sweep above the
    // gate would reach for the holder's side files and trip the
    // rmSync-not-called assertion below.
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['qwen-review-pr-123-diff.txt']);

    runCleanup('pr-123');

    // The skip must key on THIS target's lease: mockReturnValueOnce is
    // argument-blind, so an unwired read consults another PR's lease.
    expect(mocks.readReviewWorktreeLease).toHaveBeenCalledWith(
      process.cwd(),
      'pr-123',
    );
    expect(mocks.releaseWorktree).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('skipped cleanup for "pr-123"'),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('session-a'),
    );
    // The note must name the lease file itself — the operator cannot act on
    // "delete the lease file" without knowing which file that is.
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen-review-lease-pr-123.json'),
    );
  });

  it('proceeds when the lease belongs to this session', () => {
    const lease = {
      sessionId: 'session-b',
      promptId: 'prompt-b',
      target: 'pr-123',
      repositoryRoot: '/repo',
      worktreePath: '/repo/.qwen/tmp/review-pr-123',
      branch: 'qwen-review/pr-123',
    };
    mocks.readReviewWorktreeLease.mockReturnValueOnce(lease);
    mocks.reviewLeaseHeldByAnotherSession.mockReturnValueOnce(false);
    mocks.execFileSync.mockReturnValue(Buffer.from(''));

    runCleanup('pr-123');

    expect(mocks.releaseWorktree).toHaveBeenCalledTimes(3);
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalledWith(
      process.cwd(),
      'pr-123',
    );
  });

  it('re-checks the lease after the network-bound audit and skips if a session moved in during it (#9205)', () => {
    // The gate above reads the lease BEFORE the audit, but the audit spawns
    // network-bound gh processes (seconds-scale). A review of the same PR that
    // starts inside that window — reading no lease, then writing its own —
    // must not be destroyed by this cleanup: re-read the lease after the audit,
    // before any destructive step, and take the same skip path.
    const lease = {
      sessionId: 'session-b',
      promptId: 'prompt-b',
      target: 'pr-123',
      repositoryRoot: '/repo',
      worktreePath: '/repo/.qwen/tmp/review-pr-123',
      branch: 'qwen-review/pr-123',
    };
    // First read (the gate): no lease yet. Second read (post-audit): session B
    // has acquired one.
    mocks.readReviewWorktreeLease
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(lease);
    mocks.reviewLeaseHeldByAnotherSession
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    runCleanup('pr-123');

    expect(mocks.readReviewWorktreeLease).toHaveBeenCalledTimes(2);
    // Pin the ARGUMENTS of both reads: mockReturnValueOnce is argument-blind,
    // so a re-check that reads a malformed target stays green here while
    // failing open in production (validTarget rejects it -> null -> not held).
    expect(mocks.readReviewWorktreeLease).toHaveBeenNthCalledWith(
      1,
      process.cwd(),
      'pr-123',
    );
    expect(mocks.readReviewWorktreeLease).toHaveBeenNthCalledWith(
      2,
      process.cwd(),
      'pr-123',
    );
    // And the second read must come AFTER the audit, not merely exist:
    // hoisting it above auditPrWrites keeps every other assertion green while
    // the seconds-long audit again runs after the last lease check (#9205).
    // Here the audit no-ops on the missing fetch report and names that skip
    // on stderr — the note's position pins the audit inside the window.
    const auditNoteIndex = mocks.writeStderrLine.mock.calls.findIndex((c) =>
      String(c[0]).includes('bypass audit skipped'),
    );
    expect(auditNoteIndex).toBeGreaterThanOrEqual(0);
    expect(
      mocks.readReviewWorktreeLease.mock.invocationCallOrder[1]!,
    ).toBeGreaterThan(
      mocks.writeStderrLine.mock.invocationCallOrder[auditNoteIndex]!,
    );
    // Nothing of B's may be touched.
    expect(mocks.releaseWorktree).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('acquired the lease'),
    );
  });

  it('releases the review worktree AND both disposable siblings', () => {
    // `base-tree` deliberately leaves its tree standing for the whole review
    // (a later verifier may need it, and a base that failed to build is kept as
    // evidence), so this is its ONLY removal — not a crash sweep like the
    // probe's. A missing entry here leaks a full built checkout per review and
    // blocks the next run's `git worktree add`.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));

    runCleanup('pr-123');

    expect(mocks.releaseWorktree.mock.calls.map((c) => c[0])).toEqual([
      '/repo/.qwen/tmp/review-pr-123',
      '/repo/.qwen/tmp/review-pr-123-probe',
      '/repo/.qwen/tmp/review-pr-123-base',
    ]);
  });

  it('sweeps every verifier scratch tree, which it can only find by prefix', () => {
    // One per verifier shard, named for the shard's record key — so unlike the
    // probe and base siblings, the sweeper cannot reconstruct the names and
    // reads the directory instead. Missing them leaks a checkout per shard and
    // wedges the next review's `git worktree add` on the leftovers.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readdirSync.mockReturnValue([
      'review-pr-123',
      'review-pr-123-scratch-verify--round-1--aaa',
      'review-pr-123-scratch-verify--round-2--bbb',
      // Neither of these belongs to this review: one is another PR's scratch
      // tree, the other an ordinary side file.
      'review-pr-999-scratch-verify--round-1--ccc',
      'qwen-review-pr-123-diff.txt',
    ] as unknown as []);

    runCleanup('pr-123');

    expect(mocks.releaseWorktree.mock.calls.map((c) => c[0])).toEqual([
      '/repo/.qwen/tmp/review-pr-123',
      '/repo/.qwen/tmp/review-pr-123-probe',
      '/repo/.qwen/tmp/review-pr-123-base',
      '/repo/.qwen/tmp/review-pr-123-scratch-verify--round-1--aaa',
      '/repo/.qwen/tmp/review-pr-123-scratch-verify--round-2--bbb',
    ]);
  });

  it('unlinks a dangling symlink at a family path, which releaseWorktree cannot see', () => {
    // `releaseWorktree`'s `existsSync` follows the link, reports "never
    // existed", and never runs its `rmSync` — while the link still wedges the
    // next review's `git worktree add` with `already exists`.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readdirSync.mockReturnValue([
      'review-pr-123-scratch-verify--round-1--aaa',
    ] as unknown as []);
    mocks.existsSync.mockReturnValue(false);
    mocks.lstatSync.mockImplementation(((p: string) => ({
      // Only the family entry is a link; its parent directory is a directory.
      isSymbolicLink: () => String(p).includes('-scratch-'),
      isDirectory: () => !String(p).includes('-scratch-'),
    })) as unknown as () => {
      isSymbolicLink: () => boolean;
      isDirectory: () => boolean;
    });

    runCleanup('pr-123');

    expect(mocks.rmSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/review-pr-123-scratch-verify--round-1--aaa',
      { force: true },
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Removed scratch worktree link'),
    );
  });

  it('unlinks a symlink at the three NAMED family paths instead of releasing what it points at', () => {
    // A LIVE link at any of them used to reach `releaseWorktree`: its
    // `existsSync` followed the link and `git worktree remove --force`
    // resolved it — together they deleted whichever registered worktree the
    // link named, measured against the real function, while reporting the
    // family path as swept. A DANGLING one was invisible to it and survived
    // to wedge the next review's `worktree add`. Both shapes are unlinked
    // the way the scratch family's always were.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    // The family paths are links; their ANCESTORS are ordinary directories —
    // a symlink above the temp dir refuses the whole clean, which is a
    // different test.
    mocks.lstatSync.mockImplementation(((p: string) => ({
      isSymbolicLink: () => String(p).includes('review-pr-'),
      isDirectory: () => !String(p).includes('review-pr-'),
    })) as unknown as () => {
      isSymbolicLink: () => boolean;
      isDirectory: () => boolean;
    });

    runCleanup('pr-123');

    expect(mocks.releaseWorktree).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledWith('/repo/.qwen/tmp/review-pr-123', {
      force: true,
    });
    expect(mocks.rmSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/review-pr-123-probe',
      { force: true },
    );
    expect(mocks.rmSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/review-pr-123-base',
      { force: true },
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Removed worktree link'),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Removed probe worktree link'),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Removed base worktree link'),
    );
    // The registration outlives the link. This branch returns before ever
    // reaching `releaseWorktree`, which is where the pipeline's only other
    // prune lives — so without one here the family paths were reported swept
    // while their admin entries stayed behind and wedged the next
    // `worktree add` with `already exists`.
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'prune'],
      expect.anything(),
    );
  });

  it('does not announce a clean sweep when it could not list the family', () => {
    // A silent skip leaks a full checkout per shard while stdout says
    // "Nothing to clean" and the lease is cleared.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    runCleanup('pr-123');

    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('for scratch worktrees'),
    );
    expect(mocks.writeStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Nothing to clean'),
    );
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
  });

  it('refuses to clean anything when the temp dir hangs off a symlink', () => {
    // The scratch sweep alone used to answer this: it announced the hazard and
    // the same function kept deleting under it — the base-tree lock and every
    // side file, all resolved through the same redirected ancestor.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.lstatSync.mockImplementation(((p: string) => ({
      isSymbolicLink: () => String(p) === '/repo/.qwen',
      isDirectory: () => String(p) !== '/repo/.qwen',
    })) as unknown as () => {
      isSymbolicLink: () => boolean;
      isDirectory: () => boolean;
    });

    runCleanup('pr-123');

    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to clean'),
    );
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.releaseWorktree).not.toHaveBeenCalled();
    expect(mocks.clearReviewWorktreeLease).not.toHaveBeenCalled();
  });

  it('sweeps a stale base-tree build lock left by a killed builder', () => {
    // The lock is a plain directory (`mkdirSync` test-and-set), not a worktree,
    // so `releaseWorktree` never touches it; a builder killed mid-build leaves it
    // behind and every later base-tree probe reports "another probe is building"
    // until a manual rm. Cleanup sweeps it at the end of the review.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));

    runCleanup('pr-123');

    expect(mocks.rmSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/review-pr-123-base.lock',
      { recursive: true, force: true },
    );
  });

  it('never sweeps lease files, even for a target whose name collides with the lease prefix (#9205)', () => {
    // `safeTarget` flattens `lease` (and `./lease`) to `lease`, so a
    // file-review target with that name sweeps with a prefix that IS the
    // lease prefix: unguarded, the rmSync below deletes every live PR lease
    // — including another session's — and defeats the lock this PR adds.
    // Lease removal belongs to `clearReviewWorktreeLease` alone.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['qwen-review-lease-pr-123.json']);

    runCleanup('lease');

    expect(mocks.rmSync).not.toHaveBeenCalledWith(
      join('/repo/.qwen/tmp', 'qwen-review-lease-pr-123.json'),
      expect.anything(),
    );
    expect(
      mocks.writeStdoutLine.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toContain('qwen-review-lease-pr-123.json');
  });

  it('sweeps the side files of a lease-named target that share the lease prefix', () => {
    // The guard keys on the real lease shape, not the bare prefix: a
    // file-review target named `lease` flattens to exactly the lease prefix,
    // so keying on the prefix alone skips its OWN side files and nothing else
    // ever removes them (`clearReviewWorktreeLease` no-ops off `pr-\d+`) —
    // permanent residue. Only files shaped `…-pr-<n>.json` are real leases.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue([
      'qwen-review-lease-diff.txt',
      'qwen-review-lease-pr-999.json',
    ]);

    runCleanup('lease');

    const sideFile = join('/repo/.qwen/tmp', 'qwen-review-lease-diff.txt');
    expect(mocks.rmSync).toHaveBeenCalledWith(sideFile, {
      recursive: true,
      force: true,
    });
    // A live foreign lease survives the very same sweep.
    expect(mocks.rmSync).not.toHaveBeenCalledWith(
      join('/repo/.qwen/tmp', 'qwen-review-lease-pr-999.json'),
      expect.anything(),
    );
  });

  it('still sweeps side files that match the target prefix', () => {
    // The positive control for the lease guard: the skip keys on the lease
    // prefix, not on the sweep itself.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['qwen-review-local-diff.txt']);

    runCleanup('local');

    const sideFile = join('/repo/.qwen/tmp', 'qwen-review-local-diff.txt');
    expect(mocks.rmSync).toHaveBeenCalledWith(sideFile, {
      recursive: true,
      force: true,
    });
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      `Removed temp file: ${sideFile}`,
    );
  });

  it('keeps the record directory of a NON-CONVERGED reverse audit (#9206)', () => {
    // The loop writes its stop marker inside the record directory when it
    // runs to the round cap (or the budget) without converging, and clears
    // it on a clean convergence — so a marker on disk is exactly the run
    // whose certification history must survive the sweep for diagnosis.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue([
      'qwen-review-pr-123-fetch.json',
      'qwen-review-pr-123-fetch-prompts',
      'qwen-review-pr-123-diff.txt',
    ]);
    mocks.readFileSync.mockImplementation((path: string): string => {
      if (path.endsWith('budget-stop.json')) {
        return JSON.stringify({
          cause: 'round-cap',
          cap: 5,
          entry: 'reverse audit — did not converge within the 5-round cap of 5',
          entryZh: '反向审计——在 5 轮的反审轮数上限内未收敛',
          round: 6,
          remainingSeconds: 0,
          reserveSeconds: 0,
          atMs: Date.now(),
        });
      }
      // The fetch report without `fetchedAt`: the bypass audit skips itself.
      return JSON.stringify({});
    });

    runCleanup('pr-123');

    const removed = mocks.rmSync.mock.calls.map((c) => c[0]);
    expect(removed).toContain('/repo/.qwen/tmp/qwen-review-pr-123-fetch.json');
    expect(removed).toContain('/repo/.qwen/tmp/qwen-review-pr-123-diff.txt');
    expect(removed).not.toContain(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Kept /repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      ),
    );
  });

  it('keeps the record directory whose records predate the plan — a killed loop leaves no marker (#9206)', () => {
    // Signal 2: a loop KILLED mid-round stops without converging and
    // writes no marker; its records predate the retry's fresh plan
    // capture. The mtime comparison is what keeps that history — pinned
    // here against an inverted `<` or a slack/sign slip (#9259).
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockImplementation((p: string): string[] =>
      p === '/repo/.qwen/tmp'
        ? ['qwen-review-pr-123-fetch.json', 'qwen-review-pr-123-fetch-prompts']
        : ['reverse-audit--chunk-13--round-1--abc.txt'],
    );
    // No marker — the readFileSync default throws for budget-stop.json.
    const planNow = Date.now();
    mocks.statSync.mockImplementation((p: string) => ({
      mtimeMs: p.endsWith('.json') ? planNow : Date.parse('2020-01-01'),
    }));

    runCleanup('pr-123');

    expect(mocks.rmSync).not.toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      expect.anything(),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Kept /repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      ),
    );
  });

  it('keeps the record directory whose plan is already gone — a second cleanup keeps what the first kept (#9213)', () => {
    // Signal 3: the first cleanup preserved the directory and swept the
    // plan beside it, so no marker read and no mtime comparison can run.
    // The directory that survived on that evidence must survive again —
    // and "Nothing to clean" must NOT print while something was kept.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockImplementation((p: string) => p === '/repo/.qwen/tmp');
    mocks.readdirSync.mockReturnValue(['qwen-review-pr-123-fetch-prompts']);

    runCleanup('pr-123');

    expect(mocks.rmSync).not.toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      expect.anything(),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Kept /repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      ),
    );
    expect(mocks.writeStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Nothing to clean'),
    );
  });

  it('keeps the record directory on a PREVIOUS run’s marker — retention reads unfenced (#9213)', () => {
    // The fence drops a marker older than the plan capture — exactly the
    // marker a killed run left behind. Retention reading through the
    // fenced `readBudgetStop` would sweep the evidence #9206 reports;
    // this pins the unfenced read against that swap.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockImplementation((p: string): string[] =>
      p === '/repo/.qwen/tmp'
        ? ['qwen-review-pr-123-fetch.json', 'qwen-review-pr-123-fetch-prompts']
        : [],
    );
    const planNow = Date.now();
    mocks.statSync.mockImplementation((p: string) => {
      if (p.endsWith('.json')) return { mtimeMs: planNow };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mocks.readFileSync.mockImplementation((path: string): string => {
      if (path.endsWith('budget-stop.json')) {
        // A stop from HOURS before the plan capture — the fenced reader
        // (deadline.ts's own tests pin this) returns null for it.
        return JSON.stringify({
          cause: 'round-cap',
          cap: 5,
          entry: 'reverse audit — did not converge within the 5-round cap',
          entryZh: '反向审计——在 5 轮的反审轮数上限内未收敛',
          round: 6,
          remainingSeconds: 0,
          reserveSeconds: 0,
          atMs: Date.parse('2020-01-01'),
        });
      }
      return JSON.stringify({});
    });

    runCleanup('pr-123');

    expect(mocks.rmSync).not.toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      expect.anything(),
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Kept /repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      ),
    );
  });

  it('still sweeps the record directory once the loop converged (#9206)', () => {
    // A converged run cleared its marker (`refuseConverged` removes it): the
    // certification history earned nothing, and the sweep takes it like any
    // other side file. Same entries as the retention test, no marker.
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue([
      'qwen-review-pr-123-fetch.json',
      'qwen-review-pr-123-fetch-prompts',
    ]);
    mocks.readFileSync.mockReturnValue(JSON.stringify({}));

    runCleanup('pr-123');

    expect(mocks.rmSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch-prompts',
      { recursive: true, force: true },
    );
  });
});

describe('findUnsanctionedIssueComments', () => {
  const since = '2026-07-24T08:00:00Z';
  const comment = (over: Partial<RawIssueComment> & { id: number }) =>
    ({
      user: { login: 'reviewer' },
      created_at: '2026-07-24T09:00:00Z',
      ...over,
    }) as RawIssueComment;

  it('keeps only the reviewing account inside the window, case-insensitively', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({ id: 1 }),
        comment({ id: 2, user: { login: 'Reviewer' } }),
        comment({ id: 3, user: { login: 'someone-else' } }),
        comment({ id: 4, created_at: '2026-07-24T07:59:59Z' }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([1, 2]);
    expect(got.edited).toEqual([]);
  });

  it('classifies a pre-window comment edited inside the window as an edit', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 5,
          created_at: '2026-07-24T07:00:00Z',
          updated_at: '2026-07-24T09:00:00Z',
        }),
        comment({
          id: 6,
          created_at: '2026-07-24T07:00:00Z',
          updated_at: '2026-07-24T07:00:00Z',
        }),
      ],
      'reviewer',
      since,
    );
    expect(got.edited.map((c) => c.id)).toEqual([5]);
    expect(got.posted).toEqual([]);
  });

  it('still flags a comment that merely QUOTES an automation marker mid-body', () => {
    // The filter is anchored to the body start: a hand-posted summary quoting
    // a marked bot comment (or hiding the marker mid-body) stays visible.
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 9,
          body: 'summary quoting:\n<!-- qwen-triage stage=1 -->',
        }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([9]);
  });

  it('drops comments carrying the repo automation marker — CI shares the bot account', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({
          id: 7,
          body: '<!-- qwen-pr-precheck:manual-required -->\nchecks…',
        }),
        comment({ id: 8, body: 'a human sentence' }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted.map((c) => c.id)).toEqual([8]);
  });

  it('drops comments with no author or no timestamp instead of guessing', () => {
    const got = findUnsanctionedIssueComments(
      [
        comment({ id: 1, user: null }),
        comment({ id: 2, created_at: undefined }),
      ],
      'reviewer',
      since,
    );
    expect(got.posted).toEqual([]);
    expect(got.edited).toEqual([]);
  });
});

describe('findUnsanctionedReviews', () => {
  const since = '2026-07-24T08:00:00Z';
  const review = (over: Partial<RawReview> & { id: number }) =>
    ({
      user: { login: 'reviewer' },
      state: 'COMMENTED',
      submitted_at: '2026-07-24T09:00:00Z',
      ...over,
    }) as RawReview;

  it('flags in-window reviews by the account that the receipt does not vouch for', () => {
    const got = findUnsanctionedReviews(
      [
        review({ id: 1 }),
        review({ id: 2, user: { login: 'someone-else' } }),
        review({ id: 3, submitted_at: '2026-07-24T07:00:00Z' }),
      ],
      'reviewer',
      since,
      new Set(),
    );
    expect(got.map((r) => r.id)).toEqual([1]);
  });

  it('excludes every receipt-vouched review id, not just the last', () => {
    // Two sanctioned submits in one window (drift restart) — both ids are on
    // the receipt, and NEITHER may be flagged.
    const got = findUnsanctionedReviews(
      [review({ id: 1 }), review({ id: 2 }), review({ id: 3 })],
      'reviewer',
      since,
      new Set([2, 3]),
    );
    expect(got.map((r) => r.id)).toEqual([1]);
  });
});

describe('runCleanup — bypass-write audit', () => {
  const fetchReport = JSON.stringify({
    prNumber: '123',
    ownerRepo: 'acme/widgets',
    fetchedAt: '2026-07-24T08:00:00Z',
    host: 'ghe.example.com',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Implementations survive `clearAllMocks`, so a `mockReturnValue` set in
    // the other describe would otherwise decide what this one's directory
    // sweep sees — the same drift the sibling beforeEach pins against.
    mocks.readdirSync.mockReturnValue([]);
    mocks.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    });
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mocks.currentUser.mockReturnValue('reviewer');
    mocks.ghApiAll.mockReturnValue([]);
    // Same leak class: the Aone audit describe steers the dispatch, and a
    // leaked 'aone' would reroute every gh-path test here through a1.
    mocks.detectPlatformKind.mockReturnValue('github');
  });

  it('flags reviewer issue comments posted inside the window', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([
      {
        id: 42,
        user: { login: 'reviewer' },
        created_at: '2026-07-24T09:02:32Z',
        html_url: 'https://ghe.example.com/acme/widgets/pull/123#c42',
      },
      {
        id: 43,
        user: { login: 'pr-author' },
        created_at: '2026-07-24T09:03:00Z',
      },
    ]);

    runCleanup('pr-123');

    expect(mocks.readFileSync).toHaveBeenCalledWith(
      '/repo/.qwen/tmp/qwen-review-pr-123-fetch.json',
      'utf8',
    );
    expect(mocks.setGhHost).toHaveBeenCalledWith('ghe.example.com');
    expect(mocks.ghApiAll).toHaveBeenCalledWith(
      expect.stringContaining('repos/acme/widgets/issues/123/comments'),
    );
    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 42');
    expect(warnings.join('\n')).not.toContain('comment 43');
    expect(warnings.join('\n')).toContain('qwen review submit');
  });

  it('stays silent when the window is clean', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([
      {
        id: 7,
        user: { login: 'pr-author' },
        created_at: '2026-07-24T09:00:00Z',
      },
    ]);

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings).toEqual([]);
  });

  it('skips the audit without gh calls when the fetch report is absent or pre-fetchedAt, and names the skip', () => {
    runCleanup('pr-123'); // report missing (readFileSync throws)
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ prNumber: '123', ownerRepo: 'acme/widgets' }),
    );
    runCleanup('pr-123'); // old report without fetchedAt

    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    expect(mocks.setGhHost).not.toHaveBeenCalled();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.some((l) => l.includes('no fetch report'))).toBe(true);
    expect(notes.some((l) => l.includes('no fetchedAt'))).toBe(true);
  });

  it('skips when the fetch report names a different PR than the cleanup target', () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '999',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
      }),
    );

    runCleanup('pr-123');

    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.some((l) => l.includes('for PR 999'))).toBe(true);
  });

  it('clears any prior Enterprise host for a github.com report (host: null)', () => {
    // setGhHost(undefined) is what un-routes gh after an Enterprise review in
    // the same process; only the Enterprise fixture was asserted before.
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
        host: null,
      }),
    );
    mocks.ghApiAll.mockReturnValue([
      {
        id: 9,
        user: { login: 'reviewer' },
        created_at: '2026-07-24T09:00:00Z',
      },
    ]);

    runCleanup('pr-123');

    expect(mocks.setGhHost).toHaveBeenCalledWith(undefined);
    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 9');
  });

  it('restores the prior gh host after the audit instead of leaking the override', () => {
    // A host set before cleanup ran must be back in place afterwards — the
    // audit's Enterprise override is scoped to the audit block.
    mocks.getGhHost.mockReturnValue('prior.example.com');
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T08:00:00Z',
        host: 'ghe.example.com',
      }),
    );
    mocks.ghApiAll.mockReturnValue([]);

    runCleanup('pr-123');

    // Override applied, then the prior host restored (the last call).
    expect(mocks.setGhHost).toHaveBeenCalledWith('ghe.example.com');
    expect(mocks.setGhHost).toHaveBeenLastCalledWith('prior.example.com');
  });

  it('does not resolve the current user when the window has no comments at all', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockReturnValue([]);

    runCleanup('pr-123');

    expect(mocks.currentUser).not.toHaveBeenCalled();
  });

  it('reaches back past the recorded opening by the clock-skew allowance', () => {
    // fetchedAt 08:00:00 → boundary 07:58:00; a comment at 07:58:30 predates
    // the recorded opening but only by less than the allowance, so a fast
    // local clock cannot hide it.
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 11,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T07:58:30Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 11');
    expect(
      String(
        mocks.ghApiAll.mock.calls.find(([p]) =>
          String(p).includes('/issues/'),
        )![0],
      ),
    ).toContain(encodeURIComponent('2026-07-24T07:58:00.000Z'));
  });

  it('audits from auditSince when drift restarts pushed fetchedAt forward', () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'acme/widgets',
        fetchedAt: '2026-07-24T10:00:00Z',
        auditSince: '2026-07-24T08:00:00Z',
        host: null,
      }),
    );
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 12,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T08:30:00Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('posted comment 12');
  });

  it('renders the edited-comment warning with id, timestamp and URL through runCleanup', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/issues/')
        ? [
            {
              id: 21,
              user: { login: 'reviewer' },
              created_at: '2026-07-24T06:00:00Z',
              updated_at: '2026-07-24T09:10:00Z',
              html_url: 'https://ghe.example.com/acme/widgets/pull/123#c21',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain(
      'edited comment 21 at 2026-07-24T09:10:00Z — https://ghe.example.com/acme/widgets/pull/123#c21',
    );
  });

  it('flags an in-window review with no receipt, and spares the receipt-vouched one', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('submit-receipt.json')) {
        return JSON.stringify({ reviewId: 500 });
      }
      return fetchReport;
    });
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/reviews')
        ? [
            {
              id: 500,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:00:00Z',
            },
            {
              id: 501,
              user: { login: 'reviewer' },
              state: 'APPROVED',
              submitted_at: '2026-07-24T09:05:00Z',
              html_url: 'https://ghe.example.com/acme/widgets/pull/123#r501',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    expect(warnings.join('\n')).toContain('review 501 (APPROVED)');
    expect(warnings.join('\n')).toContain('no submit receipt vouches for it');
    expect(warnings.join('\n')).not.toContain('review 500');
    // The footer leads with the benign explanation — a same-account write is
    // usually external (you, a bot, or a concurrent workflow under the same
    // login) — names the account, and qualifies the bypass claim instead of
    // asserting a gate bypass outright. A concurrent same-account write on an
    // observe-only run must not read as "you bypassed the submit gate".
    expect(warnings.join('\n')).toContain('likely cause is benign');
    // Pin the interpolation SHAPE `(${me})`, not the bare word — the header
    // also says "reviewing account", so `toContain('reviewer')` would stay
    // green even if the account name were dropped from the footer.
    expect(warnings.join('\n')).toContain('(reviewer)');
    expect(warnings.join('\n')).toMatch(/real bypass of that gate only if/);
    // The relay instruction is the sentence that actually moves the warning to
    // a human — the rest of the audit is inert without it, so pin it here.
    expect(warnings.join('\n')).toContain('Relay this warning verbatim');
    // The footer's platform noun is contract text relayed verbatim.
    expect(warnings.join('\n')).toContain('writes to the PR');
  });

  it('spares every review in a multi-id receipt (two sanctioned submits in one window)', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('submit-receipt.json')) {
        return JSON.stringify({ reviewIds: [500, 502] });
      }
      return fetchReport;
    });
    mocks.ghApiAll.mockImplementation((path: string) =>
      path.includes('/reviews')
        ? [
            {
              id: 500,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:00:00Z',
            },
            {
              id: 502,
              user: { login: 'reviewer' },
              state: 'COMMENT',
              submitted_at: '2026-07-24T09:05:00Z',
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    const warnings = mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));
    // Both are receipt-vouched → no bypass warning at all.
    expect(warnings.join('\n')).not.toContain('review 500');
    expect(warnings.join('\n')).not.toContain('review 502');
  });

  it('names each malformed-report shape and never reaches GitHub', () => {
    const cases: Array<[string, string]> = [
      ['not json at all {', 'not valid JSON'],
      [
        JSON.stringify({ fetchedAt: '2026-07-24T08:00:00Z' }),
        'missing prNumber/ownerRepo',
      ],
      [
        JSON.stringify({
          prNumber: '123',
          ownerRepo: 'evil repo/../../x',
          fetchedAt: '2026-07-24T08:00:00Z',
        }),
        'not owner/repo-shaped',
      ],
    ];
    for (const [raw, expected] of cases) {
      vi.clearAllMocks();
      mocks.readFileSync.mockReturnValue(raw);
      runCleanup('pr-123');
      expect(mocks.ghApiAll).not.toHaveBeenCalled();
      const notes = mocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('note: bypass audit skipped'));
      expect(notes.join('\n')).toContain(expected);
    }
  });

  it('distinguishes an unreadable report from an absent one', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('cannot read fetch report (EACCES)');
    expect(notes.join('\n')).not.toContain('no fetch report');
  });

  it('surfaces the first non-empty stderr line when gh fails, not the generic wrapper', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: gh api …'), {
        stderr: '\ngh: Not authenticated. Run gh auth login.\n',
      });
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('gh: Not authenticated');
  });

  it('never fails the cleanup when the audit itself fails', () => {
    mocks.readFileSync.mockReturnValue(fetchReport);
    mocks.ghApiAll.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });

    expect(() => runCleanup('pr-123')).not.toThrow();
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalled();
  });
});

describe('findUnsanctionedAoneComments', () => {
  // Window boundary as epoch milliseconds; Aone stamps a NUMERIC utc offset
  // (+08:00), so the fixtures carry it — the lexicographic comparison the
  // gh twin uses would misorder every one of them.
  const sinceMs = Date.parse('2026-07-24T00:30:00.000Z');
  const comment = (over: Partial<RawAoneComment> & { id: number }) =>
    ({
      author: { username: 'reviewer' },
      // 2026-07-24T09:00:00+08:00 = 01:00Z — inside the window.
      createdAt: '2026-07-24T09:00:00+08:00',
      ...over,
    }) as RawAoneComment;

  it('keeps only the authenticated account inside the window, case-insensitively', () => {
    const got = findUnsanctionedAoneComments(
      [
        comment({ id: 1 }),
        comment({ id: 2, author: { username: 'Reviewer' } }),
        comment({ id: 3, author: { username: 'someone-else' } }),
        // 2026-07-24T08:15:00+08:00 = 00:15Z — BEFORE the 00:30Z boundary.
        comment({ id: 4, createdAt: '2026-07-24T08:15:00+08:00' }),
      ],
      'reviewer',
      sinceMs,
      new Set(),
    );
    expect(got.posted.map((c) => c.id)).toEqual([1, 2]);
    expect(got.edited).toEqual([]);
  });

  it('compares instants, not wall-clock strings, in both directions', () => {
    const got = findUnsanctionedAoneComments(
      [
        // 00:15Z — OUTSIDE the window, yet its wall-clock string
        // ('…T08:15…') sorts AFTER the boundary's ('…T00:30…'): a
        // lexicographic comparison would flag it.
        comment({ id: 1, createdAt: '2026-07-24T08:15:00+08:00' }),
        // The previous day's 16:45-08:00 = 00:45Z — INSIDE the window,
        // yet its string sorts BEFORE the boundary's date: a lexicographic
        // comparison would drop it.
        comment({ id: 2, createdAt: '2026-07-23T16:45:00-08:00' }),
      ],
      'reviewer',
      sinceMs,
      new Set(),
    );
    expect(got.posted.map((c) => c.id)).toEqual([2]);
  });

  it('excludes every receipt-vouched comment id, not just the last', () => {
    // Two sanctioned submits in one window (drift restart) — both ids are on
    // the receipt, and NEITHER may be flagged.
    const got = findUnsanctionedAoneComments(
      [comment({ id: 1 }), comment({ id: 2 }), comment({ id: 3 })],
      'reviewer',
      sinceMs,
      new Set([2, 3]),
    );
    expect(got.posted.map((c) => c.id)).toEqual([1]);
  });

  it('excludes a vouched comment from the EDITED arm too, not only the posted one', () => {
    // The vouch sits in the shared `relevant` filter: a submit-posted
    // comment whose updatedAt bumps inside the window (a hand-edit of
    // submit's own summary, or a backend state flip) must not be flagged
    // as an edited bypass.
    const got = findUnsanctionedAoneComments(
      [
        comment({
          id: 9,
          // 2026-07-23T23:00Z — before the window …
          createdAt: '2026-07-24T07:00:00+08:00',
          // … bumped at 2026-07-24T01:10Z — inside it.
          updatedAt: '2026-07-24T09:10:00+08:00',
        }),
      ],
      'reviewer',
      sinceMs,
      new Set([9]),
    );
    expect(got.posted).toEqual([]);
    expect(got.edited).toEqual([]);
  });

  it('classifies a pre-window comment edited inside the window as an edit', () => {
    const got = findUnsanctionedAoneComments(
      [
        comment({
          id: 5,
          // 2026-07-23T23:00Z — before the window …
          createdAt: '2026-07-24T07:00:00+08:00',
          // … edited at 2026-07-24T01:10Z — inside it.
          updatedAt: '2026-07-24T09:10:00+08:00',
        }),
        comment({
          id: 6,
          createdAt: '2026-07-24T07:00:00+08:00',
          updatedAt: '2026-07-24T07:00:00+08:00',
        }),
      ],
      'reviewer',
      sinceMs,
      new Set(),
    );
    expect(got.edited.map((c) => c.id)).toEqual([5]);
    expect(got.posted).toEqual([]);
  });

  it('drops comments carrying the repo automation marker, but not ones merely quoting it', () => {
    const got = findUnsanctionedAoneComments(
      [
        comment({
          id: 7,
          note: '<!-- qwen-pr-precheck:manual-required -->\nchecks…',
        }),
        comment({
          id: 8,
          note: 'summary quoting:\n<!-- qwen-triage stage=1 -->',
        }),
      ],
      'reviewer',
      sinceMs,
      new Set(),
    );
    expect(got.posted.map((c) => c.id)).toEqual([8]);
  });

  it('drops comments with no author, no timestamp, or an unparseable one instead of guessing', () => {
    const got = findUnsanctionedAoneComments(
      [
        comment({ id: 1, author: null }),
        comment({ id: 2, createdAt: undefined }),
        comment({ id: 3, createdAt: 'not a timestamp' }),
      ],
      'reviewer',
      sinceMs,
      new Set(),
    );
    expect(got.posted).toEqual([]);
    expect(got.edited).toEqual([]);
  });
});

describe('runCleanup — Aone bypass-write audit', () => {
  const aoneFetchReport = JSON.stringify({
    prNumber: '123',
    ownerRepo: 'maxcompute/odps_src',
    fetchedAt: '2026-07-24T08:00:00Z',
    host: 'gitlab.alibaba-inc.com',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readdirSync.mockReturnValue([]);
    mocks.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    });
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileSync.mockReturnValue(Buffer.from(''));
    mocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mocks.detectPlatformKind.mockReturnValue('aone');
    mocks.aoneWhoamiAccount.mockReturnValue('reviewer');
    mocks.a1Json.mockReturnValue([]);
  });

  const warnings = () =>
    mocks.writeStdoutLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('warning:'));

  it('routes the audit through a1, never gh, and flags an in-window same-account comment', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 777,
        note: 'hand-posted summary',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T17:02:32+08:00', // 09:02Z — inside the window
        path: 'src/foo.ts',
        line: 12,
      },
      {
        id: 778,
        note: 'author reply',
        author: { username: 'pr-author' },
        createdAt: '2026-07-24T17:03:00+08:00',
      },
    ]);

    runCleanup('pr-123');

    // The dispatch saw the recorded host; BOTH comment-list queries rode a1
    // with the report's coordinates (the default list plus the --resolved
    // union half) — and nothing touched the gh seam.
    expect(mocks.detectPlatformKind).toHaveBeenCalledWith({
      host: 'gitlab.alibaba-inc.com',
    });
    expect(mocks.a1Json).toHaveBeenCalledWith(
      'repo',
      'mr',
      'comment',
      'list',
      '--mr',
      '123',
      '--repo',
      'maxcompute/odps_src',
    );
    expect(mocks.a1Json).toHaveBeenCalledWith(
      'repo',
      'mr',
      'comment',
      'list',
      '--mr',
      '123',
      '--repo',
      'maxcompute/odps_src',
      '--resolved',
    );
    expect(mocks.ghApiAll).not.toHaveBeenCalled();
    expect(mocks.setGhHost).not.toHaveBeenCalled();
    expect(warnings().join('\n')).toContain(
      'posted comment 777 at 2026-07-24T17:02:32+08:00 on src/foo.ts:12',
    );
    expect(warnings().join('\n')).not.toContain('778');
    expect(warnings().join('\n')).toContain('qwen review submit');
    // The union dedupes by id: BOTH queries returned comment 777, and the
    // relayed lines flag it once, under a header counting it once.
    expect(
      warnings().filter((l) => l.includes('posted comment 777')),
    ).toHaveLength(1);
    expect(warnings().join('\n')).toContain(
      'warning: 1 comment(s) by the reviewing account on maxcompute/odps_src MR 123',
    );
    // The footer names the account and the relay instruction, as on GitHub.
    expect(warnings().join('\n')).toContain('(reviewer)');
    expect(warnings().join('\n')).toContain('Relay this warning verbatim');
    // The footer's platform noun is contract text relayed verbatim.
    expect(warnings().join('\n')).toContain('writes to the MR');
  });

  it('flags a posted-then-RESOLVED bypass through the --resolved union half', () => {
    // The default list hides resolved comments (measured a1 behaviour); the
    // union half must bring a bypass that was resolved inside the window
    // back into the posted arm.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockImplementation((...args: string[]) =>
      args.includes('--resolved')
        ? [
            {
              id: 88,
              note: 'hand-posted, then resolved to hide',
              author: { username: 'reviewer' },
              createdAt: '2026-07-24T17:05:00+08:00',
              closed: 1,
              path: 'src/bar.ts',
              line: 4,
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    expect(warnings().join('\n')).toContain(
      'posted comment 88 at 2026-07-24T17:05:00+08:00 on src/bar.ts:4',
    );
  });

  it('does not read a resolution bump on a resolved comment as an edit', () => {
    // Resolving a comment bumps updatedAt exactly like an edit; the edited
    // arm skips closed comments so an author resolving an old discussion
    // inside the window draws no flag.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockImplementation((...args: string[]) =>
      args.includes('--resolved')
        ? [
            {
              id: 89,
              note: 'pre-window comment, resolved inside the window',
              author: { username: 'reviewer' },
              createdAt: '2026-07-24T07:00:00+08:00', // 23:00Z — pre-window
              updatedAt: '2026-07-24T17:10:00+08:00', // resolution bump
              closed: 1,
            },
          ]
        : [],
    );

    runCleanup('pr-123');

    expect(warnings()).toEqual([]);
  });

  it('spares receipt-vouched comment ids, and reads ONLY the comment-id axis', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('submit-receipt.json')) {
        // reviewIds on the same receipt must not vouch for a comment.
        return JSON.stringify({ commentIds: [777, 779], reviewIds: [778] });
      }
      return aoneFetchReport;
    });
    mocks.a1Json.mockReturnValue([
      {
        id: 777,
        note: 'sanctioned inline',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T17:02:32+08:00',
      },
      {
        id: 778,
        note: 'hand-posted',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T17:03:00+08:00',
      },
      {
        id: 779,
        note: 'sanctioned summary, bumped inside the window',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T07:00:00+08:00', // pre-window
        updatedAt: '2026-07-24T17:10:00+08:00', // in-window bump
      },
    ]);

    runCleanup('pr-123');

    expect(warnings().join('\n')).not.toContain('777');
    expect(warnings().join('\n')).toContain('posted comment 778');
    // The vouch also covers the EDITED arm: a vouched comment whose
    // updatedAt moves inside the window is no edited bypass.
    expect(warnings().join('\n')).not.toContain('779');
  });

  it('stays silent when the window is clean', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 7,
        note: 'bot pipeline note',
        author: { username: 'odps-cm' },
        createdAt: '2026-07-24T17:00:00+08:00',
      },
    ]);

    runCleanup('pr-123');

    expect(warnings()).toEqual([]);
  });

  it('does not resolve the account when the MR has no comments at all', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([]);

    runCleanup('pr-123');

    expect(mocks.aoneWhoamiAccount).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it('flattens control sequences out of an MR-author-controlled path before the terminal', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 31,
        note: 'inline on a hostile filename',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T17:02:32+08:00',
        path: 'src/evil\u001b[31m.ts',
        line: 3,
      },
    ]);

    runCleanup('pr-123');

    const joined = warnings().join('\n');
    expect(joined).toContain('posted comment 31');
    // inertPath swaps the control run for a space — the escape never
    // reaches the terminal as an escape.
    expect(joined).toContain('on src/evil [31m.ts:3');
    expect(joined).not.toContain('\u001b');
  });

  it('renders an edited-comment warning with id and updatedAt', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 21,
        note: 'pre-window comment, edited inside the window',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T07:00:00+08:00', // 23:00Z the day before
        updatedAt: '2026-07-24T17:10:00+08:00', // 09:10Z — inside
      },
    ]);

    runCleanup('pr-123');

    const joined = warnings().join('\n');
    expect(joined).toContain('edited comment 21 at 2026-07-24T17:10:00+08:00');
    // Comment 21 carries no path — the absent-path branch of the location
    // suffix must render nothing, not `undefined` (the lines are relayed
    // verbatim into the user-facing summary).
    const editedLine = warnings().find((l) => l.includes('edited comment 21'));
    expect(editedLine).not.toContain('undefined');
    expect(editedLine).toBe(
      'warning:   edited comment 21 at 2026-07-24T17:10:00+08:00',
    );
  });

  it('reaches back past the recorded opening by the clock-skew allowance', () => {
    // auditSince 08:00:00Z → boundary 07:58:00Z; a comment at 15:58:30+08:00
    // (07:58:30Z) predates the recorded opening by less than the allowance,
    // so a fast local clock cannot hide it.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 11,
        note: 'just inside the skew allowance',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T15:58:30+08:00',
      },
    ]);

    runCleanup('pr-123');

    expect(warnings().join('\n')).toContain('posted comment 11');
  });

  it('audits from auditSince when drift restarts pushed fetchedAt forward', () => {
    // The Aone twin of the gh drift test: fetchedAt 10:00Z but auditSince
    // 08:00Z → boundary 07:58Z; a comment at 08:30Z sits inside the
    // auditSince window yet outside any fetchedAt-based one.
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'maxcompute/odps_src',
        fetchedAt: '2026-07-24T10:00:00Z',
        auditSince: '2026-07-24T08:00:00Z',
        host: 'gitlab.alibaba-inc.com',
      }),
    );
    mocks.a1Json.mockReturnValue([
      {
        id: 12,
        note: 'posted during the abandoned attempt',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T16:30:00+08:00', // 08:30Z
      },
    ]);

    runCleanup('pr-123');

    expect(warnings().join('\n')).toContain('posted comment 12');
  });

  it('passes host undefined to the dispatch for a hostless report (the cwd-origin fall-through)', () => {
    // A bare-number Aone run that omitted --host records no host; the
    // dispatch then falls back to the cwd clone's origin (the registry's
    // own fall-through, steered to 'aone' here). The pin is the call shape:
    // host null must arrive as undefined, not as a string gh could route.
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '123',
        ownerRepo: 'maxcompute/odps_src',
        fetchedAt: '2026-07-24T08:00:00Z',
        host: null,
      }),
    );
    mocks.a1Json.mockReturnValue([]);

    runCleanup('pr-123');

    expect(mocks.detectPlatformKind).toHaveBeenCalledWith({ host: undefined });
    expect(mocks.a1Json).toHaveBeenCalled();
    expect(mocks.ghApiAll).not.toHaveBeenCalled();
  });

  it('treats a non-array comment list as a failure, not a clean window', () => {
    // a1 can answer a well-formed error OBJECT with exit 0; reading it as
    // "no comments" would make the tripwire's off state indistinguishable
    // from its all-clear state.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue({
      schemaVersion: 'a1.error/v1',
      code: 'COMMAND_FAILED',
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('unexpected shape');
    expect(warnings()).toEqual([]);
  });

  it('surfaces the message of an exit-0 error OBJECT, not just the shape complaint', () => {
    // Measured a1 behaviour: a backend auth failure or a client timeout
    // answers the error object with exit 0. The operator paging at 3 AM
    // needs the cause (auth outage vs schema drift), not only "unexpected
    // shape".
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue({
      schemaVersion: 'a1.error/v1',
      code: 'COMMAND_FAILED',
      message:
        'listing MR comments: failed to initialize NCS CLI executor: ncs below minimum version',
      retryable: false,
      exitCode: 1,
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('unexpected shape');
    expect(notes.join('\n')).toContain('failed to initialize NCS CLI executor');
    expect(warnings()).toEqual([]);
  });

  it('names the skip when whoami fails, and still finishes cleanup', () => {
    // The author arm cannot run without the account; matching nothing would
    // read like a clean window, so the failure must surface as a skip.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockReturnValue([
      {
        id: 41,
        note: 'some comment',
        author: { username: 'reviewer' },
        createdAt: '2026-07-24T17:02:32+08:00',
      },
    ]);
    mocks.aoneWhoamiAccount.mockImplementation(() => {
      throw new Error('a1 auth whoami returned no account');
    });

    expect(() => runCleanup('pr-123')).not.toThrow();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('whoami returned no account');
    expect(warnings()).toEqual([]);
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalled();
  });

  it('surfaces the first non-empty stderr line when a1 fails, and still finishes cleanup', () => {
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockImplementation(() => {
      throw Object.assign(
        new Error('Command failed: a1 repo mr comment list …'),
        {
          stderr: '\nno repo context: run this command in a git repository\n',
        },
      );
    });

    expect(() => runCleanup('pr-123')).not.toThrow();
    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('no repo context');
    expect(mocks.clearReviewWorktreeLease).toHaveBeenCalled();
  });

  it("reads the message field of a1's JSON error object, not its opening brace", () => {
    // a1 fails with a PRETTY-PRINTED JSON error object on stderr; the first
    // non-empty line is `{`, which says nothing. The cause rides `message`.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockImplementation(() => {
      throw Object.assign(
        new Error('Command failed: a1 repo mr comment list …'),
        {
          stderr: JSON.stringify(
            {
              schemaVersion: 'a1.error/v1',
              code: 'COMMAND_FAILED',
              message: 'merge request not found: 999999999',
              retryable: false,
              exitCode: 1,
            },
            null,
            2,
          ),
        },
      );
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('merge request not found: 999999999');
    expect(notes.join('\n')).not.toContain('skipped ({)');
  });

  it('flattens a message-less JSON error object instead of paging its opening brace', () => {
    // The `message` field is the cause when present; an error object
    // without one must still reach the operator as more than the
    // pretty-print's opening brace.
    mocks.readFileSync.mockReturnValue(aoneFetchReport);
    mocks.a1Json.mockImplementation(() => {
      throw Object.assign(
        new Error('Command failed: a1 repo mr comment list …'),
        {
          stderr: JSON.stringify(
            {
              schemaVersion: 'a1.error/v1',
              code: 'COMMAND_FAILED',
              retryable: false,
              exitCode: 1,
            },
            null,
            2,
          ),
        },
      );
    });

    runCleanup('pr-123');

    const notes = mocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('note: bypass audit skipped'));
    expect(notes.join('\n')).toContain('"code":"COMMAND_FAILED"');
    expect(notes.join('\n')).not.toContain('skipped ({)');
  });
});
