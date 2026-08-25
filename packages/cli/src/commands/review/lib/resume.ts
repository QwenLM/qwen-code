/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// May this run continue the interrupted one, or must it start over?
//
// The ruling is pure: `fetch-pr --resume` gathers the probes (git, gh, file
// hashes, the resume marker) and this function only compares them. Every
// check fails toward a FRESH run — resuming on stale state would continue a
// review of code nobody is reviewing anymore, which is strictly worse than
// re-fetching. The checkpoint key is content (the diff's sha256, the head
// SHA), never a path or a timestamp: input that changed re-runs, by
// construction rather than by invalidation logic.
//
// Resume is a LOCAL convenience: a developer whose `qwen review` was
// interrupted re-runs it with `--resume`. The on-disk state was written by
// the trusted CLI and the developer — there is no adversarial attempt-1 code
// racing the same disk (CI does not resume; its trigger runs fresh), so the
// ruling asks only whether the state is genuinely UNCHANGED and resumable,
// not whether a report field was forged. Every check still fails toward a
// FRESH run: resuming stale state reviews code nobody is reviewing anymore.

import { EFFORT_LEVELS } from '../parse-args.js';
import { RESUME_MAX } from './run-ledger.js';

/** Why a resume was refused. Stable identifiers: the report carries one. */
export type ResumeRefusal =
  | 'no-report' // no previous fetch report at the plan path
  | 'pr-mismatch' // the report on disk is another PR's
  | 'effort-mismatch' // an explicit --effort differs from the recorded run's
  | 'no-diff-hash' // the previous run predates diffSha256 (or captured no diff)
  | 'worktree-gone' // the interrupted attempt's worktree no longer exists
  | 'worktree-sha-mismatch' // the worktree is not checked out at fetchedSha
  | 'worktree-dirty' // the worktree holds uncommitted changes
  | 'diff-unreadable' // the captured diff is gone or cannot be read
  | 'diff-hash-mismatch' // the diff file changed since it was captured
  | 'head-moved' // the PR head advanced — the once-per-review restart case
  | 'resume-cap' // this review has already resumed RESUME_MAX times
  | 'worktree-untrusted'; // the tree's gitfile no longer resolves to its own admin entry

export type ResumeAssessment =
  | { ok: true }
  | { ok: false; reason: ResumeRefusal };

/** What the previous fetch report claims. All fields as parsed, unvalidated. */
export interface PreviousReport {
  prNumber?: unknown;
  fetchedSha?: unknown;
  diffSha256?: unknown;
  effort?: unknown;
}

/** What the world looks like now, probed by the caller. */
export interface ResumeProbes {
  /** The PR number this invocation was asked to review. */
  prNumber: string;
  /** `git -C <worktree> rev-parse HEAD`, or null when the worktree is gone. */
  worktreeHeadSha: string | null;
  /**
   * `git status --porcelain` on the worktree reported no changes. A tree at
   * the right HEAD can still hold uncommitted edits — this pipeline's own
   * build/test agents mutate worktrees by design, and a death between an
   * apply and its revert leaves exactly that. Resuming there would review
   * code that is not in the PR. Null when the probe could not run, treated
   * as dirty.
   */
  worktreeClean: boolean | null;
  /** sha256 of the diff file's bytes on disk, or null when unreadable. */
  diffSha256OnDisk: string | null;
  /** The PR's live head OID from the forge, or null when unavailable. */
  liveHeadSha: string | null;
  /** How many times this review has already resumed. */
  resumeCount: number;
  /**
   * The --effort this invocation was called with, or null. An EXPLICIT
   * effort different from the recorded run's is a request for different
   * work, not a continuation; absent effort keeps the recorded level.
   */
  requestedEffort: string | null;
}

/**
 * The ruling. Checks are ordered from "there is nothing to resume" through
 * "the state is not the state that was left" to "resuming is not allowed
 * again" — so the reported reason names the FIRST fact that broke the chain.
 */
export function assessResume(
  prev: PreviousReport | null,
  probes: ResumeProbes,
): ResumeAssessment {
  if (
    prev === null ||
    typeof prev.fetchedSha !== 'string' ||
    prev.fetchedSha === ''
  ) {
    return { ok: false, reason: 'no-report' };
  }
  if (prev.prNumber !== probes.prNumber) {
    return { ok: false, reason: 'pr-mismatch' };
  }
  // A plan with no recorded effort ran the default (high) roster; an
  // explicit effort that differs is a request for different work, not a
  // continuation. (An invalid recorded level simply selects the default,
  // like an absent one — locally there is no forger to distinguish.)
  if (
    probes.requestedEffort !== null &&
    probes.requestedEffort !==
      (typeof prev.effort === 'string' &&
      prev.effort !== '' &&
      EFFORT_LEVELS.has(prev.effort)
        ? prev.effort
        : 'high')
  ) {
    return { ok: false, reason: 'effort-mismatch' };
  }
  // A pre-diffSha256 report (or a run that captured no diff) has no content
  // identity to verify against; a resume that cannot prove its input is
  // unchanged does not happen.
  if (typeof prev.diffSha256 !== 'string' || prev.diffSha256 === '') {
    return { ok: false, reason: 'no-diff-hash' };
  }
  if (probes.worktreeHeadSha === null) {
    return { ok: false, reason: 'worktree-gone' };
  }
  if (probes.worktreeHeadSha !== prev.fetchedSha) {
    return { ok: false, reason: 'worktree-sha-mismatch' };
  }
  if (probes.worktreeClean !== true) {
    return { ok: false, reason: 'worktree-dirty' };
  }
  // Absent local state and changed input are different facts: one says this
  // run lost its own capture, the other says what it captured is no longer
  // what it captured.
  if (probes.diffSha256OnDisk === null) {
    return { ok: false, reason: 'diff-unreadable' };
  }
  if (probes.diffSha256OnDisk !== prev.diffSha256) {
    return { ok: false, reason: 'diff-hash-mismatch' };
  }
  // An unreachable forge is NOT a head-moved: it is indistinguishable from
  // "unchanged", and the worktree/diff checks above already pin the content.
  // presubmit's headDrift re-checks against the live head before anything is
  // posted, so failing open here costs nothing that gate does not catch.
  if (probes.liveHeadSha !== null && probes.liveHeadSha !== prev.fetchedSha) {
    return { ok: false, reason: 'head-moved' };
  }
  if (probes.resumeCount >= RESUME_MAX) {
    return { ok: false, reason: 'resume-cap' };
  }
  return { ok: true };
}
