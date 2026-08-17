/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Argv, CommandModule } from 'yargs';
import { resolve } from 'node:path';
import {
  fetchPrCommand,
  countDiffChangedLines,
  isEmptyDiff,
  isCollapsedFromUpstream,
  resolveIncrementalAnchor,
  containmentRuling,
  type AnchorProbe,
} from './fetch-pr.js';
import {
  clearReviewWorktreeLease,
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
} from '../../services/review-worktree-lease.js';
import { classifyHeavy } from './lib/heavy.js';
import { buildRoleBrief } from './agent-prompt.js';
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
    // The incremental anchor is a flag too — SKILL Step 1 passes it, so a
    // dropped registration would break every incremental review at parse time.
    expect(opts).toContain('since');
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
  gitOpt: vi.fn((..._args: string[]): string | null => null),
  gitRaw: vi.fn((..._args: string[]): Buffer => Buffer.from('')),
  resolveMergeBase: vi.fn(
    (): { sha: string | null; baseFetchFailed: boolean } => ({
      sha: null,
      baseFetchFailed: false,
    }),
  ),
  // Defaults to the REAL implementation (captured by the module mock below);
  // a test overrides it only to force the partition-failure path.
  buildDiffPlan: vi.fn(),
  actualBuildDiffPlan: undefined as unknown as (...a: unknown[]) => unknown,
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
  gitOpt: producerMocks.gitOpt,
  // The exit-code-aware probe, expressed in terms of the same mock: a null
  // answer is the DEFINITIVE no (exit 1), which is what these fixtures mean.
  // A test that wants the git-surface-unavailable shape overrides this.
  gitProbe: (...args: string[]) => {
    const out = producerMocks.gitOpt(...args);
    return { out, status: out === null ? 1 : 0 };
  },
  gitRaw: producerMocks.gitRaw,
  refExists: producerMocks.refExists,
  releaseWorktree: producerMocks.releaseWorktree,
}));

vi.mock('./lib/merge-base.js', () => ({
  resolveMergeBase: producerMocks.resolveMergeBase,
}));

// The ledger append is the wiring under test here, not the ledger itself
// (run-ledger.test.ts owns that): a silently unwritten ledger would make a
// later --resume find no prior sessions and re-run everything.
vi.mock('./lib/run-ledger.js', () => ({
  appendRunSession: vi.fn(),
}));
vi.mock('./lib/diff-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/diff-plan.js')>();
  producerMocks.actualBuildDiffPlan = actual.buildDiffPlan as (
    ...a: unknown[]
  ) => unknown;
  return { ...actual, buildDiffPlan: producerMocks.buildDiffPlan };
});

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
    producerMocks.gitOpt.mockImplementation(() => null);
    producerMocks.gitRaw.mockImplementation(() => Buffer.from(''));
    producerMocks.resolveMergeBase.mockImplementation(() => ({
      sha: null,
      baseFetchFailed: false,
    }));
    producerMocks.buildDiffPlan.mockImplementation((...a: unknown[]) =>
      producerMocks.actualBuildDiffPlan(...a),
    );
    // Same reason as the rest: an implementation set by one test (the
    // ENOSPC case) survives clearAllMocks and would fail every later one.
    producerMocks.writeFileSync.mockImplementation(() => undefined);
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
    // findLast, not find: a test that drives two rounds must read the report
    // the SECOND one wrote, or it asserts against the first round's state.
    const call = producerMocks.writeFileSync.mock.calls.findLast(
      ([path]: unknown[]) => path === '/tmp/fetch-report.json',
    );
    if (!call) throw new Error('report was not written');
    return JSON.parse(String(call[1]));
  }

  /** What `publish()` actually wrote to the diff file, or null. */
  function writtenDiff(): string | null {
    const call = producerMocks.writeFileSync.mock.calls.findLast(
      ([path]: unknown[]) => String(path).endsWith('diff.txt'),
    );
    return call ? String(call[1]) : null;
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

  // ---- the --since incremental branches, driven through the real handler ----

  const ANCHOR = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);
  /**
   * `anchor..head` for ONE coherent history, so the pair below can be read as
   * a real round rather than two unrelated captures:
   *
   *   base   [line,        line2, tail]
   *   anchor [line, added, line2, tail]
   *   head   [line, added, line2, bulk × 200, tail]
   *
   * The old pair gave the same head commit two different trees — a 3-line
   * file here and a 204-line one in FULL_DIFF — which no capture can produce,
   * and which a later case extending either side would be written against.
   */
  const DELTA_DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,4 +1,204 @@',
    ' line',
    ' added',
    ' line2',
    ...Array.from({ length: 200 }, (_, i) => `+bulk ${i}`),
    ' tail',
    '',
  ].join('\n');
  /**
   * The PR's whole diff, of which DELTA_DIFF's hunk is a proper part — the
   * ordinary shape of an incremental round. The containment check refuses a
   * delta whose hunks this does NOT cover, so a fixture that means "a valid
   * incremental round" has to supply it.
   */
  const FULL_DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,204 @@',
    ' line',
    '+added',
    ' line2',
    ...Array.from({ length: 200 }, (_, i) => `+bulk ${i}`),
    ' tail',
    '',
  ].join('\n');
  /** Serve the delta for `ANCHOR..head` and the full range for `BASE..head`. */
  function servesBothRanges(full = FULL_DIFF, delta = DELTA_DIFF) {
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${ANCHOR}..f00df00df00d`)
        ? Buffer.from(delta)
        : args.includes(`${BASE}..f00df00df00d`)
          ? Buffer.from(full)
          : Buffer.from(''),
    );
  }

  /** gitOpt that vouches for ANCHOR as a commit behind the head. */
  function anchorIsValid() {
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'cat-file' || args[0] === 'merge-base'
        ? ''
        : args[0] === 'rev-parse'
          ? ANCHOR
          : null,
    );
  }

  it('scopes the plan to a valid anchor and suppresses the full-range flags', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    // Advertised stat large enough that an ungated collapse ratio WOULD fire
    // on the tiny delta: the flag's absence below is what kills the mutant
    // that keys the collapse ratio (or emptyDiff) on the PUBLISHED delta
    // instead of on fullText.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'main',
        additions: 400,
        deletions: 100,
        changedFiles: 9,
        isCrossRepository: false,
        body: '',
      }),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      diffBase: ANCHOR,
    });
    expect(report.diffPath).not.toBeNull();
    // The DISK payload, not just the report: a write unpaired from the text
    // the report describes hands every agent a diff whose chunks and
    // diffBase advertise something else — the same mismatch class as the
    // diffPath leak this PR shipped and fixed.
    expect(writtenDiff()).toBe(DELTA_DIFF);
    expect(report.diffPathAbsolute).toBe(resolve(report.diffPath as string));
    // …and the PLAN is the delta's, not the full range's: a re-plan over
    // fullText would pair a 200-line plan with an 8-line published diff.
    expect(report.diffLines).toBe(DELTA_DIFF.trimEnd().split('\n').length);
    expect(report.emptyDiff).toBeUndefined();
    expect(report.collapsedFromUpstream).toBeUndefined();
    // The probe wiring, pinned by invocation shape: a transposed
    // --is-ancestor operand pair would refuse every valid anchor while every
    // content-agnostic mock stayed green (measured by the review's mutant).
    const gitOptCalls = producerMocks.gitOpt.mock.calls;
    // Bare sha, no `^{commit}` peel: with the peel real git answers an
    // unknown-but-well-formed sha with 128 rather than 1, which made the
    // definitive-absent branch unreachable.
    expect(gitOptCalls).toContainEqual(['cat-file', '-e', ANCHOR]);
    expect(gitOptCalls).toContainEqual([
      'merge-base',
      '--is-ancestor',
      ANCHOR,
      'f00df00df00d',
    ]);
    expect(gitOptCalls).toContainEqual(['rev-parse', `${ANCHOR}^{commit}`]);
    // ...and the merge-base clamp: anchor at or after the base.
    expect(gitOptCalls).toContainEqual([
      'merge-base',
      '--is-ancestor',
      BASE,
      ANCHOR,
    ]);
  });

  it('takes the LAST value of a repeated --since, and expands an abbreviation', async () => {
    // Two findings in one round trip. yargs folds a repeated flag into an
    // array — the recovery flow produces one — and the array stringifies to
    // "shaA,shaB", which the hex gate refuses with zero git probes. And the
    // ruling must scope from what rev-parse RESOLVED, not from the string
    // that came in: `diffBase` is welded into Agent 7's `--base`, where an
    // abbreviation is ambiguous once the repo grows.
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'cat-file' || args[0] === 'merge-base'
        ? ''
        : args[0] === 'rev-parse'
          ? ANCHOR // the full sha for the abbreviation
          : null,
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: ['0'.repeat(40), 'abc1234'] });
    expect(report.incremental).toEqual({
      since: 'abc1234',
      effective: true,
      diffBase: ANCHOR,
    });
    // The probes ran against the LAST value, not the first or the join.
    expect(producerMocks.gitOpt.mock.calls).toContainEqual([
      'cat-file',
      '-e',
      'abc1234',
    ]);
  });

  it('still flags an emptied PR on a delta round — the full range rules it', async () => {
    // The PR collapses between rounds (a revert, or the work landing in the
    // base another way): the full range is empty while `anchor..head` is
    // not. Both guards fire, and both matter — the delta's hunks are not in
    // the PR's diff (so the anchor is refused rather than scoped), and the
    // published full range is empty (so the skill stops and recommends
    // close-as-superseded instead of reviewing hunks GitHub's empty PR diff
    // does not contain, where one anchored comment 422s the whole review).
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges('');
    const report = await reportFor({ since: ANCHOR });
    expect(report.emptyDiff).toBe(true);
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'hunks-outside-pr-diff',
    });
    // A base resolved from a possibly stale local ref cannot rule it — the
    // same fail-closed conjunct the text path has always had.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: true,
    });
    expect((await reportFor({ since: ANCHOR })).emptyDiff).toBeUndefined();
  });

  it('refuses a delta carrying hunks the PR diff does not contain', async () => {
    // An "undo per feedback" commit reverts some of the previous round's
    // lines back to base content: those lines are changed in `anchor..head`
    // and unchanged in `base..head`. Ancestry cannot see it — the anchor is
    // a perfectly good ancestor — so containment is checked on the hunks,
    // because a comment anchored on such a hunk 422s the entire review.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    const REVERT_DELTA = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -400,1 +400,1 @@',
      '-experiment',
      '+original',
      '',
    ].join('\n');
    servesBothRanges(FULL_DIFF, REVERT_DELTA);
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'hunks-outside-pr-diff',
    });
    // Refused, so the round reviews the PR's own diff instead — and the
    // FILE agents read must be that diff, not the refused delta: a publish
    // left at capture time would hand them hunks the oracle just proved
    // absent from GitHub's PR diff.
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    expect(writtenDiff()).toBe(FULL_DIFF);
    // `read_file` rejects a relative path, so every agent dereferences this
    // one — a relative leak fails the whole fan-out.
    expect(report.diffPathAbsolute).toBe(resolve(report.diffPath as string));
  });

  it('refuses to scope when the containment oracle was LOST, not absent', async () => {
    // A base WAS resolved and its capture threw (the 120s git timeout on the
    // large long-lived PR --since exists for). Publishing the delta here
    // would scope with the oracle never run — the fail-open shape the guard
    // exists to refuse. Distinct from the base-FREE shape, where there is no
    // PR diff to be contained in.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes(`${BASE}..f00df00df00d`)) throw new Error('timed out');
      return Buffer.from(DELTA_DIFF);
    });
    const report = await reportFor({ since: ANCHOR });
    // The reason names the CAUSE and keeps naming it: the capture threw.
    // Whether a plan exists is `diffPath`, reported separately — one field
    // meaning both is what used to rename this into the retryable class.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
    expect(report.diffPath).toBeNull();
    // What this pins beyond the reason: the delta did NOT become the scope.
    expect(writtenDiff()).not.toBe(DELTA_DIFF);
    expect(
      producerMocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('refused')),
    ).toContain('capture-failed');
  });

  it('names an UNRULEABLE oracle apart from a disproved delta', async () => {
    // A path the parser cannot name leaves the oracle unavailable; saying
    // `hunks-outside-pr-diff` there asserts a containment failure that was
    // never established, and steers recovery on a false reason.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    // Not a diff at all — the state where the oracle genuinely cannot rule
    // (a capture that returned an error stream, say). Path shapes that used
    // to land here are handled by the shared parser now.
    const UNPARSEABLE = 'fatal: bad revision\nnoise\n';
    servesBothRanges(FULL_DIFF, UNPARSEABLE);
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'containment-unverified',
    });
  });

  it('refuses the anchor end to end when the base fetch failed', async () => {
    // The handler wiring of `{sha, fetchFailed}`, which the unit-level
    // describe cannot pin: a call site passing `fetchFailed: false` (or
    // dropping the argument) silences the clamp with no red test.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: true,
    });
    servesBothRanges();
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });
    expect(report.diffPath).not.toBeNull();
  });

  it('refuses to scope when NO base resolved — nothing to be contained in', async () => {
    // This used to scope, on the reasoning that the delta range needs no base
    // and so a deleted or renamed base branch should not cost a valid anchor
    // its scope. The capture reasoning is right; the SCOPE reasoning is not.
    // With no base there is no PR diff to check the delta against, and "no
    // diff to check against" is the absence of proof, not proof — it was the
    // one arm where an uncontained delta shipped by design, and the shape it
    // ships is the same "undo per feedback" revert every sibling arm refuses.
    // `base-untrusted` still means a base that cannot be TRUSTED; this is a
    // base that does not exist, and the reason says the oracle could not rule.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: true,
    });
    servesBothRanges();
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'containment-unverified',
    });
    // Nothing is published, which is what a base-free round does ANYWAY: with
    // no merge base there is no full range either, and the command already
    // tells agents to fall back to running `git diff` themselves. So this
    // costs no review that existed — it removes the one arm that shipped a
    // scope no containment check had ever seen.
    expect(report.diffPath).toBeNull();
  });

  it('keeps upToDate through a partition failure — the stop flow needs no plan', async () => {
    // The `!upToDate` exemption in the partition catch: without it the
    // demote strips `upToDate` and the round stops being "no new changes"
    // for an anchor that is the head.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    // Empty delta → upToDate; the full range is what gets partitioned.
    servesBothRanges(FULL_DIFF, '');
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      upToDate: true,
    });
    expect(report.diffPath).toBeNull();
    // The catch nulls BOTH halves — a stale absolute path beside a null
    // relative one hands a degraded-flow consumer a file the report says
    // does not exist.
    expect(report.diffPathAbsolute).toBeNull();
  });

  it('rules upToDate from the anchor-at-head shape, not just the empty delta', async () => {
    // Every other upToDate case here reaches it through the empty-delta
    // arm; this is the shape an unchanged-head re-fetch takes, where
    // `resolved === fetchedSha` decides it before any capture runs.
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'cat-file' || args[0] === 'merge-base'
        ? ''
        : args[0] === 'rev-parse'
          ? 'f00df00df00d' // the anchor IS the head
          : null,
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: 'f00df00df00d' });
    expect(report.incremental).toEqual({
      since: 'f00df00df00d',
      effective: true,
      upToDate: true,
    });
    // The FULL range is what the round carries, for the flows that continue.
    expect(writtenDiff()).toBe(FULL_DIFF);
    // …and NO delta capture ran. That is the property this shape exists to
    // pin, and the assertions above cannot see it: with the at-head arm
    // removed, the anchor resolves to `f00df00df00d`, the handler captures
    // `f00df00d..f00df00d`, the mock answers empty, and the empty-delta arm
    // sets the identical `upToDate` — both the report and the written diff
    // come out byte-identical. The redundant `git diff` is exactly what
    // deciding at-head BEFORE any capture exists to eliminate.
    const ranges = producerMocks.gitRaw.mock.calls
      .flat()
      .filter((a: unknown) => typeof a === 'string' && a.includes('..'));
    expect(ranges).toEqual([`${BASE}..f00df00df00d`]);
  });

  it('reuses the full range when the anchor IS the merge base', async () => {
    // The dedupe shortcut: re-running the identical `git diff` would spend
    // the capture (and its timeout) twice on the same bytes.
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'cat-file' || args[0] === 'merge-base'
        ? ''
        : args[0] === 'rev-parse'
          ? BASE // the anchor resolves to the merge base
          : null,
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: BASE });
    expect(report.incremental).toEqual({
      since: BASE,
      effective: true,
      diffBase: BASE,
    });
    // Exactly one capture: the delta arm read no second range.
    const ranges = producerMocks.gitRaw.mock.calls.filter((c) =>
      c.some((a: unknown) => String(a).includes('..f00df00df00d')),
    );
    expect(ranges).toHaveLength(1);
  });

  it('calls a probe ERROR infrastructure, not a verdict about the anchor', async () => {
    // gitOpt collapses every non-zero exit to null, so an error exit (128,
    // a timeout kill) used to read as a definitive "not an ancestor" — a
    // reason the recovery flow treats as deterministic, so the anchor was
    // never retried and the round paid a full review for a transient fault.
    producerMocks.gitOpt.mockImplementation(() => null);
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    // The fault must land on ANCESTRY: a blanket error makes `cat-file`
    // answer first, and 128 there is the object's absence (deterministic),
    // not the surface failing. This is the probe whose error classification
    // the comment above describes.
    const mod = await import('./lib/git.js');
    const spy = vi
      .spyOn(mod, 'gitProbe')
      .mockImplementation((...args: string[]) =>
        args[0] === 'merge-base'
          ? { out: null, status: 128 }
          : args[0] === 'rev-parse'
            ? { out: ANCHOR, status: 0 }
            : { out: '', status: 0 },
      );
    try {
      const report = await reportFor({ since: ANCHOR });
      expect(report.incremental).toEqual({
        since: ANCHOR,
        effective: false,
        reason: 'capture-failed',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('splits each probe exit three ways — 0, deterministic, and the surface', async () => {
    // The shared shim answers `out === null ? 1 : 0`, so it can only ever
    // produce statuses 0 and 1: the `128` arms and the `status: null` arm
    // (a timeout kill) are unreachable from every non-spy fixture in this
    // file, and mutants collapsing them survived the whole suite. Each row
    // drives ONE probe to a status only real git produces.
    const cases: Array<{
      what: string;
      probe: string;
      answer: { out: string | null; status: number | null };
      reason: string;
    }> = [
      // "not a valid object name" — an over-long hex that names nothing, the
      // shape a SHA-256 marker sha has when read against SHA-1 history.
      // Deterministic absence, so it must never be retried.
      {
        what: 'cat-file 128 is the object absent',
        probe: 'cat-file',
        answer: { out: null, status: 128 },
        reason: 'unknown-commit',
      },
      // 128 from `rev-parse <sha>^{commit}` is "this is not a commit" — a
      // blob or tree sha in a cache or marker.
      {
        what: 'rev-parse 128 is not-a-commit',
        probe: 'rev-parse',
        answer: { out: null, status: 128 },
        reason: 'unknown-commit',
      },
      // A kill leaves no exit code at all: `{status: null}`. That is the
      // surface failing, which IS retried — the opposite disposition to the
      // two rows above, from the same probe.
      {
        what: 'a signalled probe is the surface',
        probe: 'cat-file',
        answer: { out: null, status: null },
        reason: 'capture-failed',
      },
      // The same kill, on the other two probes. Each classifies status
      // independently, and the unit describe cannot reach them — it injects
      // already-interpreted answers, while the classification lives in
      // `runFetchPr`'s closures. Folding `null` into `resolveCommit`'s
      // not-a-commit arm reports a killed `rev-parse` as `unknown-commit`;
      // folding it into `isAncestor`'s NO reports a killed `merge-base` as
      // `not-an-ancestor`. Neither is retried, so a transient kill retires a
      // valid anchor for good.
      {
        what: 'a signalled rev-parse is the surface',
        probe: 'rev-parse',
        answer: { out: null, status: null },
        reason: 'capture-failed',
      },
      {
        what: 'a signalled merge-base is the surface',
        probe: 'merge-base',
        answer: { out: null, status: null },
        reason: 'capture-failed',
      },
    ];

    const mod = await import('./lib/git.js');
    for (const { what, probe, answer, reason } of cases) {
      vi.clearAllMocks();
      anchorIsValid();
      producerMocks.resolveMergeBase.mockReturnValue({
        sha: BASE,
        baseFetchFailed: false,
      });
      servesBothRanges();
      const spy = vi
        .spyOn(mod, 'gitProbe')
        .mockImplementation((...args: string[]) =>
          args[0] === probe
            ? (answer as { out: string | null; status: number })
            : args[0] === 'rev-parse'
              ? { out: ANCHOR, status: 0 }
              : { out: '', status: 0 },
        );
      try {
        const report = await reportFor({ since: ANCHOR });
        expect({ what, ...report.incremental }).toEqual({
          what,
          since: ANCHOR,
          effective: false,
          reason,
        });
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("welds Agent 7's --base to the anchor the producer stamped", async () => {
    // The only test that crosses the producer→consumer seam. This file never
    // mentions `buildRoleBrief` and agent-prompt's own tests hand-build every
    // report, so an asymmetric rename of `diffBase` — or a consumer guard
    // that stops matching — ships with both suites green while Agent 7
    // silently falls back to the merge base: its test-efficacy probe then
    // recomputes `base..HEAD`, spending the round's budget reversing hunks an
    // earlier round already reviewed and reporting survivors outside this
    // round's diff. The PR's own comment concedes the reversion "left the
    // whole suite green".
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      diffBase: ANCHOR,
    });
    // The REAL brief builder, over the REAL report the handler just wrote.
    // The probe block is gated on a PR number and a plan path — the shape
    // Agent 7 is actually launched with.
    const brief = buildRoleBrief(
      report as Parameters<typeof buildRoleBrief>[0],
      '7',
      { planPath: '/tmp/plan.json' },
    );
    expect(brief).toContain(`--base ${ANCHOR}`);
    expect(brief).not.toContain(`--base ${BASE}`);
  });

  it('reads collapsedFromUpstream off the FULL range on a delta round', async () => {
    // Both `--since` fixtures assert the flag is `undefined`, which pins only
    // that the flag is not computed from the DELTA — in both, the full range
    // would not fire either, so a mutant suppressing the flag outright on
    // delta rounds (`!scopedDelta && isCollapsedFromUpstream(...)`) survives.
    // Agent 0 then never gets the rebase-lag disclosure and narrates
    // already-landed work as this PR's current change.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    // Advertised 900 against a full range of 4 changed lines: 4 × 4 ≤ 900,
    // and ≥ 200, so the full range HAS collapsed.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'main',
        additions: 800,
        deletions: 100,
        changedFiles: 9,
        isCrossRepository: false,
        body: '',
      }),
    );
    const report = await reportFor({ since: ANCHOR });
    // Still delta-scoped…
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      diffBase: ANCHOR,
    });
    expect(writtenDiff()).toBe(DELTA_DIFF);
    // …and the full-range fact is still reported.
    expect(report.collapsedFromUpstream).toBe(true);
  });

  it('ignores a value-less --since instead of blaming the anchor', async () => {
    // yargs parses a bare `--since` (and `--since ""`) to the empty string;
    // reporting `unknown-commit` would assert this history never held a sha
    // nobody supplied, and route recovery on that lie.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: '' });
    expect(report.incremental).toBeUndefined();
    expect(writtenDiff()).toBe(FULL_DIFF);
    expect(
      producerMocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.includes('Ignoring --since with no value')),
    ).toBe(true);
  });

  it('keeps upToDate when the containment oracle is LOST and the delta is empty', async () => {
    // Arm ORDER: the empty-delta upToDate arm must sit above the
    // oracle-lost arm. Swapped, the flagship shape — a large PR whose
    // full-range capture deterministically times out, with nothing landed
    // since the anchor — demotes to capture-failed, which SKILL retries,
    // re-running the same timeout every round.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes(`${BASE}..f00df00df00d`)) throw new Error('timed out');
      return Buffer.from('');
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      upToDate: true,
    });
    expect(report.diffPath).toBeNull();
  });

  it("keeps a REFUSED anchor's reason when the full range then fails to tile", async () => {
    // The `effective` clause in the partition guard: without it a round
    // whose anchor was refused for a deterministic reason gets relabelled
    // `partition-failed`, which invites re-running a dead anchor.
    producerMocks.gitOpt.mockImplementation(
      (...args: string[]) =>
        args[0] === 'cat-file' ? '' : args[0] === 'rev-parse' ? ANCHOR : null, // not an ancestor
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'not-an-ancestor',
    });
  });

  it('degrades when the diff FILE cannot be written, instead of dying', async () => {
    // A full or read-only tmp volume used to yield a diff-less report the
    // round continued from with disclosed partial coverage; letting the
    // write throw killed the command after the worktree existed and before
    // any report was written.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.writeFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('diff.txt')) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      }
    });
    const report = await reportFor({ since: ANCHOR });
    // The report exists — that is the whole point — and discloses the gap.
    expect(report.diffPath).toBeNull();
    expect(report.diffPathAbsolute).toBeNull();
    // …and `emptyDiff` still reads `fullText`, which was captured and is
    // NOT empty: a mutant computing it from the published round state sees
    // an empty published diff here and would recommend closing a live PR.
    expect(report.emptyDiff).toBeUndefined();
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
  });

  it('treats a value-less or negated --since as no anchor at all', async () => {
    // yargs turns `--no-since` into boolean `false` even for a string
    // option; reaching the hex test with it published `since: false` and
    // then crashed on `since.slice(…)` after the worktree existed.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    for (const since of [false, 42, null]) {
      const report = await reportFor({ since });
      expect(report.incremental).toBeUndefined();
      expect(report.diffPath).not.toBeNull();
    }
  });

  it('calls a well-formed but unknown anchor unknown-commit, not transient', async () => {
    // Real git answers `cat-file -e <sha>` for an absent object with exit 1
    // (definitive). Peeling `^{commit}` made it 128, so every unknown
    // anchor was reported as a transient failure the recovery flow retries
    // forever — and `unknown-commit` became unreachable.
    producerMocks.gitOpt.mockImplementation(() => null); // exit 1 in the mock
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: '0'.repeat(40) });
    expect(report.incremental).toEqual({
      since: '0'.repeat(40),
      effective: false,
      reason: 'unknown-commit',
    });
  });

  it('refuses a rebased-away anchor end to end, on a full-range plan', async () => {
    producerMocks.gitOpt.mockImplementation(
      (...args: string[]) =>
        args[0] === 'cat-file' ? '' : args[0] === 'rev-parse' ? ANCHOR : null, // every merge-base probe fails → not an ancestor
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'not-an-ancestor',
    });
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
  });

  it('refuses an anchor OLDER than the merge base — scoping wider than the PR is not incremental', async () => {
    // Reachable non-adversarially: PR commits landing in the base between
    // rounds move the merge base past the cached anchor; anchor..head would
    // then re-review base history, and a comment anchored there 422s the
    // whole Create Review call.
    producerMocks.gitOpt.mockImplementation(
      (...args: string[]) =>
        args[0] === 'cat-file'
          ? ''
          : args[0] === 'rev-parse'
            ? ANCHOR
            : args[0] === 'merge-base' && args[2] === ANCHOR
              ? '' // anchor IS behind the head…
              : null, // …but the base is NOT behind the anchor
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'behind-merge-base',
    });
    expect(report.diffPath).not.toBeNull();
  });

  it('retries the FULL range when the delta will not tile, and demotes', async () => {
    // A delta the partitioner refuses must not end the round diff-less
    // while the PR's own range — already read — might tile fine: the delta
    // is the optimization, the full range is the review.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (text === DELTA_DIFF) throw new Error('chunks do not tile the diff');
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    // The rescue republished the FULL range — the file agents read must be
    // the range the report now describes.
    expect(writtenDiff()).toBe(FULL_DIFF);
    // The anchor cannot stay effective over a full-range plan — one round,
    // two scopes is what that would mean for Agent 7's welded --base — and
    // the reason names what actually happened, not a capture that worked.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'partition-failed',
    });
  });

  it('calls a failed rescue WRITE a capture fault, not a tiling one', async () => {
    // The rescue tiled and only its write failed. `partition-failed` is
    // declared deterministic-for-the-same-sha and is never retried, so
    // labelling a transient tmp-volume fault that way loses the anchor's
    // scope permanently instead of retrying it. The ENOSPC fixture above
    // fails the FIRST write, which ends the round before a rescue exists, so
    // this branch was unreachable and an always-`partition-failed` mutant
    // left the suite green.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (text === DELTA_DIFF) throw new Error('chunks do not tile the diff');
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    // Write 1 is the delta publish and succeeds; write 2 is the rescue.
    let diffWrites = 0;
    producerMocks.writeFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('diff.txt') && ++diffWrites === 2) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      }
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).toBeNull();
    expect(report.diffPathAbsolute).toBeNull();
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
    // Nothing was rescued, so nothing may announce a full review.
    const said = producerMocks.writeStderrLine.mock.calls.map((c) =>
      String(c[0]),
    );
    expect(said.some((l) => l.includes('Retried the partition'))).toBe(false);
    // The PLAN stayed empty. `plan = rescued` assigned before the write is
    // checked ships the full range's chunk ranges beside a null `diffPath` —
    // chunk agents handed ranges naming a file nobody wrote.
    expect(report.diffLines).toBe(0);
    // …and the narration names the write, not the partitioner. The delta plan
    // DID throw here, so a ternary reading `partitionFailed` alone announces
    // "could not be partitioned" for a round whose only fault was a transient
    // ENOSPC — contradicting the report's own retryable reason.
    const line = said.find((l) => l.includes('Incremental anchor'));
    expect(line).toContain('no diff could be captured');
    expect(line).not.toContain('could not be partitioned');
  });

  it('refuses the anchor before the partitioner when NO base ever resolved', async () => {
    // The rescue reads `fullText`, which is null when the base branch was
    // deleted or renamed — the state the blessed "scopes a valid anchor when
    // NO base resolved" test establishes, here combined with a partitioner
    // that refuses. Without the null guard, `null.trim()` throws inside the
    // partition catch itself — outside the nested try — so `runFetchPr` dies
    // after the worktree exists and before any report is written, which is
    // precisely what that catch exists to prevent.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).toBeNull();
    // The base-free arm now refuses for containment BEFORE anything is
    // partitioned, so the reason names the earlier cause. That also makes the
    // rescue's `fullText !== null` guard unreachable from here: `scopedDelta`
    // can no longer be true without a base, so it now implies a non-null
    // `fullText`. The guard stays as a guard; what changed is that this shape
    // no longer reaches it.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'containment-unverified',
    });
  });

  it('names the partitioner, not the capture, when a REFUSED anchor ends planless', async () => {
    // The refusal reason and the planless cause are different facts. An
    // anchor refused on its own merits whose full range then fails to tile
    // keeps that reason — so a status line that infers the cause from the
    // reason announced "no diff could be captured" moments after the capture
    // succeeded and the partitioner warned, sending whoever diagnoses the
    // round at git and the network instead of at the partitioner.
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      // `merge-base` answers null → exit 1 → the predicate's NO.
      args[0] === 'cat-file' ? '' : args[0] === 'rev-parse' ? ANCHOR : null,
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    // The anchor keeps its own cause…
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'not-an-ancestor',
    });
    expect(report.diffPath).toBeNull();
    // …and the narration names what actually left the round planless.
    const line = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Incremental anchor'));
    expect(line).toContain('could not be partitioned');
    expect(line).not.toContain('no diff could be captured');
  });

  it('ends planless only when BOTH ranges refuse to tile', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    // A large advertised stat, so the collapse ratio WOULD fire if the
    // demoted state resurrected the full-range flags over the delta text —
    // without it this assertion cannot discriminate.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'main',
        additions: 400,
        deletions: 100,
        changedFiles: 9,
        isCrossRepository: false,
        body: '',
      }),
    );
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).toBeNull();
    // Planless, but NOT `full-range-unavailable`: both ranges captured
    // fine, so the cause is the partitioner, and the same bytes re-fail it
    // identically — SKILL's same-sha retry must keep excluding this reason.
    // Planless-ness is on the report as `diffPath: null`, which is what the
    // degraded flow reads.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'partition-failed',
    });
    expect(report.diffPathAbsolute).toBeNull();
    expect(report.collapsedFromUpstream).toBeUndefined();
  });

  it('demotes to capture-failed when the delta capture throws', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes(`${ANCHOR}..f00df00df00d`)) {
        throw new Error('git timed out');
      }
      return Buffer.from(DELTA_DIFF);
    });
    const report = await reportFor({ since: ANCHOR });
    // The full-range fallback DID produce a plan, so the reason stays the
    // one that names why the delta was abandoned.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
    expect(report.diffPath).not.toBeNull();
  });

  it('keeps the CAUSE as the reason on a planless round', async () => {
    // The delta throws and there is no merge base to fall back to, so the
    // round ends with no plan. The reason still names what happened; the
    // planless fact is `diffPath: null`, which is what the degraded flow
    // reads. Renaming causes into one planless label put deterministic
    // refusals into the class the skill retries.
    anchorIsValid();
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes('diff')) throw new Error('git timed out');
      return Buffer.from('');
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).toBeNull();
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
    const refusedLine = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('refused'));
    expect(refusedLine).toContain('capture-failed');
    expect(refusedLine).toContain('no diff could be captured');
  });

  it('upgrades an empty delta to upToDate and recaptures the FULL range', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      upToDate: true,
    });
    // upToDate promises the FULL-range plan for the flows that continue.
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    expect(report.emptyDiff).toBeUndefined();
  });

  it('does not let an empty delta leak into emptyDiff when no full range exists', async () => {
    // The shipped Critical: the empty-delta capture set diffPath, the
    // merge-base fallback never ran (sha: null), and
    // isEmptyDiff({diffPath: non-null, baseFetchFailed: false, diffText: ''})
    // recommended a LIVE PR for closure. Publishing only at the accepting
    // site is what closes it.
    anchorIsValid();
    producerMocks.gitRaw.mockImplementation(() => Buffer.from(''));
    const report = await reportFor({ since: ANCHOR });
    expect(report.emptyDiff).toBeUndefined();
    expect(report.diffPath).toBeNull();
    // Both halves null, or a consumer dereferences a path for a plan that
    // does not exist.
    expect(report.diffPathAbsolute).toBeNull();
    // `upToDate` SURVIVES the missing full range: it is a fact about the
    // anchor, proven by the delta capture, and the flow it serves — "No new
    // changes since last review" → cleanup, stop — consumes no plan. The
    // continuing flows read `diffPath` like any other degraded round.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      upToDate: true,
    });
    const line = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Incremental:'));
    expect(line).toContain('up to date with the head');
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

describe('resolveIncrementalAnchor', () => {
  const HEAD = 'f'.repeat(40);
  const ANCHOR = 'a'.repeat(40);
  /** A history that holds the anchor behind the head. */
  const probe = (over: Partial<AnchorProbe> = {}): AnchorProbe => ({
    commitExists: () => true,
    isAncestor: () => true,
    resolveCommit: (sha) => (sha === ANCHOR ? ANCHOR : sha),
    ...over,
  });

  it('scopes to a valid anchor behind the head', () => {
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, probe());
    expect(r.incremental).toEqual({ since: ANCHOR, effective: true });
    expect(r.diffBase).toBe(ANCHOR);
  });

  it('reports up-to-date when the anchor IS the head, and keeps the full range', () => {
    // The flows that continue past an up-to-date anchor (a model change,
    // --comment) run a full review, so the diff must not be scoped to the
    // empty range.
    const r = resolveIncrementalAnchor(HEAD, HEAD, probe());
    expect(r.incremental).toEqual({
      since: HEAD,
      effective: true,
      upToDate: true,
    });
    expect(r.diffBase).toBeNull();
  });

  it('refuses an anchor the history has never seen', () => {
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, {
      ...probe(),
      commitExists: () => false,
    });
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'unknown-commit',
    });
    expect(r.diffBase).toBeNull();
  });

  it('refuses a rebased-away anchor — not an ancestor of the head', () => {
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, {
      ...probe(),
      isAncestor: () => false,
    });
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'not-an-ancestor',
    });
    expect(r.diffBase).toBeNull();
  });

  it('expands an abbreviated anchor to the full sha it scopes from', () => {
    // The cache and the marker may both hold an abbreviation (git's
    // auto-abbreviation grows with the repo). `diffBase` is contracted as a
    // FULL sha — it is welded into Agent 7's `--base` — so the ruling scopes
    // from what rev-parse resolved, never from the string that came in.
    const r = resolveIncrementalAnchor(
      'abc1234',
      HEAD,
      probe({ resolveCommit: () => ANCHOR }),
    );
    expect(r.diffBase).toBe(ANCHOR);
    expect(r.incremental).toEqual({ since: 'abc1234', effective: true });
  });

  it('refuses an anchor when the merge base is too stale to clamp against', () => {
    // Ruling the clamp on a base resolved from a possibly stale local ref is
    // the one thing every sibling guard here refuses to do.
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, probe(), {
      sha: 'c'.repeat(40),
      fetchFailed: true,
    });
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });
    expect(r.diffBase).toBeNull();
  });

  it('rules upToDate even when the base fetch failed — the empty delta needs no base', () => {
    // Check ORDER is load-bearing: moving the fetchFailed refusal above the
    // head comparison turns "nothing new to review" into a refused anchor
    // and misdirects the SKILL's recovery, with no other test red.
    const r = resolveIncrementalAnchor(HEAD, HEAD, probe(), {
      sha: 'c'.repeat(40),
      fetchFailed: true,
    });
    expect(r.incremental).toEqual({
      since: HEAD,
      effective: true,
      upToDate: true,
    });
    expect(r.diffBase).toBeNull();
  });

  it('scopes a valid anchor when the base fetch failed but resolved NO base', () => {
    // `base-untrusted` is about an untrustworthy clamp, not a missing one:
    // with no base there is nothing to clamp, and the delta range needs
    // none — a deleted or renamed base branch must not cost the scope.
    // Pinned on the CALL, not just the outcome: a constant-true isAncestor
    // makes a dropped `sha != null` guard invisible, so record what the
    // clamp asked and assert it never asked about a null base.
    const asked: Array<[string, string]> = [];
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({
        isAncestor: (a, b) => {
          asked.push([a, b]);
          return true;
        },
      }),
      { sha: null, fetchFailed: true },
    );
    expect(r.incremental).toEqual({ since: ANCHOR, effective: true });
    expect(r.diffBase).toBe(ANCHOR);
    // Only the head-ancestry question, never a clamp against `null`.
    expect(asked).toEqual([[ANCHOR, HEAD]]);
  });

  it('rules base-untrusted BEFORE the clamp — an unverifiable base cannot be clamped against', () => {
    // Swapping the two checks leaves the suite green while the clamp rules
    // on a base the run has flagged unreliable, which is the state every
    // sibling guard declines to rule in.
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ isAncestor: (a) => a !== 'c'.repeat(40) }),
      { sha: 'c'.repeat(40), fetchFailed: true },
    );
    expect(r.incremental.reason).toBe('base-untrusted');
  });

  it('compares the RESOLVED sha to the head, not the string it was given', () => {
    // An abbreviation of the head must rule upToDate: comparing the raw
    // input would scope an empty range instead of stopping the round.
    const r = resolveIncrementalAnchor(
      'f00df00',
      HEAD,
      probe({ resolveCommit: () => HEAD }),
    );
    expect(r.incremental).toEqual({
      since: 'f00df00',
      effective: true,
      upToDate: true,
    });
    expect(r.diffBase).toBeNull();
  });

  it('clamps an anchor older than the merge base — wider than the PR is not incremental', () => {
    const MERGE_BASE = 'c'.repeat(40);
    // The anchor is behind the head, but the merge base is NOT behind the
    // anchor: scoping anchor..head would include base history the PR's own
    // diff does not contain.
    const base = { sha: MERGE_BASE, fetchFailed: false };
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({
        isAncestor: (a) => a !== MERGE_BASE,
      }),
      base,
    );
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'behind-merge-base',
    });
    expect(r.diffBase).toBeNull();
    // With the base behind the anchor the clamp passes and the scope stands.
    expect(resolveIncrementalAnchor(ANCHOR, HEAD, probe(), base).diffBase).toBe(
      ANCHOR,
    );
  });

  it('reports unknown-commit when BOTH probes fail — the shape real git produces', () => {
    // A sha this history never held fails `cat-file -e` AND
    // `merge-base --is-ancestor`; the canonical side-file case (a fresh
    // clone validating a marker sha posted elsewhere). The order decides
    // which reason the user is told, and "a rebase retired it" is the wrong
    // story for a commit that was never here.
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, {
      commitExists: () => false,
      isAncestor: () => false,
      resolveCommit: () => null,
    });
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'unknown-commit',
    });
  });

  it('accepts a 64-character SHA-256 anchor', () => {
    // The allowlist's `{7,64}` ceiling is what admits a SHA-256 object id,
    // and this module reads one: its own comment names "a SHA-256 marker sha
    // read against SHA-1 history". Every other valid anchor here is 40 chars,
    // so a mutant tightening the bound to `{7,40}` refused a real anchor —
    // before any probe, as the never-retried `unknown-commit` — while the
    // whole suite stayed green.
    const sha256 = 'a'.repeat(64);
    const r = resolveIncrementalAnchor(
      sha256,
      HEAD,
      probe({ resolveCommit: (sha) => sha }),
    );
    expect(r.incremental).toEqual({ since: sha256, effective: true });
    expect(r.diffBase).toBe(sha256);
  });

  it('accepts a valid UPPERCASE anchor, probing the lowercased value', () => {
    // The normalisation is exercised only on the refusal path today — every
    // bad-anchor input is invalid in either case, so none of them distinguishes
    // a mutant testing the CASED string against the lowercase-only `SHA_RE`.
    // That mutant refuses a valid in-history anchor as `unknown-commit`: the
    // deterministic reason, never retried, asserting the history never held a
    // sha it holds.
    const asked: string[] = [];
    const r = resolveIncrementalAnchor(ANCHOR.toUpperCase(), HEAD, {
      commitExists: (sha) => (asked.push(sha), true),
      isAncestor: () => true,
      resolveCommit: (sha) => (asked.push(sha), sha === ANCHOR ? ANCHOR : null),
    });
    expect(r.incremental).toEqual({ since: ANCHOR, effective: true });
    expect(r.diffBase).toBe(ANCHOR);
    // git resolves hex case-insensitively, but the value handed to it is the
    // normalised one, so the echoed `since` and the probed sha agree.
    expect(asked).toEqual([ANCHOR, ANCHOR]);
  });

  it('never hands a flag-shaped or non-hex anchor to git', () => {
    // The anchor arrives from a cache file or a posted marker; the hex
    // allowlist runs BEFORE any probe so nothing flag-shaped reaches git.
    for (const bad of [
      '--upload-pack=/tmp/x',
      'HEAD',
      'refs/heads/main',
      '$(rm -rf /)',
      'abc123', // 6 chars — below the 7-char abbreviation floor
      'f'.repeat(65), // 65 chars — one past the SHA-256 ceiling
    ]) {
      let probed = false;
      const r = resolveIncrementalAnchor(bad, HEAD, {
        commitExists: () => ((probed = true), true),
        isAncestor: () => ((probed = true), true),
        resolveCommit: () => ((probed = true), HEAD),
      });
      expect(probed).toBe(false);
      expect(r.incremental).toEqual({
        // Echoed normalised: a recovery flow re-deriving the anchor from
        // the report must get the value the next round will judge.
        since: bad.toLowerCase(),
        effective: false,
        reason: 'unknown-commit',
      });
    }
  });

  it('settles commit-ness BEFORE asking about ancestry', () => {
    // Order is the whole finding. A blob or tree sha passes `cat-file -e`;
    // asking `merge-base --is-ancestor` about it exits 128, which this
    // module's probe turns into `GitUnavailable` → the retryable
    // `capture-failed` → SKILL re-running the same never-resolvable anchor
    // every round, forever. Resolving commit-ness first ends it at the
    // deterministic `unknown-commit`, which is never retried.
    //
    // The other `resolveCommit: () => null` cases pair with a constant-true
    // `isAncestor`, so a block-swap mutant is observationally identical
    // there — and it survived the entire review suite. This probe gives
    // ancestry an error channel and asserts it is never reached.
    let ancestryAsked = false;
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({
        resolveCommit: () => null,
        isAncestor: () => {
          ancestryAsked = true;
          throw new Error('ancestry asked about an unresolved anchor');
        },
      }),
    );
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'unknown-commit',
    });
    expect(ancestryAsked).toBe(false);
  });

  it('rules a rebased-away anchor even when the base fetch failed', () => {
    // Both refusals are live in one round: a force-push retires the cached
    // anchor while the base branch cannot be fetched (deleted or renamed).
    // Ancestry needs only the fetched PR history, so the deterministic answer
    // exists — and it must win, because `base-untrusted` is re-run with the
    // SAME sha, so ordering the base check first re-refuses a dead anchor
    // every round instead of ending it in round one.
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ isAncestor: () => false }),
      { sha: 'c'.repeat(40), fetchFailed: true },
    );
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'not-an-ancestor',
    });
  });

  it('treats an anchor rev-parse cannot name as unknown, not as a full-range effective', () => {
    // effective:true over a full-range diff would misstate the report's scope.
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, {
      ...probe(),
      resolveCommit: () => null,
    });
    // The whole decision, not just `effective`: the SKILL keys its recovery
    // bullets on `reason`, so a drifted reason hands the flow a wrong
    // diagnosis with no red test.
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'unknown-commit',
    });
    expect(r.diffBase).toBeNull();
  });
});

describe('containmentRuling — the containment oracle', () => {
  // The battery below reads the `ok` fact. `unverified` — the other half of
  // the ruling — is asserted directly, in the cases that produce it.
  const contained = (inner: string, outer: string) =>
    containmentRuling(inner, outer).ok;

  const sec = (file: string, hunks: Array<[number, number]>) =>
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      // A PURE ADDITION: zero old-side lines, `count` new ones. The counts
      // are declared truthfully so the fixture models a real capture:
      // `parseDiff` closes a hunk STRUCTURALLY, at the next `@@` /
      // `diff --git` header or EOF, and reads the declared counts only to
      // compute `newEnd` — so a mismatched count does not truncate anything,
      // it just misplaces the range the containment check then compares.
      ...hunks.flatMap(([start, count]) => [
        `@@ -${start},0 +${start},${count} @@`,
        ...Array.from({ length: count }, (_, i) => `+line ${start + i}`),
      ]),
      '',
    ].join('\n');

  /**
   * A covering section that ALSO deletes `deleted`.
   *
   * `sec` emits pure additions, so it deletes nothing, and a delta carrying a
   * deletion is refused by the content rule before its ranges are ever
   * compared. Tests that mean to measure the range arithmetic on a deletion
   * hunk need an outer that performs the same deletion — which is also the
   * only shape in which the PR's diff displays that line at all.
   */
  const secDeleting = (
    file: string,
    [start, count]: [number, number],
    deleted: string[],
    /**
     * New-side junction the deletions sit at. Defaults to the hunk's own
     * start; pass the delta's junction when modelling "the PR performs the
     * same deletion", because sameness is (content, position) and not content
     * alone — a `-X` displayed elsewhere in the file is no help to a comment
     * anchored here.
     */
    junction: number = start,
  ) => {
    const lead = junction - start; // context lines before the deletions
    const added = count - lead; // `+` lines after them
    return [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      // Counts declared truthfully: old side is the leading context plus the
      // deleted lines, new side is that context plus the added ones.
      `@@ -${start},${lead + deleted.length} +${start},${count} @@`,
      ...Array.from({ length: lead }, (_, i) => ` ctx ${start + i}`),
      ...deleted.map((d) => `-${d}`),
      ...Array.from({ length: added }, (_, i) => `+line ${junction + i}`),
      '',
    ].join('\n');
  };

  /**
   * A delta section that DELETES `what`, wrapped in context.
   *
   * The shape `--unified=3` actually emits: the hunk is not `newCount === 0`,
   * so a rule keyed on pure-deletion hunks never sees it, and its surviving
   * new-side range is just the context a covering hunk contains for free.
   */
  const deletes = (file: string, at: number, what: string[]) =>
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -${at},${what.length + 2} +${at},2 @@`,
      ' ctx before',
      ...what.map((w) => `-${w}`),
      ' ctx after',
      '',
    ].join('\n');

  it('accepts a delta whose hunks sit inside the PR diff, per file', () => {
    expect(contained(sec('a.ts', [[10, 3]]), sec('a.ts', [[1, 100]]))).toBe(
      true,
    );
  });

  it('discriminates BOTH boundary directions', () => {
    // `s <= start && end <= e` — a mutant flipping either comparison accepts
    // a delta carrying hunks GitHub's PR diff does not contain, and one
    // comment anchored there 422s the whole review.
    const outer = sec('a.ts', [[10, 10]]); // covers [10, 19]
    // starts BELOW the covering hunk
    expect(contained(sec('a.ts', [[1, 3]]), outer)).toBe(false);
    // …including by exactly one line. The far-below fixture above kills a
    // FLIPPED comparison but not a widened one: `s - 1 <= start` survived the
    // whole suite, and a delta hunk starting one line above the covering hunk
    // touches a line GitHub's PR diff does not display.
    expect(contained(sec('a.ts', [[9, 2]]), outer)).toBe(false);
    expect(contained(sec('a.ts', [[10, 2]]), outer)).toBe(true);
    // starts inside, ends PAST it
    expect(contained(sec('a.ts', [[12, 50]]), outer)).toBe(false);
    // …including by exactly one line: a delta hunk whose last line sits one
    // past the covering hunk is a line GitHub's PR diff does not display,
    // and an anchored comment there 422s the entire review. Shared
    // deletions need no slack — both captures share the head tree, so an
    // identical junction is covered at equality.
    // (`sec` takes [start, COUNT]: 12+9-1 = 20 is one past the outer's 19.)
    expect(contained(sec('a.ts', [[12, 9]]), outer)).toBe(false);
    expect(contained(sec('a.ts', [[12, 8]]), outer)).toBe(true);
  });

  it('records EVERY hunk of a section, not just the first', () => {
    // A second hunk must be seen as a hunk. `parseDiff` closes hunks at the
    // next header, so this does not test truncation — it tests that the loop
    // over `section.ranges` reads every entry and not just the first.
    const two = sec('a.ts', [
      [10, 3],
      [50, 2],
    ]);
    expect(contained(two, sec('a.ts', [[10, 3]]))).toBe(false);
    expect(contained(two, sec('a.ts', [[1, 100]]))).toBe(true);
  });

  it('consumes the no-newline marker without spending a body line', () => {
    // `\ No newline at end of file` is a marker, not content: it belongs to
    // neither side, so counting it as a body line shifts the new-side cursor
    // and every range after it. The most common real-world diff artifact
    // there is.
    const withMarker = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      // The marker lands MID-hunk, with a count still owed on the new side
      // — the shape real git emits whenever a modification hunk's old side
      // lacks a trailing newline. Spending the counts before it arrives
      // routes the line through the outside-hunk skip and leaves the
      // in-hunk branch unexercised, which is what the first cut did.
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '@@ -50,0 +50,1 @@',
      '+later',
      '',
    ].join('\n');
    // Both hunks are seen: covered by a wide outer, refused by a narrow one.
    // The outer shares the `-old` deletion, so what is measured here is the
    // marker's effect on hunk boundaries and not the content rule.
    expect(
      contained(withMarker, secDeleting('a.ts', [1, 100], ['old'], 1)),
    ).toBe(true);
    expect(
      contained(withMarker, secDeleting('a.ts', [1, 10], ['old'], 1)),
    ).toBe(false);
  });

  it('checks EVERY section of the delta, not just the first', () => {
    // Every other fixture is single-file, so the loop over inner sections
    // was unconstrained — a mutant reading only the first section accepts a
    // delta whose SECOND file is absent from the PR's diff.
    const twoFiles = `${sec('a.ts', [[10, 3]])}${sec('b.ts', [[10, 3]])}`;
    expect(contained(twoFiles, sec('a.ts', [[1, 100]]))).toBe(false);
    expect(
      contained(
        twoFiles,
        `${sec('a.ts', [[1, 100]])}${sec('b.ts', [[1, 100]])}`,
      ),
    ).toBe(true);
  });

  it('scans EVERY covering hunk, not just the first', () => {
    // A mutant testing only `covering[0]` survives while every outer is
    // single-hunk; a real PR diff is many hunks per file.
    const outer = sec('a.ts', [
      [1, 5],
      [100, 20],
    ]);
    expect(contained(sec('a.ts', [[105, 3]]), outer)).toBe(true);
    expect(contained(sec('a.ts', [[50, 3]]), outer)).toBe(false);
  });

  it('keys coverage per FILE — a numerically-inside range in another file is not covered', () => {
    // A pooled-ranges mutant (dropping the file key) accepts this shape: the
    // delta's b.ts hunk falls numerically inside a.ts's full-range hunk.
    expect(contained(sec('b.ts', [[10, 3]]), sec('a.ts', [[1, 100]]))).toBe(
      false,
    );
  });

  it('does not read added CONTENT as diff structure', () => {
    // An added line shaped like a file header — an embedded diff fixture is
    // exactly that — used to re-attribute every LATER hunk of the file:
    // here the second hunk would be filed under `big.ts` and found covered
    // by its [1,2000] range, so a delta carrying a hunk outside GitHub's PR
    // diff published as the review scope. Structure is recognized only
    // outside hunk bodies, as both sibling parsers in this file already do.
    const spoofing = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '+++ b/big.ts',
      ' context2',
      '@@ -99,2 +99,4 @@',
      ' keep',
      '+undo per feedback',
      '+second line',
      ' keep2',
      '',
    ].join('\n');
    // Both hunks belong to x.ts, so a PR diff that only touches big.ts
    // cannot cover them however wide its range is.
    expect(contained(spoofing, sec('big.ts', [[1, 2000]]))).toBe(false);
    // …and against x.ts's own wide hunk they are covered.
    expect(contained(spoofing, sec('x.ts', [[1, 200]]))).toBe(true);
  });

  it('counts deletions, so one displayed line clears only one', () => {
    // Set membership let a SINGLE `-X` in the PR's diff clear ANY number of
    // `-X` lines in the delta. A round that deletes two identical lines — a
    // duplicated guard clause, a repeated import, a blank line — where the PR
    // deletes one was accepted, and the second deletion is a line GitHub does
    // not display.
    const twice = deletes('a.ts', 6, ['return true;', 'return true;']);
    expect(
      contained(twice, secDeleting('a.ts', [1, 100], ['return true;'], 7)),
    ).toBe(false);
    expect(
      contained(
        twice,
        secDeleting('a.ts', [1, 100], ['return true;', 'return true;'], 7),
      ),
    ).toBe(true);
  });

  it('refuses a delta section with nothing comparable against a covering one that has hunks', () => {
    // A mode change, a pure rename, a binary replacement: no range and no
    // deletion, so both containment loops iterate zero times and the section
    // used to pass vacuously. An "undo per feedback" round that reverts round
    // 1's `chmod +x` is exactly this shape, and the PR's own diff — which
    // ends at the same head — shows no mode change at all.
    const modeOnly = [
      'diff --git a/m.sh b/m.sh',
      'old mode 100755',
      'new mode 100644',
      '',
    ].join('\n');
    expect(contained(modeOnly, sec('m.sh', [[1, 100]]))).toBe(false);
    // Still vacuous-true when the PR's section is equally contentless: two
    // binary sections have nothing to compare on either side.
    const binary = [
      'diff --git a/i.png b/i.png',
      'Binary files a/i.png and b/i.png differ',
      '',
    ].join('\n');
    expect(contained(binary, binary)).toBe(true);
  });

  it('declines to rule when either capture decoded lossily', () => {
    // Captures arrive decoded as UTF-8, and that decode is lossy: every byte
    // git emitted that is not valid UTF-8 becomes one U+FFFD. Distinct bytes
    // then compare EQUAL — two filenames differing only in an invalid byte
    // share one map key, and two byte-distinct deleted lines match 1:1 — and
    // nothing downstream can tell. Refusing to rule is the only honest answer.
    // (Built from buffers: macOS rejects invalid-UTF-8 filenames outright, so
    // no filesystem fixture can carry this shape.)
    const bytes = (...parts: Array<string | number[]>) =>
      Buffer.concat(
        // No ternary: `Buffer.from` already accepts the whole
        // `string | number[]` union, and a dead branch here invites a future
        // edit to give one arm a different encoding — silently redefining the
        // exact bytes these collision fixtures exist to carry.
        parts.map((x) => Buffer.from(x)),
      );
    const nameA = bytes('data_', [0xe9], '.log').toString('utf8');
    const nameB = bytes('data_', [0xf1], '.log').toString('utf8');
    expect(nameA).toBe(nameB); // the collision itself

    // Distinct files, one decoded key: the delta's hunks would be judged
    // against the OTHER file's ranges.
    expect(
      containmentRuling(
        deletes(nameA, 6, ['X']),
        secDeleting(nameB, [1, 100], ['X'], 7),
      ),
    ).toEqual({ ok: false, unverified: true });

    // Same path, byte-distinct deleted lines that decode identically — the
    // count map cannot see the difference either.
    const sentA = bytes('sentinel ', [0xff]).toString('utf8');
    const sentB = bytes('sentinel ', [0xfe]).toString('utf8');
    expect(
      containmentRuling(
        deletes('a.ts', 6, [sentA]),
        secDeleting('a.ts', [1, 100], [sentB], 7),
      ),
    ).toEqual({ ok: false, unverified: true });

    // ONE-SIDED, both directions. Every case above is lossy on both sides, so
    // an `&&` in place of the `||` survives them all — and the difference
    // matters: a lossy delta against a clean full capture would then be ruled
    // `hunks-outside-pr-diff`, which asserts a PROVEN scope violation, rather
    // than `containment-unverified`, which says the oracle could not read its
    // input. The reachable shape is a file whose path carries an invalid byte,
    // added after the anchor and deleted in the undo round: the delta capture
    // carries it, the full capture nets it to nothing.
    expect(
      containmentRuling(
        deletes(nameA, 6, ['X']),
        secDeleting('a.ts', [1, 100], ['X'], 7),
      ),
    ).toEqual({ ok: false, unverified: true });
    expect(
      containmentRuling(
        deletes('a.ts', 6, ['X']),
        secDeleting(nameA, [1, 100], ['X'], 7),
      ),
    ).toEqual({ ok: false, unverified: true });
  });

  it('compares SHORT deleted lines by their whole content', () => {
    // The collector strips exactly one marker character. Stripping two
    // transforms both captures identically — so every equality this battery
    // checks still holds — while collapsing distinct short deletions onto the
    // empty string: `-a` and `-b` both become ``. The battery's own comment
    // names "a blank line" as a shape it cares about, and no fixture supplied
    // one.
    expect(
      contained(
        deletes('a.ts', 6, ['a']),
        secDeleting('a.ts', [1, 100], [''], 7),
      ),
    ).toBe(false);
    // A genuinely blank deleted line is matched by a blank one.
    expect(
      contained(
        deletes('a.ts', 6, ['']),
        secDeleting('a.ts', [1, 100], [''], 7),
      ),
    ).toBe(true);
  });

  it('keys the deletion rule per FILE, not across the whole diff', () => {
    // Every other deletion fixture is single-file, and the only cross-file
    // test uses addition-only sections — so a mutant pooling all outer
    // sections' deletions into one set survives. Real shape: round 1 moves
    // line X from b.ts to a.ts, and the undo round deletes it from a.ts. The
    // PR's own diff displays `-X` only in b.ts, so a comment anchored on the
    // a.ts deletion hits a line GitHub does not show there.
    const full = `${secDeleting('a.ts', [1, 100], [])}${secDeleting('b.ts', [1, 100], ['X'], 7)}`;
    expect(contained(deletes('a.ts', 6, ['X']), full)).toBe(false);
    // …and it is displayed where the PR actually deletes it.
    expect(contained(deletes('b.ts', 6, ['X']), full)).toBe(true);
  });

  it('draws the deletion budget from the ENCLOSING hunk, not the whole file', () => {
    // Held per file, a `-X` the PR displays in one hunk cleared a `-X` the
    // delta performs thirty lines away in another — a line displayed nowhere
    // near where the delta deletes it, so a comment anchored there still 422s.
    // Locality is available (the shared head tree is the same fact the range
    // check rests on), so the budget comes from the hunks that enclose.
    const far = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      // encloses the delta's range but deletes nothing. Counts declared to
      // match the body: 3 context + 1 changed + 9 context on each side.
      '@@ -2,13 +2,13 @@',
      ...Array.from({ length: 3 }, (_, i) => ` c${i}`),
      '-edited',
      '+edited2',
      ...Array.from({ length: 9 }, (_, i) => ` d${i}`),
      // deletes X, but nowhere near. Old side 1 + 1 + 8, new side 1 + 8.
      '@@ -40,10 +40,9 @@',
      ' e0',
      '-X',
      ...Array.from({ length: 8 }, (_, i) => ` e${i + 1}`),
      '',
    ].join('\n');
    expect(contained(deletes('a.ts', 6, ['X']), far)).toBe(false);
    // …and it IS accepted when the enclosing hunk is the one that deletes it.
    expect(
      contained(
        deletes('a.ts', 6, ['X']),
        secDeleting('a.ts', [1, 100], ['X'], 7),
      ),
    ).toBe(true);
  });

  it('starts the body scan AFTER the hunk header, not at the section metadata', () => {
    // The scan begins at `diffStart` (the `@@` line's own index) precisely so
    // the section's `--- a/<path>` metadata is not read as a deletion. Nothing
    // pinned that: no inner fixture ever deleted content shaped like a
    // stripped header. Two hunks, because a widened window also sweeps the
    // inner section's own header and would otherwise cancel out.
    const deletesHeaderShape = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -6,3 +6,2 @@',
      ' c',
      '-- a/a.ts',
      ' c2',
      '@@ -20,3 +20,2 @@',
      ' d',
      '-- a/a.ts',
      ' d2',
      '',
    ].join('\n');
    void deletesHeaderShape;
    // The attack shape: the delta deletes a line whose text is exactly what a
    // stripped `--- a/<path>` header looks like, at the junction the outer
    // hunk STARTS at — which is where a widened scan would record the outer's
    // own header. The PR's diff deletes no such line, so this must be refused.
    const innerAtJunctionOne = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,1 @@',
      '-- a/a.ts',
      ' keep',
      '',
    ].join('\n');
    expect(contained(innerAtJunctionOne, sec('a.ts', [[1, 100]]))).toBe(false);
  });

  it('reads a deletion that ends the hunk body, with no trailing context', () => {
    // Under `--unified=3`, deleting within three lines of EOF emits a hunk
    // whose body ENDS in the `-` line. Every other deletion fixture here wraps
    // its deletions in trailing context, so the body scan's trailing bound was
    // pinned by nothing while its leading bound was.
    const endsInDeletion = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -8,3 +8,2 @@',
      ' ctx',
      ' ctx2',
      '-X',
      '',
    ].join('\n');
    // The PR displays no such deletion, so it must be refused — which only
    // happens if the scan SAW the trailing `-X` at all.
    expect(contained(endsInDeletion, sec('a.ts', [[1, 100]]))).toBe(false);
    expect(
      contained(endsInDeletion, secDeleting('a.ts', [1, 100], ['X'], 10)),
    ).toBe(true);
  });

  it('refuses a delta WITH hunks against a same-file section that has none', () => {
    // The mirror of the vacuous-pass case. `refuses hunk-less sections`
    // anchors its mode/binary deltas against a DIFFERENT file, so
    // `covering === undefined` refuses before the range loop is reached and
    // the empty-covering path goes unexercised. Real shape: round 1 edits
    // `m.sh` and chmods it, round 2 reverts only the content, so `base..head`
    // nets to a mode-only section while the delta still carries a hunk.
    const modeOnly = [
      'diff --git a/m.sh b/m.sh',
      'old mode 100755',
      'new mode 100644',
      '',
    ].join('\n');
    expect(contained(sec('m.sh', [[10, 3]]), modeOnly)).toBe(false);
    expect(contained(deletes('m.sh', 6, ['X']), modeOnly)).toBe(false);
  });

  it("needs EVERY delta hunk's deletion displayed, not just one of them", () => {
    // Round 1 chains edits and adds a duplicate X near a legitimately deleted
    // twin; round 2's undo deletes both copies. The full capture is one merged
    // hunk displaying `-X` once, the delta is two hunks deleting one each, and
    // the second copy is displayed nowhere. Matching by content alone let the
    // single displayed occurrence clear both.
    const twoHunks = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -7,3 +7,2 @@',
      ' c1',
      '-X',
      ' c2',
      '@@ -24,3 +23,2 @@',
      ' d1',
      '-X',
      ' d2',
      '',
    ].join('\n');
    // The PR displays `-X` at ONE of the two junctions (8), not both.
    const oneX = secDeleting('a.ts', [1, 100], ['X'], 8);
    expect(contained(twoHunks, oneX)).toBe(false);
    // Both junctions displayed → both delta hunks are covered.
    const bothX = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,42 +1,40 @@',
      // 7 context → cursor 8, where the delta's first `-X` sits; 16 more →
      // cursor 24, where its second sits. New side 7+16+17 = 40, old side +2.
      ...Array.from({ length: 7 }, (_, i) => ` p${i}`),
      '-X',
      ...Array.from({ length: 16 }, (_, i) => ` q${i}`),
      '-X',
      ...Array.from({ length: 17 }, (_, i) => ` r${i}`),
      '',
    ].join('\n');
    expect(contained(twoHunks, bothX)).toBe(true);
  });

  it("does not let the no-newline marker shift a deletion's junction", () => {
    // The marker belongs to neither side, so it must not advance the new-side
    // cursor. If it did, every junction after it in the hunk would be off by
    // one and would stop matching the PR's own — turning a legitimately
    // displayed deletion into a refusal, silently, on the most common
    // real-world diff artifact there is.
    const withMarker = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -6,4 +6,2 @@',
      ' ctx',
      '-gone',
      '\\ No newline at end of file',
      '-X',
      ' ctx after',
      '',
    ].join('\n');
    // Both deletions sit at junction 7: the marker spends no line.
    const outer = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,102 +1,100 @@',
      ...Array.from({ length: 6 }, (_, i) => ` z${i}`),
      '-gone',
      '-X',
      ...Array.from({ length: 94 }, (_, i) => ` y${i}`),
      '',
    ].join('\n');
    expect(contained(withMarker, outer)).toBe(true);
  });

  it('ties a deleted line to the junction it was deleted at', () => {
    // Content alone does not say WHERE. A single inner hunk against a single
    // outer hunk, budget spent exactly once — so no amount of counting closes
    // this — where the PR deletes `dup` near the top of the file and the delta
    // deletes `dup` thirty lines down, at a junction the PR's diff never
    // touches. Junctions are comparable for the same reason ranges are: both
    // captures end at the same head tree.
    const delta = deletes('a.ts', 30, ['dup']); // junction 31
    expect(contained(delta, secDeleting('a.ts', [1, 100], ['dup'], 6))).toBe(
      false,
    );
    expect(contained(delta, secDeleting('a.ts', [1, 100], ['dup'], 31))).toBe(
      true,
    );
  });

  it('accepts when the PR displays MORE occurrences than the delta deletes', () => {
    // The battery pinned the under-supplied refusal and the exact match; the
    // over-supplied accept was pinned nowhere, so rewriting the consume loop
    // as an equality check survives. That mutant rules `hunks-outside-pr-diff`
    // — a PROVEN violation that did not happen — on the ordinary shape where
    // the PR deletes two identical lines and the `--since` round deletes only
    // the one that came after the anchor, and that reason is never retried.
    const one = deletes('a.ts', 6, ['dup']); // junction 7
    const outerTwo = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,102 +1,100 @@',
      ...Array.from({ length: 6 }, (_, i) => ` m${i}`),
      '-dup', // junction 7 — the one the delta also deletes
      '-dup', // junction 7 as well: two deletions at the same place
      ...Array.from({ length: 94 }, (_, i) => ` n${i}`),
      '',
    ].join('\n');
    expect(contained(one, outerTwo)).toBe(true);
  });

  it('refuses a deletion the PR diff does not itself perform', () => {
    // New-side ranges cannot see a deletion: what survives it on the new side
    // is context, which a covering hunk contains for free. So a delta that
    // removes a line the PR introduced after the merge base — the "undo per
    // feedback" round — passed the range check outright, and the review scope
    // became a diff whose content GitHub displays on neither side.
    const delta = deletes('a.ts', 6, ['X1']);
    // Same file, and a range wide enough to cover — only the deletion differs.
    expect(contained(delta, secDeleting('a.ts', [1, 100], ['X1'], 7))).toBe(
      true,
    );
    expect(
      contained(delta, secDeleting('a.ts', [1, 100], ['unrelated'], 7)),
    ).toBe(false);
    // A PR diff that only adds lines deletes nothing, so it displays nothing
    // to anchor a comment on.
    expect(contained(delta, sec('a.ts', [[1, 100]]))).toBe(false);
    // Every deleted line must be matched, not just one of them.
    expect(
      contained(
        deletes('a.ts', 6, ['X1', 'X2']),
        secDeleting('a.ts', [1, 100], ['X1'], 7),
      ),
    ).toBe(false);
  });

  it('pins the deletion junction in BOTH directions — no slack', () => {
    // The junction is where deleted text used to sit. A slack constant here
    // was invisible to the suite for two rounds: `end <= e`, `e + 1` and
    // `e + 2` were all green. These two fix that in both directions.
    const deletionAt = (line: number) =>
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        `@@ -${line},2 +${line},0 @@`,
        '-gone',
        '-gone2',
        '',
      ].join('\n');
    // The outer performs the same deletion — otherwise the content rule
    // refuses first and the junction arithmetic goes unmeasured.
    const outer = secDeleting('a.ts', [1, 19], ['gone', 'gone2'], 19);
    // covering hunk [1,19]: a junction AT its end is contained…
    expect(contained(deletionAt(19), outer)).toBe(true);
    // …one past it is not, and neither is two past.
    expect(contained(deletionAt(20), outer)).toBe(false);
    expect(contained(deletionAt(21), outer)).toBe(false);
  });

  it('refuses a deletion the PR diff does not share', () => {
    // `+++ /dev/null` contributes no new-side range, so a deletion-only
    // delta used to pass vacuously: an undo-per-feedback commit deleting a
    // file the PR added is absent from the full range, and a finding
    // anchored on it 422s the review.
    const deletion = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-was here',
      '-and here',
      '',
    ].join('\n');
    expect(contained(deletion, sec('a.ts', [[1, 100]]))).toBe(false);
    expect(contained(deletion, deletion)).toBe(true);
  });

  it('refuses hunk-less sections — mode, binary and rename', () => {
    // git emits no `+++`/`@@` for these at all, so they were invisible to a
    // hunk-only parser and passed vacuously.
    const modeOnly = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const rename = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      '',
    ].join('\n');
    for (const delta of [modeOnly, binary, rename]) {
      expect(contained(delta, sec('a.ts', [[1, 100]]))).toBe(false);
      // …and the same section in the PR's own diff is contained.
      expect(contained(delta, delta)).toBe(true);
    }
  });

  it('rules containment on a non-ASCII path — the quotePath pin, from the oracle side', () => {
    // git C-style-quotes such a path unless `core.quotePath=false` is pinned
    // (it is, in PINNED_DIFF_CONFIG). Unquoted, the oracle rules normally;
    // quoted, it cannot name the section and every --since round on a PR
    // touching the file would refuse as `containment-unverified`.
    const unquoted = sec('docs/架构.md', [[1, 3]]);
    expect(contained(unquoted, sec('docs/架构.md', [[1, 100]]))).toBe(true);
    const quoted = [
      'diff --git "a/docs/\\346\\236\\266\\346\\236\\204.md" "b/docs/\\346\\236\\266\\346\\236\\204.md"',
      '--- "a/docs/\\346\\236\\266\\346\\236\\204.md"',
      '+++ "b/docs/\\346\\236\\266\\346\\236\\204.md"',
      '@@ -1,0 +1,1 @@',
      '+x',
      '',
    ].join('\n');
    // And the quoted shape rules too: git quotes such a path even under
    // `core.quotePath=false` when it holds a quote, a backslash or a
    // control character, so the oracle unquotes rather than trusting the
    // capture's config. The pin still matters (it keeps the common
    // non-ASCII case unquoted end to end) and is asserted in diff-flags.
    expect(contained(quoted, quoted)).toBe(true);
  });

  it('keys quote-bearing paths apart, not onto one shared bucket', () => {
    // Two DIFFERENT files whose names both carry a quote: a keying
    // regression that collapsed them onto one bucket would rule this
    // contained and publish an unchecked scope.
    const inner = [
      'diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"',
      '--- "a/we\\"ird.ts"',
      '+++ "b/we\\"ird.ts"',
      '@@ -1,0 +1,1 @@',
      '+x',
      '',
    ].join('\n');
    const outer = [
      'diff --git "a/oth\\"er.ts" "b/oth\\"er.ts"',
      '--- "a/oth\\"er.ts"',
      '+++ "b/oth\\"er.ts"',
      '@@ -1,0 +1,50 @@',
      ...Array.from({ length: 50 }, (_, i) => `+line ${i}`),
      '',
    ].join('\n');
    expect(contained(inner, outer)).toBe(false);
    expect(contained(inner, inner)).toBe(true);
  });

  it('names paths the shared parser can name — including a space and a quote', () => {
    // The oracle reads sections out of `parseDiff`, which unquotes and knows
    // the rename shapes, so paths that defeated a hand-rolled split are
    // ordinary now: this is what moving off a private grammar buys.
    const spacey = [
      'diff --git a/my b/file.ts b/my b/file.ts',
      '--- a/my b/file.ts',
      '+++ b/my b/file.ts',
      '@@ -1,0 +1,1 @@',
      '+x',
      '',
    ].join('\n');
    expect(contained(spacey, spacey)).toBe(true);
  });

  it('fails closed on a payload that is not a diff at all', () => {
    // The remaining "could not rule" state: a capture that returned
    // something with no sections in it. Refusing is right — an oracle that
    // cannot read its input must not vouch for a scope.
    const notADiff = 'fatal: bad revision\nsome other noise\n';
    expect(containmentRuling(notADiff, notADiff)).toEqual({
      ok: false,
      unverified: true,
    });
    // Each side, alone. Feeding the garbage to BOTH arguments leaves the
    // OUTER null-check pinned by nothing: a mutant dropping it survives, and
    // the day it regressed `sectionsContained(inner, null)` would throw a
    // TypeError out of `runFetchPr` — after the worktree exists and before
    // any report is written — instead of degrading to
    // `containment-unverified`.
    const real = sec('a.ts', [[1, 3]]);
    expect(containmentRuling(real, notADiff)).toEqual({
      ok: false,
      unverified: true,
    });
    expect(containmentRuling(notADiff, real)).toEqual({
      ok: false,
      unverified: true,
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

describe('fetch-pr diff identity (diffSha256)', () => {
  const savedEnv: { sessionId?: string; promptId?: string } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // fetch-pr refuses to run without the lease identity (a lease-less run
    // builds the review state with no lock against concurrent sessions), so
    // the handler this suite drives starts registered, same shape as the
    // report-assembly suite.
    savedEnv.sessionId = process.env['QWEN_CODE_SESSION_ID'];
    savedEnv.promptId = process.env['QWEN_CODE_PROMPT_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-self';
    process.env['QWEN_CODE_PROMPT_ID'] = 'prompt-now';
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
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

  async function reportFor() {
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
    } as unknown as Parameters<typeof handler>[0]);
    const call = producerMocks.writeFileSync.mock.calls.find(
      ([path]) => path === '/tmp/fetch-report.json',
    );
    if (!call) throw new Error('report was not written');
    return JSON.parse(String(call[1]));
  }

  it('hashes the captured diff bytes — the resume check compares against this', async () => {
    const diff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n+x\n';
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    const { gitRaw } = await import('./lib/git.js');
    vi.mocked(resolveMergeBase).mockReturnValue({
      sha: 'base123',
      baseFetchFailed: false,
    });
    vi.mocked(gitRaw).mockImplementation((...args: string[]) =>
      args.includes('diff') ? Buffer.from(diff) : Buffer.from(''),
    );

    const report = await reportFor();
    const { createHash } = await import('node:crypto');
    expect(report.diffSha256).toBe(
      createHash('sha256').update(Buffer.from(diff)).digest('hex'),
    );
  });

  it('hashes the BYTES, not a utf8 decode of them', async () => {
    // A pure-ASCII fixture cannot see the difference: digests of the Buffer
    // and of its utf8-decoded string coincide for every valid-UTF-8 diff and
    // diverge only on invalid bytes — which real diffs of binary-adjacent or
    // latin1 files do contain. A regression to string-hashing would make the
    // resume comparison refuse legitimate resumes on exactly those PRs.
    const bytes = Buffer.concat([
      Buffer.from('diff --git a/f b/f\n+'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from('\n'),
    ]);
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    const { gitRaw } = await import('./lib/git.js');
    vi.mocked(resolveMergeBase).mockReturnValue({
      sha: 'base123',
      baseFetchFailed: false,
    });
    vi.mocked(gitRaw).mockImplementation((...args: string[]) =>
      args.includes('diff') ? (bytes as unknown as Buffer) : Buffer.from(''),
    );

    const report = await reportFor();
    const { createHash } = await import('node:crypto');
    expect(report.diffSha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    // The decode-then-hash digest differs; equality above rules it out.
    expect(report.diffSha256).not.toBe(
      createHash('sha256').update(bytes.toString('utf8')).digest('hex'),
    );
  });

  it('is null when no diff was captured', async () => {
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    vi.mocked(resolveMergeBase).mockReturnValue({
      sha: null,
      baseFetchFailed: false,
    });
    const report = await reportFor();
    expect(report.diffSha256).toBeNull();
  });
});

describe('fetch-pr run-session ledger wiring', () => {
  const savedEnv: { sessionId?: string; promptId?: string } = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    // fetch-pr refuses to run without the lease identity (a lease-less run
    // builds the review state with no lock against concurrent sessions), so
    // the handler this suite drives starts registered, same shape as the
    // report-assembly suite.
    savedEnv.sessionId = process.env['QWEN_CODE_SESSION_ID'];
    savedEnv.promptId = process.env['QWEN_CODE_PROMPT_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-self';
    process.env['QWEN_CODE_PROMPT_ID'] = 'prompt-now';
    // clearAllMocks resets call history, NOT implementations — re-assert the
    // ones the preceding diff-identity describe reprogrammed, so this
    // suite's "no diff captured" shape is an assertion rather than a
    // coincidence of whatever final state leaked in.
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    const { gitRaw } = await import('./lib/git.js');
    vi.mocked(resolveMergeBase).mockReturnValue({
      sha: null,
      baseFetchFailed: false,
    });
    vi.mocked(gitRaw).mockImplementation(() => Buffer.from(''));
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
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

  it('appends the session against the plan it just wrote, after the write', async () => {
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
    } as unknown as Parameters<typeof handler>[0]);

    const { appendRunSession } = await import('./lib/run-ledger.js');
    expect(vi.mocked(appendRunSession)).toHaveBeenCalledWith(
      '/tmp/fetch-report.json',
    );
    // After the plan write: the entry must sit inside the run-epoch fence the
    // readers apply, which is keyed on the plan's mtime.
    const appendOrder = vi.mocked(appendRunSession).mock.invocationCallOrder[0];
    const writeIndex = producerMocks.writeFileSync.mock.calls.findIndex(
      ([path]) => path === '/tmp/fetch-report.json',
    );
    // A findIndex miss returns -1, and `.at(-1)` would silently hand back an
    // unrelated call's order — the assertion below would still pass.
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    const writeOrder =
      producerMocks.writeFileSync.mock.invocationCallOrder[writeIndex];
    expect(appendOrder).toBeGreaterThan(writeOrder);
  });
});
