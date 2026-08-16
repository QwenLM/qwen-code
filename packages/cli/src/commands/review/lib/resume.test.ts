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
  auditSince: '2026-01-01T00:00:00.000Z',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  chunks: [{ id: 1, startLine: 1, endLine: 5, lines: 5, chars: 10 }],
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
  mergeBaseSha: MERGE_BASE,
  chunksTile: true,
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
});
