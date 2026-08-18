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
import { DEADLINE_ENV } from './lib/deadline.js';
import type { MergeBaseResult } from './lib/merge-base.js';
import { buildRoleBrief } from './agent-prompt.js';
import { PARSE_ARGS_REPORT, worktreePath } from './lib/paths.js';
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
  writeFileSync: vi.fn(),
  readFileSync: vi.fn((_path?: unknown): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  gh: vi.fn(),
  git: vi.fn(),
  execFileSync: vi.fn(),
  refExists: vi.fn((..._refs: unknown[]): boolean => false),
  releaseWorktree: vi.fn(() => ({ existed: false, freed: true })),
  gitOpt: vi.fn((..._args: string[]): string | null => null),
  gitRaw: vi.fn((..._args: string[]): Buffer => Buffer.from('')),
  resolveMergeBase: vi.fn(
    (..._args: unknown[]): MergeBaseResult => ({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: false,
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
  // Moved out of fetch-pr.ts into lib/git.ts (it is `rescope`'s too now), so
  // the mock owes it an export. Expressed over the same `gitRaw` fixture the
  // real one reads, rather than a constant: a report's line counts decide
  // heaviness, and a stub returning 0 everywhere would make every plan light.
  fileLineCount: (ref: string, path: string) => {
    try {
      const buf = producerMocks.gitRaw('show', `${ref}:${path}`);
      if (!buf || buf.length === 0) return 0;
      let n = 0;
      for (const b of buf) if (b === 0x0a) n++;
      return buf[buf.length - 1] === 0x0a ? n : n + 1;
    } catch {
      return 0;
    }
  },
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

/**
 * The anchor RULING, without the scope it produced.
 *
 * `incremental` answers two questions in one object: MAY this anchor scope the
 * round (`since`/`effective`/`reason`/`upToDate`/`diffBase`), and — when it
 * may — WHICH files it scoped to (`scope`, `fullDiffPath`). Nearly every
 * assertion below is about the first, and folding the second into their exact
 * shapes would make each of them fail on any change to the widening. The
 * scope has its own tests.
 */
function ruling(report: { incremental?: unknown }): Record<string, unknown> {
  const {
    scope: _scope,
    fullDiffPath: _fullDiffPath,
    ...rest
  } = (report.incremental ?? {}) as Record<string, unknown>;
  return rest;
}

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
    producerMocks.refExists.mockReturnValue(false);
    producerMocks.git.mockImplementation((...args: string[]) =>
      args[0] === 'rev-parse' ? 'f00df00df00d' : '',
    );
    producerMocks.gitOpt.mockImplementation(() => null);
    producerMocks.gitRaw.mockImplementation(() => Buffer.from(''));
    producerMocks.resolveMergeBase.mockImplementation(() => ({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: false,
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
      return { sha: null, baseFetchFailed: !ok, probeUnavailable: false };
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
      return {
        sha: null,
        baseFetchFailed: !probe.fetch('origin', 'v1.0'),
        probeUnavailable: false,
      };
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
      return { sha: 'mb1', baseFetchFailed: false, probeUnavailable: false };
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
      probeUnavailable: false,
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
  /**
   * A TWO-file PR whose delta touches only the first — the shape that makes a
   * slice smaller than the full range, and therefore the only shape in which
   * "scoped" and "not scoped" are distinguishable at all. `ls-tree` is mocked
   * per file so the restoration probe can be steered.
   */
  const FULL_TWO = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1,2 +1,3 @@',
    ' alpha',
    '+beta',
    ' gamma',
    '',
  ].join('\n');
  /** Just `a.ts`'s section of FULL_TWO, byte-for-byte. */
  const SLICE_A = FULL_TWO.split('diff --git a/b.ts')[0];
  const DELTA_A = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
    });
    expect(report.diffPath).not.toBeNull();
    // The DISK payload, not just the report: a write unpaired from the text
    // the report describes hands every agent a diff whose chunks and
    // diffBase advertise something else — the same mismatch class as the
    // diffPath leak this PR shipped and fixed.
    //
    // And what is published is the PR's OWN section for the scoped file
    // (`@@ -1,3`), not the delta's re-capture of it (`@@ -1,4`). That is the
    // property the slice buys: every hunk an agent can anchor a comment on
    // exists byte-identically in the diff GitHub renders, so an anchored
    // comment cannot 422 and take the whole Create Review call with it. The
    // delta is read for WHICH files changed, never for their hunks.
    expect(writtenDiff()).toBe(FULL_DIFF);
    expect(writtenDiff()).not.toBe(DELTA_DIFF);
    expect(report.diffPathAbsolute).toBe(resolve(report.diffPath as string));
    // The plan is the SLICE's — here the whole full range, because the one
    // changed file is the PR's only file. `scopes to the delta's files` below
    // is where a slice smaller than the full range is pinned.
    expect(report.diffLines).toBe(FULL_DIFF.trimEnd().split('\n').length);
    // The scope block names what it kept, and the superseded full range stays
    // on disk for the steps that want the whole PR.
    expect(
      (report.incremental as { scope?: { deltaFiles?: string[] } }).scope
        ?.deltaFiles,
    ).toEqual(['a.ts']);
    expect(
      (report.incremental as { fullDiffPath?: string }).fullDiffPath,
    ).toMatch(/diff-full\.txt$/);
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

  it('scopes the slice to the delta files, keeping the PR\u2019s own bytes', async () => {
    // The core of an incremental round: `b.ts` is in the PR but not in the
    // delta and nothing imports `a.ts`, so it is out of scope — and what is
    // published is `a.ts`'s section of the PR's own diff, byte-identical.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges(FULL_TWO, DELTA_A);
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
    });
    expect(writtenDiff()).toBe(SLICE_A);
    expect(writtenDiff()).not.toContain('b.ts');
    // The PLAN is built over the slice, not over the full range. The sibling
    // test pins this only where the slice IS the full range, so planning over
    // `fullText` while publishing the slice was indistinguishable there —
    // and a plan describing hunks the published file does not contain sends
    // every agent to line ranges that are not in their diff.
    expect(report.diffLines).toBe(SLICE_A.trimEnd().split('\n').length);
    expect(report.files.map((f: { path: string }) => f.path)).toEqual(['a.ts']);
    const scope = (report.incremental as { scope: Record<string, unknown> })
      .scope;
    expect(scope).toMatchObject({
      anchor: ANCHOR,
      deltaFiles: ['a.ts'],
      interaction: [],
      restoredFileCount: 0,
    });
    // `b.ts` was CONSIDERED and left out — counted, so a reader can tell
    // "nothing imports the change" from "there was nothing to consider".
    expect(scope['contextFileCount']).toBe(1);
  });

  it('widens one import hop: a still-clean importer re-enters the scope', async () => {
    // `b.ts` has no change of its own, so no delta capture can show it — and
    // that is exactly why it needs reviewing. Round 1 cleared it against
    // `a.ts`'s OLD shape; (b.ts@head \u00d7 a.ts@head) is a pairing no round
    // has seen. The slice is what makes this expressible: `b.ts` is pulled in
    // carrying its own full-range hunks.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges(FULL_TWO, DELTA_A);
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return "import './a.js';\n";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const report = await reportFor({ since: ANCHOR });
    expect(writtenDiff()).toBe(FULL_TWO); // both sections, in PR order
    const scope = (report.incremental as { scope: Record<string, unknown> })
      .scope;
    expect(scope['deltaFiles']).toEqual(['a.ts']);
    expect(scope['interaction']).toEqual([
      { path: 'b.ts', importsChanged: ['a.ts'] },
    ]);
    // Pulled in, so no longer merely context.
    expect(scope['contextFileCount']).toBe(0);
  });

  it('a file undone since the anchor owes no review but still moves its importers', async () => {
    // `a.ts` is in the delta and its tree entry is identical at both ends of
    // the PR: the fix round undid it. It has no hunks left to review, so it
    // is not in `deltaFiles` — a plan naming a file with zero hunks sends
    // agents hunting for scope that does not exist — but the undoing IS a
    // change its importers were cleared against, so `b.ts` still enters.
    anchorIsValid();
    producerMocks.gitOpt.mockImplementation((...args: string[]) => {
      if (args[0] === 'cat-file' || args[0] === 'merge-base') return '';
      if (args[0] === 'rev-parse') return ANCHOR;
      // Same tree entry at base and head \u2014 restored.
      if (args.includes('ls-tree') && args.includes('a.ts')) {
        return '100644 blob deadbeef\ta.ts';
      }
      return null;
    });
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges(FULL_TWO, DELTA_A);
    producerMocks.readFileSync.mockImplementation((path?: unknown) => {
      if (String(path).endsWith('b.ts')) return "import './a.js';\n";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const report = await reportFor({ since: ANCHOR });
    const scope = (report.incremental as { scope: Record<string, unknown> })
      .scope;
    expect(scope['deltaFiles']).toEqual([]);
    expect(scope['restoredFileCount']).toBe(1);
    expect(scope['interaction']).toEqual([
      { path: 'b.ts', importsChanged: ['a.ts'] },
    ]);
    // Only the importer's section is published \u2014 the undone file has none
    // of its own worth reading.
    expect(writtenDiff()).not.toContain('a/a.ts');
    expect(writtenDiff()).toContain('a/b.ts');
  });

  it('the restoration probe compares WHOLE tree entries, mode included', () => {
    // Both existing fixtures return the SAME ls-tree entry for every ref, so
    // two mutants survived the whole suite: dropping the equality
    // (`return b !== null && h !== null`) marks every live delta file
    // restored and slices its section out, and comparing only the oid half
    // reads a `chmod +x` with unchanged bytes as a restoration — while the
    // mode-only section IS in the PR's diff and would go unreviewed.
    //
    // Steered per REF, which is what the two-mock fixture cannot express.
    const entries = (base: string, head: string) =>
      producerMocks.gitOpt.mockImplementation((...args: string[]) => {
        if (args[0] === 'cat-file' || args[0] === 'merge-base') return '';
        if (args[0] === 'rev-parse') return ANCHOR;
        if (args.includes('ls-tree')) {
          return args.includes(BASE) ? base : head;
        }
        return null;
      });

    const restoredOf = async (base: string, head: string) => {
      entries(base, head);
      producerMocks.resolveMergeBase.mockReturnValue({
        sha: BASE,
        baseFetchFailed: false,
        probeUnavailable: false,
      });
      servesBothRanges(FULL_TWO, DELTA_A);
      const report = await reportFor({ since: ANCHOR });
      const scope = (report.incremental as { scope?: { deltaFiles: string[] } })
        .scope;
      // `a.ts` out of deltaFiles ⇔ the probe called it restored.
      return !(scope?.deltaFiles ?? []).includes('a.ts');
    };

    return (async () => {
      // Identical entries — restored.
      expect(await restoredOf('100644 blob dead', '100644 blob dead')).toBe(
        true,
      );
      // Different OIDs — a live change, not a restoration.
      expect(await restoredOf('100644 blob dead', '100644 blob beef')).toBe(
        false,
      );
      // Same bytes, MODE flipped — `chmod +x`. Not a restoration: its
      // mode-only section is in the PR's diff and owes a review.
      expect(await restoredOf('100644 blob dead', '100755 blob dead')).toBe(
        false,
      );
    })();
  });

  it('stops the round when everything changed since the anchor was undone', async () => {
    // Every delta file restored and nothing imports them: there is genuinely
    // nothing to re-review. Same outcome as an empty delta \u2014 `upToDate`,
    // which the skill turns into "No new changes since last review" \u2014
    // and the full range is still published for the flows that continue
    // anyway (a model change, --comment).
    anchorIsValid();
    producerMocks.gitOpt.mockImplementation((...args: string[]) => {
      if (args[0] === 'cat-file' || args[0] === 'merge-base') return '';
      if (args[0] === 'rev-parse') return ANCHOR;
      if (args.includes('ls-tree')) return '100644 blob deadbeef\tpath';
      return null;
    });
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges(FULL_TWO, DELTA_A);
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
      upToDate: true,
    });
    expect(writtenDiff()).toBe(FULL_TWO);
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
      probeUnavailable: false,
    });
    servesBothRanges();

    // Same model NAME, different provider — the case the digest exists for.
    const other = await reportFor({
      since: ANCHOR,
      sinceModel: 'fixture-model@9f8e7d6c',
    });
    expect(ruling(other)).toEqual({
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
      ruling(await reportFor({ since: ANCHOR, sinceModel: undefined })),
    ).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'cross-model-anchor',
    });

    // …and the matching identity scopes, which is what makes the refusals
    // above about the gate rather than about the anchor.
    expect(ruling(await reportFor({ since: ANCHOR }))).toEqual({
      since: ANCHOR,
      effective: true,
    });
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
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: ['0'.repeat(40), 'abc1234'] });
    expect(ruling(report)).toEqual({
      since: 'abc1234',
      effective: true,
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
    // not. Both guards fire, and both matter — there is no section of the
    // PR's own diff for the changed file to be sliced from (so the anchor is
    // refused rather than scoped), and the published full range is empty (so
    // the skill stops and recommends close-as-superseded instead of reviewing
    // hunks GitHub's empty PR diff does not contain, where one anchored
    // comment 422s the whole review).
    //
    // `lineage-unfollowable` is the name for that under slicing, where the
    // pre-slice code said `hunks-outside-pr-diff`: the delta is no longer
    // checked for containment — it cannot fail containment, because it is
    // never published — so what refuses here is the file having no section
    // to slice. Same class, same fallback, and the reason still names a
    // deterministic cause the recovery flow must not retry.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges('');
    const report = await reportFor({ since: ANCHOR });
    expect(report.emptyDiff).toBe(true);
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'lineage-unfollowable',
    });
    // A base resolved from a possibly stale local ref cannot rule it — the
    // same fail-closed conjunct the text path has always had.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: true,
      probeUnavailable: false,
    });
    expect((await reportFor({ since: ANCHOR })).emptyDiff).toBeUndefined();
  });

  it('reviews an "undo per feedback" file at its FULL-RANGE hunks', async () => {
    // The case that used to cost the whole round. An "undo per feedback"
    // commit reverts some of the previous round's lines back to base
    // content: those lines are changed in `anchor..head` and unchanged in
    // `base..head`, so a delta capture carries hunks the PR's own diff does
    // not contain — and a comment anchored on one 422s the entire Create
    // Review call. Ancestry cannot see it; the anchor is a perfectly good
    // ancestor. The pre-slice code therefore refused the anchor outright
    // (`hunks-outside-pr-diff`) and re-reviewed the whole PR.
    //
    // Slicing dissolves it. The delta says WHICH file changed; the hunks come
    // from the PR's own diff, where the reverted lines simply are not. So the
    // round stays incremental, reviews `a.ts` at the shape GitHub renders,
    // and every anchor it can produce is one GitHub accepts.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
    });
    // The published bytes are the PR's own section for `a.ts`, so the
    // `-experiment/+original` pair the delta carried — the pair that would
    // have 422'd — is nowhere in what agents read.
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    expect(writtenDiff()).toBe(FULL_DIFF);
    expect(writtenDiff()).not.toContain('-experiment');
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
      probeUnavailable: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes(`${BASE}..f00df00df00d`)) throw new Error('timed out');
      return Buffer.from(DELTA_DIFF);
    });
    const report = await reportFor({ since: ANCHOR });
    // The reason names the CAUSE and keeps naming it: the capture threw.
    // Whether a plan exists is `diffPath`, reported separately — one field
    // meaning both is what used to rename this into the retryable class.
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    // Not a diff at all — a capture that returned an error stream, say. The
    // delta is read for one fact, the list of changed files, and a stream
    // that names none leaves that list empty: nothing to scope to, and no
    // basis to claim the round has nothing new either, because the emptiness
    // is the parser's not the tree's.
    const UNPARSEABLE = 'fatal: bad revision\nnoise\n';
    servesBothRanges(FULL_DIFF, UNPARSEABLE);
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'containment-unverified',
    });
    // …and the round reviews the PR's own diff, the fallback every refusal
    // lands on.
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
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });
    expect(report.diffPath).not.toBeNull();
  });

  it('splits a base-free round by WHY there is no base — retryable or not', async () => {
    // This used to scope, on the reasoning that the delta range needs no base
    // and so a deleted or renamed base branch should not cost a valid anchor
    // its scope. The capture reasoning is right; the SCOPE reasoning is not.
    // With no base there is nothing for the slice to come FROM, so the round
    // reviews the full range — but WHICH reason it reports decides whether
    // the recovery flow ever retries the anchor, and the two causes are not
    // the same class.
    anchorIsValid();
    servesBothRanges();

    // The fetch FAILED: the anchor was never ruled invalid, and a re-run
    // repeats exactly the component that failed. `base-untrusted` is the
    // infrastructure-retryable name; reporting `containment-unverified` here
    // files a transient blip under "deterministic for the same sha and must
    // NOT be retried", so a CI checkout with a flappy base fetch pays a full
    // review every round from then on — and the reason misnames the cause,
    // because the delta read fine.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: true,
      probeUnavailable: false,
    });
    const transient = await reportFor({ since: ANCHOR });
    expect(ruling(transient)).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });

    // The base fetch worked and the merge-base PROBE could not answer — a
    // 128, or the 120s timeout a large long-lived PR under CI load reaches.
    // Nothing about the histories was established, so this is infrastructure
    // like the fetch failure above, not the deterministic shape below.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: true,
    });
    expect(ruling(await reportFor({ since: ANCHOR }))).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'base-untrusted',
    });

    // The fetch SUCCEEDED and `git merge-base` found no common ancestor at
    // all — a cross-fork PR with unrelated history. A re-run reproduces that
    // exactly, so it is the deterministic class and must not be retried.
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    const permanent = await reportFor({ since: ANCHOR });
    expect(ruling(permanent)).toEqual({
      since: ANCHOR,
      effective: false,
      reason: 'containment-unverified',
    });

    // Either way nothing is published, which is what a base-free round does
    // ANYWAY: with no merge base there is no full range either, and the
    // command already tells agents to fall back to running `git diff`
    // themselves. So this costs no review that existed — it removes the one
    // arm that shipped a scope no containment check had ever seen.
    expect(transient.diffPath).toBeNull();
    expect(permanent.diffPath).toBeNull();
  });

  it('keeps upToDate through a partition failure — the stop flow needs no plan', async () => {
    // The `!upToDate` exemption in the partition catch: without it the
    // demote strips `upToDate` and the round stops being "no new changes"
    // for an anchor that is the head.
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: 'f00df00df00d' });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: BASE });
    expect(ruling(report)).toEqual({
      since: BASE,
      effective: true,
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
      probeUnavailable: false,
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
      expect(ruling(report)).toEqual({
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
        probeUnavailable: false,
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
        expect({ what, ...ruling(report) }).toEqual({
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

  it("welds Agent 7's --base to the range the round actually PUBLISHED", async () => {
    // The only test that crosses the producer→consumer seam, and slicing
    // inverted what it must assert. Agent 7 recomputes its own diff as
    // `base..HEAD`, so `--base` has to name the left side of the bytes the
    // round published — and those are now sections of `merge-base..head`,
    // not a capture of `anchor..head`. Welding the ANCHOR here would send
    // the probe over hunks the round never reviewed while missing the ones
    // it did: the exact error `diffBase` was introduced to prevent, arrived
    // at from the other side.
    //
    // So the producer stops writing `diffBase` on a sliced round and the
    // consumer falls back to `mergeBaseSha`, which is the correct answer.
    // The fallback is not a degradation here — it is the answer. (A plan an
    // older CLI wrote still carries `diffBase`, and the consumer still
    // honours it, because a delta-range publish made it true there.)
    anchorIsValid();
    producerMocks.resolveMergeBase.mockReturnValue({
      sha: BASE,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
      since: ANCHOR,
      effective: true,
    });
    // The slice of the PR's own diff, not the delta's re-capture of it.
    expect(writtenDiff()).toBe(FULL_DIFF);
    // …and the full-range fact is still reported. It is computed off
    // `fullText` on every round, so a slice that happens to equal the full
    // range here does not make the assertion vacuous: the mutant this test
    // was written for suppresses the flag on delta-scoped rounds outright,
    // and `effective: true` above is what makes this one of those.
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
      probeUnavailable: false,
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
      probeUnavailable: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) => {
      if (args.includes(`${BASE}..f00df00df00d`)) throw new Error('timed out');
      return Buffer.from('');
    });
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    servesBothRanges();
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (typeof text === 'string' && text.trim() !== '') {
        throw new Error('chunks do not tile the diff');
      }
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
      probeUnavailable: false,
    });
    servesBothRanges();
    const report = await reportFor({ since: '0'.repeat(40) });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    // Two files, one in the delta, so the slice is a PROPER part of the full
    // range and "the partitioner refused the scoped diff" is a state that
    // exists. With the one-file fixture the two texts are identical and the
    // rescue could not be told from the first attempt.
    servesBothRanges(FULL_TWO, DELTA_A);
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (text === SLICE_A) throw new Error('chunks do not tile the diff');
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    const report = await reportFor({ since: ANCHOR });
    expect(report.diffPath).not.toBeNull();
    expect(report.diffLines).toBeGreaterThan(0);
    // The rescue republished the FULL range — the file agents read must be
    // the range the report now describes.
    expect(writtenDiff()).toBe(FULL_TWO);
    // The anchor cannot stay effective over a full-range plan — one round,
    // two scopes is what that would mean for Agent 7's welded --base — and
    // the reason names what actually happened, not a capture that worked.
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    // Two files, one in the delta — see the sibling above for why the
    // one-file fixture cannot express a scoped-then-rescued round.
    servesBothRanges(FULL_TWO, DELTA_A);
    producerMocks.buildDiffPlan.mockImplementation((text: unknown) => {
      if (text === SLICE_A) throw new Error('chunks do not tile the diff');
      return producerMocks.actualBuildDiffPlan(text, 400);
    });
    // Write 1 is the scoped publish and succeeds; write 2 is the rescue.
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
    expect(ruling(report)).toEqual({
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
    });
    producerMocks.gitRaw.mockImplementation((...args: string[]) =>
      args.includes(`${BASE}..f00df00df00d`)
        ? Buffer.from(DELTA_DIFF)
        : Buffer.from(''),
    );
    const report = await reportFor({ since: ANCHOR });
    expect(ruling(report)).toEqual({
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
    expect(ruling(report)).toEqual({
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
      probeUnavailable: false,
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
      probeUnavailable: false,
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
      probeUnavailable: false,
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
      probeUnavailable: false,
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
