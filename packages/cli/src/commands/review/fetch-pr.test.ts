/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Argv, CommandModule } from 'yargs';
import {
  fetchPrCommand,
  countDiffChangedLines,
  isEmptyDiff,
  isCollapsedFromUpstream,
} from './fetch-pr.js';
import {
  clearReviewWorktreeLease,
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
} from '../../services/review-worktree-lease.js';
import { classifyHeavy } from './lib/heavy.js';
import { PARSE_ARGS_REPORT, worktreePath } from './lib/paths.js';

describe('classifyHeavy', () => {
  it('flags a substantially rewritten existing file', () => {
    // PR #6457's QQChannel.ts: 1551 -> 2643 lines, 1714 changed.
    const r = classifyHeavy({
      preLines: 1551,
      fileLines: 2643,
      changedLines: 1714,
      binary: false,
      kind: 'source',
    });
    expect(r.rewriteRatio).toBe(0.65);
    expect(r.heavy).toBe(true);
  });

  it('does NOT flag a brand-new file, whose ratio is 1.0 by definition', () => {
    // A new file is not a *rewrite*, and its chunk agents already own every
    // line of it. PR #6457 added events.test.ts (1535 lines) this way.
    const r = classifyHeavy({
      preLines: 0,
      fileLines: 1535,
      changedLines: 1535,
      binary: false,
      kind: 'source',
    });
    expect(r.rewriteRatio).toBe(1);
    expect(r.heavy).toBe(false);
  });

  it('does NOT flag a small file even at a high ratio', () => {
    // types.ts: 42 -> 113 lines, 75 changed. Ratio 0.66, but a chunk agent
    // holds the whole thing; a whole-file invariant pass adds nothing.
    const r = classifyHeavy({
      preLines: 42,
      fileLines: 113,
      changedLines: 75,
      binary: false,
      kind: 'source',
    });
    expect(r.rewriteRatio).toBe(0.66);
    expect(r.heavy).toBe(false);
  });

  it('does NOT flag a big file with a modest edit', () => {
    // send.test.ts: 1787 -> 2170 lines, 449 changed. Ratio 0.21.
    expect(
      classifyHeavy({
        preLines: 1787,
        fileLines: 2170,
        changedLines: 449,
        binary: false,
        kind: 'source',
      }).heavy,
    ).toBe(false);
  });

  it('flags a very large edit even when the ratio stays low', () => {
    // 900 changed lines in a 6000-line file: ratio 0.15, but the edit is big
    // enough that its new lines interact across the file.
    const r = classifyHeavy({
      preLines: 5800,
      fileLines: 6000,
      changedLines: 900,
      binary: false,
      kind: 'source',
    });
    expect(r.rewriteRatio).toBe(0.15);
    expect(r.heavy).toBe(true);
  });

  it('flags a renamed-and-rewritten file', () => {
    // `preLines` is derived as `fileLines - added + removed`, not measured with
    // `git show <base>:<newpath>` — that path does not exist at the base for a
    // rename, would report 0, and would classify a wholesale rewrite as light.
    const fileLines = 2000;
    const added = 1400;
    const removed = 900;
    const preLines = fileLines - added + removed; // 1500
    expect(preLines).toBe(1500);
    const r = classifyHeavy({
      preLines,
      fileLines,
      changedLines: added + removed,
      binary: false,
      kind: 'source',
    });
    expect(r.heavy).toBe(true);
  });

  it('never flags a binary blob', () => {
    expect(
      classifyHeavy({
        preLines: 5000,
        fileLines: 0,
        changedLines: 5000,
        binary: true,
        kind: 'source',
      }).heavy,
    ).toBe(false);
  });

  it('never flags a deleted file, which has no post-image to read', () => {
    // 900 changed lines clears the volume threshold, but the invariant agents
    // are told to read the post-change file — and there isn't one. Launching
    // three of them against nothing is pure waste.
    const r = classifyHeavy({
      preLines: 900,
      fileLines: 0,
      changedLines: 900,
      binary: false,
      kind: 'source',
    });
    expect(r.rewriteRatio).toBe(0);
    expect(r.heavy).toBe(false);
  });

  it('never flags a test or generated file', () => {
    // The invariant checklist is about a long-lived stateful object. A heavily
    // rewritten test file has no fields, timers, or error taxonomy to check,
    // and three whole-file agents on it would be spent for nothing.
    const heavyShape = {
      preLines: 1800,
      fileLines: 2600,
      changedLines: 1700,
      binary: false,
    } as const;
    expect(classifyHeavy({ ...heavyShape, kind: 'source' }).heavy).toBe(true);
    expect(classifyHeavy({ ...heavyShape, kind: 'test' }).heavy).toBe(false);
    expect(classifyHeavy({ ...heavyShape, kind: 'generated' }).heavy).toBe(
      false,
    );
  });

  it('compares the exact ratio, not the rounded one', () => {
    const base = {
      preLines: 300,
      fileLines: 1000,
      binary: false,
      kind: 'source',
    } as const;
    expect(classifyHeavy({ ...base, changedLines: 400 }).heavy).toBe(true);
    // 399/1000 = 0.399 — below the 0.40 threshold, even though it *reports*
    // as 0.4. Rounding before comparing would wrongly flag it.
    const just_under = classifyHeavy({ ...base, changedLines: 399 });
    expect(just_under.rewriteRatio).toBe(0.4);
    expect(just_under.heavy).toBe(false);
  });

  it('requires the file to have existed at a real size', () => {
    expect(
      classifyHeavy({
        preLines: 299,
        fileLines: 1000,
        changedLines: 900,
        binary: false,
        kind: 'source',
      }).heavy,
    ).toBe(false);
    expect(
      classifyHeavy({
        preLines: 300,
        fileLines: 1000,
        changedLines: 900,
        binary: false,
        kind: 'source',
      }).heavy,
    ).toBe(true);
  });
});

describe('fetchPrCommand builder', () => {
  it('registers --host so Enterprise routing is a flag, not a prose instruction', () => {
    const opts: string[] = [];
    const stub = {
      positional: () => stub,
      option: (name: string) => {
        opts.push(name);
        return stub;
      },
    } as unknown as Argv;
    ((fetchPrCommand as CommandModule).builder as (y: Argv) => Argv)(stub);
    expect(opts).toContain('host');
  });
});

// ---------------------------------------------------------------------------
// Producer half of the cleanup bypass-audit contract.
//
// `cleanup` reads `fetchedAt` / `host` back out of this report; if either is
// dropped in a refactor, `readAuditWindow` returns a skip and the audit turns
// off with output identical to a clean window. A tripwire whose off state is
// indistinguishable from its all-clear state is the one property worth a test.
// The run is steered down the lightest real path: merge-base unresolvable, so
// no diff capture, an empty plan, and the report write is the observable.
// ---------------------------------------------------------------------------

const producerMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn((_path?: unknown): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  gh: vi.fn(),
  git: vi.fn(),
  execFileSync: vi.fn(),
  refExists: vi.fn(() => false),
  releaseWorktree: vi.fn(() => ({ existed: false, freed: true })),
  writeStderrLine: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      readFileSync: producerMocks.readFileSync,
      writeFileSync: producerMocks.writeFileSync,
    },
    mkdirSync: vi.fn(),
    readFileSync: producerMocks.readFileSync,
    writeFileSync: producerMocks.writeFileSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, execFileSync: producerMocks.execFileSync },
    execFileSync: producerMocks.execFileSync,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: producerMocks.writeStderrLine,
  // The settings fallback announces through the SAFE writer; this mock is a
  // partial one, so an export it does not list is a load-time failure for
  // every test in the file.
  writeStderrLineSafe: producerMocks.writeStderrLine,
}));

vi.mock('../../services/review-worktree-lease.js', () => ({
  clearReviewWorktreeLease: vi.fn(),
  clearReviewWorktreeLeaseIfOwned: vi.fn(),
  createReviewWorktreeLease: vi.fn(),
  readReviewWorktreeLease: vi.fn((): unknown => null),
  reviewLeaseHeldByAnotherSession: vi.fn((): boolean => false),
  reviewLeasePath: (repositoryRoot: string, target: string) =>
    `${repositoryRoot}/.qwen/tmp/qwen-review-lease-${target}.json`,
}));

vi.mock('./lib/gh.js', () => ({
  ensureAuthenticated: vi.fn(),
  gh: producerMocks.gh,
  setGhHost: vi.fn(),
}));

vi.mock('./lib/git.js', () => ({
  git: producerMocks.git,
  gitOpt: vi.fn(() => null),
  gitRaw: vi.fn(() => Buffer.from('')),
  refExists: producerMocks.refExists,
  releaseWorktree: producerMocks.releaseWorktree,
}));

vi.mock('./lib/merge-base.js', () => ({
  resolveMergeBase: vi.fn(() => ({ sha: null, baseFetchFailed: false })),
}));

describe('fetch-pr report assembly', () => {
  const savedEnv: { sessionId?: string; promptId?: string } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT implementations, so a
    // mockReturnValue a prior test set on readFileSync would leak into a test
    // that relies on the default. Re-assert the default (no prior report →
    // ENOENT) here so every test starts from a known state regardless of
    // order.
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    producerMocks.refExists.mockReturnValue(false);
    producerMocks.git.mockImplementation((...args: string[]) =>
      args[0] === 'rev-parse' ? 'f00df00df00d' : '',
    );
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'main',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    // fetch-pr refuses to run without the lease identity (a lease-less run
    // would build the review state with no lock against concurrent
    // sessions), so every path this suite drives starts registered.
    savedEnv.sessionId = process.env['QWEN_CODE_SESSION_ID'];
    savedEnv.promptId = process.env['QWEN_CODE_PROMPT_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-self';
    process.env['QWEN_CODE_PROMPT_ID'] = 'prompt-now';
  });

  afterEach(() => {
    if (savedEnv.sessionId === undefined) {
      delete process.env['QWEN_CODE_SESSION_ID'];
    } else {
      process.env['QWEN_CODE_SESSION_ID'] = savedEnv.sessionId;
    }
    if (savedEnv.promptId === undefined) {
      delete process.env['QWEN_CODE_PROMPT_ID'];
    } else {
      process.env['QWEN_CODE_PROMPT_ID'] = savedEnv.promptId;
    }
  });

  async function reportFor(extraArgs: Record<string, unknown>) {
    const handler = fetchPrCommand.handler;
    if (!handler) throw new Error('fetch-pr handler missing');
    await handler({
      _: [],
      $0: 'qwen',
      pr_number: '42',
      owner_repo: 'acme/widgets',
      remote: 'origin',
      out: '/tmp/fetch-report.json',
      maxChunkLines: 400,
      ...extraArgs,
    } as unknown as Parameters<typeof handler>[0]);
    const call = producerMocks.writeFileSync.mock.calls.find(
      ([path]) => path === '/tmp/fetch-report.json',
    );
    if (!call) throw new Error('report was not written');
    return JSON.parse(String(call[1]));
  }

  it('stamps fetchedAt as a real timestamp and host as null off-Enterprise', async () => {
    const before = Date.now();
    const report = await reportFor({});
    expect(report.host).toBeNull();
    const stamped = Date.parse(report.fetchedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });

  it('carries --host into the report for the cleanup audit to reuse', async () => {
    const report = await reportFor({ host: 'ghe.example.com' });
    expect(report.host).toBe('ghe.example.com');
  });

  // The lease is also a lock (#9205): a concurrent same-PR fetch-pr used to
  // stale-clean the holder's worktree before failing on, destroying it. The
  // refusal must precede every destructive step, including the lease write.
  describe('lease lock', () => {
    const foreignLease = {
      sessionId: 'session-other',
      promptId: 'prompt-other',
      target: 'pr-42',
      repositoryRoot: process.cwd(),
      worktreePath: '.qwen/tmp/review-pr-42',
      branch: 'qwen-review/pr-42',
    };

    it('refuses with an actionable error when another session holds the lease', async () => {
      vi.mocked(readReviewWorktreeLease).mockReturnValueOnce(foreignLease);
      vi.mocked(reviewLeaseHeldByAnotherSession).mockReturnValueOnce(true);

      await expect(reportFor({})).rejects.toThrow(
        'PR #42 is already being reviewed by another session ' +
          '(session session-other)',
      );
      // The lock must consult THIS PR's lease: mockReturnValueOnce is
      // argument-blind, so an unwired target leaves the race undetected.
      expect(vi.mocked(readReviewWorktreeLease)).toHaveBeenCalledWith(
        process.cwd(),
        'pr-42',
      );
      // The decision must receive the lease that was read — same hazard, one
      // call over: an unwired `holder` makes the service return false for
      // every lease, silently disabling the lock.
      expect(vi.mocked(reviewLeaseHeldByAnotherSession)).toHaveBeenCalledWith(
        foreignLease,
      );
      // Nothing was touched on the way out.
      expect(vi.mocked(createReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).not.toHaveBeenCalled();
      expect(producerMocks.git).not.toHaveBeenCalled();
      expect(producerMocks.gh).not.toHaveBeenCalled();
      expect(producerMocks.releaseWorktree).not.toHaveBeenCalled();
      expect(producerMocks.execFileSync).not.toHaveBeenCalled();
      expect(producerMocks.writeFileSync).not.toHaveBeenCalled();
    });

    it('names the lease file to delete when the holder session is gone', async () => {
      vi.mocked(readReviewWorktreeLease).mockReturnValueOnce(foreignLease);
      vi.mocked(reviewLeaseHeldByAnotherSession).mockReturnValueOnce(true);

      await expect(reportFor({})).rejects.toThrow(
        'qwen-review-lease-pr-42.json',
      );
    });

    it('refuses a malformed pr_number before the gate, matching the lock to the destroyer', async () => {
      // The lease gate only engages `pr-\d+` targets, but `cleanStale`
      // destroys `worktreePath(prNumber)` for ANY input — `path.join`
      // normalizes `'5/.'` onto `review-pr-5`. Unvalidated, a malformed
      // number sails past the gate lease-less and deletes a live holder's
      // worktree (#9205 with the lock never engaged).
      await expect(reportFor({ pr_number: '5/.' })).rejects.toThrow(
        'fetch-pr: pr_number must be a positive integer, got "5/."',
      );
      expect(producerMocks.releaseWorktree).not.toHaveBeenCalled();
      expect(producerMocks.git).not.toHaveBeenCalled();
      expect(producerMocks.gh).not.toHaveBeenCalled();
      expect(vi.mocked(createReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).not.toHaveBeenCalled();
    });

    it('refuses a zero pr_number the regex disjunct alone accepts', async () => {
      // `'0'` matches `\d+`; only `Number(prNumber) <= 0` rejects it.
      // Unpinned, fetch-pr engages the gate for `pr-0` and stale-cleans
      // `review-pr-0` lease-less before the fetch fails.
      await expect(reportFor({ pr_number: '0' })).rejects.toThrow(
        'fetch-pr: pr_number must be a positive integer, got "0"',
      );
      expect(producerMocks.releaseWorktree).not.toHaveBeenCalled();
      expect(vi.mocked(createReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).not.toHaveBeenCalled();
    });

    it('refuses to run when the lease cannot register for lack of identity', async () => {
      // A bare-terminal fetch-pr has neither id; the lease write no-ops on
      // them, and a lease-less run builds the whole review state with no
      // lock against concurrent sessions (#9205). Fail closed like the
      // takeover rule does.
      delete process.env['QWEN_CODE_SESSION_ID'];
      delete process.env['QWEN_CODE_PROMPT_ID'];

      await expect(reportFor({})).rejects.toThrow('QWEN_CODE_SESSION_ID');

      expect(vi.mocked(readReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(vi.mocked(createReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(producerMocks.releaseWorktree).not.toHaveBeenCalled();
      expect(producerMocks.git).not.toHaveBeenCalled();
      expect(producerMocks.gh).not.toHaveBeenCalled();
    });

    it('lets the holding session re-fetch its own lease', async () => {
      // Ownership is per session, not per prompt: a later round re-fetches
      // while its own earlier prompt's lease is still on disk.
      vi.mocked(readReviewWorktreeLease).mockReturnValueOnce({
        ...foreignLease,
        sessionId: 'session-self',
        promptId: 'prompt-earlier',
      });
      vi.mocked(reviewLeaseHeldByAnotherSession).mockReturnValueOnce(false);

      await reportFor({});

      expect(vi.mocked(createReviewWorktreeLease)).toHaveBeenCalledTimes(1);
      // Pin the lease's ARGUMENTS — the service silently no-ops on a malformed
      // target or missing ids, so an unwired field writes nothing and voids
      // the lock with every other test still green.
      expect(vi.mocked(createReviewWorktreeLease)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-self',
          promptId: 'prompt-now',
          target: 'pr-42',
          repositoryRoot: process.cwd(),
          // Through the REAL (unmocked) path helper, so the expectation
          // tracks the platform separator instead of pinning a POSIX
          // literal against it.
          worktreePath: worktreePath('42'),
          branch: 'qwen-review/pr-42',
        }),
      );
      // Success must NOT clear the lease: it persists so a concurrent session
      // cannot stale-clean this run's live worktree. A catch→finally refactor
      // would delete it here while every rollback test stays green.
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).not.toHaveBeenCalled();
    });

    it('writes the lease before the stale-clean and the first git call', async () => {
      // The ordering IS the lock's window: session B starting while session A
      // sits inside the network-bound fetch must still see A's lease. Moving
      // the write after any destructive or network step (#9205's interleave)
      // keeps every other test green while widening that window.
      // refExists true so BOTH destructive legs of cleanStale run — the
      // branch deletion must also come after the lease is visible.
      producerMocks.refExists.mockReturnValue(true);

      await reportFor({});

      const leaseOrder = vi.mocked(createReviewWorktreeLease).mock
        .invocationCallOrder[0]!;
      expect(leaseOrder).toBeLessThan(
        producerMocks.releaseWorktree.mock.invocationCallOrder[0]!,
      );
      expect(leaseOrder).toBeLessThan(
        producerMocks.git.mock.invocationCallOrder[0]!,
      );
      expect(leaseOrder).toBeLessThan(
        producerMocks.execFileSync.mock.invocationCallOrder[0]!,
      );
    });
  });

  // A handled failure after the lease write must roll the lease back with the
  // rest of the state: the lock refuses any later session that finds another
  // session's lease, so one left behind blocks every later review of this PR
  // until it is deleted by hand.
  describe('lease rollback on failure', () => {
    it('clears the lease when the PR fetch fails', async () => {
      producerMocks.git.mockImplementation(() => {
        throw new Error('network down');
      });

      await expect(reportFor({})).rejects.toThrow(
        'Failed to fetch PR #42 from remote "origin"',
      );
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).toHaveBeenCalledWith(
        process.cwd(),
        'pr-42',
        { sessionId: 'session-self', promptId: 'prompt-now' },
      );
    });

    it('keeps a pre-existing same-session lease when a re-fetch fails', async () => {
      // A drift restart enters holding its own earlier lease. A failure
      // must not delete it: the session is still mid-review, and dropping
      // the lock lets a session refused minutes earlier through the
      // emptied gate to stale-clean the live worktree (#9205).
      vi.mocked(readReviewWorktreeLease).mockReturnValueOnce({
        sessionId: 'session-self',
        promptId: 'prompt-earlier',
        target: 'pr-42',
        repositoryRoot: process.cwd(),
        worktreePath: worktreePath('42'),
        branch: 'qwen-review/pr-42',
      });
      vi.mocked(reviewLeaseHeldByAnotherSession).mockReturnValueOnce(false);
      producerMocks.git.mockImplementation(() => {
        throw new Error('network down');
      });

      await expect(reportFor({})).rejects.toThrow(
        'Failed to fetch PR #42 from remote "origin"',
      );
      expect(vi.mocked(clearReviewWorktreeLease)).not.toHaveBeenCalled();
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).not.toHaveBeenCalled();
    });

    it('clears the lease when the metadata fetch fails', async () => {
      producerMocks.gh.mockImplementation(() => {
        throw new Error('gh unavailable');
      });

      await expect(reportFor({})).rejects.toThrow(
        'Failed to fetch PR #42 metadata',
      );
      expect(producerMocks.execFileSync).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'qwen-review/pr-42'],
        { stdio: 'pipe' },
      );
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).toHaveBeenCalledWith(
        process.cwd(),
        'pr-42',
        { sessionId: 'session-self', promptId: 'prompt-now' },
      );
      // Teardown mirrors the acquisition window: the destructive branch
      // rollback first, the lease released LAST — a clear that lands before
      // `branch -D` lets another session through the emptied gate while the
      // deletion is still pending. Compare the FIRST clear: the outer catch's
      // second clear fires after the branch leg anyway.
      expect(
        producerMocks.execFileSync.mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        vi.mocked(clearReviewWorktreeLeaseIfOwned).mock.invocationCallOrder[0]!,
      );
    });

    it('clears the lease when the worktree add fails', async () => {
      producerMocks.git.mockImplementation((...args: string[]) => {
        if (args[0] === 'worktree') throw new Error('disk full');
        return args[0] === 'rev-parse' ? 'f00df00d' : '';
      });

      await expect(reportFor({})).rejects.toThrow(
        'Failed to create worktree at',
      );
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).toHaveBeenCalledWith(
        process.cwd(),
        'pr-42',
        { sessionId: 'session-self', promptId: 'prompt-now' },
      );
    });

    it('clears the lease when a post-worktree step fails (the report write)', async () => {
      // The rollback must reach EVERY throwing path after the lease write,
      // not only the wrapped catches: a run that dies on the final report
      // write exits non-zero while the lease persists, refusing every later
      // review of this PR until the file is deleted by hand.
      producerMocks.writeFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      });

      await expect(reportFor({})).rejects.toThrow('ENOSPC');
      expect(vi.mocked(clearReviewWorktreeLeaseIfOwned)).toHaveBeenCalledWith(
        process.cwd(),
        'pr-42',
        { sessionId: 'session-self', promptId: 'prompt-now' },
      );
    });

    it('still surfaces the original cause when the lease rollback itself throws', async () => {
      // The rollback is best-effort (tryRemove): an un-removable lease file —
      // EACCES on a shared runner, EROFS on a read-only fs — must not mask the
      // failure that triggered the rollback, and the lease wedge it would
      // otherwise report is secondary to naming the real cause.
      producerMocks.git.mockImplementation(() => {
        throw new Error('network down');
      });
      vi.mocked(clearReviewWorktreeLeaseIfOwned).mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied, unlink lease');
      });

      await expect(reportFor({})).rejects.toThrow(
        'Failed to fetch PR #42 from remote "origin"',
      );
    });
  });

  it('preserves the earliest window opening across drift restarts of the same PR', async () => {
    // A drift restart reruns fetch-pr and overwrites this report; the audit
    // boundary must keep reaching back to the abandoned attempt's opening.
    producerMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '42',
        fetchedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    const report = await reportFor({});
    expect(report.auditSince).toBe('2020-01-01T00:00:00.000Z');
    expect(report.fetchedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('prefers a prior auditSince over its fetchedAt (the third-restart case)', async () => {
    // On a third restart the prior report already carries an auditSince
    // EARLIER than its own fetchedAt; that earliest opening must win, not the
    // prior fetchedAt. Seeds both so the auditSince-preference branch runs.
    producerMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '42',
        auditSince: '2020-01-01T00:00:00.000Z',
        fetchedAt: '2022-06-01T00:00:00.000Z',
      }),
    );
    const report = await reportFor({});
    expect(report.auditSince).toBe('2020-01-01T00:00:00.000Z');
  });

  it('does not inherit a window from a DIFFERENT PR left at the same path', async () => {
    producerMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '999',
        fetchedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    const report = await reportFor({});
    expect(report.auditSince).toBe(report.fetchedAt);
  });

  it('warns (not silently resets) when a prior report exists but is corrupt', async () => {
    // A crash mid-write leaves truncated JSON. Silently resetting auditSince
    // would let a bypass write from the abandoned attempt escape the window.
    producerMocks.readFileSync.mockReturnValue('{"prNumber":"42","audit');
    const report = await reportFor({});
    expect(report.auditSince).toBe(report.fetchedAt); // best available
    const warned = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes('not valid JSON'));
    expect(warned).toBe(true);
  });

  it('stays silent on ENOENT (a genuine first attempt)', async () => {
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await reportFor({});
    const warnedAboutReport = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes('previous fetch report'));
    expect(warnedAboutReport).toBe(false);
  });

  it('names a non-ENOENT read failure of the prior report', async () => {
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    await reportFor({});
    const warned = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes('could not read the previous fetch report'));
    expect(warned).toBe(true);
  });

  describe('effort threading', () => {
    // The PR path spreads `planEffortField(args.effort)` into the report exactly
    // as capture-local and plan-diff do, but a refactor of this result assembly
    // (dropping the import, or a later property shadowing `effort`) would silently
    // lose it — safe-expanding the roster to the full set even with `--effort
    // medium` while the sibling tests still pass. These trip that wire.
    function seedReport(effort: unknown): void {
      producerMocks.readFileSync.mockImplementation((path?: unknown) => {
        if (path === PARSE_ARGS_REPORT) {
          return JSON.stringify({ effort, effortSource: 'flag' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    }

    it('records an explicit --effort in the report', async () => {
      const report = await reportFor({ effort: 'medium' });
      expect(report.effort).toBe('medium');
    });

    it('recovers the effort parse-args resolved when --effort is not re-threaded', async () => {
      seedReport('medium');
      const report = await reportFor({});
      expect(report.effort).toBe('medium');
      // And the resolution is disclosed on stderr, not silent.
      const traced = producerMocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .some(
          (l) =>
            l.includes('effort: medium') && l.includes('parse-args report'),
        );
      expect(traced).toBe(true);
    });

    it('omits effort when neither flag nor report is present', async () => {
      const report = await reportFor({});
      expect(report.effort).toBeUndefined();
    });

    it('ignores a malformed effort in the report rather than trusting it', async () => {
      seedReport('turbo');
      const report = await reportFor({});
      expect(report.effort).toBeUndefined();
    });
  });
});

describe('isEmptyDiff', () => {
  // The SKILL acts on this by recommending the PR be closed as superseded, so
  // each guard is tested for the live PR it would otherwise close.
  const base = {
    diffPath: '/tmp/d.patch',
    baseFetchFailed: false,
    diffText: '',
  };

  it('is true only when a SUCCESSFUL capture found nothing', () => {
    expect(isEmptyDiff(base)).toBe(true);
    expect(isEmptyDiff({ ...base, diffText: '   \n  ' })).toBe(true);
  });

  it('is false when the capture never succeeded', () => {
    // A capture that threw leaves diffText empty too. Reading that as "no
    // changes" closes a live PR on an infrastructure error.
    expect(isEmptyDiff({ ...base, diffPath: null })).toBe(false);
  });

  it('is false when the merge base came from a possibly stale local ref', () => {
    // A stale base that already contains the head commits diffs to empty —
    // same wrong recommendation, one cause further out.
    expect(isEmptyDiff({ ...base, baseFetchFailed: true })).toBe(false);
  });

  it('is false whenever there is any diff at all', () => {
    expect(isEmptyDiff({ ...base, diffText: '+a\n' })).toBe(false);
  });
});

describe('isCollapsedFromUpstream', () => {
  /** A diff with `n` changed lines. */
  const diff = (n: number) =>
    `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n${'+x\n'.repeat(n)}`;

  it('fires when the recomputed diff is 4x smaller past the 200-line floor', () => {
    expect(
      isCollapsedFromUpstream({
        baseFetchFailed: false,
        diffText: diff(50),
        additions: 200,
        deletions: 0,
      }),
    ).toBe(true);
  });

  it('holds the 4x boundary exactly', () => {
    // 51 * 4 = 204 > 200: one line the other side of the ratio and the
    // signature is gone. Pinned so the comparison cannot drift to `<`.
    expect(
      isCollapsedFromUpstream({
        baseFetchFailed: false,
        diffText: diff(51),
        additions: 200,
        deletions: 0,
      }),
    ).toBe(false);
  });

  it('holds the 200-line floor exactly', () => {
    // Below it one file IS the ratio, which is what the floor exists to keep
    // out — a rename-threshold disagreement, not an upstream collapse.
    expect(
      isCollapsedFromUpstream({
        baseFetchFailed: false,
        diffText: diff(40),
        additions: 199,
        deletions: 0,
      }),
    ).toBe(false);
    expect(
      isCollapsedFromUpstream({
        baseFetchFailed: false,
        diffText: diff(40),
        additions: 100,
        deletions: 100,
      }),
    ).toBe(true);
  });

  it('does not fire off a base the fetch could not confirm', () => {
    // The sibling guard, for the sibling reason. `isEmptyDiff` refuses to rule
    // on a possibly stale local base ref because such a base can already hold
    // the head commits; the PARTIAL form of that lands here, shrinking the
    // recomputed diff past the ratio. The flag then tells Agent 0 to read the
    // body as description-of-history when the body may be perfectly current
    // and the real cause is an infrastructure failure.
    const collapsing = { diffText: diff(50), additions: 200, deletions: 0 };
    expect(
      isCollapsedFromUpstream({ ...collapsing, baseFetchFailed: false }),
    ).toBe(true);
    expect(
      isCollapsedFromUpstream({ ...collapsing, baseFetchFailed: true }),
    ).toBe(false);
  });

  it('never fires on an empty diff — that is emptyDiff, a different claim', () => {
    expect(
      isCollapsedFromUpstream({
        baseFetchFailed: false,
        diffText: '',
        additions: 5000,
        deletions: 0,
      }),
    ).toBe(false);
  });
});

describe('countDiffChangedLines', () => {
  it('counts +/- body lines and excludes file headers', () => {
    const d = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' ctx',
    ].join('\n');
    expect(countDiffChangedLines(d)).toBe(2);
    expect(countDiffChangedLines('')).toBe(0);
  });

  it('counts body lines whose own content starts with -- or ++', () => {
    // A DELETED markdown rule / YAML marker / SQL comment arrives as `--- …`,
    // and an ADDED `++x` as `+++x`. A prefix-shape rule has to drop both, and
    // every dropped line pushes the ratio toward a false collapse disclosure
    // (the flag fires when the recomputed count comes in LOW).
    const d = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,4 +1,4 @@',
      '----',
      '--- a title underline',
      '+++ replacement',
      '++i;',
      ' ctx',
      '\\ No newline at end of file',
    ].join('\n');
    expect(countDiffChangedLines(d)).toBe(4);
  });

  it('does not count the file headers of a SECOND file in the diff', () => {
    // `diff --git` closes the previous hunk: without that, the next file's
    // `---`/`+++` headers would be read as body lines of the hunk above.
    const d = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b b/b',
      'index 111..222 100644',
      '--- a/b',
      '+++ b/b',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n');
    expect(countDiffChangedLines(d)).toBe(4);
  });
});
