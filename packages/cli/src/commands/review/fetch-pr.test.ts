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
  resolveIncrementalAnchor,
  type AnchorProbe,
} from './fetch-pr.js';
import { classifyHeavy } from './lib/heavy.js';
import { PARSE_ARGS_REPORT } from './lib/paths.js';

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
    default: { ...actual, execFileSync: vi.fn() },
    execFileSync: vi.fn(),
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
  createReviewWorktreeLease: vi.fn(),
}));

vi.mock('./lib/gh.js', () => ({
  ensureAuthenticated: vi.fn(),
  gh: producerMocks.gh,
  setGhHost: vi.fn(),
}));

vi.mock('./lib/git.js', () => ({
  git: producerMocks.git,
  gitOpt: producerMocks.gitOpt,
  gitRaw: producerMocks.gitRaw,
  refExists: vi.fn(() => false),
  releaseWorktree: vi.fn(() => ({ existed: false, freed: true })),
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
  const DELTA_DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,3 @@',
    ' line',
    '+added',
    ' line2',
    '',
  ].join('\n');

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
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${ANCHOR}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    // Advertised stat large enough that an ungated collapse ratio WOULD fire
    // on the tiny delta: the flag's absence below is what kills the mutant
    // that drops the !scopedDelta gate.
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
    expect(report.emptyDiff).toBeUndefined();
    expect(report.collapsedFromUpstream).toBeUndefined();
    // The probe wiring, pinned by invocation shape: a transposed
    // --is-ancestor operand pair would refuse every valid anchor while every
    // content-agnostic mock stayed green (measured by the review's mutant).
    const gitOptCalls = producerMocks.gitOpt.mock.calls;
    expect(gitOptCalls).toContainEqual([
      'cat-file',
      '-e',
      `${ANCHOR}^{commit}`,
    ]);
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

  it('demotes a delta whose partition failed — no incremental claim over a planless report', async () => {
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${ANCHOR}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).toBeNull();
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
    // The demoted state must not resurrect the full-range flags over the
    // delta text either.
    expect(report.collapsedFromUpstream).toBeUndefined();
  });

  it('demotes to capture-failed when the delta capture throws', async () => {
    anchorIsValid();
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes('diff')) throw new Error('git timed out');
      return Buffer.from('');
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'capture-failed',
    });
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
    // recommended a LIVE PR for closure. The reset before the fallback and
    // the upToDate demotion are both pinned here.
    anchorIsValid();
    producerMocks.gitRaw.mockImplementation(() => Buffer.from(''));
    const report = await reportFor({ since: ANCHOR });
    expect(report.emptyDiff).toBeUndefined();
    expect(report.diffPath).toBeNull();
    // upToDate without the full-range plan would overclaim; it demotes —
    // under its own reason, because unlike every other refusal there is NO
    // diff or plan to fall back to, and the stderr line must not claim one.
    expect(report.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'full-range-unavailable',
    });
    const refusedLine = producerMocks.writeStderrLine.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('refused'));
    expect(refusedLine).toContain('no diff could be captured');
    expect(refusedLine).not.toContain('reviewing the full diff');
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

  it('clamps an anchor older than the merge base — wider than the PR is not incremental', () => {
    const MERGE_BASE = 'c'.repeat(40);
    // The anchor is behind the head, but the merge base is NOT behind the
    // anchor: scoping anchor..head would include base history the PR's own
    // diff does not contain.
    const r = resolveIncrementalAnchor(
      ANCHOR,
      HEAD,
      probe({
        isAncestor: (a) => a !== MERGE_BASE,
      }),
      MERGE_BASE,
    );
    expect(r.incremental).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'behind-merge-base',
    });
    expect(r.diffBase).toBeNull();
    // With the base behind the anchor the clamp passes and the scope stands.
    expect(
      resolveIncrementalAnchor(ANCHOR, HEAD, probe(), MERGE_BASE).diffBase,
    ).toBe(ANCHOR);
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
    ]) {
      let probed = false;
      const r = resolveIncrementalAnchor(bad, HEAD, {
        commitExists: () => ((probed = true), true),
        isAncestor: () => ((probed = true), true),
        resolveCommit: () => ((probed = true), HEAD),
      });
      expect(probed).toBe(false);
      expect(r.incremental).toEqual({
        since: bad,
        effective: false,
        reason: 'unknown-commit',
      });
    }
  });

  it('treats an anchor rev-parse cannot name as unknown, not as a full-range effective', () => {
    // effective:true over a full-range diff would misstate the report's scope.
    const r = resolveIncrementalAnchor(ANCHOR, HEAD, {
      ...probe(),
      resolveCommit: () => null,
    });
    expect(r.incremental.effective).toBe(false);
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

describe('fetch-pr diff identity (diffSha256)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  beforeEach(async () => {
    vi.clearAllMocks();
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
