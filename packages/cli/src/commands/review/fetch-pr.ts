/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review fetch-pr`: prepare a PR review's working state in a single
// deterministic pass.
//
//   1. Clean any stale worktree / branch from a previously interrupted run
//      so the new run starts fresh.
//   2. `git fetch <remote> pull/<n>/head:qwen-review/pr-<n>` — pull the PR
//      HEAD into a unique local ref (does not modify the user's working
//      tree, unlike `gh pr checkout`).
//   3. `gh pr view ...` to fetch metadata (head/base ref names, head SHA,
//      diff stats, cross-repo flag).
//   4. `git worktree add` to create an ephemeral worktree at
//      `.qwen/tmp/review-pr-<n>` so subsequent steps can run in isolation.
//   5. Capture the review diff to `.qwen/tmp/qwen-review-pr-<n>-diff.txt` and
//      partition it into chunks. Review agents `read_file` a chunk's line
//      range instead of running `git diff` themselves: Shell keeps a 30 000
//      character persistence trigger but returns an approximately 4 000
//      character head-and-tail model preview, which hides most of a large diff
//      from every agent at once. See `lib/diff-plan.ts`.
//   6. Emit a single JSON report describing the resulting state, which the
//      LLM reads to drive the rest of Step 1.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
} from '../../services/review-worktree-lease.js';
import { setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import type { ReviewEffort } from './parse-args.js';
import {
  fileLineCount,
  git,
  gitOpt,
  gitProbe as gitExit,
  gitRaw,
  refExists,
  releaseWorktree,
} from './lib/git.js';
import {
  LITERAL_PATHSPECS,
  PINNED_DIFF_CONFIG,
  PINNED_DIFF_FLAGS,
} from './lib/diff-flags.js';
import {
  REVIEW_TMP_DIR,
  reviewBranch,
  tmpFile,
  worktreePath,
} from './lib/paths.js';
import { planEffortField } from './lib/effort.js';
import {
  buildDiffPlan,
  parseDiff,
  DEFAULT_MAX_CHUNK_LINES,
  READ_FILE_CHAR_CAP,
} from './lib/diff-plan.js';
import {
  buildPlanReport,
  warnOnReportSize,
  type PlanReport,
  stringifyPlanReport,
} from './lib/report.js';
import { resolveMergeBase, type GitProbe } from './lib/merge-base.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { hasReviewDeadline } from './lib/deadline.js';
import { appendRunSession } from './lib/run-ledger.js';
import { SHA_RE } from './lib/ledger.js';
import { certifierMatchesRound, roundModelIdFrom } from './lib/round-model.js';
import {
  computeIncrementalScope,
  type IncrementalScope,
} from './lib/incremental-scope.js';

interface PrMetadata {
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isCrossRepository: boolean;
  /** The PR description, fetched only to detect the author's language. */
  body?: string;
}

interface FetchPrArgs {
  pr_number: string;
  owner_repo: string;
  remote: string;
  out: string;
  host?: string;
  /** yargs camelCases `--max-chunk-lines`; the snake_case form does not exist. */
  maxChunkLines: number;
  effort?: ReviewEffort;
  /**
   * The incremental anchor — the head the last clean round reviewed. Typed
   * as possibly-repeated because yargs collapses a repeated flag into an
   * array and the recovery flow can produce one; `runFetchPr` normalizes.
   */
  since?: string | string[];
  /**
   * WHO certified the `--since` anchor: the `lastModelId` beside it in the
   * cache, or the `model` beside the marker's `sha`. Copied through verbatim
   * — the orchestrator never compares it to anything, because a comparison
   * stated in prompt text is one that can be skipped, and because the two
   * sides are not even the same kind of string there (`{{model}}` is the bare
   * `config.getModel()`; what the CLI writes is provider-qualified). The gate
   * lives HERE, over `certifierMatchesRound`, which is the same function the
   * marker-recovery ruling uses.
   *
   * Omitted for an anchor nobody certified — a cache written before the
   * field. That is a mismatch, not a pass.
   */
  sinceModel?: string | string[];
}

type FetchPrResult = PlanReport & {
  /** The review's effort, recorded so the roster reads one value everywhere. */
  effort?: ReviewEffort;
  prNumber: string;
  ownerRepo: string;
  remote: string;
  ref: string;
  fetchedSha: string;
  /**
   * When this review window opened (ISO-8601). `cleanup` audits the PR for
   * writes by the current user inside [fetchedAt, cleanup) that did not go
   * through `qwen review submit` — the submit-only contract's tripwire.
   */
  fetchedAt: string;
  /**
   * Earliest `fetchedAt` across drift restarts of the SAME PR (the head-drift
   * rule reruns fetch-pr, overwriting this report). Cleanup audits from here,
   * so a write made during an abandoned attempt stays inside the window.
   */
  auditSince: string;
  /** GitHub host this PR lives on (Enterprise), null for github.com — so the
   * cleanup audit queries the same host the review did. */
  host: string | null;
  worktreePath: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  diffStat: { files: number; additions: number; deletions: number };
  /**
   * The merge-base diff is EMPTY: the branch tree is byte-identical to its
   * base — the work already landed (a merge resolved everything away, or the
   * PR was superseded). Reviewing it would review nothing; the skill stops and
   * says so instead of fanning out agents over zero hunks.
   */
  emptyDiff?: boolean;
  /**
   * The recomputed merge-base diff is far smaller than the PR's advertised
   * GitHub stat — overlapping PRs merged since the author's last rebase have
   * collapsed this one to a residual, and the description likely narrates work
   * that is already on the base branch. The review scope is the RECOMPUTED
   * diff; the body's claims about the rest are description-of-history.
   */
  collapsedFromUpstream?: boolean;
  /** Merge-base of the PR head and its base branch — the diff's left side. */
  mergeBaseSha: string | null;
  /** True when the base branch could not be fetched; `mergeBaseSha` may be stale. */
  baseFetchFailed: boolean;
  /** Project-relative path to the captured diff (null if capture or planning failed). */
  diffPath: string | null;
  /** Absolute path — `read_file` rejects relative paths. Agents use this. */
  diffPathAbsolute: string | null;
  /**
   * SHA-256 of the captured diff's raw bytes — the identity of WHAT this run
   * reviews, hashed from the same buffer the diff file was written from (the
   * `diffHashOf` discipline: one read, no TOCTOU window). Groundwork for the
   * stack's `--resume` (the next PR): its ruling will compare this against
   * the diff file on disk — a mismatch means the input changed, and changed
   * input re-runs; the checkpoint key is content, never a path or a
   * timestamp. No reader exists at THIS commit. Null when no diff was
   * captured.
   */
  diffSha256: string | null;
  /**
   * True when the PR description contains Han characters — the author writes
   * Chinese. `compose-review` reads it from this report (its `planPath`) and
   * renders the posted body bilingually, English first with the full Chinese
   * version collapsed; the skill mirrors the format on inline comments. A
   * local review's plan has no such field: nothing is posted there.
   */
  prDescriptionHasHan: boolean;
  /**
   * The model this ROUND started under — the runtime identity at capture
   * time, stamped here because nothing else in the flow remembers it.
   *
   * `compose-review` certifies the posted anchor with the model that did the
   * review, and its only other source is `QWEN_CODE_MODEL` read at compose
   * or submit time. That env tracks the session's CURRENT model: the
   * documented deferred-post flow — review under A, `/model` to B, "post
   * comments" — then certified A's range as B, and the next round under B
   * scoped `sha..HEAD` past code B never reviewed. A stamp taken when the
   * diff was captured is the one value that cannot drift out from under the
   * work it describes.
   *
   * Absent on a report written before this field. Compose keeps its previous
   * behaviour there rather than withholding every anchor: a report is written
   * at the start of the round and read at its end, so a missing stamp means
   * the CLI was upgraded between the two — and on a runtime that publishes no
   * model id at all, the runtime side of the comparison is empty too, so the
   * pair is certified by the same declared fallback as before this field.
   */
  reviewModelId?: string;
  /**
   * Present when `--since <sha>` was passed: the incremental-review scoping
   * decision, validated HERE so the orchestrator never hand-runs git against
   * an anchor. `effective: true` without `upToDate` means the diff and plan
   * in this report cover `since..fetchedSha` instead of the merge-base range.
   * `upToDate: true` means nothing has landed since the anchor (the anchor is
   * the head, or the commits since it change no bytes) — a fact about the
   * anchor, proven without consulting the base. The diff and plan then cover
   * the FULL range, because the flows that continue past an up-to-date
   * anchor (a model change, `--comment`) run a full review; when that range
   * could not be captured, `diffPath` is null and those flows read the
   * ordinary degraded state, while the flow that stops the round needs no
   * plan at all.
   * `effective: false` carries the reason the anchor was refused, and every
   * reason names a CAUSE: a rebase or force-push (`not-an-ancestor`), a sha
   * this history has never seen (`unknown-commit`), an anchor older than the
   * merge base that would scope WIDER than the PR's diff
   * (`behind-merge-base`), a delta carrying hunks the PR's own diff does not
   * contain (`hunks-outside-pr-diff` — an "undo per feedback" revert makes an
   * in-range anchor produce them), a containment check that could not be
   * RULED because the parser cannot name a path (`containment-unverified`),
   * a merge base too stale to rule the clamp on (`base-untrusted`), a
   * capture that threw (`capture-failed`), or a partitioner that refused to
   * tile (`partition-failed`).
   *
   * Whether a PLAN exists is a separate fact, and it is `diffPath`: null
   * means this round has no diff to review, whatever refused the anchor. A
   * reader keys the degraded flow on that, never on the reason — a single
   * field meaning both is what renamed deterministic refusals into the
   * class the skill retries.
   */
  incremental?: IncrementalDecision;
};

export interface IncrementalDecision {
  since: string;
  effective: boolean;
  upToDate?: boolean;
  reason?:
    | 'unknown-commit'
    | 'not-an-ancestor'
    | 'behind-merge-base'
    | 'hunks-outside-pr-diff'
    | 'containment-unverified'
    | 'lineage-unfollowable'
    | 'cross-model-anchor'
    | 'base-untrusted'
    | 'capture-failed'
    | 'partition-failed';
  /**
   * The scoped range's left side as a FULL sha, present exactly when the
   * report's diff is the delta (`effective` and not `upToDate`). Downstream
   * consumers that recompute their own ranges read it instead of
   * `mergeBaseSha` — Agent 7's test-efficacy probe welds `--base` into its
   * brief, and probing the full range on a delta-scoped round would spend
   * the probe budget on already-reviewed hunks and report survivors from
   * outside this round's scope.
   */
  diffBase?: string;
  /**
   * WHICH files this round reviews and why, present with `diffBase`. The
   * scoped diff is a slice of the PR's own, so a file can be in scope with no
   * change of its own: `interaction` names the still-clean importers the
   * one-hop widening pulled in, with the changed files each of them imports,
   * and a brief built for one points its agent at that seam instead of a
   * from-scratch re-review.
   */
  scope?: IncrementalScope;
  /**
   * Where the superseded FULL-range diff was kept. A later step that needs
   * the whole PR — Agent 0's issue fidelity, the reverse audit's whole-file
   * lens — reads it instead of re-running the capture. Absent when it could
   * not be written; the round is unaffected.
   */
  fullDiffPath?: string;
}

/** Thrown when a probe could not answer — the git surface, not a verdict. */
class GitUnavailable extends Error {}

/** The git questions the anchor ruling asks, injectable for tests. */
export interface AnchorProbe {
  /**
   * `git cat-file -e <sha>` — does this history hold that object? Bare, with
   * no `^{commit}` peel: peeling makes git answer 128 for a well-formed but
   * unknown sha, which is indistinguishable from the surface failing.
   * Commit-ness is `resolveCommit`'s job.
   */
  commitExists(sha: string): boolean;
  /** `git merge-base --is-ancestor <a> <b>` — is it behind the fetched head? */
  isAncestor(a: string, b: string): boolean;
  /** `git rev-parse <sha>^{commit}` — the full sha, for the head comparison. */
  resolveCommit(sha: string): string | null;
}

/**
 * Rule on an incremental anchor against the fetched history. Pure — the
 * probe is the git surface — because the SKILL used to ask the orchestrator
 * to run these exact checks by hand, and a hand-run check is one a run can
 * skip. The hex allowlist comes first so an anchor recovered from a marker
 * or cache is never handed to git as something flag-shaped.
 *
 * `diffBase` is the full sha to scope the diff from, null when the diff must
 * stay full-range (anchor refused, or already at the head).
 *
 * `mergeBase`'s `sha`, when one was resolved, is the clamp: an anchor that is
 * an ancestor of the head but OLDER than the merge base would scope a range
 * strictly
 * WIDER than the PR's own diff (`anchor..head` = the PR plus a slice of base
 * history) — re-reviewing already-landed hunks whose comments fall outside
 * every hunk of GitHub's PR diff, where a single one 422s the whole Create
 * Review call. Reachable non-adversarially: commits from the PR branch
 * landing in the base between rounds move the merge base past the cached
 * anchor. A null `sha` skips the clamp, consistent with the capture path's
 * base-free design — but a `fetchFailed` base that DID resolve a sha refuses
 * the anchor: the clamp would then be ruling on a base resolved from a
 * possibly stale local ref, and every sibling guard here (`isEmptyDiff`,
 * `isCollapsedFromUpstream`) declines to rule in that state rather than
 * ruling on it. `{fetchFailed: true, sha: null}` is not that state — there
 * is no clamp to rule at all, and the delta range needs no base.
 */
export function resolveIncrementalAnchor(
  rawSince: string,
  fetchedSha: string,
  probe: AnchorProbe,
  mergeBase: { sha: string | null; fetchFailed: boolean } | null = null,
): { incremental: IncrementalDecision; diffBase: string | null } {
  // git resolves hex case-insensitively, and an operator pasting an
  // uppercase sha (some UIs render them that way) was refused before any
  // probe ran, under a reason asserting the history never held it — and the
  // cased value was echoed back, so a recovery flow re-deriving the anchor
  // from the report was refused again every round. Normalise once, here, so
  // the CLI path and the marker path still share one predicate.
  const since = rawSince.toLowerCase();
  // The SAME shape predicate the ledger marker applies, imported rather than
  // restated: an anchor the marker will not carry must not be one the fetch
  // accepts, or the cache path and the marker path drift apart.
  if (!SHA_RE.test(since) || !probe.commitExists(since)) {
    return {
      incremental: { since, effective: false, reason: 'unknown-commit' },
      diffBase: null,
    };
  }
  // Commit-ness BEFORE ancestry. An existing non-commit object (a blob sha
  // in a cache or marker) passes `cat-file -e`, and asking `merge-base
  // --is-ancestor` about it is an ERROR, not a "no" — which the ancestry
  // probe reports as an unavailable git surface, so the anchor was called
  // transient and retried forever. Resolving first turns that whole class
  // into what it is: an anchor this history holds no commit for.
  const resolved = probe.resolveCommit(since);
  if (resolved === null) {
    return {
      incremental: { since, effective: false, reason: 'unknown-commit' },
      diffBase: null,
    };
  }
  if (resolved === fetchedSha) {
    return {
      incremental: { since, effective: true, upToDate: true },
      diffBase: null,
    };
  }
  // Ancestry is asked about the RESOLVED commit, so a non-commit can no
  // longer reach it and an error here really is the git surface.
  if (!probe.isAncestor(resolved, fetchedSha)) {
    return {
      incremental: { since, effective: false, reason: 'not-an-ancestor' },
      diffBase: null,
    };
  }
  // Only when a base was actually resolved: with `sha: null` there is no
  // clamp to rule, stale or otherwise, and the docstring's "a null `sha`
  // skips the clamp" holds — the delta range needs no base at all, so a
  // deleted or renamed base branch must not cost a valid anchor its scope.
  if (mergeBase?.fetchFailed && mergeBase.sha != null) {
    return {
      incremental: { since, effective: false, reason: 'base-untrusted' },
      diffBase: null,
    };
  }
  if (mergeBase?.sha != null && !probe.isAncestor(mergeBase.sha, resolved)) {
    return {
      incremental: { since, effective: false, reason: 'behind-merge-base' },
      diffBase: null,
    };
  }
  return { incremental: { since, effective: true }, diffBase: resolved };
}

/**
 * Does every hunk of `inner` fall inside `outer`, per file?
 *
 * This is the containment an ancestry clamp cannot give. An anchor can be a
 * proper ancestor of the head and still produce a delta whose hunks are absent
 * from the PR's own diff: an "undo per feedback" commit reverts some of the
 * previous round's lines back to base content, so those lines are changed in
 * `anchor..head` and unchanged in `base..head`. A comment anchored on such a
 * hunk 422s the whole Create Review call.
 *
 * The result is TWO facts, not one: DISPROVED containment and an oracle that
 * could not rule are different, and only the first is what
 * `hunks-outside-pr-diff` asserts. A boolean wrapper over this used to exist
 * for the tests' convenience; it collapsed exactly the split the refusal enum
 * pays to keep, so callers take the pair.
 *
 * The grammar is NOT re-implemented here. Three rounds of review found a new
 * shape-tolerance defect in a hand-rolled parser every time — count-less
 * headers, trailing function context, quoted rename headers, deletion
 * junctions — so this reads the sections and hunks out of `parseDiff`, the
 * parser the chunk planner already trusts on these exact captures (it
 * unquotes paths, tracks hunk bodies, and knows the binary and rename
 * shapes). A ruling is then set arithmetic over its output.
 */
export function containmentRuling(
  inner: string,
  outer: string,
): { ok: boolean; unverified: boolean } {
  // Both captures reach here already decoded as UTF-8, and that decode is
  // LOSSY: every byte git emitted that is not valid UTF-8 — in a path or in a
  // line's content — arrives as one U+FFFD. Distinct bytes therefore become
  // the same character, and everything below compares decoded strings: two
  // filenames differing only in an invalid byte share one map key, so one
  // file's hunks get judged against the other's ranges; two byte-distinct
  // deleted lines match each other 1:1. Neither is detectable after the
  // decode, so the oracle declines to rule rather than ruling on text it
  // knows is not the text git produced. A file that legitimately contains
  // U+FFFD refuses too — a full review, which is the safe direction.
  if (inner.includes('�') || outer.includes('�')) {
    return { ok: false, unverified: true };
  }
  const innerSections = sectionsOf(inner);
  const outerSections = sectionsOf(outer);
  if (innerSections === null || outerSections === null) {
    return { ok: false, unverified: true };
  }
  return {
    ok: sectionsContained(innerSections, outerSections),
    unverified: false,
  };
}

/**
 * What one HUNK contributes to a ruling.
 *
 * Two facts, because the two sides of a diff are comparable in different ways.
 * The captures share a head tree, so their NEW-side line numbers name the same
 * lines and compare as numbers. Their OLD sides are different trees — the
 * anchor and the merge base — so old-side line numbers name nothing in common
 * and deletions compare only by CONTENT.
 *
 * The pairing is what makes the content comparison sound. Held per FILE, a
 * `-X` the PR displays in one hunk cleared a `-X` the delta performs thirty
 * lines away in another — a line displayed nowhere near where the delta
 * deletes it. Locality is available (the head tree is shared, which is the
 * same fact the range check already rests on), so it is used: a deletion is
 * matched only against hunks that ENCLOSE the hunk performing it.
 */
interface HunkFacts {
  /** New-side range of this hunk. */
  range: [number, number];
  /**
   * This hunk body's `-` lines as `content@junction`.
   *
   * The junction is the new-side cursor where the deleted line stood: context
   * and `+` lines advance it, `-` lines do not — the same walk `parseDiff`
   * performs. Content alone was not enough. Two hunks can delete the same text
   * at different places, and matching by text let a delta's `-dup` be cleared
   * by a `-dup` the PR displays thirty lines away, in a hunk that never
   * touches the delta's junction. Junctions are comparable for the same reason
   * ranges are: both captures end at the same head tree.
   */
  deletions: string[];
}

/** `path -> hunks`, via the shared parser. Null if it found nothing in a
 *  non-empty diff, which is the "could not rule" state. */
function sectionsOf(diffText: string): Map<string, HunkFacts[]> | null {
  const { files } = parseDiff(diffText);
  if (diffText.trim() !== '' && files.length === 0) return null;
  // Split once: `containmentRuling` runs on every incremental capture, and
  // re-splitting per hunk made it quadratic in the diff size.
  const lines = diffText.split('\n');
  const out = new Map<string, HunkFacts[]>();
  for (const f of files) {
    // A section with no hunk at all — a mode change, a binary replacement, a
    // pure rename — carries nothing to compare. It enters as an EMPTY list so
    // the path check still runs: each used to pass vacuously, which is how a
    // delta whose only content is a file the PR's own diff never mentions
    // became the scope.
    const hunks = out.get(f.path) ?? [];
    for (const h of f.hunks) {
      // A pure deletion (`newCount === 0`) sits BETWEEN two post-image lines;
      // `parseDiff` already clamps its range to the junction, and comparing
      // that junction against a covering hunk is what keeps a deletion the
      // PR's own diff performs from being refused.
      const deletions: string[] = [];
      // Body lines only. `diffStart` is the `@@` header's own 1-based line
      // number, so the body begins at that index and ends at `diffEnd - 1`;
      // starting at the header would read `---` file metadata as a deletion.
      let cursor = h.newStart;
      for (let i = h.diffStart; i < h.diffEnd; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.startsWith('-')) {
          // Where this line stood on the new side: between the lines the
          // cursor has and has not yet reached.
          deletions.push(`${cursor}\u0000${line.slice(1)}`);
        } else if (
          line.startsWith('+') ||
          line === '' ||
          line.startsWith(' ')
        ) {
          // Both occupy a new-side line. A `\ No newline at end of file`
          // marker is neither, and must not move the cursor.
          cursor++;
        }
      }
      hunks.push({ range: [h.newStart, h.newEnd], deletions });
    }
    out.set(f.path, hunks);
  }
  return out;
}

/** The containment loop over already-parsed sections. */
function sectionsContained(
  inner: Map<string, HunkFacts[]>,
  outer: Map<string, HunkFacts[]>,
): boolean {
  for (const [file, hunks] of inner) {
    const covering = outer.get(file);
    if (!covering) return false;
    // A delta section with nothing comparable — a mode change, a pure rename,
    // a binary replacement — carries no hunk at all, so the loop below iterates
    // zero times and the section passes vacuously. That is the right answer
    // only when the PR's own section is equally contentless (two binary
    // sections, say). When the covering section HAS hunks, the delta is
    // asserting a change of a kind the PR's diff does not show — an "undo per
    // feedback" round that reverts round 1's `chmod +x` is exactly this shape —
    // and vacuous truth is the wrong verdict for it.
    if (hunks.length === 0 && covering.length > 0) return false;

    // Keyed by `content@junction`, not content. The entry a delta deletion
    // consumes must be the one the PR displays AT THAT PLACE: matching by text
    // alone let a `-dup` the PR shows near the top of the file clear a `-dup`
    // the delta performs thirty lines down, at a junction the PR's diff never
    // touches. Junctions are comparable for the same reason ranges are — both
    // captures end at the same head tree.
    //
    // ONE budget for the whole file, consumed across every delta hunk, so a
    // single displayed deletion is spent once. Measured honestly: with the
    // junction in the key this is not observable — two delta hunks cannot
    // delete at the same junction — so it is the invariant stated where it
    // belongs rather than a live guard. Rebuilding it per hunk would make
    // correctness depend on junction-uniqueness without saying so.
    const budget = new Map<string, number>();
    for (const o of covering) {
      for (const d of o.deletions) budget.set(d, (budget.get(d) ?? 0) + 1);
    }

    for (const hunk of hunks) {
      const [start, end] = hunk.range;
      // Strict containment, no slack. Both captures share the head tree, so
      // a deletion the PR's own diff performs yields an identical junction
      // range and is covered at equality; slack for it bought nothing and
      // accepted a delta hunk one line past the covering hunk — a line
      // GitHub's PR diff does not display, where an anchored comment 422s
      // the entire all-or-nothing Create Review call.
      if (!covering.some((o) => o.range[0] <= start && end <= o.range[1])) {
        return false;
      }

      // Deleted lines occupy NO new-side line, so the range check above is
      // blind to them: what survives a deletion hunk on the new side is its
      // context, which the covering hunk contains for free. A delta that
      // deletes a line the PR's own diff never displays passed the range check
      // outright.
      //
      // The discriminator is where the line came from. `-X` in the delta means
      // X stood at the anchor and is gone at head. If X also stood at the merge
      // base then the PR — which ends at that same head — must delete it too,
      // so `-X` appears in the full capture, at the same junction. So the
      // converse is the refusal: no such entry means the PR introduced X after
      // the base and took it back out, and GitHub's PR diff shows that line on
      // neither side. An inline comment anchored there 422s the entire
      // all-or-nothing Create Review call.
      for (const deleted of hunk.deletions) {
        const left = budget.get(deleted) ?? 0;
        if (left === 0) return false;
        budget.set(deleted, left - 1);
      }
    }
  }
  return true;
}

/**
 * Allowlist shape for a server-controlled branch name reaching git's argv:
 * a plain branch name and nothing else (twin of aone.ts's guard — see that
 * comment for each admitted channel's wrong outcome). Fail closed: an
 * unusual-but-legal name is refused with a clear metadata-stage error
 * rather than guessed at inside a git invocation. The pseudo-ref set rides
 * the same rejection: `FETCH_HEAD` resolves to the JUST-fetched PR head
 * (merge-base(head, head) = empty diff beside full-range metadata), and
 * `ORIG_HEAD` to an arbitrary ancestor — both shape-legal, both silently
 * wrong. The match is CASE-INSENSITIVE: on case-insensitive filesystems
 * (macOS/Windows defaults) `.git/fetch_head` folds onto `.git/FETCH_HEAD`,
 * so the lowercase spellings reach the same pseudo-refs. `refs/`-prefixed
 * names ride the same rejection: they are legal branch names
 * (`git check-ref-format --branch` accepts `refs/heads/x`), but as a
 * fetch/merge-base argument they resolve QUALIFIED refs the server
 * controls — a wrong base disclosed only by a misdescribing warning.
 */
const GIT_PSEUDO_REFS =
  /^(FETCH|ORIG|MERGE|CHERRY_PICK|REVERT|REBASE|BISECT)_HEAD$/i;

function isPlainBranchName(name: string): boolean {
  return (
    name.toUpperCase() !== 'HEAD' &&
    !GIT_PSEUDO_REFS.test(name) &&
    !name.includes('..') &&
    !/^refs\//i.test(name) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
  );
}

/** The real git surface `resolveMergeBase` runs against. */
const gitProbe: GitProbe = {
  // `--` ends option parsing: the base ref is server-controlled platform
  // metadata (GitHub `baseRefName`, Aone `targetBranch`), and a dash-leading
  // value must never reach git as an option (`git fetch origin
  // --upload-pack=<payload>` executes the attacker-named program on the
  // remote host with the reviewer's credentials).
  //
  // The fetch must ALSO have produced the tracking ref: a bare-name fetch
  // of a TAG exits 0 writing only FETCH_HEAD (`* tag v1.0 -> FETCH_HEAD`),
  // so the fetch "succeeds" yet no `origin/<ref>` exists — and the
  // bare-name fallback then merge-bases against the reviewer's LOCAL tag:
  // a wrong-base diff with baseFetchFailed falsely false. The fetch is an
  // EXPLICIT BRANCH REFSPEC: the source is fully qualified (git dwims a
  // bare name onto a same-named TAG and exits 0 without updating the
  // tracking ref — a pushable, server-controlled shadow that passes the
  // freshness guard it never refreshed), and the destination is the
  // qualified tracking ref. The backstop check is FULLY QUALIFIED
  // (`refs/remotes/…`): an unqualified `origin/<ref>` resolves in
  // refs/tags and refs/heads FIRST, so a tag or branch named
  // `origin/<ref>` — likewise pushable, auto-carried at clone time — would
  // satisfy the check with no tracking ref present.
  fetch: (remote, ref) =>
    gitOpt(
      'fetch',
      remote,
      '--',
      `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`,
    ) !== null && refExists(`refs/remotes/${remote}/${ref}`),
  refExists,
  mergeBase: (a, b) => gitOpt('merge-base', a, b),
};

function tryRemove(action: () => void): void {
  try {
    action();
  } catch {
    /* idempotent — silent on missing target */
  }
}

function cleanStale(prNumber: string): void {
  releaseWorktree(worktreePath(prNumber));
  const ref = reviewBranch(prNumber);
  if (refExists(ref)) {
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
    );
  }
}

/**
 * Is `path`'s tree entry identical at both ends of the PR?
 *
 * The whole ENTRY — `<mode> <oid>` — not the blob. `rev-parse <ref>:<path>`
 * yields the oid alone, so a fix round that reverts the content and keeps
 * `chmod +x`, or swaps a file for a symlink with the same text, compared equal
 * and was scoped out as "restored". Its mode-only section IS in the PR's diff,
 * so dropping it put a change nobody reviewed past the next round's anchor.
 *
 * Absent on BOTH sides is deliberately NOT a restoration. Two shapes produce
 * it and this layer cannot tell them apart: a file the PR added and this round
 * deleted (net-zero — safe), and a file renamed before the anchor and deleted
 * now, whose unreviewed deletion hunks sit in the PR diff under its pre-rename
 * name (dropping it loses them). Refusing costs a full review on the first
 * shape; dropping loses scope on the second, so the refusal wins.
 */
function treeEntryUnchanged(
  baseSha: string,
  headSha: string,
  path: string,
): boolean {
  const at = (ref: string): string | null => {
    const line = gitOpt(LITERAL_PATHSPECS, 'ls-tree', ref, '--', path);
    if (line === null || line === '') return null;
    const tab = line.indexOf('\t');
    const meta = (tab < 0 ? line : line.slice(0, tab)).split(' ');
    return meta.length >= 3 ? `${meta[0]} ${meta[2]}` : null;
  };
  const b = at(baseSha);
  const h = at(headSha);
  return b !== null && h !== null && b === h;
}

async function runFetchPr(args: FetchPrArgs): Promise<void> {
  // Sampled HERE, at the start of the round: see `reviewModelId`.
  const roundModelId = roundModelIdFrom(process.env);
  const { pr_number: prNumber, owner_repo: ownerRepo, remote, out } = args;

  // The lease gate below only engages `pr-\d+` targets, but `cleanStale`
  // destroys `worktreePath(prNumber)` for ANY input (`path.join` even
  // normalizes `'5/.'` onto PR 5's tree). Refuse every other shape before the
  // gate, or a malformed number sails past it lease-less and deletes a live
  // holder's state — #9205 with the lock never engaged. Same check, same
  // message shape, as the sibling commands.
  if (!/^\d+$/.test(prNumber) || Number(prNumber) <= 0) {
    throw new Error(
      `fetch-pr: pr_number must be a positive integer, got ${JSON.stringify(prNumber)}`,
    );
  }

  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  // Validate before coercing: Number('1e3') is 1000, so an unvalidated token
  // would fetch a DIFFERENT PR's head while the ref/worktree/report all carry
  // the caller's label. `[1-9]` also rejects `0` (no PR zero — the message
  // promises a POSITIVE integer, and admitting it ran detection, auth, and a
  // worktree lease before dying at the fetch) and leading zeros (the label
  // would not round-trip through Number). The skill path is guarded by
  // parse-args' digit grammar; this is the direct-CLI surface.
  if (!/^[1-9]\d*$/.test(prNumber)) {
    throw new Error(
      `pr_number must be a positive integer, got ${JSON.stringify(prNumber)}`,
    );
  }

  const ref = reviewBranch(prNumber);
  const wt = worktreePath(prNumber);

  // The lease is also a lock. The worktree path is fixed per PR number, so
  // the stale-clean below would remove a worktree ANOTHER session is actively
  // reviewing — that is precisely how #9205 destroyed a round-4 review mid-run.
  // Refuse before touching anything; the refusal must precede both the lease
  // write and `cleanStale`, because a fetch-pr that fails AFTER either one
  // has still clobbered the holder's lease and state. Same-session re-fetches
  // (drift restarts, later rounds of a multi-prompt review) pass: ownership
  // is per session, not per prompt.
  const leaseTarget = `pr-${prNumber}`;
  const sessionId = process.env['QWEN_CODE_SESSION_ID'];
  const promptId = process.env['QWEN_CODE_PROMPT_ID'];
  // The lease write no-ops without both ids, and a lease-less run builds
  // the whole review state unprotected — a later session passes the empty
  // gate and destroys it mid-run (#9205 again). Refuse before touching
  // anything: the fail-closed rule the gate applies to taking over a
  // lease applies to acquiring one too.
  if (!sessionId || !promptId) {
    throw new Error(
      `fetch-pr: QWEN_CODE_SESSION_ID and QWEN_CODE_PROMPT_ID must both ` +
        `be set to register the review worktree lease. Run fetch-pr from ` +
        `a Qwen Code session (the /review skill sets both); without the ` +
        `lease nothing locks the shared worktree path against a ` +
        `concurrent session.`,
    );
  }
  const holder = readReviewWorktreeLease(process.cwd(), leaseTarget);
  if (reviewLeaseHeldByAnotherSession(holder)) {
    throw new Error(
      `PR #${prNumber} is already being reviewed by another session ` +
        `(session ${holder.sessionId}). Same-PR reviews share one worktree ` +
        `path and cannot run concurrently, so this run refuses rather than ` +
        `destroy the other session's state. Wait for that session to finish ` +
        `— its cleanup releases the lease — or, only if that session is ` +
        `gone, delete ${reviewLeasePath(process.cwd(), leaseTarget)} and ` +
        `re-run.`,
    );
  }
  // The lock above refuses any later session that finds another
  // session's lease, so one left behind by ANY failure after this point
  // would block every later review of this PR until deleted by hand.
  // Roll it back on every throw; the branch rollbacks stay where the
  // ref they remove is created.
  try {
    // 0. Register the lease. Inside the rollback so a failed write
    //    (ENOSPC, lost acquire race) cannot escape the catch; the
    //    rollback's removal is safe when nothing was written.
    createReviewWorktreeLease({
      sessionId,
      promptId,
      target: leaseTarget,
      repositoryRoot: process.cwd(),
      worktreePath: wt,
      branch: ref,
    });

    // Select the platform from the remote under review (falling back to the
    // cwd clone's origin), so an Aone clone fetches the Aone ref via a1
    // while a GitHub clone keeps `pull/<n>/head` via gh. Trim the host:
    // isAoneHost does not trim, and a padded `--host` would silently drop
    // to GitHub here. Runs INSIDE the lease gate: the refusal above must
    // precede every call this command makes — the detection probe included
    // — and a detection/auth failure rolls the lease back through the catch.
    let remoteUrl: string | undefined;
    try {
      remoteUrl = git('remote', 'get-url', remote).trim();
    } catch {
      remoteUrl = undefined;
    }
    const platform = getPlatformReader({ remoteUrl, host: args.host?.trim() });
    platform.ensureAuthenticated();

    // 1. Clean any stale worktree / branch from an earlier run.
    cleanStale(prNumber);

    // 2. Fetch PR HEAD into a unique local ref. The refspec source is
    //    platform-specific: GitHub `pull/<n>/head`, Aone
    //    `refs/merge-requests/<global-id>/head`.
    try {
      git(
        'fetch',
        remote,
        `${platform.fetchHeadRefSpec(Number(prNumber))}:${ref}`,
      );
    } catch (err) {
      throw new Error(
        `Failed to fetch PR #${prNumber} from remote "${remote}": ${(err as Error).message}`,
      );
    }
    // QUALIFIED: an unqualified `ref` resolves in refs/tags BEFORE
    // refs/heads, so a planted tag with the throwaway branch's name (fully
    // attacker-known, no pid here) would silently name the tag's commit as
    // the fetched head while the worktree shows the real one.
    const fetchedSha = git('rev-parse', `refs/heads/${ref}`);

    // 3. Fetch PR metadata via the platform. Cross-repo flag tells the LLM
    //    whether to switch into lightweight mode.
    let meta: PrMetadata;
    try {
      const fetchMeta = platform.getFetchMeta(Number(prNumber), ownerRepo);
      meta = {
        headRefName: fetchMeta.headRefName ?? prNumber,
        headRefOid: fetchMeta.headRefOid,
        baseRefName: fetchMeta.baseRefName,
        // Platforms without advertised stats (Aone) fill these from the
        // captured diff after step 5.
        additions: fetchMeta.additions ?? 0,
        deletions: fetchMeta.deletions ?? 0,
        changedFiles: fetchMeta.changedFiles ?? 0,
        isCrossRepository: fetchMeta.isCrossRepository,
        body: fetchMeta.body,
      };
      // The base ref is server-controlled metadata reaching git's argv through
      // the base fetch below. The fetch probe passes `--`, but that only ends
      // OPTION parsing — validate ALLOWLIST-style, accepting only a plain
      // branch name (the twin of aone.fetchDiff's target guard, whose comment
      // names each admitted channel's wrong outcome: option spellings, `+`
      // force refspec, `src:dst` colon refspec, `HEAD`'s silent fetch + stale
      // clone-time symref merge-base, rev-parse metasyntax, the empty
      // string). A hostile platform value dies here with the metadata rolled
      // back, not inside a git invocation.
      if (!isPlainBranchName(meta.baseRefName)) {
        throw new Error(
          `refusing base ref ${JSON.stringify(meta.baseRefName)} from the ` +
            `platform metadata — not a plain branch name`,
        );
      }
    } catch (err) {
      // Roll back the fetched ref so the next run starts clean.
      tryRemove(() =>
        execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
      );
      throw new Error(
        `Failed to fetch PR #${prNumber} metadata: ${(err as Error).message}`,
      );
    }
    // Aone does not advertise diff stats; compute them from the captured diff
    // once it exists. Tracked so the recomputed numbers replace the zeros.
    const needsLocalStats = platform.kind !== 'github';

    // 4. Create the ephemeral worktree.
    try {
      mkdirSync(dirname(wt), { recursive: true });
      git('worktree', 'add', wt, ref);
    } catch (err) {
      tryRemove(() =>
        execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
      );
      throw new Error(
        `Failed to create worktree at ${wt}: ${(err as Error).message}`,
      );
    }

    mkdirSync(REVIEW_TMP_DIR, { recursive: true });

    // 5. Capture the diff to a file and partition it. The capture is decoded
    //    to UTF-8 text and written back as text, so a byte sequence that is
    //    not valid UTF-8 becomes U+FFFD — this file is READ, never applied:
    //    chunk agents read ranges out of it and `diffHashOf` hashes it. What
    //    the round trip does not do is normalise CRLF (that would rewrite
    //    every hunk of a CRLF file) or drop the trailing newline.
    const { sha: mergeBaseSha, baseFetchFailed } = resolveMergeBase(
      remote,
      meta.baseRefName,
      // QUALIFIED — the head side is dwim-shadowable exactly like the
      // fetchedSha read above.
      `refs/heads/${ref}`,
      gitProbe,
    );
    if (baseFetchFailed) {
      writeStderrLine(
        `WARNING: could not fetch ${remote}/${meta.baseRefName}. The merge-base ` +
          `is resolved from a possibly stale local ref, so the diff may not be ` +
          `the one under review.`,
      );
    }
    const diffRel = tmpFile(`pr-${prNumber}`, 'diff.txt');
    let diffPath: string | null = null;
    let diffPathAbsolute: string | null = null;
    let diffSha256: string | null = null;
    let diffText = '';
    // Every knob user config could turn is pinned in `lib/diff-flags.ts`,
    // shared with `capture-local` so the two capture paths cannot drift into
    // producing diffs that parse differently. Null on a failed capture — the
    // callers distinguish "captured empty" from "could not capture". The
    // capture returns TEXT ONLY: publishing `diffPath` is the ACCEPTING
    // caller's decision, because `isEmptyDiff`'s invariant is that `diffPath`
    // is set only on a successful capture of the diff being judged — a
    // producer that published on every success leaked an empty delta's path
    // into the full-range judgment and recommended a live PR for closure on
    // an infrastructure state.
    const readRange = (left: string): Buffer | null => {
      try {
        // BYTES, not text. `diffSha256` identifies the published diff for the
        // resume comparison, and a diff of a binary-adjacent or latin1 file
        // contains bytes that are not valid UTF-8: decoding first collapses
        // them onto U+FFFD, so the digest would no longer name what was
        // written. The decode happens where text is actually wanted.
        return gitRaw(
          ...PINNED_DIFF_CONFIG,
          'diff',
          ...PINNED_DIFF_FLAGS,
          `${left}..${fetchedSha}`,
        );
      } catch (err) {
        writeStderrLine(`Failed to capture diff: ${(err as Error).message}`);
        return null;
      }
    };
    /**
     * Publish a range as THE reviewed diff — the file write and both paths.
     * False when the WRITE failed.
     *
     * The capture's try/catch used to cover the write too, so a full or
     * read-only tmp volume produced a diff-less report the round continued
     * from with disclosed partial coverage. Letting it throw instead killed
     * the command after the worktree existed and before any report was
     * written — the failure class the partition catch below calls out as one
     * that must not take the whole review with it.
     */
    const publish = (bytes: Buffer): boolean => {
      try {
        writeFileSync(diffRel, bytes);
      } catch (err) {
        writeStderrLine(`Failed to capture diff: ${(err as Error).message}`);
        return false;
      }
      diffText = bytes.toString('utf8');
      diffPath = diffRel;
      diffPathAbsolute = resolve(diffRel);
      // Digest of what was WRITTEN, over the bytes themselves. A round may read
      // two ranges before publishing one, so hashing at capture time would name
      // bytes no reader ever sees; hashing a decode of them would name bytes
      // nobody wrote.
      diffSha256 = createHash('sha256').update(bytes).digest('hex');
      return true;
    };

    // The incremental anchor rules first: an effective anchor scopes the diff
    // to `since..head` and the merge base is not consulted for the CAPTURE
    // (the range needs no base, so a failed base fetch does not cost the
    // incremental path) — but it IS consulted for the ruling, as the clamp
    // that keeps an anchor from scoping WIDER than the PR's own diff. Every
    // refusal falls back to the full range with its reason in the report —
    // never silently.
    let anchor: {
      incremental: IncrementalDecision;
      diffBase: string | null;
    } | null = null;
    // yargs collapses a REPEATED flag into an array, and the recovery flow
    // that appends a second `--since` to a command that already carries one
    // is exactly how that happens. Left unnormalized, the array stringifies
    // to `"shaA,shaB"`, the comma fails the hex allowlist, and a valid
    // in-history anchor is refused as `unknown-commit` with no git probe run
    // at all. The LAST value wins — a repeated flag means "use this one".
    const rawSince = Array.isArray(args.since)
      ? (args.since as string[])[args.since.length - 1]
      : args.since;
    // yargs' boolean-negation turns `--no-since` into `false` even for an
    // option declared `type: 'string'`. Anything that is not a string falls
    // through to the no-anchor path rather than reaching the hex test and,
    // later, `since.slice(…)` — which crashed the command after the worktree
    // existed and before any report was written.
    const sinceArg = typeof rawSince === 'string' ? rawSince : undefined;
    // WHO certified it, gated before the history is consulted at all: "clean
    // up to this sha" is the recorded identity's verdict, and `fetch-pr`
    // validates an anchor against the HISTORY, never against who certified
    // it — so an anchor from another model is ancestrally perfect and still
    // scopes this round past code it never reviewed.
    //
    // Ruled here rather than in the skill because every prompt-text version
    // of this comparison has been wrong: `{{model}}` interpolates the BARE
    // `config.getModel()` while every identity the CLI writes is
    // provider-qualified, so the two sides were never the same kind of string
    // and two providers exposing one model name passed each other's gate.
    // With the check here there is no identity comparison left in prompt text
    // at all — the orchestrator copies two fields and reads a decision.
    const rawSinceModel = Array.isArray(args.sinceModel)
      ? args.sinceModel[args.sinceModel.length - 1]
      : args.sinceModel;
    const sinceModel =
      typeof rawSinceModel === 'string' ? rawSinceModel : undefined;
    const crossModel =
      sinceArg !== undefined &&
      sinceArg !== '' &&
      !certifierMatchesRound(sinceModel, roundModelIdFrom(process.env));
    if (crossModel) {
      anchor = {
        incremental: {
          since: sinceArg,
          effective: false,
          reason: 'cross-model-anchor',
        },
        diffBase: null,
      };
      writeStderrLine(
        `Incremental anchor not used — it was certified by ` +
          `${sinceModel ? `"${sinceModel}"` : 'no recorded identity'}, and ` +
          `this review runs as ` +
          `${roundModelIdFrom(process.env) || 'an unpublished identity'}. ` +
          `Reviewing the full range.`,
      );
    } else if (sinceArg !== undefined && sinceArg !== '') {
      try {
        anchor = resolveIncrementalAnchor(
          sinceArg,
          fetchedSha,
          {
            // A predicate answers "no" with exit 1. Any other failure is the
            // git surface being unavailable — reported as such rather than as
            // a verdict about the anchor, because the two lead to opposite
            // recovery flows (retry the transient one, never the deterministic).
            // No `^{commit}` peel here: with it, real git answers a
            // well-formed but unknown sha with 128, so the definitive-absent
            // branch was unreachable and every unknown anchor was reported as
            // a transient failure the recovery flow retries forever. The
            // hex allowlist already keeps the value flag-safe, and commit-ness
            // is `resolveCommit`'s job, which now runs before ancestry.
            commitExists: (sha) => {
              const { status } = gitExit('cat-file', '-e', sha);
              if (status === 0) return true;
              // 1 = "no such object"; 128 = "not a valid object name", which
              // is what git says for an abbreviation or an over-long hex that
              // names nothing (a SHA-256 marker read against SHA-1 history).
              // Both are the object's absence — deterministic, never retried.
              // Only a spawn failure or a signal is the surface failing.
              if (status === 1 || status === 128) return false;
              throw new GitUnavailable();
            },
            isAncestor: (a, b) => {
              const { status } = gitExit('merge-base', '--is-ancestor', a, b);
              if (status === 0) return true;
              if (status === 1) return false;
              throw new GitUnavailable();
            },
            // Same three-way split as its siblings: this is the only probe
            // that used to fold a transient git failure into a verdict about
            // the anchor, because `gitOpt` returns null for every non-zero
            // exit. 128 means "not a commit" (a blob, a tree, a name this
            // history cannot resolve); anything else is the surface.
            resolveCommit: (sha) => {
              const { out, status } = gitExit('rev-parse', `${sha}^{commit}`);
              if (status === 0) return out;
              if (status === 128) return null;
              throw new GitUnavailable();
            },
          },
          { sha: mergeBaseSha, fetchFailed: baseFetchFailed },
        );
      } catch (err) {
        if (!(err instanceof GitUnavailable)) throw err;
        // The git surface, not the anchor: an error exit or a kill says
        // nothing about whether the anchor is valid, and calling it
        // `not-an-ancestor` would tell the recovery flow never to retry.
        anchor = {
          incremental: {
            since: sinceArg,
            effective: false,
            reason: 'capture-failed',
          },
          diffBase: null,
        };
      }
    } else if (sinceArg === '') {
      // yargs parses a bare `--since` (and `--since ""`) to the empty string.
      // Reporting it as `unknown-commit` would assert this history never held
      // a sha nobody supplied.
      writeStderrLine(
        'Ignoring --since with no value; reviewing the full diff.',
      );
    }
    /** Refuse the anchor, keeping every demotion one shape. */
    const demote = (
      reason: NonNullable<IncrementalDecision['reason']>,
    ): void => {
      if (!anchor) return;
      anchor.incremental = {
        since: anchor.incremental.since,
        effective: false,
        reason,
      };
    };
    // The FULL range is read once, up front, whenever a base exists — even on
    // an incremental round. It is not a redundant capture: it is the fallback
    // every refusal lands on, the quantity `emptyDiff`/`collapsedFromUpstream`
    // are defined against (both compare the PR's whole diff, never a delta),
    // and the containment oracle the clamp cannot be. Reading it costs one
    // `git diff`; the savings incremental review exists for are agent time.
    const fullBytes = mergeBaseSha === null ? null : readRange(mergeBaseSha);
    const fullText = fullBytes === null ? null : fullBytes.toString('utf8');
    if (mergeBaseSha === null) {
      writeStderrLine(
        `Could not resolve merge-base of ${meta.baseRefName} and ${ref}; ` +
          `agents will have to fall back to running \`git diff\` themselves.`,
      );
    }
    /** True when the FINAL published diff is the incremental delta. */
    let scopedDelta = false;
    if (anchor?.diffBase) {
      // The delta is read for ONE fact: which files changed since the anchor.
      // Their hunks come from the full-range diff — see
      // `computeIncrementalScope` for why the published bytes are a SLICE of
      // the PR's own diff and never a re-capture.
      //
      // An anchor that resolved to the merge base names the range already in
      // hand: re-running the identical `git diff` would spend the capture (and
      // its timeout) twice on the same bytes. Reachable without adversary —
      // commits older than the last round's head landing in the base.
      const deltaBytes =
        anchor.diffBase === mergeBaseSha
          ? fullBytes
          : readRange(anchor.diffBase);
      const delta = deltaBytes === null ? null : deltaBytes.toString('utf8');
      if (deltaBytes === null || delta === null) {
        // Infrastructure, not anchor validity — but the report must not claim
        // an incremental scope the capture never produced.
        demote('capture-failed');
      } else if (delta.trim() === '') {
        // Commits since the anchor change no bytes: nothing new to review.
        // Same outcome as anchor-at-head, and the full range is published
        // below for the flows that continue anyway (a model change,
        // --comment).
        anchor.incremental.upToDate = true;
      } else if (
        mergeBaseSha === null ||
        fullBytes === null ||
        fullText === null
      ) {
        // No full range to slice, and the reason must name WHICH cause,
        // because the recovery flow retries one class and not the other.
        //
        // `base-untrusted` when the base FETCH failed: the anchor was never
        // ruled invalid, and the component that failed is one the re-run
        // repeats, so a flappy fetch must not cost this PR its incremental
        // scope for ever. `capture-failed` when a base existed and reading
        // the range threw (the 120s git timeout the large long-lived PR
        // `--since` exists for) — also infrastructure, also retryable.
        // `containment-unverified` only for the genuinely base-FREE case:
        // `git merge-base` found no common ancestor at all (a cross-fork PR
        // with unrelated history), which a re-run reproduces exactly.
        //
        // Collapsing the first into the last is how the split was lost once
        // already: `containment-unverified` is filed under "deterministic for
        // the same sha and must NOT be retried", so a CI checkout whose base
        // fetch blips would pay a full review every round from then on, under
        // a reason that also misnames the cause — the delta read fine.
        //
        // `mergeBaseSha === null` is also the load-bearing FIRST conjunct
        // rather than a nested check: "fullBytes !== null implies a base" is
        // true at runtime and invisible to the compiler, so without it the
        // narrowing does not reach the else branch and the package does not
        // build.
        demote(
          baseFetchFailed
            ? 'base-untrusted'
            : mergeBaseSha === null
              ? 'containment-unverified'
              : 'capture-failed',
        );
      } else if (parseDiff(delta).files.length === 0) {
        // Non-empty bytes that name no file: the capture returned something
        // this parser cannot read (an error stream on stdout, a shape it does
        // not model). The empty file list is the PARSER's, not the tree's —
        // the `delta.trim() === ''` arm above is what an actually-empty range
        // takes — so this must not read as "nothing changed since the
        // anchor", which would stop the round. An oracle that could not rule
        // is exactly `containment-unverified`.
        demote('containment-unverified');
      } else {
        const ruling = computeIncrementalScope({
          anchor: anchor.diffBase,
          fullDiff: fullBytes,
          deltaFiles: parseDiff(delta).files.map((f) => f.path),
          restored: (path) =>
            treeEntryUnchanged(mergeBaseSha, fetchedSha, path),
          readWorktree: (rel) => {
            try {
              return readFileSync(join(wt, rel), 'utf8');
            } catch {
              return null;
            }
          },
        });
        if (ruling.kind === 'refuse') {
          writeStderrLine(
            `Incremental scope refused: ${ruling.detail} Reviewing the full range.`,
          );
          demote(ruling.reason);
        } else if (ruling.kind === 'nothing-new') {
          // Every changed file was undone and nothing imports them. That is
          // the same state as an empty delta, and it takes the same exit.
          writeStderrLine(`Nothing new since the anchor: ${ruling.detail}`);
          anchor.incremental.upToDate = true;
        } else if (publish(ruling.diff)) {
          scopedDelta = true;
          // The scoped range's left side, full-sha, for downstream consumers
          // that recompute their own diffs (Agent 7's test-efficacy probe
          // welds --base into its brief) — without it they would probe the
          // full merge-base range on a delta-scoped round.
          anchor.incremental.diffBase = anchor.diffBase;
          anchor.incremental.scope = ruling.scope;
          // The superseded full diff stays on disk: a later step that needs
          // the whole PR (Agent 0's issue fidelity, the reverse audit's
          // whole-file lens) reads it rather than re-running the capture.
          try {
            const fullPath = tmpFile(`pr-${prNumber}`, 'diff-full.txt');
            writeFileSync(fullPath, fullBytes);
            anchor.incremental.fullDiffPath = fullPath;
          } catch (err) {
            // A convenience artefact must never take the round with it.
            writeStderrLine(
              `Could not keep the full-range diff beside the scoped one ` +
                `(${(err as Error).message}); steps that want the whole PR ` +
                `will have to re-capture it.`,
            );
          }
        } else {
          // The slice captured but could not be written: degrade like any
          // other capture failure rather than scoping to a file nobody has.
          demote('capture-failed');
        }
      }
    }
    if (!scopedDelta) {
      if (fullBytes !== null) publish(fullBytes);
      // `upToDate` is NOT demoted when the full range is unavailable. It is a
      // fact about the ANCHOR — nothing has landed since it — proven by the
      // delta capture (or, for anchor-at-head, by arithmetic), and neither
      // proof consults the base. The flow it primarily serves consumes no
      // plan at all: "No new changes since last review" stops the round. The
      // flows that DO continue past it read `diffPath` like every other
      // degraded round. Conditioning the anchor fact on the unrelated
      // full-range capture cost a PR whose base branch was deleted its stop
      // branch on every same-sha retry, whose only possible answer was
      // "up to date".
    }
    // `buildDiffPlan` throws when the chunks do not tile the diff — a coverage
    // hole. That must be loud, but it must not take the whole review with it: the
    // throw would fire after the worktree exists and before any report is
    // written. Degrade to the documented `diffPath: null` path instead, which
    // tells the skill to fall back and warn the user that coverage is partial.
    let plan;
    /** The rescue tiled but its write failed — a capture fault, not a tiling one. */
    let rescueWriteFailed = false;
    /**
     * The partitioner refused. Tracked, not inferred from the refusal reason:
     * an anchor refused for its own cause (`not-an-ancestor`, say) whose
     * full-range diff then fails to tile keeps THAT reason, so reading the
     * reason to narrate the planless round told the operator "no diff could be
     * captured" moments after the capture succeeded and the partitioner warned.
     */
    let partitionFailed = false;
    try {
      plan = buildDiffPlan(diffText, args.maxChunkLines);
    } catch (err) {
      partitionFailed = true;
      writeStderrLine(
        `WARNING: could not partition the diff (${(err as Error).message}). ` +
          `Falling back to a diff-less report; coverage will be partial.`,
      );
      diffPath = null;
      diffPathAbsolute = null;
      diffSha256 = null;
      plan = buildDiffPlan('', args.maxChunkLines);
      // A partition failure on a delta must not end the round diff-less while
      // the FULL range — already in hand — might tile fine: the delta is the
      // optimization, the full range is the review. Retry it, and demote under
      // the reason that names what actually happened (the capture succeeded;
      // the partitioner did not).
      if (
        scopedDelta &&
        fullBytes !== null &&
        fullText !== null &&
        fullText.trim() !== ''
      ) {
        try {
          const rescued = buildDiffPlan(fullText, args.maxChunkLines);
          // A write failure here is degradation, not a tiling failure: the
          // inner catch must not swallow it into "both ranges refuse to tile"
          // and ship plan chunks beside a null `diffPath`.
          if (publish(fullBytes)) {
            plan = rescued;
            scopedDelta = false;
            writeStderrLine(
              'Retried the partition over the full range, which tiled; the ' +
                'round is a full review.',
            );
          } else {
            // The rescue tiled but could not be written. Nothing was rescued:
            // the plan stays empty and `diffPath` stays null, so announcing a
            // full review — and, below, calling this a partition failure —
            // would both name the wrong thing. The write failure is the cause,
            // and it is the retryable one.
            rescueWriteFailed = true;
          }
        } catch {
          // Both ranges refuse to tile — keep the diff-less report.
        }
      }
      // Whether or not the retry rescued the plan, the ruling cannot stand:
      // an `incremental: {effective: true}` over a full-range (or diff-less)
      // plan would send Agent 7 to a delta base while every other reader uses
      // the merge base — one round, two scopes.
      // NOT on an upToDate round: `upToDate` is a fact about the anchor, its
      // stop flow consumes no plan, and the rationale for demoting (Agent 7's
      // welded `--base` reading `diffBase`) cannot apply — an upToDate ruling
      // never carries one. Stripping it published "the anchor is invalid" for
      // an anchor that IS the head.
      if (anchor?.incremental.effective && !anchor.incremental.upToDate) {
        demote(rescueWriteFailed ? 'capture-failed' : 'partition-failed');
      }
    }
    // Every refusal that ends with NO diff at all reports the planless reason,
    // whatever refused the anchor first. The contract downstream reads is "one
    // reason names the degraded flow" — three shapes (a partition failure, a
    // delta throw with the full-range capture also failing, a delta throw with
    // no merge base) used to publish `capture-failed` over a zero-chunk plan
    // while the skill's per-reason bullet said the full range was in hand. The
    // original refusal is not lost: the status line below names it.
    // No restamping. A reason names the CAUSE of the refusal — a capture that
    // threw, a partitioner that refused, an anchor ruled invalid — and whether
    // a PLAN exists is `diffPath`, which the report already carries. One field
    // meaning both facts is what renamed a deterministic partition failure
    // into the class SKILL retries, and put a validity refusal under a name
    // that invited re-running the invalid anchor.
    // The incremental status line is emitted AFTER planning, so it describes
    // the state the report actually publishes — a demotion above must not be
    // narrated as a scoped round.
    if (anchor) {
      const inc = anchor.incremental;
      writeStderrLine(
        inc.upToDate
          ? `Incremental: anchor ${inc.since.slice(0, 10)} is up to date with the head — nothing new to review.`
          : inc.effective
            ? `Incremental: scoped to ${inc.since.slice(0, 10)}..${fetchedSha.slice(0, 10)}.`
            : `Incremental anchor ${inc.since.slice(0, 10)} refused (${inc.reason}); ${
                diffPath !== null
                  ? 'reviewing the full diff.'
                  : // `rescueWriteFailed` means the full range DID tile and only
                    // its write failed, so the partitioner is not what left the
                    // round planless — the write is.
                    partitionFailed && !rescueWriteFailed
                    ? 'the diff could not be partitioned — coverage will be partial.'
                    : 'no diff could be captured — coverage will be partial.'
              }`,
      );
    }

    // Aone does not advertise diff stats — fill them from the captured diff
    // so the report's diffStat and the stderr summary carry real numbers.
    // Runs AFTER the plan/rescue above, where `diffText` is FINAL: the
    // partition-rescue can republish the full range over a delta-scoped
    // capture, and a backfill run before it would advertise the delta's
    // numbers beside a diffPath pointing at the full merge-base diff. The
    // numbers must describe the SAME diff the report points at.
    if (needsLocalStats) {
      const stats = computeDiffStats(diffText);
      meta.additions = stats.additions;
      meta.deletions = stats.deletions;
      meta.changedFiles = stats.changedFiles;
    }

    // 6. Emit the report. The window opening survives drift restarts: this
    // command overwrites its own report, and a reset boundary would hide any
    // bypass write made during the abandoned attempt from cleanup's audit.
    const fetchedAt = new Date().toISOString();
    let auditSince = fetchedAt;
    let prevRaw: string | null = null;
    try {
      prevRaw = readFileSync(out, 'utf8');
    } catch (err) {
      // ENOENT is the normal first attempt for this target — silent. Any other
      // read failure (EACCES, EISDIR, I/O) is NOT "no previous report"; name it
      // so an operator is not sent toward the wrong cause.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        writeStderrLine(
          `WARNING: could not read the previous fetch report at ${out} (${code ?? (err as Error).message}); ` +
            `the audit window starts at this fetch and may not reach an earlier abandoned attempt.`,
        );
      }
    }
    if (prevRaw !== null) {
      try {
        const prev = JSON.parse(prevRaw) as {
          prNumber?: unknown;
          fetchedAt?: unknown;
          auditSince?: unknown;
        };
        const prevSince =
          typeof prev.auditSince === 'string'
            ? prev.auditSince
            : typeof prev.fetchedAt === 'string'
              ? prev.fetchedAt
              : null;
        if (
          prev.prNumber === prNumber &&
          prevSince !== null &&
          !Number.isNaN(Date.parse(prevSince)) &&
          // `< auditSince` (which is `fetchedAt`, i.e. now) is also the upper
          // bound: the window opening only ever moves BACKWARD to an earlier
          // attempt, never forward. A corrupted far-future `auditSince`
          // (`"2099-…"`) is therefore rejected here — it would push the window
          // ahead of every real comment and silently report a clean audit.
          // (ISO-8601 strings from `toISOString()` compare chronologically.)
          prevSince < auditSince
        ) {
          auditSince = prevSince;
        }
      } catch {
        // The file exists but is unparseable — a crash mid-write leaves
        // truncated JSON. Silently resetting the window to this fetch would let
        // a bypass write from the abandoned attempt escape the audit, so warn:
        // the window may not reach it.
        writeStderrLine(
          `WARNING: the previous fetch report at ${out} is not valid JSON (a crash mid-write?); ` +
            `the audit window starts at this fetch and may not reach an earlier abandoned attempt.`,
        );
      }
    }
    const result: FetchPrResult = {
      prNumber,
      ownerRepo,
      remote,
      ref,
      fetchedSha,
      fetchedAt,
      auditSince,
      // Record the TRIMMED host: setGhHost routes the padded-but-valid flag
      // fine, but downstream readers that re-validate (compose-review's plan
      // identity, the agent-prompt weld) must see the same canonical form, or
      // a padded host silently drops to github.com anchor links.
      host: args.host?.trim() || null,
      worktreePath: wt,
      baseRefName: meta.baseRefName,
      headRefName: meta.headRefName,
      isCrossRepository: meta.isCrossRepository,
      // Two gates, because the SKILL acts on this by recommending the PR be
      // closed as superseded — the one ruling here that is expensive to get
      // wrong. `diffPath` (set only on a SUCCESSFUL capture): a capture that
      // threw also leaves diffText empty, and closing off that would close a
      // live PR on an infrastructure error. `baseFetchFailed`: the merge base is
      // then "resolved from a possibly stale local ref" (the warning above says
      // so), and a stale base ref that already contains the head commits diffs
      // to empty — the same wrong recommendation, one cause further out.
      // Both flags are facts about the PR's WHOLE diff, never about a round's
      // scope, so both read `fullText` — the range this command now always
      // reads when a base exists. Keying them on the published diff made a
      // delta round judge the wrong quantity twice: the collapse ratio fired
      // against GitHub's full-PR stat on every incremental round, and an
      // emptied PR went unflagged because its own delta was not empty. Both
      // are full-range facts, so both read `fullText` on EVERY round, delta
      // -scoped or not.
      ...(isEmptyDiff({
        diffPath: fullText === null ? null : diffRel,
        baseFetchFailed,
        diffText: fullText ?? '',
      })
        ? { emptyDiff: true }
        : {}),
      // Collapse detection compares recomputed reality against GitHub's
      // advertised stat: a 4x shrink past a 200-line floor is a rebase-lag
      // signature, not rounding. Both thresholds are deliberately coarse — this
      // is a disclosure, never a gate.
      //
      // The two sides are produced by different tools, so the ratio has floors
      // under it for a reason. Rename detection is the divergence that matters:
      // `--find-renames` is pinned here and GitHub applies its own, and a move
      // whose similarity lands on opposite sides of the two thresholds shrinks
      // one side and not the other. That is what the 4x buys — a threshold
      // disagreement moves the ratio by the size of one file, a genuine
      // upstream collapse moves it by the size of the PR. Kept as a disclosure
      // precisely because the ratio is not a measurement of the same quantity
      // twice.
      // Both comparisons above read the FULL merge-base range against GitHub's
      // advertised full-PR stat; a delta-scoped diff is a different quantity on
      // one side only. An incremental delta is always far smaller than the
      // advertised stat, so the collapse ratio would fire on every incremental
      // review — both flags are full-range facts, so both read `fullText` on
      // EVERY round, delta-scoped or not.
      // The collapse disclosure needs TWO independent quantities: the
      // platform-advertised full-PR stat and the recomputed full-range count.
      // Off GitHub the advertised half is locally derived FROM THE SAME
      // captured text — one source, not two — and on a delta-scoped round it
      // is delta-scoped beside a full-range count (a churned delta passing
      // containment would fire a false "overlapping merged PRs collapsed
      // this PR"). Skip it when the stats are locally derived; a genuine
      // upstream collapse cannot be disclosed without an independent fact.
      ...(needsLocalStats
        ? {}
        : isCollapsedFromUpstream({
              diffText: fullText ?? '',
              baseFetchFailed,
              additions: meta.additions,
              deletions: meta.deletions,
            })
          ? { collapsedFromUpstream: true }
          : {}),
      diffStat: {
        files: meta.changedFiles,
        additions: meta.additions,
        deletions: meta.deletions,
      },
      mergeBaseSha,
      baseFetchFailed,
      diffPath,
      diffPathAbsolute,
      diffSha256,
      prDescriptionHasHan: /\p{Script=Han}/u.test(meta.body ?? ''),
      ...(roundModelId ? { reviewModelId: roundModelId } : {}),
      ...(anchor ? { incremental: anchor.incremental } : {}),
      ...buildPlanReport(plan, (path) => fileLineCount(fetchedSha, path), {
        operatorRoundCap: operatorReviewSettings().reverseAuditRounds,
        hasDeadline: hasReviewDeadline(process.env),
      }),
      ...planEffortField(args.effort),
    };

    writeFileSync(out, stringifyPlanReport(result), 'utf8');
    // Record this session against the plan just written: a later `--resume`
    // reads the ledger to find this attempt's transcripts. After the plan
    // write, so the entry sits inside the run-epoch fence it is read through.
    appendRunSession(out);
    writeStdoutLine(`Wrote fetch-pr report to ${out}`);
    if (diffPath) writeStdoutLine(`Wrote review diff to ${diffPath}`);
    // Surface diff stats to stderr so a human running the command interactively
    // sees something useful even without inspecting the JSON.
    writeStderrLine(
      `PR #${prNumber} (${ownerRepo}): ${meta.changedFiles} files, +${meta.additions}/-${meta.deletions}, base=${meta.baseRefName}, head=${meta.headRefName}`,
    );
    warnOnReportSize(out, READ_FILE_CHAR_CAP);
    writeStderrLine(
      `Diff: ${plan.diffLines} lines (${plan.srcDiffLines} source, ` +
        `${plan.testDiffLines} test, ${plan.docsDiffLines} docs, ` +
        `${plan.generatedDiffLines} generated) ` +
        `/ ${plan.diffChars} chars -> ${plan.chunks.length} review chunk(s)`,
    );
    const heavy = result.files.filter((f) => f.heavy);
    if (heavy.length > 0) {
      writeStderrLine(
        `Heavily rewritten (whole-file invariant review): ${heavy
          .map((f) => `${f.path} (${f.changedLines}L, ${f.rewriteRatio})`)
          .join(', ')}`,
      );
    }
  } catch (err) {
    // Roll back only a lease THIS run created: a re-fetch enters holding
    // its own earlier lease, and deleting that would expose the session's
    // live worktree the moment a refused session retries. Compare before
    // deleting so a lease another session wrote during this run (the
    // manual-recovery path for a stuck one) survives too. Best-effort,
    // like the branch rollbacks: a failure here must not mask the
    // original cause.
    if (holder === null) {
      tryRemove(() =>
        clearReviewWorktreeLeaseIfOwned(process.cwd(), leaseTarget, {
          sessionId,
          promptId,
        }),
      );
    }
    throw err;
  }
}

/**
 * Whether the capture found nothing to review.
 *
 * Extracted and pure because the SKILL ACTS on it — it recommends the PR be
 * closed as superseded — which makes it the one disclosure here that is
 * expensive to get wrong, and it was the one with no test. Both guards are
 * load-bearing and neither is about the diff: a capture that THREW also leaves
 * `diffText` empty (`diffPath` is set only on success), and a merge base
 * resolved from a stale local ref can already contain the head commits and so
 * diff to empty. Either would close a live PR on an infrastructure error.
 */
export function isEmptyDiff(i: {
  diffPath: string | null;
  baseFetchFailed: boolean;
  diffText: string;
}): boolean {
  return i.diffPath !== null && !i.baseFetchFailed && i.diffText.trim() === '';
}

/**
 * Whether the recomputed diff has collapsed against GitHub's advertised stat —
 * the rebase-lag signature.
 *
 * Both thresholds are coarse on purpose, and the reason is that the two sides
 * are produced by DIFFERENT tools: `--find-renames` is pinned locally while
 * GitHub applies its own, so a move whose similarity lands on opposite sides of
 * the two thresholds shrinks one side and not the other. The 4x is what buys
 * past that — a threshold disagreement moves the ratio by one file, a genuine
 * upstream collapse moves it by the size of the PR — and the 200-line floor
 * keeps small PRs, where one file IS the ratio, out of it entirely. A
 * disclosure, never a gate, precisely because it is not the same quantity
 * measured twice.
 */
export function isCollapsedFromUpstream(i: {
  diffText: string;
  baseFetchFailed: boolean;
  additions: number;
  deletions: number;
}): boolean {
  // The sibling guard, for the sibling reason — and it is the guard, not the
  // ratio, that was missing here. `isEmptyDiff` refuses to rule when the merge
  // base came from a possibly stale local ref because such a base can already
  // contain the head commits and diff to empty. The PARTIAL form of the same
  // cause lands here instead: a stale ref holding most of the head commits
  // shrinks the recomputed diff past the 4x ratio, and this flag then tells
  // Agent 0 a story — "overlapping merged PRs collapsed this one, read the
  // body as description-of-history" — that is wrong in the way that matters,
  // because the body's claims may be perfectly current and the real cause is
  // an infrastructure failure. A disclosure that steers how the body is read
  // has to be as sure of its base as a gate does.
  const advertised = i.additions + i.deletions;
  return (
    !i.baseFetchFailed &&
    i.diffText.trim() !== '' &&
    advertised >= 200 &&
    countDiffChangedLines(i.diffText) * 4 <= advertised
  );
}

/**
 * Changed (+/-) lines in a unified diff — headers excluded. Delegates to the
 * single hunk-state walker in computeDiffStats so the two can never disagree
 * (isCollapsedFromUpstream compares this against the advertised stats, and
 * for Aone the advertised stats COME from computeDiffStats — one walker, or
 * the ratio is load-bearing on two copies agreeing).
 *
 * POSITION, not prefix shape. Guessing by prefix (`^-(?!--)`) has to exclude
 * every line starting `--`, and a DELETED line whose own content starts `--`
 * arrives as `--- …`: markdown rules and YAML document markers, SQL and Lua
 * comments, a `--flag` in a script. Each one silently dropped a real changed
 * line, and every drop pushes the ratio toward a false `collapsedFromUpstream`
 * (the disclosure fires when the recomputed count comes in LOW).
 */
export function countDiffChangedLines(diffText: string): number {
  const { additions, deletions } = computeDiffStats(diffText);
  return additions + deletions;
}

/**
 * Additions / deletions / changed-files counted straight off a unified diff —
 * the single hunk-state walker (see countDiffChangedLines). Used when the
 * platform does not advertise diff stats (Aone); GitHub's `gh pr view`
 * reports them, so GitHub keeps the advertised numbers. Inside a hunk the
 * position is unambiguous — `---`/`+++` cannot be file headers there — so
 * track hunk state and count every `+`/`-` line in it; `diff --git` opens
 * the next file's header block and `\ No newline at end of file` is a marker,
 * not content.
 */
export function computeDiffStats(diffText: string): {
  additions: number;
  deletions: number;
  changedFiles: number;
} {
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      changedFiles++;
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions, changedFiles };
}

export const fetchPrCommand: CommandModule = {
  command: 'fetch-pr <pr_number> <owner_repo>',
  describe:
    'Prepare a PR review worktree: clean stale state, fetch the PR HEAD, create a worktree, and write a JSON state report',
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe: 'GitHub "owner/repo"',
      })
      .option('remote', {
        type: 'string',
        default: 'origin',
        describe:
          'Git remote to fetch from (use "upstream" for fork-based workflows)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('host', {
        type: 'string',
        describe:
          "The host the target lives on — it selects the platform, i.e. whether the fetch uses pull/<n>/head or refs/merge-requests/<id>/head. An Aone host (*.alibaba-inc.com) selects the Aone backend; omitted: detected from the remote under review, else the clone's origin, else GitHub.",
      })
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe:
          'Target size, in diff lines, of each review chunk. A chunk boundary falls on a hunk boundary; a hunk larger than this is split only at a top-level declaration, never inside a function.',
      })
      .option('effort', {
        type: 'string',
        choices: ['low', 'medium', 'high'],
        describe:
          'The review effort. `medium` (balanced) drops the adversarial ' +
          'personas from the required roster; recorded in the plan so ' +
          'check-coverage, agent-prompt --roster and compose-review all read ' +
          'one value. Omit for the full (high) roster.',
      })
      .option('since', {
        type: 'string',
        describe:
          'Incremental anchor: the head sha the last clean review round ' +
          'covered (from the review cache, or the posted ledger marker). ' +
          'Validated against the fetched history here — an anchor that is ' +
          'unknown or not an ancestor of the head falls back to the full ' +
          'diff with the reason in the report; a valid one scopes the diff ' +
          "and the chunk plan to since..head. The decision is the report's " +
          '`incremental` field.',
      })
      .option('since-model', {
        type: 'string',
        describe:
          'WHO certified the --since anchor: the `lastModelId` beside it in ' +
          'the review cache, or the `model` beside the marker sha. Copy it ' +
          'through verbatim — do NOT compare it to anything yourself. The ' +
          'anchor is used only when it matches the identity running this ' +
          'review; otherwise the report says `cross-model-anchor` and the ' +
          'round reviews the full diff, because "clean up to this sha" is ' +
          "the recorded identity's verdict and this command validates an " +
          'anchor against the history, never against who certified it.',
      }),
  handler: async (argv) => {
    setGhHost((argv as { host?: string }).host);
    await runFetchPr(argv as unknown as FetchPrArgs);
  },
};
