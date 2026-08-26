/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { Argv, CommandModule } from 'yargs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  fetchPrCommand,
  countDiffChangedLines,
  computeDiffStats,
  isEmptyDiff,
  isCollapsedFromUpstream,
  resolveIncrementalAnchor,
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
import { DEADLINE_ENV, hasReviewDeadline } from './lib/deadline.js';
import type { MergeBaseResult } from './lib/merge-base.js';
import { buildRoleBrief } from './agent-prompt.js';
import { PARSE_ARGS_REPORT, tmpFile, worktreePath } from './lib/paths.js';
import { buildDiffPlan } from './lib/diff-plan.js';
import { buildPlanReport } from './lib/report.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { makeDiff } from './lib/test-utils.js';

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
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn((_path?: unknown): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // Same fail-closed default as readFileSync: the widening's reader gates
  // on lstat BEFORE it reads, and a path nothing serves does not exist.
  lstatSync: vi.fn((_path?: unknown): { isFile: () => boolean } => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // Identity by default: this fixture's filesystem holds no symlinks, so a
  // path's real location IS its lexical one and the widening reader's
  // containment passes. A test that wants an ESCAPE steers it per path.
  realpathSync: vi.fn((path?: unknown): string => String(path)),
  gh: vi.fn(),
  git: vi.fn(),
  execFileSync: vi.fn(),
  refExists: vi.fn((..._refs: unknown[]): boolean => false),
  releaseWorktree: vi.fn(() => ({ existed: false, freed: true })),
  gitOpt: vi.fn((..._args: string[]): string | null => null),
  // The exit-status-aware probe as its own vi.fn: the default mapping (set
  // in beforeEach) can only produce exit 0 and the DEFINITIVE no (exit 1),
  // so a test that wants a git-surface-unavailable shape — an exit-128
  // fatal, a timeout kill's null status — overrides this.
  gitExit: vi.fn(),
  statSync: vi.fn((path?: unknown): { mtimeMs: number } | undefined =>
    String(path).endsWith('-fetch.json') ||
    String(path).endsWith('fetch-report.json')
      ? { mtimeMs: Date.parse('2026-08-13T00:00:00.000Z') }
      : undefined,
  ),
  gitRaw: vi.fn((..._args: string[]): Buffer => Buffer.from('')),
  resolveMergeBase: vi.fn(
    (..._args: unknown[]): MergeBaseResult => ({
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
      mkdirSync: producerMocks.mkdirSync,
      lstatSync: producerMocks.lstatSync,
      realpathSync: producerMocks.realpathSync,
      readFileSync: producerMocks.readFileSync,
      writeFileSync: producerMocks.writeFileSync,
      statSync: statSyncThroughMock,
    },
    mkdirSync: producerMocks.mkdirSync,
    lstatSync: producerMocks.lstatSync,
    realpathSync: producerMocks.realpathSync,
    readFileSync: producerMocks.readFileSync,
    writeFileSync: producerMocks.writeFileSync,
    statSync: statSyncThroughMock,
  };
  function statSyncThroughMock(path?: unknown, ...rest: unknown[]) {
    const mocked = producerMocks.statSync(path);
    if (mocked !== undefined) return mocked;
    return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
  }
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

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    ensureAuthenticated: vi.fn(),
    gh: producerMocks.gh,
    setGhHost: vi.fn(),
  };
});

vi.mock('./lib/git.js', () => ({
  git: producerMocks.git,
  gitOpt: producerMocks.gitOpt,
  gitProbe: (...args: string[]) => producerMocks.gitExit(...args),
  gitRaw: producerMocks.gitRaw,
  gitWithInput: vi.fn((): string => ''),
  refExists: producerMocks.refExists,
  releaseWorktree: producerMocks.releaseWorktree,
}));

vi.mock('./lib/merge-base.js', () => ({
  resolveMergeBase: producerMocks.resolveMergeBase,
}));

// The ledger append is the wiring under test here, not the ledger itself
// (run-ledger.test.ts owns that): a silently unwritten ledger would make a
// later --resume find no prior sessions and re-run everything.
vi.mock('./lib/run-ledger.js', async (importOriginal) => {
  // Take RESUME_MAX from the real module: hardcoding it here made the
  // production constant unfalsifiable — changing it shipped this suite green.
  const actual = await importOriginal<typeof import('./lib/run-ledger.js')>();
  return {
    ...actual,
    appendRunSession: vi.fn(),
    priorSessionIds: vi.fn(() => []),
    sessionEntryCount: vi.fn(() => 1),
    ledgerResumeCount: vi.fn(() => 0),
    readResumeMarker: vi.fn(() => ({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    })),
    recordResume: vi.fn(),
    recordRestart: vi.fn(),
  };
});

// The budget-hygiene branch runs in these tests; unmocked it performs REAL
// filesystem deletes against the hardcoded report path's record dir, and
// nothing could observe whether it ran.
vi.mock('./lib/deadline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/deadline.js')>();
  // Spread the real module so `DEADLINE_ENV` and the real deadline/round-cap
  // wiring the report-assembly suite exercises pass through; stub only the
  // budget-hygiene calls the resume suite asserts on. `hasReviewDeadline`
  // stays real — it reads `DEADLINE_ENV`, which is unset in the resume tests,
  // so it returns false there anyway.
  return {
    ...actual,
    readBudgetStop: vi.fn(() => null),
    clearBudgetStop: vi.fn(),
    clearRoundStamps: vi.fn(),
  };
});
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
    // mockReturnValue a prior test set would leak into a test that relies on
    // the default. Re-assert the defaults (no prior report → ENOENT, no
    // merge base → no diff) here so every test starts from a known state
    // regardless of order.
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    producerMocks.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    producerMocks.refExists.mockReturnValue(false);
    producerMocks.git.mockImplementation((...args: string[]) =>
      args[0] === 'rev-parse' ? 'f00df00df00d' : '',
    );
    producerMocks.gitOpt.mockImplementation(() => null);
    // The default exit-status mapping, expressed over gitOpt: a null answer
    // is the DEFINITIVE no (exit 1), which is what these fixtures mean.
    producerMocks.gitExit.mockImplementation((...args: string[]) => {
      const out = producerMocks.gitOpt(...args);
      return { out, status: out === null ? 1 : 0 };
    });
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
        baseRefOid: 'ba5e0f0ba5e0',
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

  /**
   * The identity these fixtures run as, on both sides of the same-model gate.
   *
   * A `--since` anchor is used only when `--since-model` matches the running
   * identity, so a test about ancestry or scoping has to agree on WHO
   * certified the anchor before it can be about anything else. Supplied by
   * default here rather than repeated in thirty call sites; the tests that
   * are ABOUT the gate pass their own `sinceModel` and set their own env.
   */
  const CERTIFIER = 'fixture-model@1a2b3c4d';

  async function reportFor(extraArgs: Record<string, unknown>) {
    const handler = fetchPrCommand.handler;
    if (!handler) throw new Error('fetch-pr handler missing');
    const savedIdentity = process.env['QWEN_CODE_MODEL_IDENTITY'];
    process.env['QWEN_CODE_MODEL_IDENTITY'] = CERTIFIER;
    try {
      await handler({
        _: [],
        $0: 'qwen',
        pr_number: '42',
        owner_repo: 'acme/widgets',
        remote: 'origin',
        out: '/tmp/fetch-report.json',
        maxChunkLines: 400,
        ...(extraArgs['since'] !== undefined && !('sinceModel' in extraArgs)
          ? { sinceModel: CERTIFIER }
          : {}),
        ...extraArgs,
      } as unknown as Parameters<typeof handler>[0]);
    } finally {
      if (savedIdentity === undefined) {
        delete process.env['QWEN_CODE_MODEL_IDENTITY'];
      } else {
        process.env['QWEN_CODE_MODEL_IDENTITY'] = savedIdentity;
      }
    }
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

  it('refuses a dash-leading baseRefName from the platform metadata', async () => {
    // The base ref is server-controlled and reaches git's argv through the
    // base fetch — a dash-leading name (`--upload-pack=<payload>` is
    // creatable by full-refname push) must die here, never inside git.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: '--upload-pack=/tmp/evil',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    await expect(reportFor({})).rejects.toThrow(
      /refusing base ref "--upload-pack=\/tmp\/evil"/,
    );
    const reportCall = producerMocks.writeFileSync.mock.calls.find(
      ([path]) => path === '/tmp/fetch-report.json',
    );
    expect(reportCall).toBeUndefined();
  });

  it('refuses the refspec channel on baseRefName too (+ and colon)', async () => {
    // `--` ends option parsing, but a leading `+` or `src:dst` shape still
    // parses as a (force) refspec after it — same channels as
    // aone.fetchDiff's target guard.
    for (const baseRefName of ['+main', '+main:victim', 'src:dst']) {
      producerMocks.gh.mockReturnValue(
        JSON.stringify({
          headRefName: 'feat/x',
          headRefOid: 'f00df00df00d',
          baseRefName,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          isCrossRepository: false,
          body: '',
        }),
      );
      await expect(reportFor({})).rejects.toThrow(/not a plain branch name/);
    }
  });

  it('refuses HEAD, rev-parse metasyntax, and the empty baseRefName', async () => {
    // `HEAD` fetches silently and merge-bases through the stale clone-time
    // symref; `main^` rev-parses to the WRONG base under a misdescribing
    // warning; the empty string degrades to a garbled diff-less fallback.
    for (const baseRefName of ['HEAD', 'main^', 'main~1', '']) {
      producerMocks.gh.mockReturnValue(
        JSON.stringify({
          headRefName: 'feat/x',
          headRefOid: 'f00df00df00d',
          baseRefName,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          isCrossRepository: false,
          body: '',
        }),
      );
      await expect(reportFor({})).rejects.toThrow(/not a plain branch name/);
    }
  });

  it('refuses git pseudo-refs as baseRefName (allowlist)', async () => {
    // `FETCH_HEAD` resolves to the just-fetched PR head — merge-base(head,
    // head) = an EMPTY diff beside full-range metadata; `ORIG_HEAD` to an
    // arbitrary ancestor. Shape-legal, silently wrong — refused at the
    // metadata stage. Case-insensitively: on case-insensitive filesystems
    // (macOS/Windows defaults) `.git/fetch_head` folds onto the
    // `.git/FETCH_HEAD` the immediately-preceding fetch wrote.
    for (const baseRefName of [
      'FETCH_HEAD',
      'ORIG_HEAD',
      'MERGE_HEAD',
      'fetch_head',
      'orig_head',
      'head',
      // Legal branch names (check-ref-format --branch accepts them) that
      // resolve qualified refs the server controls as fetch/merge-base
      // arguments — refused like the pseudo-refs.
      'refs/heads/main',
      'refs/remotes/origin/HEAD',
    ]) {
      producerMocks.gh.mockReturnValue(
        JSON.stringify({
          headRefName: 'feat/x',
          headRefOid: 'f00df00df00d',
          baseRefName,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          isCrossRepository: false,
          body: '',
        }),
      );
      await expect(reportFor({})).rejects.toThrow(/not a plain branch name/);
    }
  });

  it('a TAG-only base ref degrades to the disclosed baseFetchFailed state', async () => {
    // `git fetch origin -- v1.0` exits 0 writing only FETCH_HEAD when v1.0
    // is tag-only on the remote — the fetch "succeeds" yet no tracking ref
    // exists, and the bare-name fallback would merge-base against the
    // reviewer's LOCAL tag: a wrong-base diff with baseFetchFailed falsely
    // false. The probe requires the tracking ref, so the tag-only shape
    // lands in the DISCLOSED state instead.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'v1.0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    // The fetch itself exits 0 (tag shape), but no `origin/v1.0` tracking
    // ref exists afterwards.
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'fetch' ? '' : null,
    );
    producerMocks.refExists.mockReturnValue(false);
    // Drive the seam the way the real resolveMergeBase does: the probe the
    // command passes must report the fetch as FAILED for the tag shape.
    producerMocks.resolveMergeBase.mockImplementation((...args: unknown[]) => {
      const probe = args[3] as { fetch: (r: string, b: string) => boolean };
      const ok = probe.fetch('origin', 'v1.0');
      return { sha: null, baseFetchFailed: !ok };
    });
    const report = await reportFor({});
    expect(report.baseFetchFailed).toBe(true);
  });

  it('the tracking-ref check is FULLY QUALIFIED (no origin/<name> shadow)', async () => {
    // A local tag or branch literally named `origin/v1.0` (slash-bearing
    // ref names are legal) satisfies an UNQUALIFIED refExists with no
    // tracking ref present — and such a tag is SERVER-CONTROLLED: a remote
    // carrying it auto-carries it into refs/tags/ at plain clone time. The
    // probe must check `refs/remotes/origin/<ref>` so the shadow cannot
    // satisfy it and silently move the base.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'v1.0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'fetch' ? '' : null,
    );
    const checked: string[] = [];
    producerMocks.refExists.mockImplementation((...refs: unknown[]) => {
      checked.push(String(refs[0]));
      return false;
    });
    producerMocks.resolveMergeBase.mockImplementation((...args: unknown[]) => {
      const probe = args[3] as { fetch: (r: string, b: string) => boolean };
      return { sha: null, baseFetchFailed: !probe.fetch('origin', 'v1.0') };
    });
    await reportFor({});
    expect(checked).toContain('refs/remotes/origin/v1.0');
    expect(checked).not.toContain('origin/v1.0');
  });

  it('the base fetch is an EXPLICIT branch refspec (no tag dwim)', async () => {
    // A bare-name fetch of a base that is also a tag name dwims onto the
    // TAG: exit 0, FETCH_HEAD-only, tracking ref untouched — the stale-base
    // state passing the freshness guard it never refreshed. The probe fetch
    // must name the branch source and the qualified tracking-ref
    // destination explicitly.
    producerMocks.gh.mockReturnValue(
      JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'f00df00df00d',
        baseRefName: 'v1.0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    const fetched: string[][] = [];
    producerMocks.gitOpt.mockImplementation((...args: string[]) => {
      if (args[0] === 'fetch') fetched.push(args.slice(1));
      return args[0] === 'fetch' ? '' : null;
    });
    producerMocks.refExists.mockImplementation((...refs: unknown[]) => {
      void refs;
      return true;
    });
    producerMocks.resolveMergeBase.mockImplementation((...args: unknown[]) => {
      const probe = args[3] as { fetch: (r: string, b: string) => boolean };
      probe.fetch('origin', 'v1.0');
      return { sha: 'mb1', baseFetchFailed: false };
    });
    await reportFor({});
    expect(fetched).toEqual([
      ['origin', '--', '+refs/heads/v1.0:refs/remotes/origin/v1.0'],
    ]);
  });

  it('refuses a non-positive pr_number before any side effect', async () => {
    // `/^\d+$/` once admitted '0'; the guard promises a POSITIVE integer
    // and must reject before detection, auth, and the worktree lease.
    await expect(reportFor({ pr_number: '0' })).rejects.toThrow(
      /pr_number must be a positive integer, got "0"/,
    );
    expect(producerMocks.git).not.toHaveBeenCalled();
  });
  it('records the round cap its capture wiring writes — huge tier only with a clock (#9256)', async () => {
    // plan-diff and capture-local pin this wiring in their own handlers; the
    // fetch-pr side had no assertion because this harness steers the lightest
    // real path (no merge base → no diff). Override the two mocks that steer
    // it into a real diff instead: a resolvable merge base and a raw diff
    // buffer. A handler that forgot the deadline read — or the capture-time
    // tier call — would keep every budget unit test green and this one red.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: 'beef0000',
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockReturnValue(
      Buffer.from(makeDiff('src/huge.ts', 9000)),
    );

    const before = process.env[DEADLINE_ENV];
    try {
      delete process.env[DEADLINE_ENV];
      producerMocks.writeFileSync.mockClear();
      const noClock = await reportFor({});
      expect(noClock.srcDiffLines).toBeGreaterThanOrEqual(3000);
      expect(noClock.budget.reverseAuditRounds).toBe(5);

      process.env[DEADLINE_ENV] = String(Math.floor(Date.now() / 1000) + 7200);
      producerMocks.writeFileSync.mockClear();
      const withClock = await reportFor({});
      expect(withClock.budget.reverseAuditRounds).toBe(3);
    } finally {
      if (before === undefined) delete process.env[DEADLINE_ENV];
      else process.env[DEADLINE_ENV] = before;
    }
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
        // Sanitized env: a delete must land in the repository the caller
        // named, not the one an exported `GIT_DIR` points at.
        expect.objectContaining({ stdio: 'pipe', env: expect.any(Object) }),
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

  it('does not inherit an extended-year forgery that sorts before today', async () => {
    // `'+275760-09-13…'` parses to the maximum Date yet sorts
    // lexicographically BEFORE any `'2026-…'` string — a string-compared
    // bound inherited exactly the far-future forgery it exists to reject,
    // and cleanup's `comments?since=<far future>` audit then returned
    // nothing. The bound compares numerically.
    producerMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        prNumber: '42',
        auditSince: '+275760-09-13T00:00:00.000Z',
        fetchedAt: '+275760-09-13T00:00:00.000Z',
      }),
    );
    const report = await reportFor({});
    expect(report.auditSince).toBe(report.fetchedAt);
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
   * ONE coherent history across TWO files, because narrowing is per FILE:
   *
   *   base   a.ts [line, line2, line3, ctx, ctx2]   b.ts [x, y]
   *   anchor a.ts + `added`                          b.ts + `y2`
   *   head   a.ts + 200 bulk lines                   b.ts unchanged since anchor
   *
   * The round touches only `a.ts`, so the published scope is `a.ts`'s section
   * ENTIRE — both hunks, including the one the anchor round already covered —
   * and `b.ts` is dropped. The saving is the untouched file; over-inclusion
   * inside a touched file is the deliberate price of never dropping a hunk
   * two independent Myers alignments place differently.
   */
  const FULL_DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line',
    '+added',
    ' line2',
    ' line3',
    '@@ -50,2 +51,202 @@',
    ' ctx',
    ...Array.from({ length: 200 }, (_, i) => `+bulk ${i}`),
    ' ctx2',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1,2 +1,2 @@',
    ' x',
    '+y2',
    '',
  ].join('\n');
  /** `anchor..head`: only `a.ts` changed since the anchor. */
  const DELTA_DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -51,2 +51,202 @@',
    ' ctx',
    ...Array.from({ length: 200 }, (_, i) => `+bulk ${i}`),
    ' ctx2',
    '',
  ].join('\n');
  /** `a.ts`'s section whole; `b.ts` gone. */
  const NARROWED = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line',
    '+added',
    ' line2',
    ' line3',
    '@@ -50,2 +51,202 @@',
    ' ctx',
    ...Array.from({ length: 200 }, (_, i) => `+bulk ${i}`),
    ' ctx2',
    '',
  ].join('\n');

  /**
   * The scope the default fixture yields: `a.ts` moved since the anchor, and
   * `b.ts` is a clean source file the widening weighed and passed over — it
   * imports nothing that changed.
   */
  const SCOPE_A = {
    anchor: ANCHOR,
    deltaFiles: ['a.ts'],
    interaction: [],
    contextFileCount: 1,
  };
  /** Anchor at the merge base: the delta is the full range, so both moved. */
  const SCOPE_AB = {
    anchor: BASE,
    deltaFiles: ['a.ts', 'b.ts'],
    interaction: [],
    contextFileCount: 0,
  };

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

  /**
   * The ORPHANED-anchor shape, the complement of `anchorIsValid`: the
   * anchor EXISTS and resolves to a commit, but every ancestry question
   * answers null (exit 1) — a rebased-away GitHub anchor, or an Aone head
   * orphaned by the AGit-Flow amend. One shape, so the tests that refuse
   * it on GitHub and the tests that scope it on Aone cannot drift apart.
   */
  function serveOrphanShape(): void {
    producerMocks.gitOpt.mockImplementation((...args: string[]) =>
      args[0] === 'cat-file' ? '' : args[0] === 'rev-parse' ? ANCHOR : null,
    );
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
  }

  it('pulls a still-clean importer of a changed file back into the scope', async () => {
    // The narrowing is sound in one direction only. `b.ts` has not changed
    // since the anchor, so the delta capture cannot show it and the narrowed
    // scope drops its section — but the round before cleared it against
    // `a.ts`'s OLD shape, and (b.ts@head × a.ts@head) is a pairing no round
    // has seen. Left out, that seam retires the moment the ledger certifies
    // this head as the next anchor.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.lstatSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return "import './a.js';\n";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const report = await reportFor({ since: ANCHOR });

    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      diffBase: BASE,
      scope: {
        anchor: ANCHOR,
        deltaFiles: ['a.ts'],
        interaction: [{ path: 'b.ts', importsChanged: ['a.ts'] }],
        contextFileCount: 0,
      },
    });
    // …and the widened file is PUBLISHED, carrying its own full-range hunks:
    // the plan naming it is worth nothing if no chunk holds its diff.
    expect(writtenDiff()).toContain('b/a.ts');
    expect(writtenDiff()).toContain('b/b.ts');
  });

  it('resolves the critical posture from the side file and seam-bounds the widening (#10104)', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.lstatSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // `b.ts` imports the changed file, but on lines its own single hunk
    // (new-side 1-2) does not display — the seam-bounded widening keeps the
    // file with none of its hunks.
    const B_SOURCE =
      '//x\n//y\nconst pad = 1;\n' +
      "import { added } from './a.js';\nadded();\n";
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return B_SOURCE;
      if (String(path).endsWith('qwen-review-pr-42-prev-ledger.json')) {
        // The previous posted round: round 7, so this round is 8 — past the
        // auto floor's round schedule.
        return JSON.stringify({
          round: 7,
          findings: [],
          posted: 1,
          floor: 'c',
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const report = await reportFor({ since: ANCHOR });

    expect(report.incremental.posture).toBe('critical');
    expect(report.incremental.postureCause).toBe('round');
    expect(report.incremental.scope.interaction).toEqual([
      { path: 'b.ts', importsChanged: ['a.ts'], seam: { kept: 0, total: 1 } },
    ]);
    // The file publishes header-only: still in scope (a chunk holds it, its
    // brief asks the seam question), none of its cleared hunks re-shown.
    const diff = writtenDiff() ?? '';
    expect(diff).toContain('diff --git a/b.ts b/b.ts');
    expect(diff).not.toContain('+y2');
    expect(diff).toContain('+added');
    // The recorded round cap prices the territory tier the posture flips to,
    // not the small tier the narrowed sizes would read.
    expect(report.budget.reverseAuditRounds).toBe(5);
  });

  it('drops a widening candidate whose real path leaves the worktree', async () => {
    // Wiring, not the rule itself — `worktree-reader.test.ts` proves the rule
    // against a real filesystem, where the kernel does the resolving. What
    // this pins is that `fetch-pr` reaches the worktree THROUGH the contained
    // reader: `lstat` spares only the final component, so an intermediate
    // symlink the PR planted keeps the path lexically inside while its real
    // location is outside, and what the reader returns is content-derived and
    // lands in `scope.interaction` in the published report.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.lstatSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // `b.ts` is reached through a symlinked ancestor: lexically inside,
    // really outside.
    producerMocks.realpathSync.mockImplementation((path?: unknown) =>
      String(path).endsWith('b.ts') ? '/elsewhere/victim.ts' : String(path),
    );
    // The edge EXISTS in the content this serves — only containment stops it.
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return "import './a.js';\n";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const report = await reportFor({ since: ANCHOR });

    const scope = (report.incremental as { scope: Record<string, unknown> })
      .scope;
    expect(scope['interaction']).toEqual([]);
    expect(writtenDiff()).not.toContain('b/b.ts');
  });

  it('treats an irregular worktree file as unreadable, never reading it', async () => {
    // The widening's reader is handed paths the PR itself names, so a planted
    // symlink or fifo reaches it. Opening a fifo blocks the synchronous read
    // forever, and a device like /dev/zero grows the buffer until SIGKILL —
    // neither throws, so the catch that frees the worktree lease never runs
    // and every later review of the PR hangs identically. The reader lstats
    // first: anything not a regular file is unreadable, contributes no edge,
    // and the round keeps the unwidened floor.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();
    producerMocks.lstatSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return { isFile: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // The edge b.ts -> a.ts EXISTS in the content this serves — a reader
    // that skipped the lstat gate would find it and publish the section.
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return "import './a.js';\n";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const report = await reportFor({ since: ANCHOR });

    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: true,
      diffBase: BASE,
      scope: {
        anchor: ANCHOR,
        deltaFiles: ['a.ts'],
        interaction: [],
        contextFileCount: 1,
      },
    });
    expect(writtenDiff()).toContain('b/a.ts');
    expect(writtenDiff()).not.toContain('b/b.ts');
    // The gate refused b.ts BEFORE any read: no readFileSync call asked for
    // it. A gateless mutant reads the served edge and the two assertions
    // above flip.
    expect(
      producerMocks.readFileSync.mock.calls.some((c) =>
        String(c[0]).endsWith('b.ts'),
      ),
    ).toBe(false);
  });

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
        baseRefOid: 'ba5e0f0ba5e0',
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
      scope: SCOPE_A,
      diffBase: BASE,
    });
    expect(report.diffPath).not.toBeNull();
    // The DISK payload, not just the report: a write unpaired from the text
    // the report describes hands every agent a diff whose chunks and
    // diffBase advertise something else — the same mismatch class as the
    // diffPath leak this PR shipped and fixed.
    expect(writtenDiff()).toBe(NARROWED);
    expect(report.diffPathAbsolute).toBe(resolve(report.diffPath as string));
    // …and the PLAN is the delta's, not the full range's: a re-plan over
    // fullText would pair a 200-line plan with an 8-line published diff.
    expect(report.diffLines).toBe(NARROWED.trimEnd().split('\n').length);
    const narrowedSrcDiffLines = buildDiffPlan(NARROWED).srcDiffLines;
    const fullSrcDiffLines = buildDiffPlan(FULL_DIFF).srcDiffLines;
    expect(fullSrcDiffLines).toBeGreaterThan(narrowedSrcDiffLines);
    expect(report.fullSrcDiffLines).toBe(fullSrcDiffLines);
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

  it('refuses an anchor another identity certified, before touching history', async () => {
    // "Clean up to this sha" is the recorded identity's verdict, and this
    // command validates an anchor against the HISTORY, never against who
    // certified it — so a cross-model anchor is ancestrally perfect and
    // still scopes the round past code it never reviewed.
    //
    // The gate lives here because every prompt-text version of it was wrong:
    // `{{model}}` interpolates the BARE `config.getModel()` while every
    // identity the CLI writes is provider-qualified, so two providers
    // exposing one model name passed each other's gate.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    servesBothRanges();

    // Same model NAME, different provider — the case the digest exists for.
    const other = await reportFor({
      since: ANCHOR,
      sinceModel: 'fixture-model@9f8e7d6c',
    });
    expect(other.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'cross-model-anchor',
    });
    // Refused before the history was consulted at all: no probe ran for it.
    expect(producerMocks.gitOpt.mock.calls).not.toContainEqual([
      'cat-file',
      '-e',
      ANCHOR,
    ]);
    // The round still reviews — the full range.
    expect(other.diffPath).not.toBeNull();

    // An anchor nobody certified (a cache written before the field) is a
    // mismatch, not a pass.
    expect(
      (await reportFor({ since: ANCHOR, sinceModel: undefined })).incremental,
    ).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'cross-model-anchor',
    });

    // …and the matching identity scopes, which is what makes the refusals
    // above about the gate rather than about the anchor.
    expect((await reportFor({ since: ANCHOR })).incremental).toEqual({
      since: ANCHOR,
      effective: true,
      scope: SCOPE_A,
      diffBase: BASE,
    });
  });

  it('takes the LAST value of a repeated --since, and expands an abbreviation', async () => {
    // Two findings in one round trip. yargs folds a repeated flag into an
    // array — the recovery flow produces one — and the array stringifies to
    // "shaA,shaB", which the hex gate refuses with zero git probes. And the
    // ruling must scope from what rev-parse RESOLVED, not from the string
    // that came in: the delta capture is keyed on the resolved sha, where
    // an abbreviation is ambiguous once the repo grows.
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
      scope: SCOPE_A,
      diffBase: BASE,
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
      reason: 'nothing-to-narrow',
    });
    // A base resolved from a possibly stale local ref cannot rule it — the
    // same fail-closed conjunct the text path has always had.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: true,
    });
    expect((await reportFor({ since: ANCHOR })).emptyDiff).toBeUndefined();
  });

  it('publishes the full section when the delta carries hunks the PR diff does not contain', async () => {
    // An "undo per feedback" commit reverts some of the previous round's
    // lines back to base content: those lines are changed in `anchor..head`
    // and unchanged in `base..head`. Ancestry cannot see it — the anchor is
    // a perfectly good ancestor — and the revert hunk is corroborated by no
    // full hunk, so the join fails closed and publishes the section whole.
    // The scope is assembled from the PR's own diff either way, so a
    // comment anchored on any hunk of it is a comment on a line GitHub's
    // PR diff displays.
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
      effective: true,
      scope: SCOPE_A,
      diffBase: BASE,
    });
    // The round reviews the PR's own diff — and the FILE agents read must
    // be that diff, never the delta: a publish left at capture time would
    // hand them hunks GitHub's PR diff does not display.
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    expect(writtenDiff()).toBe(NARROWED);
    // `a.ts`'s section ENTIRE — the revert's own hunks are absent because the
    // PR's diff never displays them, which is exactly why they are not
    // reviewable. `b.ts`, untouched this round, is what the narrowing drops.
    expect(writtenDiff()).not.toContain('b.ts');
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
    // What this pins beyond the reason: NOTHING was written. The only
    // wrongful write a fail-open producer can produce here is the delta it
    // did receive — a NARROWED cannot exist, because narrowing assembles
    // from the full capture, which threw.
    expect(writtenDiff()).toBeNull();
    expect(
      producerMocks.writeStderrLine.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('refused')),
    ).toContain('capture-failed');
  });

  it('narrows to nothing when the delta capture does not parse', async () => {
    // There is no oracle to be unavailable any more, so the old split between
    // "containment disproved" and "containment unruleable" is gone with it: a
    // delta the parser cannot read yields no ranges, nothing overlaps, and the
    // round keeps the full range under the one reason that names that.
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
      reason: 'nothing-to-narrow',
    });
    // …and the round still reviews the PR's own diff.
    expect(writtenDiff()).toBe(FULL_DIFF);
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

  it('splits a base-free round by WHY there is no base', async () => {
    // No base at all used to scope anyway, on the reasoning that the delta
    // range needs no base. The capture reasoning is right; the SCOPE
    // reasoning is not — with no PR diff there is nothing to narrow from.
    // But `mergeBaseSha === null` has two causes and only one is retryable,
    // which is the distinction SKILL.md's recovery paragraph already draws
    // and this pair holds the code to.
    //
    // The fetch FAILED: infrastructure, and the re-run re-runs the component
    // that failed, so the reason must be the retryable one.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: true,
    });
    servesBothRanges();
    const fetchFailed = await reportFor({ since: ANCHOR });
    expect(fetchFailed.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });

    // The fetch SUCCEEDED and `git merge-base` found no common ancestor — an
    // unrelated-history PR. Nothing threw, and a re-run reproduces it exactly,
    // so the reason is the deterministic one and the recovery flow must not
    // spend a re-run on it.
    vi.clearAllMocks();
    producerMocks.writeFileSync.mockImplementation(() => undefined);
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: false,
    });
    servesBothRanges();
    const noAncestor = await reportFor({ since: ANCHOR });
    expect(noAncestor.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'nothing-to-narrow',
    });

    // Either way nothing is published, which is what a base-free round does
    // ANYWAY: with no merge base there is no full range either, and the
    // command already tells agents to fall back to running `git diff`
    // themselves. The reason is what differs, and it is what the recovery
    // flow acts on.
    expect(fetchFailed.diffPath).toBeNull();
    expect(noAncestor.diffPath).toBeNull();
  });

  it('splits merge-base probe exits — only exit 1 is "no common ancestor"', async () => {
    // The probe folded every non-zero `git merge-base` exit onto the same
    // null, so the nothing-to-narrow arm stamped its deterministic reason
    // over exit-128 fatals and the 120s timeout kill. Only exit 1 is "no
    // common ancestor"; the rest are the surface, and they demote to the
    // retryable class instead.
    producerMocks.refExists.mockReturnValue(true);
    // Drive the seam the way the real resolveMergeBase does, so it is the
    // REAL probe's exit split — and its throw — that runs.
    producerMocks.resolveMergeBase.mockImplementation((...args: unknown[]) => {
      const probe = args[3] as {
        fetch: (remote: string, ref: string) => boolean;
        refExists: (ref: string) => boolean;
        mergeBase: (a: string, b: string) => string | null;
      };
      const baseFetchFailed = !probe.fetch('origin', 'main');
      const sha = probe.refExists('refs/remotes/origin/main')
        ? probe.mergeBase('refs/remotes/origin/main', 'refs/heads/feat/x')
        : null;
      return { sha, baseFetchFailed };
    });
    const drive = (mergeBase: {
      out: string | null;
      status: number | null;
    }) => {
      producerMocks.gitOpt.mockImplementation((...args: string[]) =>
        args[0] === 'fetch' ||
        args[0] === 'cat-file' ||
        args[0] === 'merge-base'
          ? ''
          : args[0] === 'rev-parse'
            ? ANCHOR
            : null,
      );
      producerMocks.gitExit.mockImplementation((...args: string[]) => {
        // Match the SUBCOMMAND, not argv[0]: the probe prefixes `-c`
        // config pins (`core.commitGraph=false`), so a predicate keyed on
        // the first argument silently stops matching when one is added —
        // and the mock then answers from the default mapping, which can
        // only produce exit 0 and exit 1, quietly turning a surface failure
        // into "no common ancestor".
        if (args.includes('merge-base') && !args.includes('--is-ancestor')) {
          return mergeBase;
        }
        const out = producerMocks.gitOpt(...args);
        return { out, status: out === null ? 1 : 0 };
      });
    };
    servesBothRanges();
    // Exit 128 (a fatal) and the timeout kill (a null status) are the
    // surface, not the history: the retryable reason, nothing published.
    for (const mergeBase of [
      { out: null, status: 128 },
      { out: null, status: null },
    ]) {
      drive(mergeBase);
      const report = await reportFor({ since: ANCHOR });
      expect(report.incremental).toEqual({
        since: ANCHOR,
        effective: false,
        reason: 'capture-failed',
      });
      expect(report.diffPath).toBeNull();
      expect(report.mergeBaseSha).toBeNull();
      expect(report.baseFetchFailed).toBe(false);
    }
    // Exit 1 alone is the deterministic member: no throw, the deterministic
    // reason, and the probe answers null.
    drive({ out: null, status: 1 });
    expect((await reportFor({ since: ANCHOR })).incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'nothing-to-narrow',
    });
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
      scope: SCOPE_AB,
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

  it("welds Agent 7's --base to the range the published scope came from", async () => {
    // The producer half of the producer→consumer seam, end to end: the REAL
    // report the handler writes carries `diffBase: BASE` on an effective
    // round, and the REAL brief builder welds `--base BASE`, never the
    // ANCHOR — welding the anchor would send the probe over a range carrying
    // hunks the PR's diff does not display (an undo round's reverted lines)
    // and report survivors no comment can anchor on. The consumer half —
    // reading `diffBase` at all, and the guards on it — is pinned where the
    // two sources are distinguishable: agent-prompt's suite hand-builds a
    // report whose `diffBase` differs from `mergeBaseSha` and fails a
    // consumer that stops reading it. This fixture cannot distinguish them,
    // because the producer writes the two equal by design.
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
      scope: SCOPE_A,
      diffBase: BASE,
    });
    // The REAL brief builder, over the REAL report the handler just wrote.
    // The probe block is gated on a PR number and a plan path — the shape
    // Agent 7 is actually launched with.
    const brief = buildRoleBrief(
      report as Parameters<typeof buildRoleBrief>[0],
      '7',
      { planPath: '/tmp/plan.json' },
    );
    expect(brief).toContain(`--base ${BASE}`);
    expect(brief).not.toContain(`--base ${ANCHOR}`);
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
        baseRefOid: 'ba5e0f0ba5e0',
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
      scope: SCOPE_A,
      diffBase: BASE,
    });
    expect(writtenDiff()).toBe(NARROWED);
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
    serveOrphanShape(); // not an ancestor
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
    // Every merge-base probe fails → not an ancestor.
    serveOrphanShape();
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
      if (text === NARROWED) throw new Error('chunks do not tile the diff');
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
      if (text === NARROWED) throw new Error('chunks do not tile the diff');
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
    // The base-free arm refuses BEFORE anything is partitioned, so the reason
    // names the earlier cause — and it is the deterministic one, because no
    // capture threw. That also makes the rescue's `fullText !== null` guard
    // unreachable from here: `scopedDelta` cannot be true without a base, so
    // it now implies a non-null `fullText`.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'nothing-to-narrow',
    });
  });

  it('names the partitioner, not the capture, when a REFUSED anchor ends planless', async () => {
    // The refusal reason and the planless cause are different facts. An
    // anchor refused on its own merits whose full range then fails to tile
    // keeps that reason — so a status line that infers the cause from the
    // reason announced "no diff could be captured" moments after the capture
    // succeeded and the partitioner warned, sending whoever diagnoses the
    // round at git and the network instead of at the partitioner.
    // `merge-base` answers null → exit 1 → the predicate's NO.
    serveOrphanShape();
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
        baseRefOid: 'ba5e0f0ba5e0',
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

  describe('the Aone incremental rule (AGit-Flow, D7, #9618)', () => {
    // An AGit-Flow update AMENDS the single CR commit in place: the new
    // head has the cached head's parent, never the cached head itself, so
    // the head test answers "no" for the cached anchor on EVERY update —
    // and the clamp too once the update also rebased onto newer master.
    // The Aone rule must not ask either — after the fetch both heads are
    // local, and `anchor..head` is the update's delta. Driven through the
    // real handler with the Aone reader: an explicit Aone `--host` selects
    // it, a mocked `a1` serves auth + MR view, and the git probes answer
    // the orphan shape (existence yes, ancestry exit 1).

    function serveAone(): void {
      producerMocks.execFileSync.mockImplementation(
        (cmd: string, args: string[]) => {
          if (cmd !== 'a1') return '';
          if (args[0] === 'repo' && args[1] === 'mr' && args[2] === 'view') {
            return JSON.stringify({
              mergeRequest: {
                sourceBranch: 'f00df00df00d',
                targetBranch: 'main',
                detailUrl:
                  'https://code.alibaba-inc.com/acme/widgets/codereview/42',
                description: '',
              },
            });
          }
          return ''; // `auth whoami`
        },
      );
      serveOrphanShape();
    }

    it('scopes an amend-orphaned anchor instead of refusing it', async () => {
      serveAone();
      const report = await reportFor({
        since: ANCHOR,
        host: 'gitlab.alibaba-inc.com',
      });
      expect(report.incremental).toEqual({
        since: ANCHOR,
        effective: true,
        scope: SCOPE_A,
        diffBase: BASE,
      });
      expect(report.diffPath).not.toBeNull();
      // The published scope is the PR's own diff narrowed to the amend's
      // delta — the untouched file is dropped, exactly as the GitHub
      // incremental path narrows.
      expect(writtenDiff()).toBe(NARROWED);
      // ...and the diff came from the Aone ref namespace, not GitHub's.
      expect(producerMocks.git.mock.calls).toContainEqual([
        'fetch',
        'origin',
        'refs/merge-requests/42/head:qwen-review/pr-42',
      ]);
    });

    it('never asks an ancestry question on the Aone platform', async () => {
      serveAone();
      await reportFor({ since: ANCHOR, host: 'gitlab.alibaba-inc.com' });
      const ancestryCalls = producerMocks.gitOpt.mock.calls.filter(
        (args) => args[0] === 'merge-base' && args[1] === '--is-ancestor',
      );
      // Neither the head test nor the clamp — a mutant re-asking either
      // would refuse this anchor (every answer is "no") but could survive
      // an outcome-only assertion, so pin the silence itself.
      expect(ancestryCalls).toEqual([]);
    });

    it('keeps the ancestry tests on GitHub — an orphaned anchor there is a force-push', async () => {
      // Same orphan shape, GitHub platform (no Aone host): the refusal
      // stands, because on a push-based platform an anchor the head does
      // not descend from is rewritten history, not an amend.
      serveOrphanShape();
      const report = await reportFor({ since: ANCHOR });
      expect(report.incremental).toEqual({
        since: ANCHOR,
        effective: false,
        reason: 'not-an-ancestor',
      });
      // The full range is the fallback.
      expect(writtenDiff()).toBe(FULL_DIFF);
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

  // ---- The AGit-Flow rule (design D7, #9618) ----------------------------
  // Under AGit-Flow an update AMENDS the single CR commit in place, so the
  // amended head has the cached head's parent, never the cached head itself
  // — the anchor-behind-head test refuses EVERY update's anchor (the clamp
  // fires only when the update also rebased). The Aone rule rules without
  // ancestry: after the fetch both heads are local, and their diff is the
  // update's delta.

  it('noAncestry scopes an orphaned anchor the ancestry test refuses', () => {
    // isAncestor answers "no" for everything — the exact amend shape. The
    // constant-false probe also kills the mutant that keeps asking: were
    // the test still consulted, its answer would refuse this anchor.
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ isAncestor: () => false }),
      null,
      { noAncestry: true },
    );
    expect(r.incremental).toEqual({ since: ANCHOR, effective: true });
    expect(r.diffBase).toBe(ANCHOR);
  });

  it('noAncestry asks NEITHER ancestry question — not the head test, not the clamp', () => {
    // A constant-false isAncestor passes with a dropped guard on either
    // check, so pin the ruling to silence: the merge base is present and
    // "older" than nothing an amend can reach — the clamp's exact trigger
    // after a rebase onto newer master.
    const asked: Array<[string, string]> = [];
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({
        isAncestor: (a, b) => {
          asked.push([a, b]);
          return false;
        },
      }),
      { sha: 'c'.repeat(40), fetchFailed: false },
      { noAncestry: true },
    );
    expect(r.incremental).toEqual({ since: ANCHOR, effective: true });
    expect(r.diffBase).toBe(ANCHOR);
    expect(asked).toEqual([]);
  });

  it('noAncestry keeps the existence refusals — a fresh clone cannot diff the orphan', () => {
    // The ancestry skip is about LINEAGE, not presence: an anchor the
    // object store does not hold (the round-1 fetch happened elsewhere)
    // has no delta to capture, and says so with the deterministic reason.
    const absent = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ commitExists: () => false, isAncestor: () => false }),
      null,
      { noAncestry: true },
    );
    expect(absent.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'unknown-commit',
    });
    expect(absent.diffBase).toBeNull();
    const unresolvable = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ resolveCommit: () => null, isAncestor: () => false }),
      null,
      { noAncestry: true },
    );
    expect(unresolvable.incremental.reason).toBe('unknown-commit');
  });

  it('noAncestry rules upToDate when the anchor IS the head', () => {
    // A re-run with no amend in between: the identity comparison is not an
    // ancestry test, so it rules exactly as on GitHub.
    const r = resolveIncrementalAnchor(HEAD, HEAD, probe(), null, {
      noAncestry: true,
    });
    expect(r.incremental).toEqual({
      since: HEAD,
      effective: true,
      upToDate: true,
    });
    expect(r.diffBase).toBeNull();
  });

  it('noAncestry still refuses a possibly-stale base — base-untrusted is not an ancestry test', () => {
    // The published scope is assembled from the base-derived full capture;
    // a base the run flagged possibly-stale is a capture no sibling guard
    // rules on, ancestry skip or not.
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({ isAncestor: () => false }),
      { sha: 'c'.repeat(40), fetchFailed: true },
      { noAncestry: true },
    );
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });
    expect(r.diffBase).toBeNull();
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

describe('computeDiffStats', () => {
  it('counts additions, deletions, and changed files off a unified diff', () => {
    const d = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      '-gone',
      '+added1',
      '+added2',
      ' ctx',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n');
    expect(computeDiffStats(d)).toEqual({
      additions: 3,
      deletions: 2,
      changedFiles: 2,
    });
  });

  it('returns zeros for an empty diff', () => {
    expect(computeDiffStats('')).toEqual({
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    });
  });

  it('counts changedFiles on `diff --git`, not on `---`/`+++` header lines', () => {
    // A binary file contributes a `diff --git` but NO `---`/`+++` headers, so
    // #diff--git (3) differs from #--- (2) — a mutation that counted `---`
    // lines would report 2 and stay green without this fixture.
    const d = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n');
    expect(computeDiffStats(d)).toEqual({
      additions: 2,
      deletions: 2,
      changedFiles: 3,
    });
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
        baseRefOid: 'ba5e0f0ba5e0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    // Self-containment: one test here matches a `resume` filter, and the
    // shared buildDiffPlan delegation is otherwise installed only by a
    // preceding describe's beforeEach — a filtered run of this suite alone
    // partitioned with an implementation-less mock and crashed the report.
    producerMocks.buildDiffPlan.mockImplementation((...a: unknown[]) =>
      producerMocks.actualBuildDiffPlan(...a),
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
        baseRefOid: 'ba5e0f0ba5e0',
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

// The plan payload a genuine capture of the resume fixtures' diff records:
// the ruling re-plans the re-derived bytes under this invocation's context
// and compares the report field for field, so the fixture must carry what a
// real fetch-pr wrote — built through the same functions, with the line
// count the gitRaw mock answers every `git show` with (the diff's own five
// lines).
function resumePlanFields(diffBytes: string): Record<string, unknown> {
  return buildPlanReport(buildDiffPlan(diffBytes, 400), () => 5, {
    operatorRoundCap: operatorReviewSettings().reverseAuditRounds,
    hasDeadline: hasReviewDeadline(process.env),
  }) as unknown as Record<string, unknown>;
}

describe('fetch-pr --resume', () => {
  const OUT = '/tmp/fetch-report.json';
  const DIFF_BYTES = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n+x\n';

  function prevReport(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      prNumber: '42',
      ownerRepo: 'acme/widgets',
      host: null,
      fetchedSha: 'f00df00df00d',
      diffSha256: createHash('sha256')
        .update(Buffer.from(DIFF_BYTES))
        .digest('hex'),
      worktreePath: '.qwen/tmp/review-pr-42',
      diffPathAbsolute: resolve(tmpFile('pr-42', 'diff.txt')),
      mergeBaseSha: 'baseb45eb45e',
      baseRefName: 'main',
      baseRefOid: 'ba5e0f0ba5e0',
      headRefName: 'feat/x',
      baseFetchFailed: false,
      auditSince: '2026-08-12T00:00:00.000Z',
      fetchedAt: '2026-08-13T00:00:00.000Z',
      prDescriptionHasHan: false,
      isCrossRepository: false,
      diffStat: { files: 1, additions: 1, deletions: 0 },
      ...resumePlanFields(DIFF_BYTES),
      ...over,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // The path-switched fs: the previous report and the diff exist; every
    // other read (resume marker, session ledger) is ENOENT.
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport();
      if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
        return Buffer.from(DIFF_BYTES) as unknown as string;
      }
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
        baseRefOid: 'ba5e0f0ba5e0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
        headRefOidOnly: undefined,
      }),
    );
    const { gitOpt, gitRaw } = await import('./lib/git.js');
    // `status --porcelain` → clean; `ls-files -v` → ordinary tags; the
    // identity probes agree on ONE repository; rev-parse → the fetched SHA.
    vi.mocked(gitOpt).mockImplementation((...args: string[]) => {
      if (args.includes('--others')) return '';
      if (args.includes('ls-tree')) return '';
      if (args.includes('config')) return '';
      if (args.includes('merge-base')) return 'baseb45eb45e';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return 'H f.txt';
      if (args.includes('--git-common-dir')) return '/repo/.git';
      if (args.includes('--git-dir')) {
        return '/repo/.git/worktrees/review-pr-42';
      }
      return 'f00df00df00d';
    });
    // The re-derivation terms: a resolvable merge-base and a `git diff`
    // whose bytes match the recorded capture.
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    vi.mocked(resolveMergeBase).mockImplementation(() => ({
      sha: 'baseb45eb45e',
      baseFetchFailed: false,
    }));
    vi.mocked(gitRaw).mockImplementation((...args: string[]) =>
      args.includes('ls-tree') || args.includes('cat-file')
        ? Buffer.from('')
        : Buffer.from(DIFF_BYTES),
    );
    // clearAllMocks resets call history but NOT implementations; re-assert
    // the ledger defaults so a mockReturnValue set by one test cannot leak
    // into the next — the same discipline the fs mock above follows.
    const {
      priorSessionIds,
      readResumeMarker,
      ledgerResumeCount,
      sessionEntryCount,
    } = await import('./lib/run-ledger.js');
    vi.mocked(priorSessionIds).mockImplementation(() => []);
    vi.mocked(ledgerResumeCount).mockImplementation(() => 0);
    vi.mocked(sessionEntryCount).mockImplementation(() => 1);
    vi.mocked(readResumeMarker).mockImplementation(() => ({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    }));
    // Self-containment: a filtered run of ONLY this suite never executes the
    // preceding describes' beforeEach, which is the only place the shared
    // buildDiffPlan delegation is installed — clearAllMocks does not
    // reinstall it. A refused resume falls through to the fresh path and
    // partitions the diff, so the suite owns the implementation it consumes.
    producerMocks.buildDiffPlan.mockImplementation((...a: unknown[]) =>
      producerMocks.actualBuildDiffPlan(...a),
    );
    // The cap's marker term excludes THIS session, so these tests need a
    // current session id for it to exclude. The lease gate (#9205) demands
    // BOTH ids before any step runs.
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'S-test');
    vi.stubEnv('QWEN_CODE_PROMPT_ID', 'P-test');
  });

  async function run(extraArgs: Record<string, unknown> = {}) {
    const handler = fetchPrCommand.handler;
    if (!handler) throw new Error('fetch-pr handler missing');
    await handler({
      _: [],
      $0: 'qwen',
      pr_number: '42',
      owner_repo: 'acme/widgets',
      remote: 'origin',
      out: OUT,
      maxChunkLines: 400,
      resume: true,
      ...extraArgs,
    } as unknown as Parameters<typeof handler>[0]);
  }

  function reportWritten(): boolean {
    return producerMocks.writeFileSync.mock.calls.some(
      ([path]) => path === OUT,
    );
  }

  async function stdoutJsonLines(): Promise<Array<Record<string, unknown>>> {
    const { writeStdoutLine } = await import('../../utils/stdioHelpers.js');
    return vi
      .mocked(writeStdoutLine)
      .mock.calls.map((c) => String(c[0]))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('resumes without touching the report when every probe matches', async () => {
    await run();
    expect(reportWritten()).toBe(false);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      {
        resumed: true,
        resumeAttempt: 1,
        restartsSpent: 0,
        effort: 'high',
        out: OUT,
      },
    ]);
    const { recordResume, appendRunSession } = await import(
      './lib/run-ledger.js'
    );
    expect(vi.mocked(recordResume)).toHaveBeenCalledWith(OUT);
    expect(vi.mocked(appendRunSession)).toHaveBeenCalledWith(OUT);
  });

  it('falls through to a fresh fetch when the head moved, and says so', async () => {
    producerMocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('headRefOid') && !args.includes('headRefName')) {
        return JSON.stringify({ headRefOid: 'aaaa1111bbbb' });
      }
      return JSON.stringify({
        headRefName: 'feat/x',
        headRefOid: 'aaaa1111bbbb',
        baseRefName: 'main',
        baseRefOid: 'ba5e0f0ba5e0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      });
    });
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([{ resumed: false, resumeRefused: 'head-moved' }]);
    // The once-per-review restart bound becomes a fact on disk here.
    const { recordRestart } = await import('./lib/run-ledger.js');
    expect(vi.mocked(recordRestart)).toHaveBeenCalledWith(
      OUT,
      expect.stringContaining('head-moved'),
    );
  });

  it('falls through when the diff bytes changed — the content key', async () => {
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport();
      if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
        return Buffer.from('tampered') as unknown as string;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      { resumed: false, resumeRefused: 'diff-hash-mismatch' },
    ]);
  });

  it('falls through when there is no previous report at all', async () => {
    producerMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([{ resumed: false, resumeRefused: 'no-report' }]);
  });

  it('without --resume the flag path never runs', async () => {
    await run({ resume: false });
    expect(reportWritten()).toBe(true);
    expect(await stdoutJsonLines()).toEqual([]);
  });

  it('surfaces the recorded restart count to the resumed session', async () => {
    const { readResumeMarker } = await import('./lib/run-ledger.js');
    vi.mocked(readResumeMarker).mockReturnValue({
      schemaVersion: 1,
      resumes: [],
      restarts: [{ atMs: Date.now(), reason: 'head-moved aaa->bbb' }],
    });
    await run();
    const lines = await stdoutJsonLines();
    expect(lines[0]['restartsSpent']).toBe(1);
  });

  it('cross-caps the resume count on the session ledger — a deleted marker does not reset it', async () => {
    // Marker reads empty (deleted), but the ledger names three sessions:
    // the original plus two resumes — two entries past the original, so the
    // cap must read as spent.
    // Read UNGATED: the gated accessor cannot answer at ruling time, because
    // the record that satisfies its gate is written only after the ruling.
    const { ledgerResumeCount } = await import('./lib/run-ledger.js');
    // The ruling passes the CURRENT session for exclusion; a deleted-marker
    // attack arrives as a session the ledger does not name, so nothing is
    // excluded and the full count bites.
    vi.mocked(ledgerResumeCount).mockImplementation(() => 2);
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([{ resumed: false, resumeRefused: 'resume-cap' }]);
  });

  it('refuses the ORIGINAL session at the cap on the backstop path', async () => {
    // Ledger [S0 (original), S1, S2], marker deleted — the exact backstop
    // state the ledger term exists for — and S0 itself resumes again. The
    // exclusion already removed S0's entry, so the count answers 2; the old
    // unconditional minus one read 1 and admitted a third resume through
    // the cap's own backstop.
    const { ledgerResumeCount } = await import('./lib/run-ledger.js');
    vi.mocked(ledgerResumeCount).mockImplementation(() => 2);
    await run();
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([{ resumed: false, resumeRefused: 'resume-cap' }]);
  });

  it('spends the resume budget from the ledger, not one early', async () => {
    // The ledger's first entry is the original run's own session, not a
    // resume — so [original, resume1] is ONE resume spent, and RESUME_MAX = 2
    // still allows this one. Counting the first entry reads it as two and
    // refuses a legitimate continuation; the three-session case cannot see
    // the difference, because there both counts rule alike.
    const { ledgerResumeCount } = await import('./lib/run-ledger.js');
    vi.mocked(ledgerResumeCount).mockImplementation(() => 1);
    await run();
    const lines = await stdoutJsonLines();
    expect(lines[0]).toMatchObject({ resumed: true });
  });

  it('a same-session retry at the cap is the SAME resume in both terms', async () => {
    // Sessions S0/S1/S2 all inside the fence (a resume never rewrites the
    // plan), marker [S1, S2], current session S2 retrying: the ledger term
    // must exclude S2 too — counting it pushed the retry to the cap, and
    // the fresh fall-through force-removed the worktree being resumed.
    const { readResumeMarker, ledgerResumeCount } = await import(
      './lib/run-ledger.js'
    );
    vi.mocked(ledgerResumeCount).mockImplementation((_p, opts) =>
      opts?.excludeSessionId?.toLowerCase() === 's-test' ? 1 : 2,
    );
    vi.mocked(readResumeMarker).mockReturnValue({
      schemaVersion: 1,
      resumes: [
        { sessionId: 'S-prev', atMs: Date.now() },
        { sessionId: 'S-test', atMs: Date.now() },
      ],
      restarts: [],
    });
    await run();
    const lines = await stdoutJsonLines();
    expect(lines[0]).toMatchObject({ resumed: true });
  });

  it('does not count the CURRENT session against its own resume cap', async () => {
    // A same-session retry of the last permitted resume is that same resume —
    // `recordResume` dedupes on exactly this. Counting the session's own
    // marker entry refused the retry as `resume-cap`, and the fall-through
    // then force-removed the worktree and rewrote the plan, fencing out every
    // attempt's evidence: a review restarted from zero by a retry.
    const { readResumeMarker } = await import('./lib/run-ledger.js');
    vi.mocked(readResumeMarker).mockReturnValue({
      schemaVersion: 1,
      resumes: [
        { sessionId: 'S-prev', atMs: Date.now() },
        { sessionId: 'S-test', atMs: Date.now() },
      ],
      restarts: [],
    });
    await run();
    const lines = await stdoutJsonLines();
    expect(lines[0]).toMatchObject({ resumed: true });
  });

  it('asks git for untracked files EXPLICITLY, immune to user config', async () => {
    // `status.showUntrackedFiles=no` hides untracked residue from a bare
    // `--porcelain`, and untracked files are the one dirty state no other
    // probe can see.
    await run();
    const { gitOpt } = await import('./lib/git.js');
    const statusCall = vi
      .mocked(gitOpt)
      .mock.calls.find((c) => c.includes('status') && c.includes('-C'));
    expect(statusCall).toContain('--untracked-files=normal');
  });

  it('refuses on an explicit effort different from the recorded run', async () => {
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport({ effort: 'medium' });
      if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
        return Buffer.from(DIFF_BYTES) as unknown as string;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await run({ effort: 'high' });
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      { resumed: false, resumeRefused: 'effort-mismatch' },
    ]);
  });

  it('resumes at the recorded effort when none is passed, and says so', async () => {
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport({ effort: 'medium' });
      if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
        return Buffer.from(DIFF_BYTES) as unknown as string;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await run();
    const lines = await stdoutJsonLines();
    expect(lines[0]['resumed']).toBe(true);
    expect(lines[0]['effort']).toBe('medium');
  });

  it('falls through when the worktree holds uncommitted changes', async () => {
    // Right HEAD, right diff bytes, moved content: this pipeline's own probe
    // and build/test agents mutate worktrees, and a death between an apply
    // and its revert leaves exactly this.
    const { gitOpt } = await import('./lib/git.js');
    vi.mocked(gitOpt).mockImplementation((...args: string[]) => {
      if (args.includes('--others')) return '';
      if (args.includes('ls-tree')) return '';
      if (args.includes('config')) return '';
      if (args.includes('merge-base')) return 'baseb45eb45e';
      if (args.includes('status')) return ' M packages/cli/src/x.ts';
      if (args.includes('ls-files')) return 'H f.txt';
      if (args.includes('--git-common-dir')) return '/repo/.git';
      if (args.includes('--git-dir')) {
        return '/repo/.git/worktrees/review-pr-42';
      }
      return 'f00df00df00d';
    });
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      { resumed: false, resumeRefused: 'worktree-dirty' },
    ]);
  });

  it('falls through when the captured diff is gone', async () => {
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await run();
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      { resumed: false, resumeRefused: 'diff-unreadable' },
    ]);
  });

  it('falls through when the worktree is not at the fetched SHA', async () => {
    const { gitOpt } = await import('./lib/git.js');
    vi.mocked(gitOpt).mockImplementation((...args: string[]) => {
      if (args.includes('--others')) return '';
      if (args.includes('ls-tree')) return '';
      if (args.includes('config')) return '';
      if (args.includes('merge-base')) return 'baseb45eb45e';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return 'H f.txt';
      if (args.includes('--git-common-dir')) return '/repo/.git';
      if (args.includes('--git-dir')) {
        return '/repo/.git/worktrees/review-pr-42';
      }
      return 'someothersha';
    });
    await run();
    expect(reportWritten()).toBe(true);
    const lines = await stdoutJsonLines();
    expect(lines).toEqual([
      { resumed: false, resumeRefused: 'worktree-sha-mismatch' },
    ]);
  });

  // -- The report is attempt-1-writable: every field the resumed pipeline
  // -- consumes is compared against a fact this run derives itself. Each
  // -- test forges ONE field and expects the refusal that names it.

  it('does NOT refuse ordinary ignored build artifacts — node_modules is expected', async () => {
    // The residue probe respects `.gitignore` (`--exclude-standard`): a
    // resume after `npm install` left node_modules must not read as tamper.
    const { gitOpt } = await import('./lib/git.js');
    vi.mocked(gitOpt).mockImplementation((...args: string[]) => {
      // The unexcluded pathspec listing (planted .gitignore probe) and the
      // exclude-standard residue listing both come back empty; node_modules
      // is ignored, so exclude-standard omits it.
      if (args.includes('--others')) return '';
      if (args.includes('ls-tree')) return '';
      if (args.includes('config')) return '';
      if (args.includes('merge-base')) return 'baseb45eb45e';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return 'H f.txt';
      if (args.includes('--git-common-dir')) return '/repo/.git';
      if (args.includes('--git-dir')) {
        return '/repo/.git/worktrees/review-pr-42';
      }
      return 'f00df00df00d';
    });
    await run();
    expect(reportWritten()).toBe(false);
    expect(await stdoutJsonLines()).toEqual([
      {
        resumed: true,
        resumeAttempt: 1,
        restartsSpent: 0,
        effort: 'high',
        out: OUT,
      },
    ]);
  });

  it('keeps a round-cap stop and its stamps on a continuation', async () => {
    // A round-cap stop is the trusted CLI's own record that the audit reached
    // its round cap — not a stale time-budget stop — so the continuation
    // keeps it and the stamps that price its rounds rather than clearing them.
    const { readBudgetStop, clearBudgetStop, clearRoundStamps } = await import(
      './lib/deadline.js'
    );
    vi.mocked(readBudgetStop).mockReturnValue({
      cause: 'round-cap',
      cap: 5,
      entry: 'round cap',
      entryZh: '轮数上限',
      round: 5,
      remainingSeconds: 0,
      reserveSeconds: 0,
      atMs: Date.now(),
    });
    await run();
    expect(vi.mocked(clearBudgetStop)).not.toHaveBeenCalled();
    expect(vi.mocked(clearRoundStamps)).not.toHaveBeenCalled();
  });
});

describe('fetch-pr --resume bookkeeping is counted, not merely called', () => {
  // The deadline helpers derive the record dir through resolve(OUT), so OUT
  // must be a native absolute path: a POSIX literal gains a drive letter and
  // backslashes on Windows, the disk-routing mock below stops matching, and
  // /tmp also maps to an unwritable drive root there.
  const OUT = join(tmpdir(), 'fetch-report.json');
  const DIFF_BYTES = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n+x\n';

  function prevReport(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      prNumber: '42',
      ownerRepo: 'acme/widgets',
      host: null,
      fetchedSha: 'f00df00df00d',
      diffSha256: createHash('sha256')
        .update(Buffer.from(DIFF_BYTES))
        .digest('hex'),
      worktreePath: '.qwen/tmp/review-pr-42',
      diffPathAbsolute: resolve(tmpFile('pr-42', 'diff.txt')),
      mergeBaseSha: 'baseb45eb45e',
      baseRefName: 'main',
      baseRefOid: 'ba5e0f0ba5e0',
      headRefName: 'feat/x',
      baseFetchFailed: false,
      auditSince: '2026-08-12T00:00:00.000Z',
      fetchedAt: '2026-08-13T00:00:00.000Z',
      prDescriptionHasHan: false,
      isCrossRepository: false,
      diffStat: { files: 1, additions: 1, deletions: 0 },
      ...resumePlanFields(DIFF_BYTES),
      ...over,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (path === OUT) return prevReport();
      if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
        return Buffer.from(DIFF_BYTES) as unknown as string;
      }
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
        baseRefOid: 'ba5e0f0ba5e0',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        isCrossRepository: false,
        body: '',
      }),
    );
    const { gitOpt } = await import('./lib/git.js');
    // `status --porcelain` → clean; `ls-files -v` → ordinary tags; the
    // identity probes agree on ONE repository; rev-parse → the fetched SHA.
    vi.mocked(gitOpt).mockImplementation((...args: string[]) => {
      if (args.includes('--others')) return '';
      if (args.includes('ls-tree')) return '';
      if (args.includes('config')) return '';
      if (args.includes('merge-base')) return 'baseb45eb45e';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return 'H f.txt';
      if (args.includes('--git-common-dir')) return '/repo/.git';
      if (args.includes('--git-dir')) {
        return '/repo/.git/worktrees/review-pr-42';
      }
      return 'f00df00df00d';
    });
    const {
      priorSessionIds,
      readResumeMarker,
      ledgerResumeCount,
      sessionEntryCount,
    } = await import('./lib/run-ledger.js');
    vi.mocked(priorSessionIds).mockImplementation(() => []);
    vi.mocked(ledgerResumeCount).mockImplementation(() => 0);
    vi.mocked(sessionEntryCount).mockImplementation(() => 1);
    vi.mocked(readResumeMarker).mockImplementation(() => ({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    }));
    // Self-containment, the same reason as the first resume suite: these
    // re-derivation probes and the partitioner are installed only by
    // preceding describes' beforeEach in a full-file run; a filtered run of
    // this suite must install them itself.
    const { resolveMergeBase } = await import('./lib/merge-base.js');
    vi.mocked(resolveMergeBase).mockImplementation(() => ({
      sha: 'baseb45eb45e',
      baseFetchFailed: false,
    }));
    const { gitRaw } = await import('./lib/git.js');
    vi.mocked(gitRaw).mockImplementation((...args: string[]) =>
      args.includes('ls-tree') || args.includes('cat-file')
        ? Buffer.from('')
        : Buffer.from(DIFF_BYTES),
    );
    producerMocks.buildDiffPlan.mockImplementation((...a: unknown[]) =>
      producerMocks.actualBuildDiffPlan(...a),
    );
    // The cap's marker term excludes THIS session, so these tests need a
    // current session id for it to exclude. The lease gate (#9205) demands
    // BOTH ids before any step runs.
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'S-test');
    vi.stubEnv('QWEN_CODE_PROMPT_ID', 'P-test');
  });

  async function run(extra: Record<string, unknown> = {}) {
    const handler = fetchPrCommand.handler;
    if (!handler) throw new Error('fetch-pr handler missing');
    await handler({
      _: [],
      $0: 'qwen',
      pr_number: '42',
      owner_repo: 'acme/widgets',
      remote: 'origin',
      out: OUT,
      maxChunkLines: 400,
      resume: true,
      ...extra,
    } as unknown as Parameters<typeof handler>[0]);
  }

  it('writes the resume bookkeeping exactly once, and only on a continuation', async () => {
    const { appendRunSession, recordResume, recordRestart } = await import(
      './lib/run-ledger.js'
    );
    await run();
    expect(vi.mocked(recordResume)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendRunSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRestart)).not.toHaveBeenCalled();
  });

  it('records nothing when the resume is refused', async () => {
    // Hoisting the bookkeeping above the ruling shipped green before this.
    const { recordResume } = await import('./lib/run-ledger.js');
    const { gitOpt } = await import('./lib/git.js');
    vi.mocked(gitOpt).mockImplementation((...args: string[]) =>
      args.includes('status') ? '' : 'someothersha',
    );
    await run();
    expect(vi.mocked(recordResume)).not.toHaveBeenCalled();
  });

  it('records a restart ONLY for head movement, not for any refusal', async () => {
    const { recordRestart } = await import('./lib/run-ledger.js');
    const { gitOpt } = await import('./lib/git.js');
    vi.mocked(gitOpt).mockImplementation((...args: string[]) =>
      args.includes('status') ? ' M src/x.ts' : 'f00df00df00d',
    );
    await run();
    expect(vi.mocked(recordRestart)).not.toHaveBeenCalled();
  });

  it('honours the marker term of the cap independently of the ledger', async () => {
    const { readResumeMarker } = await import('./lib/run-ledger.js');
    vi.mocked(readResumeMarker).mockReturnValue({
      schemaVersion: 1,
      resumes: [
        { sessionId: 'A', atMs: 1 },
        { sessionId: 'B', atMs: 2 },
      ],
      restarts: [],
    });
    await run();
    const { writeStdoutLine } = await import('../../utils/stdioHelpers.js');
    const lines = vi
      .mocked(writeStdoutLine)
      .mock.calls.map((c) => String(c[0]))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([{ resumed: false, resumeRefused: 'resume-cap' }]);
  });

  it('numbers the attempt from the marker AFTER the write', async () => {
    // recordResume deduplicates by session, so a second --resume in the same
    // session is the same resume — not attempt 2.
    const { readResumeMarker } = await import('./lib/run-ledger.js');
    vi.mocked(readResumeMarker).mockReturnValue({
      schemaVersion: 1,
      resumes: [{ sessionId: 'S-current', atMs: 1 }],
      restarts: [],
    });
    await run();
    const { writeStdoutLine } = await import('../../utils/stdioHelpers.js');
    const line = JSON.parse(
      vi
        .mocked(writeStdoutLine)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.startsWith('{'))[0],
    ) as Record<string, unknown>;
    expect(line['resumeAttempt']).toBe(1);
  });

  it('runs the budget hygiene on a continuation, and only there', async () => {
    const { clearRoundStamps, clearBudgetStop, readBudgetStop } = await import(
      './lib/deadline.js'
    );
    vi.mocked(readBudgetStop).mockReturnValue({
      cause: 'time-budget',
      entry: 'stopped',
      entryZh: '停止',
      round: 3,
      remainingSeconds: 10,
      reserveSeconds: 4800,
      atMs: Date.now(),
    });
    await run();
    expect(vi.mocked(clearRoundStamps)).toHaveBeenCalledWith(OUT);
    expect(vi.mocked(clearBudgetStop)).toHaveBeenCalledWith(OUT);
  });

  it('keeps a round-cap stop across the resume', async () => {
    // A round-cap stop is about rounds, not time — it is the interrupted
    // attempt's genuine record that the audit reached its cap, so it survives
    // the continuation untouched.
    const { clearBudgetStop, readBudgetStop } = await import(
      './lib/deadline.js'
    );
    vi.mocked(readBudgetStop).mockReturnValue({
      cause: 'round-cap',
      cap: 5,
      entry: 'round cap',
      entryZh: '轮数上限',
      round: 5,
      remainingSeconds: 900,
      reserveSeconds: 1200,
      atMs: Date.now(),
    });
    await run();
    expect(vi.mocked(clearBudgetStop)).not.toHaveBeenCalled();
  });

  it('keeps a round-cap stop AND its stamps across TWO resumes', async () => {
    // Real stamp files: a round-cap stop and the stamps that price its rounds
    // must both survive every resume, or resume 2 reads an empty set and
    // silently reprices the exhausted cap — the exact population RESUME_MAX
    // exists for.
    const actualDeadline =
      await vi.importActual<typeof import('./lib/deadline.js')>(
        './lib/deadline.js',
      );
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const recordDir = `${OUT.replace(/\.json$/, '')}-prompts`;
    const routeRecordDirToDisk = (): void => {
      producerMocks.readFileSync.mockImplementation((path?: unknown) => {
        if (String(path).startsWith(recordDir)) {
          return realFs.readFileSync(String(path), 'utf8');
        }
        if (path === OUT) return prevReport();
        if (String(path).endsWith('qwen-review-pr-42-diff.txt')) {
          return Buffer.from(DIFF_BYTES) as unknown as string;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      producerMocks.writeFileSync.mockImplementation(
        (path: unknown, data: unknown) => {
          if (String(path).startsWith(recordDir)) {
            realFs.writeFileSync(String(path), String(data));
          }
        },
      );
      producerMocks.mkdirSync.mockImplementation((dir: unknown) => {
        if (String(dir).startsWith(recordDir)) {
          realFs.mkdirSync(String(dir), { recursive: true });
        }
      });
    };
    const { readBudgetStop, clearBudgetStop, clearRoundStamps } = await import(
      './lib/deadline.js'
    );
    try {
      routeRecordDirToDisk();
      vi.mocked(readBudgetStop).mockImplementation(() =>
        actualDeadline.readBudgetStop(OUT),
      );
      vi.mocked(clearBudgetStop).mockImplementation(() =>
        actualDeadline.clearBudgetStop(OUT),
      );
      vi.mocked(clearRoundStamps).mockImplementation(() =>
        actualDeadline.clearRoundStamps(OUT),
      );
      // Attempt 1 exhausted the round cap: stamps 1..2 and the stop marker.
      const now = Date.now();
      actualDeadline.stampRound(OUT, 1, now);
      actualDeadline.stampRound(OUT, 2, now + 1000);
      actualDeadline.writeRoundCapStop(OUT, 2, 2, now + 2000);

      await run();
      const stampsFile = join(recordDir, 'budget-rounds.json');
      // Resume 1 kept the stop — and the stamps that price its rounds.
      expect(actualDeadline.readBudgetStop(OUT)).not.toBeNull();
      expect(realFs.existsSync(stampsFile)).toBe(true);

      // The resumed run dies again — the exact population RESUME_MAX exists
      // for — and resume 2 re-reads the same state.
      await run();
      expect(vi.mocked(clearBudgetStop)).not.toHaveBeenCalled();
      expect(actualDeadline.readBudgetStop(OUT)).not.toBeNull();

      const { writeStdoutLine } = await import('../../utils/stdioHelpers.js');
      const lines = vi
        .mocked(writeStdoutLine)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([
        {
          resumed: true,
          resumeAttempt: 1,
          restartsSpent: 0,
          effort: 'high',
          out: OUT,
        },
        {
          resumed: true,
          resumeAttempt: 1,
          restartsSpent: 0,
          effort: 'high',
          out: OUT,
        },
      ]);
    } finally {
      realFs.rmSync(recordDir, { recursive: true, force: true });
    }
  });
});
