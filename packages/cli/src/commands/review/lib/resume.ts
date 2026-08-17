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

import { isDeepStrictEqual } from 'node:util';
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
  | 'base-fetch-mismatch' // the report claims a base fetch failure this run disproved
  | 'merge-base-mismatch' // the report's mergeBaseSha is not the recomputed one
  | 'incremental-delta' // the report claims a delta scope the capture cannot have
  | 'worktree-path-mismatch' // the report names a worktree this run did not choose
  | 'diff-path-mismatch' // the report names a diff path this run did not choose
  | 'chunks-mismatch' // the report's chunks do not tile the re-derived diff
  | 'plan-mismatch' // the report's plan payload is not what the diff re-plans to
  | 'repo-context-mismatch' // the recorded repository context is not what the worktree derives
  | 'pr-description-han-mismatch' // the recorded Han flag is not what the live body reads as
  | 'cross-repository-mismatch' // the recorded cross-repo flag is not the forge's live one
  | 'diff-stat-mismatch' // the recorded diff stat is not the forge's live one
  | 'collapsed-mismatch' // the recorded collapse claim is not what the range re-derives
  | 'base-ref-mismatch' // the report's baseRefName is not the forge's live one
  | 'head-ref-mismatch' // the report's headRefName is not the forge's live one
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
  /**
   * The report claims the base branch could not be fetched. Downstream
   * consumers key their degraded shapes on exactly `=== true` — the base
   * tree refuses and the merge-base identity source degrades to none — so
   * the ruling refuses the claim whenever the re-derivation it just ran
   * proves the base fetchable now.
   */
  baseFetchFailed?: unknown;
  /**
   * The recorded ref names the resumed run's rules load and base fetch route
   * through; the forge's live names are the compared facts.
   */
  baseRefName?: unknown;
  headRefName?: unknown;
  /**
   * The incremental-scoping decision, present when the run was launched with
   * `--since`. An EFFECTIVE delta (not up-to-date) scopes the captured diff
   * to `diffBase..head`, which the full-range re-derivation can neither
   * prove nor continue; `diffBase` is welded into Agent 7's probe base
   * unquoted, so an unrefused forgery rides into the probe command.
   */
  incremental?: unknown;
  /**
   * The plan payload the resumed launches consume — chunk file spans,
   * per-file kinds and heavy flags, the tool budget and the reverse-audit
   * round cap all derive from these. Re-derived from the diff bytes this
   * run hashed, and compared whole; see the `planReportMatches` probe.
   */
  diffLines?: unknown;
  diffChars?: unknown;
  /**
   * The enriched repository context the resumed briefs bake into every
   * agent's prompt — `requiredAgents` force role launches, `domains` gate
   * modeled-system content, `verificationNotes`/`relatedPaths` steer the
   * verification pass — and compose relays into the posted review. It sits
   * on the same attempt-1-writable disk as everything else here, so the
   * ruling re-derives it with the same providers the fresh enrichment runs
   * and compares whole.
   */
  repositoryContext?: unknown;
  /**
   * The PR-body Han flag gates the posted body's bilingual rendering —
   * `compose-review` returns the recorded boolean as-is, the live-body
   * fallback runs only when the field is ABSENT — so a forged `false` on a
   * Chinese-authored PR suppresses the bilingual comment. Re-derived from
   * the forge's live body and compared.
   */
  prDescriptionHasHan?: unknown;
  /**
   * The collapse disclosure, written into the posted summary and read by
   * Agent 0 as "treat the body's claims as description-of-history".
   * Re-derived from the re-derived range and the forge's live stat.
   */
  collapsedFromUpstream?: unknown;
  /** The cross-repository flag selects the roster's lightweight mode. */
  isCrossRepository?: unknown;
  /** The forge-advertised diff stat, surfaced in the posted counts. */
  diffStat?: unknown;
  srcDiffLines?: unknown;
  testDiffLines?: unknown;
  docsDiffLines?: unknown;
  generatedDiffLines?: unknown;
  files?: unknown;
  budget?: unknown;
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
   * The PR's live base ref name from the forge, or null when unavailable.
   * The resumed run's rules load reads `<remote>/<baseRefName>` from the
   * report — a forged name resolves no rules, silently enforcing none over
   * the diff, so the recorded name is compared against the forge's.
   */
  liveBaseRefName: string | null;
  /** The PR's live head ref name from the forge, or null when unavailable. */
  liveHeadRefName: string | null;
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
   * The report's full plan payload — files, budget, chunk entries and the
   * line/char tallies — equals what the planner derives from the re-derived
   * diff bytes under this invocation's context. The resumed launches
   * consume every part of it: chunk file spans weight the territory, file
   * kinds and heavy flags pick the roster and the invariant agents, the
   * budget sets tool ceilings, and the reverse-audit round cap re-derives
   * from it at every admission gate. Tiling alone (`chunksTile`) proves the
   * ranges only; a forged `kind`, `heavy` or budget field suppresses
   * exactly the scrutiny a malicious hunk owes. Null when the diff is
   * underivable.
   */
  planReportMatches: boolean | null;
  /**
   * The report's recorded `repositoryContext` deep-equals what the SAME
   * providers the fresh enrichment runs derive from this worktree and merge
   * base (both null when neither has one). False on any disagreement, and
   * when the derivation itself fails — a context the ruling cannot re-derive
   * cannot be compared, and an uncomparable field is an attacker's.
   */
  repositoryContextMatches: boolean;
  /**
   * The Han test over the forge's LIVE PR body, or null when the forge was
   * unreachable — the same query the ruling already makes for the head.
   */
  prDescriptionHasHan: boolean | null;
  /** The forge's live cross-repository flag, or null when unreachable. */
  isCrossRepository: boolean | null;
  /** The forge's live diff stat, or null when unreachable. */
  diffStat: { files: number; additions: number; deletions: number } | null;
  /**
   * The collapse flag re-computed from the re-derived diff bytes and the
   * forge's live stat — the same predicate the fresh path applies. Null when
   * the diff is underivable or the forge unreachable.
   */
  collapsedRederived: boolean | null;
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
 * True when the report's audit-window fields are present, parsable, not in
 * the future, and ordered. Nothing legitimate writes the future; a
 * forged-future opening pushes the audit window past every real write and
 * reports it clean — the exact forgery the fresh path rejects when it
 * inherits the window. `auditSince <= fetchedAt` is the writer's own
 * invariant — the window opening is a MIN over inherited openings, so it
 * only ever moves BACKWARD — and a forward-shifted-but-past forgery clears
 * the <=now checks while blinding cleanup's bypass-write audit to every
 * write made before the forgery.
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
  return auditSince <= fetchedAt && auditSince <= nowMs && fetchedAt <= nowMs;
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
  // The report's `baseFetchFailed` degrades the resumed run where the
  // consumers key on it — the base tree refuses, and the merge-base identity
  // source falls back to none — so a value of true disables verification
  // machinery on the very PR that planted it. The re-derivation reaching
  // here has itself proven the base fetchable now, so the claim is either a
  // forgery or a stale capture; either way the continuation does not carry
  // it. (The reverse forgery — false over a real failure — dies earlier as
  // `diff-underivable`: a failed base fetch leaves the re-derivation null.)
  if (prev.baseFetchFailed === true) {
    return { ok: false, reason: 'base-fetch-mismatch' };
  }
  // The report's merge-base is consumed as the revert/A-B base downstream;
  // compare it against the one this run recomputed against the forge's base
  // ref, never against itself.
  if (prev.mergeBaseSha !== probes.mergeBaseSha) {
    return { ok: false, reason: 'merge-base-mismatch' };
  }
  // An effective delta (not up-to-date) scopes the captured diff to
  // `diffBase..head` — but the re-derivation that reached this point proved
  // the captured bytes are the FULL merge-base range, so the claim
  // contradicts a fact this run derived. Consumed it is either way:
  // Agent 7's probe base welds `diffBase` — a field no comparison reaches —
  // whenever `effective === true && upToDate !== true`, exactly the shape
  // refused here. (`upToDate: true` and `effective: false` shapes carry no
  // delta and no weld; the full-range capture they describe is the one the
  // re-derivation proved.)
  const incremental = prev.incremental as
    | { effective?: unknown; upToDate?: unknown }
    | undefined;
  if (
    typeof incremental === 'object' &&
    incremental !== null &&
    incremental.effective === true &&
    incremental.upToDate !== true
  ) {
    return { ok: false, reason: 'incremental-delta' };
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
  // Tiling proves the ranges only. The resumed launches consume the WHOLE
  // plan — chunk file spans, per-file kinds and heavy flags, the tool
  // budget, the round cap — so the ruling re-plans the re-derived bytes and
  // compares the payload field for field; a disagreement is a forged or
  // stale plan, and either re-runs.
  if (probes.planReportMatches !== true) {
    return { ok: false, reason: 'plan-mismatch' };
  }
  // The resumed briefs bake the recorded repository context into every
  // agent's prompt and compose relays its gate into the posted review, so
  // the ruling re-derives it with the fresh enrichment's own providers and
  // compares whole — a field this ruling does not compare is a field the
  // attacker chooses.
  if (!probes.repositoryContextMatches) {
    return { ok: false, reason: 'repo-context-mismatch' };
  }
  // Four more consumed fields, re-derived from facts this run already
  // trusts — the forge's live `gh pr view` and the re-derived range. A
  // forged Han flag suppresses the bilingual comment on a Chinese-authored
  // PR (the live-body fallback runs only when the field is ABSENT), a
  // forged collapse claim writes a false disclosure and re-steers Agent 0,
  // forged stats surface attacker-chosen counts, and a forged cross-repo
  // flag flips the roster's mode.
  if (
    probes.prDescriptionHasHan === null ||
    prev.prDescriptionHasHan !== probes.prDescriptionHasHan
  ) {
    return { ok: false, reason: 'pr-description-han-mismatch' };
  }
  if (
    probes.isCrossRepository === null ||
    prev.isCrossRepository !== probes.isCrossRepository
  ) {
    return { ok: false, reason: 'cross-repository-mismatch' };
  }
  if (
    probes.diffStat === null ||
    !isDeepStrictEqual(prev.diffStat, probes.diffStat)
  ) {
    return { ok: false, reason: 'diff-stat-mismatch' };
  }
  if (
    probes.collapsedRederived === null ||
    (prev.collapsedFromUpstream === true) !== probes.collapsedRederived
  ) {
    return { ok: false, reason: 'collapsed-mismatch' };
  }
  // The resumed run's rules load reads `<remote>/<baseRefName>` from the
  // report, and the fetch path re-reads it when the base fetch failed; a
  // forged name resolves nothing, and "no rules found" is indistinguishable
  // from a repo that has none — the project's rules would silently not
  // apply to the diff under review. Compared against the forge's live
  // names; an unreachable forge reads as unmoved, exactly like the
  // head-moved fail-open below — the content checks have already pinned
  // the input.
  if (
    probes.liveBaseRefName !== null &&
    prev.baseRefName !== probes.liveBaseRefName
  ) {
    return { ok: false, reason: 'base-ref-mismatch' };
  }
  if (
    probes.liveHeadRefName !== null &&
    prev.headRefName !== probes.liveHeadRefName
  ) {
    return { ok: false, reason: 'head-ref-mismatch' };
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
