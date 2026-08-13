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
  | 'no-diff-hash' // the previous run predates diffSha256 (or captured no diff)
  | 'worktree-gone' // the interrupted attempt's worktree no longer exists
  | 'worktree-sha-mismatch' // the worktree is not checked out at fetchedSha
  | 'diff-hash-mismatch' // the diff file changed since it was captured
  | 'head-moved' // the PR head advanced — the once-per-review restart case
  | 'resume-cap'; // this review has already resumed RESUME_MAX times

export interface ResumeAssessment {
  ok: boolean;
  reason?: ResumeRefusal;
}

/** What the previous fetch report claims. All fields as parsed, unvalidated. */
export interface PreviousReport {
  prNumber?: unknown;
  fetchedSha?: unknown;
  diffSha256?: unknown;
  worktreePath?: unknown;
}

/** What the world looks like now, probed by the caller. */
export interface ResumeProbes {
  /** The PR number this invocation was asked to review. */
  prNumber: string;
  /** `git -C <worktree> rev-parse HEAD`, or null when the worktree is gone. */
  worktreeHeadSha: string | null;
  /** sha256 of the diff file's bytes on disk, or null when unreadable. */
  diffSha256OnDisk: string | null;
  /** The PR's live head OID from the forge, or null when unavailable. */
  liveHeadSha: string | null;
  /** How many times this review has already resumed (the marker's count). */
  resumeCount: number;
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
