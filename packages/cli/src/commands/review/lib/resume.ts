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
  | 'diff-underivable' // the diff could not be re-derived from git objects
  | 'diff-rederive-mismatch' // git derives a different diff than was recorded
  | 'worktree-path-mismatch' // the report names a worktree this run did not choose
  | 'empty-diff-mismatch' // the report's emptyDiff disagrees with the derived diff
  | 'head-moved' // the PR head advanced — the once-per-review restart case
  | 'resume-cap'; // this review has already resumed RESUME_MAX times

export type ResumeAssessment =
  | { ok: true }
  | { ok: false; reason: ResumeRefusal };

/** What the previous fetch report claims. All fields as parsed, unvalidated. */
export interface PreviousReport {
  prNumber?: unknown;
  fetchedSha?: unknown;
  diffSha256?: unknown;
  effort?: unknown;
  worktreePath?: unknown;
  emptyDiff?: unknown;
}

/** What the world looks like now, probed by the caller. */
export interface ResumeProbes {
  /** The PR number this invocation was asked to review. */
  prNumber: string;
  /** `git -C <worktree> rev-parse HEAD`, or null when the worktree is gone. */
  worktreeHeadSha: string | null;
  /** sha256 of the diff file's bytes on disk, or null when unreadable. */
  diffSha256OnDisk: string | null;
  /**
   * `git status --porcelain` on the worktree reported no changes. A tree at
   * the right HEAD can still hold uncommitted edits — this pipeline's own
   * probe and build/test agents mutate worktrees by design, and a death
   * between an apply and its revert leaves exactly that. Resuming there
   * would review code that is not in the PR. Null when the probe could not
   * run, which is treated as dirty: an unverifiable tree is not a clean one.
   */
  worktreeClean: boolean | null;
  /** The PR's live head OID from the forge, or null when unavailable. */
  liveHeadSha: string | null;
  /**
   * The worktree path THIS invocation derived from the PR number — the only
   * worktree the pipeline will operate on. The recorded `worktreePath` is
   * consumed by downstream steps (`agent-prompt`'s working_dir,
   * `build-test --worktree`), and in CI the report sits on disk the
   * reviewed PR's own code could write during attempt 1 — a forged path
   * redirects every one of those steps into an attacker-chosen directory
   * while the verdict still certifies the real head SHA.
   */
  worktreePath: string;
  /**
   * sha256 of the diff RE-DERIVED from git objects — `git diff` between the
   * recomputed merge-base and the recorded head, under the same pinned
   * flags the capture used — or null when it could not be derived. The
   * recorded hash and the on-disk file are BOTH attacker-writable in CI
   * (same disk, same attempt-1 code execution), so their agreement proves
   * self-consistency, not authenticity; git's object store keyed by the
   * forge-verified head SHA is the term the attacker cannot rewrite to
   * match.
   */
  diffSha256Rederived: string | null;
  /** The re-derived diff had zero bytes. Null when underivable. */
  rederivedDiffEmpty: boolean | null;
  /**
   * How many times this review has already resumed. The caller computes the
   * MAX of the resume marker's count and the session ledger's entry count
   * minus one (the original run's own session is not a resume): the marker
   * alone is deletable, and a deleted marker must not read as an unspent
   * cap while the ledger still names every session that ran.
   */
  resumeCount: number;
  /**
   * The --effort this invocation was called with, or null when the caller
   * passed none. An EXPLICIT effort different from the recorded run's is a
   * request for different work, not a continuation — the resume refuses and
   * the fresh fall-through honors the request. Absent effort never refuses:
   * the continuation keeps the recorded level.
   */
  requestedEffort: string | null;
}

/**
 * The ruling. Checks are ordered from "there is nothing to resume" through
 * "the state is not the state that was left" to "resuming is not allowed
 * again" — so the reported reason names the FIRST fact that broke the chain,
 * which is the one an operator can act on.
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
  // A plan with no recorded effort ran the default (high) roster; compare
  // against that rather than refusing every resume of a default-effort run.
  if (
    probes.requestedEffort !== null &&
    probes.requestedEffort !==
      (typeof prev.effort === 'string' && prev.effort !== ''
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
  // Absent local state and changed upstream input are different facts and
  // get different names: one says this run lost its own capture, the other
  // says what it captured is no longer what it captured.
  if (probes.diffSha256OnDisk === null) {
    return { ok: false, reason: 'diff-unreadable' };
  }
  if (probes.diffSha256OnDisk !== prev.diffSha256) {
    return { ok: false, reason: 'diff-hash-mismatch' };
  }
  // The recorded hash and the disk file agree — but both live on a disk the
  // reviewed PR's own code could write during attempt 1, so their agreement
  // is self-consistency, not authenticity. The diff must also be what git
  // itself derives for the recorded head: a doctored pair passes the check
  // above and fails this one, because the object store keyed by the
  // forge-verified head is not attacker-writable to match.
  if (probes.diffSha256Rederived === null) {
    return { ok: false, reason: 'diff-underivable' };
  }
  if (probes.diffSha256Rederived !== prev.diffSha256) {
    return { ok: false, reason: 'diff-rederive-mismatch' };
  }
  // The report's own routing fields, verified against facts this run
  // derived itself: a forged worktreePath redirects every downstream step,
  // and a forged emptyDiff stops the resumed run before any agent launches
  // — the gate passing by absence.
  if (
    typeof prev.worktreePath !== 'string' ||
    prev.worktreePath !== probes.worktreePath
  ) {
    return { ok: false, reason: 'worktree-path-mismatch' };
  }
  if ((prev.emptyDiff === true) !== (probes.rederivedDiffEmpty === true)) {
    return { ok: false, reason: 'empty-diff-mismatch' };
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
