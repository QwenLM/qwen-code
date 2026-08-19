/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The resume ruling, check by check. Each test breaks exactly one link in
// the chain and expects the ruling to name THAT link — the reason is what an
// operator acts on, so a later check must not shadow an earlier one.
//
// Resume is a LOCAL convenience: the on-disk state was written by the trusted
// CLI and the developer, so the ruling asks only whether that state is
// genuinely UNCHANGED and resumable, never whether a field was forged.

import { describe, it, expect } from 'vitest';
import { assessResume, type ResumeProbes } from './resume.js';
import { RESUME_MAX } from './run-ledger.js';

const SHA = 'f00df00df00df00d';
const DIFF_SHA = 'a'.repeat(64);

const prev = () => ({
  prNumber: '42',
  fetchedSha: SHA,
  diffSha256: DIFF_SHA,
  effort: undefined as unknown,
});

const probes = (over: Partial<ResumeProbes> = {}): ResumeProbes => ({
  prNumber: '42',
  worktreeHeadSha: SHA,
  worktreeClean: true,
  diffSha256OnDisk: DIFF_SHA,
  liveHeadSha: SHA,
  resumeCount: 0,
  requestedEffort: null,
  ...over,
});

describe('assessResume — the empty-string shapes, named by the FIRST break', () => {
  // A hand-edited or externally rewritten report is diagnosed by the artifact
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
    // Nothing recorded means nothing to disagree with, so an explicit `high`
    // matches the default a resumed run inherits.
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

  it('reads an invalid recorded effort as the default high', () => {
    // Locally there is no forger to distinguish a corrupt level from an
    // absent one — both simply select the default roster.
    expect(
      assessResume(
        { ...prev(), effort: 'turbo' },
        probes({ requestedEffort: 'high' }),
      ),
    ).toEqual({ ok: true });
    expect(
      assessResume(
        { ...prev(), effort: 'turbo' },
        probes({ requestedEffort: 'medium' }),
      ),
    ).toEqual({ ok: false, reason: 'effort-mismatch' });
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

  it('names a missing diff capture apart from a changed one', () => {
    // Local state loss and upstream input change are different facts.
    expect(assessResume(prev(), probes({ diffSha256OnDisk: null }))).toEqual({
      ok: false,
      reason: 'diff-unreadable',
    });
  });

  it('refuses with diff-hash-mismatch when the diff bytes changed', () => {
    // The content key: input that changed re-runs, by construction.
    expect(
      assessResume(prev(), probes({ diffSha256OnDisk: 'b'.repeat(64) })),
    ).toEqual({ ok: false, reason: 'diff-hash-mismatch' });
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
});
