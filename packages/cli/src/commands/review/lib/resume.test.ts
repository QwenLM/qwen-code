/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The resume ruling, check by check. Each test breaks exactly one link in
// the chain and expects the ruling to name THAT link — the reason is what an
// operator acts on, so a later check must not shadow an earlier one.

import { describe, it, expect } from 'vitest';
import { assessResume, type ResumeProbes } from './resume.js';
import { RESUME_MAX } from './run-ledger.js';

const SHA = 'f00df00df00df00d';
const DIFF_SHA = 'a'.repeat(64);

const WT = '.qwen/tmp/review-pr-42';

const MERGE_BASE = 'baseb45eb45e';
const DIFF_PATH = '.qwen/tmp/qwen-review-pr-42-diff.txt';

const prev = () => ({
  prNumber: '42',
  fetchedSha: SHA,
  diffSha256: DIFF_SHA,
  worktreePath: WT,
  ownerRepo: 'acme/widgets',
  host: null,
  diffPathAbsolute: DIFF_PATH,
  mergeBaseSha: MERGE_BASE,
  baseRefName: 'main',
  headRefName: 'feat/x',
  baseFetchFailed: false,
  auditSince: '2026-01-01T00:00:00.000Z',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  chunks: [{ id: 1, startLine: 1, endLine: 5, lines: 5, chars: 10 }],
  prDescriptionHasHan: false,
  isCrossRepository: false,
  diffStat: { files: 2, additions: 7, deletions: 3 },
});

const probes = (over: Partial<ResumeProbes> = {}): ResumeProbes => ({
  prNumber: '42',
  ownerRepo: 'acme/widgets',
  host: null,
  worktreeHeadSha: SHA,
  worktreeIdentityMatches: true,
  worktreeClean: true,
  diffSha256OnDisk: DIFF_SHA,
  diffSha256Rederived: DIFF_SHA,
  rederivedDiffEmpty: false,
  worktreePath: WT,
  diffPathAbsolute: DIFF_PATH,
  liveHeadSha: SHA,
  liveBaseRefName: 'main',
  liveHeadRefName: 'feat/x',
  mergeBaseSha: MERGE_BASE,
  chunksTile: true,
  planReportMatches: true,
  repositoryContextMatches: true,
  prDescriptionHasHan: false,
  isCrossRepository: false,
  diffStat: { files: 2, additions: 7, deletions: 3 },
  collapsedRederived: false,
  nowMs: Date.now(),
  graftsAbsent: true,
  resumeCount: 0,
  requestedEffort: null,
  ...over,
});

describe('assessResume — the empty-string shapes, named by the FIRST break', () => {
  // Unreachable from today's writers, which is the point: the guards exist so
  // a hand-edited or externally rewritten report is diagnosed by the artifact
  // that is actually broken. The suites otherwise pass `undefined`/`null`,
  // which take the `typeof` branches and leave these clauses free to be
  // deleted.
  it('an empty fetchedSha is a broken REPORT, not a moved worktree', () => {
    expect(assessResume({ ...prev(), fetchedSha: '' }, probes())).toEqual({
      ok: false,
      reason: 'no-report',
    });
  });

  it('an empty diffSha256 is a missing hash, not a mismatched one', () => {
    expect(assessResume({ ...prev(), diffSha256: '' }, probes())).toEqual({
      ok: false,
      reason: 'no-diff-hash',
    });
  });

  it('an empty recorded effort reads as the default, not as a mismatch', () => {
    // The documented acceptance: nothing recorded means nothing to disagree
    // with, so an explicit `high` matches the default a resumed run inherits.
    expect(
      assessResume(
        { ...prev(), effort: '' },
        probes({ requestedEffort: 'high' }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('assessResume', () => {
  it('resumes when every probe matches the previous report', () => {
    expect(assessResume(prev(), probes())).toEqual({ ok: true });
  });

  it('refuses with no-report when there is nothing to resume', () => {
    expect(assessResume(null, probes())).toEqual({
      ok: false,
      reason: 'no-report',
    });
  });

  it('refuses with no-report when the report has no fetchedSha', () => {
    expect(assessResume({ prNumber: '42' }, probes())).toEqual({
      ok: false,
      reason: 'no-report',
    });
  });

  it("refuses with pr-mismatch on another PR's report at the same path", () => {
    expect(assessResume({ ...prev(), prNumber: '999' }, probes())).toEqual({
      ok: false,
      reason: 'pr-mismatch',
    });
  });

  it('refuses with effort-mismatch when an explicit effort differs', () => {
    // A different effort is a request for different work; the fresh
    // fall-through honors it instead of silently pinning the old level.
    expect(
      assessResume(
        { ...prev(), effort: 'medium' },
        probes({ requestedEffort: 'high' }),
      ),
    ).toEqual({ ok: false, reason: 'effort-mismatch' });
  });

  it('resumes when the explicit effort matches the recorded one', () => {
    expect(
      assessResume(
        { ...prev(), effort: 'medium' },
        probes({ requestedEffort: 'medium' }),
      ),
    ).toEqual({ ok: true });
  });

  it('reads a plan with no recorded effort as the default high', () => {
    expect(assessResume(prev(), probes({ requestedEffort: 'high' }))).toEqual({
      ok: true,
    });
    expect(assessResume(prev(), probes({ requestedEffort: 'medium' }))).toEqual(
      { ok: false, reason: 'effort-mismatch' },
    );
  });

  it('never refuses on effort when none was passed', () => {
    expect(assessResume({ ...prev(), effort: 'medium' }, probes())).toEqual({
      ok: true,
    });
  });

  it('refuses with no-diff-hash on a pre-diffSha256 report', () => {
    expect(
      assessResume({ ...prev(), diffSha256: undefined }, probes()),
    ).toEqual({ ok: false, reason: 'no-diff-hash' });
  });

  it('refuses with no-diff-hash when the run captured no diff', () => {
    expect(assessResume({ ...prev(), diffSha256: null }, probes())).toEqual({
      ok: false,
      reason: 'no-diff-hash',
    });
  });

  it('refuses with worktree-gone when the worktree cannot answer rev-parse', () => {
    expect(assessResume(prev(), probes({ worktreeHeadSha: null }))).toEqual({
      ok: false,
      reason: 'worktree-gone',
    });
  });

  it('refuses with worktree-sha-mismatch when the worktree moved', () => {
    expect(assessResume(prev(), probes({ worktreeHeadSha: 'other' }))).toEqual({
      ok: false,
      reason: 'worktree-sha-mismatch',
    });
  });

  it('refuses with diff-hash-mismatch when the diff bytes changed', () => {
    // The content key: input that changed re-runs, by construction.
    expect(
      assessResume(prev(), probes({ diffSha256OnDisk: 'b'.repeat(64) })),
    ).toEqual({ ok: false, reason: 'diff-hash-mismatch' });
  });

  it('names a missing diff capture apart from a changed one', () => {
    // Local state loss and upstream input change are different facts.
    expect(assessResume(prev(), probes({ diffSha256OnDisk: null }))).toEqual({
      ok: false,
      reason: 'diff-unreadable',
    });
  });

  it('refuses with worktree-dirty on uncommitted changes at the right SHA', () => {
    // This pipeline's own probe and build/test agents mutate worktrees; a
    // death between an apply and its revert leaves exactly this state, and
    // the HEAD SHA plus the diff hash both still match.
    expect(assessResume(prev(), probes({ worktreeClean: false }))).toEqual({
      ok: false,
      reason: 'worktree-dirty',
    });
  });

  it('treats an unrunnable cleanliness probe as dirty', () => {
    expect(assessResume(prev(), probes({ worktreeClean: null }))).toEqual({
      ok: false,
      reason: 'worktree-dirty',
    });
  });

  it('reports the FIRST broken link when several are broken at once', () => {
    // The reason is what an operator acts on, so a later check must not
    // shadow an earlier one — a test that breaks exactly one link is by
    // construction insensitive to that ordering.
    expect(
      assessResume(
        prev(),
        probes({
          worktreeHeadSha: 'other',
          worktreeClean: false,
          diffSha256OnDisk: null,
          liveHeadSha: 'moved',
          resumeCount: 99,
        }),
      ),
    ).toEqual({ ok: false, reason: 'worktree-sha-mismatch' });
    expect(
      assessResume(
        prev(),
        probes({
          worktreeClean: false,
          diffSha256OnDisk: null,
          liveHeadSha: 'moved',
          resumeCount: 99,
        }),
      ),
    ).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(
      assessResume(
        prev(),
        probes({
          diffSha256OnDisk: null,
          liveHeadSha: 'moved',
          resumeCount: 99,
        }),
      ),
    ).toEqual({ ok: false, reason: 'diff-unreadable' });
    expect(
      assessResume(prev(), probes({ liveHeadSha: 'moved', resumeCount: 99 })),
    ).toEqual({ ok: false, reason: 'head-moved' });
  });

  it('refuses with head-moved when the live head advanced', () => {
    expect(assessResume(prev(), probes({ liveHeadSha: 'newhead' }))).toEqual({
      ok: false,
      reason: 'head-moved',
    });
  });

  it('does NOT refuse on an unreachable forge — the content checks pin it', () => {
    expect(assessResume(prev(), probes({ liveHeadSha: null }))).toEqual({
      ok: true,
    });
  });

  it('refuses with resume-cap at the marker limit', () => {
    expect(assessResume(prev(), probes({ resumeCount: RESUME_MAX }))).toEqual({
      ok: false,
      reason: 'resume-cap',
    });
  });

  it('still resumes one short of the cap', () => {
    expect(
      assessResume(prev(), probes({ resumeCount: RESUME_MAX - 1 })),
    ).toEqual({ ok: true });
  });
});

describe('assessResume — resume state is untrusted where the reviewed code ran', () => {
  // In CI the report, the diff file and the worktree all sit on a disk the
  // reviewed PR's own code wrote during attempt 1 (yolo-mode agents, no
  // sandbox). Self-consistency between two attacker-writable operands
  // proves nothing; the terms below come from the forge and the object
  // store instead.

  it('refuses a forged-but-consistent diff pair — the re-derived hash disagrees', () => {
    // The attacker rewrites the diff file AND patches diffSha256 to match.
    const doctored = 'b'.repeat(64);
    expect(
      assessResume(
        { ...prev(), diffSha256: doctored },
        probes({ diffSha256OnDisk: doctored }),
      ),
    ).toEqual({ ok: false, reason: 'diff-rederive-mismatch' });
  });

  it('refuses when the diff cannot be re-derived at all', () => {
    expect(assessResume(prev(), probes({ diffSha256Rederived: null }))).toEqual(
      { ok: false, reason: 'diff-underivable' },
    );
  });

  it('refuses a worktreePath this run did not derive', () => {
    expect(
      assessResume({ ...prev(), worktreePath: '/tmp/evil' }, probes()),
    ).toEqual({ ok: false, reason: 'worktree-path-mismatch' });
  });

  it('refuses a report with NO worktreePath — routing needs the field', () => {
    const { worktreePath: _dropped, ...rest } = prev();
    expect(assessResume(rest, probes())).toEqual({
      ok: false,
      reason: 'worktree-path-mismatch',
    });
  });

  it('refuses a forged emptyDiff — the gate must not pass by absence', () => {
    expect(assessResume({ ...prev(), emptyDiff: true }, probes())).toEqual({
      ok: false,
      reason: 'empty-diff-mismatch',
    });
  });

  it('accepts a GENUINE empty diff recorded as one', () => {
    expect(
      assessResume(
        { ...prev(), emptyDiff: true },
        probes({ rederivedDiffEmpty: true }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('assessResume — every report field the pipeline consumes is compared', () => {
  // The report sits on a disk attempt 1 could write; a field the ruling
  // does not compare is a field the attacker chooses. Each test forges ONE
  // field and expects the refusal that names it.

  it('refuses a forged ownerRepo', () => {
    expect(
      assessResume({ ...prev(), ownerRepo: 'evil/repo' }, probes()),
    ).toEqual({ ok: false, reason: 'owner-repo-mismatch' });
  });

  it('refuses a forged host', () => {
    expect(
      assessResume({ ...prev(), host: 'evil.example.com' }, probes()),
    ).toEqual({ ok: false, reason: 'owner-repo-mismatch' });
  });

  it('refuses a report whose host disagrees with the invocation host', () => {
    expect(assessResume(prev(), probes({ host: 'ghe.example.com' }))).toEqual({
      ok: false,
      reason: 'owner-repo-mismatch',
    });
  });

  it('reads an absent recorded host as github.com', () => {
    const { host: _dropped, ...rest } = prev();
    expect(assessResume(rest, probes())).toEqual({ ok: true });
  });

  it('refuses a recorded effort no writer emits', () => {
    expect(assessResume({ ...prev(), effort: 'turbo' }, probes())).toEqual({
      ok: false,
      reason: 'effort-corrupt',
    });
  });

  it('refuses a relinked worktree BEFORE trusting any of its answers', () => {
    // Broken identity AND a moved head: identity names the first fact,
    // because the sha answer came from wherever the pointer was relinked.
    expect(
      assessResume(
        prev(),
        probes({ worktreeIdentityMatches: false, worktreeHeadSha: 'other' }),
      ),
    ).toEqual({ ok: false, reason: 'worktree-identity-mismatch' });
  });

  it('refuses when grafts could redirect the re-derivation', () => {
    expect(assessResume(prev(), probes({ graftsAbsent: false }))).toEqual({
      ok: false,
      reason: 'grafts-present',
    });
  });

  it('refuses a forged mergeBaseSha', () => {
    expect(
      assessResume({ ...prev(), mergeBaseSha: 'deadbeef'.repeat(5) }, probes()),
    ).toEqual({ ok: false, reason: 'merge-base-mismatch' });
  });

  it('refuses a report with no recorded mergeBaseSha', () => {
    const { mergeBaseSha: _dropped, ...rest } = prev();
    expect(assessResume(rest, probes())).toEqual({
      ok: false,
      reason: 'merge-base-mismatch',
    });
  });

  it('refuses a forged diffPathAbsolute', () => {
    expect(
      assessResume(
        { ...prev(), diffPathAbsolute: '/tmp/evil-diff.txt' },
        probes(),
      ),
    ).toEqual({ ok: false, reason: 'diff-path-mismatch' });
  });

  it('refuses chunks that do not tile the re-derived diff', () => {
    expect(assessResume(prev(), probes({ chunksTile: false }))).toEqual({
      ok: false,
      reason: 'chunks-mismatch',
    });
  });

  it('refuses while the diff is underivable and the tiling unknown', () => {
    expect(
      assessResume(
        prev(),
        probes({ diffSha256Rederived: null, chunksTile: null }),
      ),
    ).toEqual({ ok: false, reason: 'diff-underivable' });
  });

  it('refuses a forged-future audit window', () => {
    expect(
      assessResume(
        { ...prev(), auditSince: '2099-01-01T00:00:00.000Z' },
        probes(),
      ),
    ).toEqual({ ok: false, reason: 'window-corrupt' });
  });

  it('refuses an auditSince AFTER fetchedAt — the opening only moves backward', () => {
    // The writers maintain `auditSince <= fetchedAt` by construction (the
    // window opening is a min over inherited openings). A forward-shifted
    // forgery still in the past clears both <=now checks while blinding
    // cleanup's bypass-write audit to every write before the forgery.
    expect(
      assessResume(
        {
          ...prev(),
          auditSince: '2026-01-02T00:00:00.000Z',
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
        probes(),
      ),
    ).toEqual({ ok: false, reason: 'window-corrupt' });
  });

  it('refuses an unparsable fetchedAt', () => {
    expect(
      assessResume({ ...prev(), fetchedAt: 'not-a-date' }, probes()),
    ).toEqual({ ok: false, reason: 'window-corrupt' });
  });

  it('refuses a report missing its audit-window fields', () => {
    const { auditSince: _a, fetchedAt: _f, ...rest } = prev();
    expect(assessResume(rest, probes())).toEqual({
      ok: false,
      reason: 'window-corrupt',
    });
  });

  it('refuses a report claiming the base fetch failed — the re-derivation disproves it', () => {
    // `baseFetchFailed: true` degrades the base tree and the merge-base
    // identity source downstream; a passing re-derivation has just proven
    // the base fetchable, so the disabling direction is refused.
    expect(
      assessResume({ ...prev(), baseFetchFailed: true }, probes()),
    ).toEqual({ ok: false, reason: 'base-fetch-mismatch' });
  });

  it('refuses a forged incremental delta attached to a genuine report', () => {
    // `effective` without `upToDate` claims a delta-scoped capture the
    // full-range re-derivation contradicts, and `diffBase` is welded into
    // Agent 7's probe base unquoted whenever the shape stands.
    expect(
      assessResume(
        {
          ...prev(),
          incremental: { since: SHA, effective: true, diffBase: SHA },
        },
        probes(),
      ),
    ).toEqual({ ok: false, reason: 'incremental-delta' });
  });

  it('accepts the incremental shapes that carry no delta and no weld', () => {
    // `upToDate: true` and `effective: false` records scope nothing and weld
    // nothing — Agent 7's predicate is exactly the shape refused above.
    expect(
      assessResume(
        {
          ...prev(),
          incremental: { since: SHA, effective: true, upToDate: true },
        },
        probes(),
      ),
    ).toEqual({ ok: true });
    expect(
      assessResume(
        {
          ...prev(),
          incremental: {
            since: SHA,
            effective: false,
            reason: 'not-an-ancestor',
          },
        },
        probes(),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses when the plan payload is not what the diff re-plans to', () => {
    expect(assessResume(prev(), probes({ planReportMatches: false }))).toEqual({
      ok: false,
      reason: 'plan-mismatch',
    });
  });

  it('refuses a recorded repository context the worktree does not derive', () => {
    // The briefs bake it into every agent and compose relays its gate — a
    // planted context steers the resumed run while every compared field
    // stays genuine.
    expect(
      assessResume(prev(), probes({ repositoryContextMatches: false })),
    ).toEqual({ ok: false, reason: 'repo-context-mismatch' });
  });

  it('refuses a recorded Han flag the live body contradicts', () => {
    expect(
      assessResume(
        { ...prev(), prDescriptionHasHan: true },
        probes({ prDescriptionHasHan: false }),
      ),
    ).toEqual({ ok: false, reason: 'pr-description-han-mismatch' });
  });

  it('refuses the Han comparison when the forge is unreachable', () => {
    expect(assessResume(prev(), probes({ prDescriptionHasHan: null }))).toEqual(
      { ok: false, reason: 'pr-description-han-mismatch' },
    );
  });

  it('refuses a recorded cross-repo flag the forge contradicts', () => {
    expect(
      assessResume(
        { ...prev(), isCrossRepository: true },
        probes({ isCrossRepository: false }),
      ),
    ).toEqual({ ok: false, reason: 'cross-repository-mismatch' });
  });

  it('refuses a recorded diff stat the forge contradicts', () => {
    expect(
      assessResume(
        { ...prev(), diffStat: { files: 99, additions: 99, deletions: 99 } },
        probes(),
      ),
    ).toEqual({ ok: false, reason: 'diff-stat-mismatch' });
  });

  it('refuses a collapse claim the re-derived range contradicts', () => {
    expect(
      assessResume(
        { ...prev(), collapsedFromUpstream: true },
        probes({ collapsedRederived: false }),
      ),
    ).toEqual({ ok: false, reason: 'collapsed-mismatch' });
  });

  it('refuses a withheld collapse flag over a genuinely collapsed range', () => {
    expect(assessResume(prev(), probes({ collapsedRederived: true }))).toEqual({
      ok: false,
      reason: 'collapsed-mismatch',
    });
  });

  it('refuses while the diff is underivable and the plan comparison unknown', () => {
    expect(
      assessResume(
        prev(),
        probes({ diffSha256Rederived: null, planReportMatches: null }),
      ),
    ).toEqual({ ok: false, reason: 'diff-underivable' });
  });

  it('refuses a forged baseRefName — the rules load reads it', () => {
    expect(
      assessResume({ ...prev(), baseRefName: 'no-such-branch' }, probes()),
    ).toEqual({ ok: false, reason: 'base-ref-mismatch' });
  });

  it('refuses a report with no recorded baseRefName when the forge answered', () => {
    const { baseRefName: _dropped, ...rest } = prev();
    expect(assessResume(rest, probes())).toEqual({
      ok: false,
      reason: 'base-ref-mismatch',
    });
  });

  it('refuses a forged headRefName', () => {
    expect(
      assessResume({ ...prev(), headRefName: 'evil/head' }, probes()),
    ).toEqual({ ok: false, reason: 'head-ref-mismatch' });
  });

  it('does NOT refuse ref names on an unreachable forge — content pins it', () => {
    // Same fail-open as head-moved: unreachable is indistinguishable from
    // unmoved, and the worktree/diff checks have already pinned the input.
    expect(
      assessResume(
        { ...prev(), baseRefName: 'no-such-branch' },
        probes({ liveBaseRefName: null, liveHeadRefName: null }),
      ),
    ).toEqual({ ok: true });
  });
});
