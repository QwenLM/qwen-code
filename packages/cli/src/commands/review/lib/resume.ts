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
// Every field of the previous report the resumed pipeline would consume is
// verified here against a fact this run derived itself. The report sits on a
// disk the reviewed PR's own code could write during attempt 1, so a field
// this ruling does not compare is a field the attacker chooses: the resumed
// agents would route through it while the verdict cites the genuine head.

import { EFFORT_LEVELS } from '../parse-args.js';
import { RESUME_MAX } from './run-ledger.js';

/** Why a resume was refused. Stable identifiers: the report carries one. */
export type ResumeRefusal =
  | 'no-report' // no previous fetch report at the plan path
  | 'pr-mismatch' // the report on disk is another PR's
  | 'owner-repo-mismatch' // the report names another repo or host
  | 'effort-corrupt' // the recorded effort is not a level writers emit
  | 'effort-mismatch' // an explicit --effort differs from the recorded run's
  | 'no-diff-hash' // the previous run predates diffSha256 (or captured no diff)
  | 'worktree-gone' // the interrupted attempt's worktree no longer exists
  | 'worktree-identity-mismatch' // the worktree belongs to another repository
  | 'worktree-sha-mismatch' // the worktree is not checked out at fetchedSha
  | 'worktree-dirty' // the worktree holds uncommitted or hidden changes
  | 'diff-unreadable' // the captured diff is gone or cannot be read
  | 'diff-hash-mismatch' // the diff file changed since it was captured
  | 'grafts-present' // info/grafts could redirect the re-derivation's base
  | 'diff-underivable' // the diff could not be re-derived, or not trusted
  | 'diff-rederive-mismatch' // git derives a different diff than was recorded
  | 'merge-base-mismatch' // the report's mergeBaseSha is not the recomputed one
  | 'worktree-path-mismatch' // the report names a worktree this run did not choose
  | 'diff-path-mismatch' // the report names a diff path this run did not choose
  | 'chunks-mismatch' // the report's chunks do not tile the re-derived diff
  | 'window-corrupt' // auditSince/fetchedAt unparsable or in the future
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
  ownerRepo?: unknown;
  host?: unknown;
  diffPathAbsolute?: unknown;
  mergeBaseSha?: unknown;
  auditSince?: unknown;
  fetchedAt?: unknown;
  chunks?: unknown;
}

/** What the world looks like now, probed by the caller. */
export interface ResumeProbes {
  /** The PR number this invocation was asked to review. */
  prNumber: string;
  /** The "owner/repo" this invocation was asked to review. */
  ownerRepo: string;
  /** The host this invocation was called with, or null for github.com. */
  host: string | null;
  /** `git -C <worktree> rev-parse HEAD`, or null when the worktree is gone. */
  worktreeHeadSha: string | null;
  /**
   * The worktree's git common dir is THIS repository's. The worktree's
   * `.git` pointer file lives inside the attempt-1-writable tree; relinking
   * it redirects every other worktree probe — rev-parse, status, ls-files —
   * into an attacker-chosen repository that answers whatever the ruling
   * asks, so no worktree answer is trusted before this holds. False when the
   * common dirs disagree or either could not be probed.
   */
  worktreeIdentityMatches: boolean;
  /** sha256 of the diff file's bytes on disk, or null when unreadable. */
  diffSha256OnDisk: string | null;
  /**
   * `git status --porcelain` on the worktree reported no changes. A tree at
   * the right HEAD can still hold uncommitted edits — this pipeline's own
   * probe and build/test agents mutate worktrees by design, and a death
   * between an apply and its revert leaves exactly that. Resuming there
   * would review code that is not in the PR. Null when the probe could not
   * run, which is treated as dirty: an unverifiable tree is not a clean one.
   * Dirty also covers what `--porcelain` cannot see: skip-worktree and
   * assume-unchanged index bits hide a tampered tracked file, and an
   * exclude-rule plant hides untracked residue — the caller probes both and
   * reports the union.
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
   * The diff path THIS invocation derived from the PR number. Every
   * downstream diff read (chunk reads, coverage's was-given-the-diff, the
   * compose-time hash) routes through the report's `diffPathAbsolute`, so a
   * forged one points every agent at an attacker-chosen file while the hash
   * probes hash the canonical path.
   */
  diffPathAbsolute: string;
  /**
   * sha256 of the diff RE-DERIVED from git objects — `git diff` between the
   * recomputed merge-base and the recorded head, under the same pinned
   * flags the capture used — or null when it could not be derived, or when
   * the derivation cannot be trusted: the base fetch failed (the left side
   * then resolves from attempt-1-writable local refs) or an attribute file
   * was planted in the git dirs (a `-diff` attribute collapses hunks to
   * `Binary files differ` in the re-derived bytes). The recorded hash and
   * the on-disk file are BOTH attacker-writable in CI (same disk, same
   * attempt-1 code execution), so their agreement proves self-consistency,
   * not authenticity; the object store keyed by the forge-verified head SHA
   * is the term the attacker cannot rewrite to match — with replace refs,
   * grafts and attribute lookup pinned out of the derivation.
   */
  diffSha256Rederived: string | null;
  /** The re-derived diff had zero bytes. Null when underivable. */
  rederivedDiffEmpty: boolean | null;
  /**
   * The merge-base THIS run recomputed against the forge's base ref, or
   * null when it could not be faithfully derived (base fetch failed, no
   * candidate ref resolved). The report's `mergeBaseSha` is consumed as the
   * revert/A-B base by test-efficacy and welded into its `--base` command,
   * so a forged one the ruling never compared rides into both.
   */
  mergeBaseSha: string | null;
  /**
   * The report's `chunks` tile the re-derived diff — contiguous line ranges
   * covering it exactly. The chunks are the dispatch AND obligation
   * universes; deleting the chunk that covers a malicious hunk leaves it
   * neither dispatched nor owed, and the tiling guarantee runs at plan time
   * only, so the ruling re-checks it against the bytes it derived itself.
   * Null when the diff is underivable, false when the chunks are malformed.
   */
  chunksTile: boolean | null;
  /**
   * The invocation's wall clock. The report's `auditSince`/`fetchedAt`
   * open cleanup's bypass-write audit window; a forged-future value blinds
   * the audit to a silent clean — the exact forgery the fresh path rejects
   * when it inherits the window.
   */
  nowMs: number;
  /**
   * No non-empty `info/grafts` sits in the worktree's git common dir. A
   * graft redirects the merge-base the re-derivation diffs against (to the
   * head itself: an empty diff matching a forged empty pair), and replace
   * refs are pinned out by the git wrappers; grafts have no flag, so a
   * present file refuses. False when the file is non-empty or the dir could
   * not be probed.
   */
  graftsAbsent: boolean;
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
 * True when the report's audit-window fields are present, parsable and not
 * in the future. Nothing legitimate writes the future; a forged-future
 * opening pushes the audit window past every real write and reports it
 * clean — the exact forgery the fresh path rejects when it inherits the
 * window.
 */
function windowSound(prev: PreviousReport, nowMs: number): boolean {
  if (typeof prev.auditSince !== 'string' || prev.auditSince === '') {
    return false;
  }
  if (typeof prev.fetchedAt !== 'string' || prev.fetchedAt === '') {
    return false;
  }
  const auditSince = Date.parse(prev.auditSince);
  const fetchedAt = Date.parse(prev.fetchedAt);
  if (Number.isNaN(auditSince) || Number.isNaN(fetchedAt)) return false;
  return auditSince <= nowMs && fetchedAt <= nowMs;
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
  // The report names the repo and host the cleanup audit queries and the
  // compose-time anchor links cite; a forged pair sends the tripwire at a
  // repo with zero writes (silent clean) and the links at the wrong forge.
  const prevHost =
    typeof prev.host === 'string' && prev.host !== '' ? prev.host : null;
  if (prev.ownerRepo !== probes.ownerRepo || prevHost !== probes.host) {
    return { ok: false, reason: 'owner-repo-mismatch' };
  }
  // The resumed run trusts the recorded effort when no explicit one is
  // passed; a level the writers never emit is a corrupt report, whatever it
  // would select. Valid-but-forged levels (high→medium) are undetectable on
  // disk and are the documented residual of resuming from attempt-1-writable
  // state at all.
  if (
    typeof prev.effort === 'string' &&
    prev.effort !== '' &&
    !EFFORT_LEVELS.has(prev.effort)
  ) {
    return { ok: false, reason: 'effort-corrupt' };
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
  // BEFORE any worktree answer is trusted: a relinked `.git` pointer makes
  // rev-parse, status and ls-files address an attacker's repository.
  if (!probes.worktreeIdentityMatches) {
    return { ok: false, reason: 'worktree-identity-mismatch' };
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
  if (!probes.graftsAbsent) {
    return { ok: false, reason: 'grafts-present' };
  }
  // The recorded hash and the disk file agree — but both live on a disk the
  // reviewed PR's own code could write during attempt 1, so their agreement
  // is self-consistency, not authenticity. The diff must also be what git
  // itself derives for the recorded head: a doctored pair passes the check
  // above and fails this one, because the object store keyed by the
  // forge-verified head is not attacker-writable to match. Null also covers
  // an UNTRUSTED derivation — a failed base fetch resolves the left side
  // from attempt-1-writable local refs, and a planted attribute file shapes
  // the bytes git derives.
  if (probes.diffSha256Rederived === null) {
    return { ok: false, reason: 'diff-underivable' };
  }
  if (probes.diffSha256Rederived !== prev.diffSha256) {
    return { ok: false, reason: 'diff-rederive-mismatch' };
  }
  // The report's merge-base is consumed as the revert/A-B base downstream;
  // compare it against the one this run recomputed against the forge's base
  // ref, never against itself.
  if (prev.mergeBaseSha !== probes.mergeBaseSha) {
    return { ok: false, reason: 'merge-base-mismatch' };
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
  if (
    typeof prev.diffPathAbsolute !== 'string' ||
    prev.diffPathAbsolute !== probes.diffPathAbsolute
  ) {
    return { ok: false, reason: 'diff-path-mismatch' };
  }
  // The chunks are the dispatch and obligation universes; the tiling
  // guarantee ran at plan time only, and the plan is attempt-1-writable.
  if (probes.chunksTile !== true) {
    return { ok: false, reason: 'chunks-mismatch' };
  }
  if (!windowSound(prev, probes.nowMs)) {
    return { ok: false, reason: 'window-corrupt' };
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
