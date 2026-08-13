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

const prev = () => ({
  prNumber: '42',
  fetchedSha: SHA,
  diffSha256: DIFF_SHA,
  worktreePath: '.qwen/tmp/review-pr-42',
});

const probes = (over: Partial<ResumeProbes> = {}): ResumeProbes => ({
  prNumber: '42',
  worktreeHeadSha: SHA,
  diffSha256OnDisk: DIFF_SHA,
  liveHeadSha: SHA,
  resumeCount: 0,
  ...over,
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

  it('refuses with diff-hash-mismatch when the diff file is unreadable', () => {
    expect(assessResume(prev(), probes({ diffSha256OnDisk: null }))).toEqual({
      ok: false,
      reason: 'diff-hash-mismatch',
    });
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
