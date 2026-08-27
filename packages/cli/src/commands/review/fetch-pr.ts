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
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
} from '../../services/review-worktree-lease.js';
import { sanitizedGitEnv } from './lib/worktree.js';
import { setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import type { ReviewPlatformReader } from './lib/platform/types.js';
import { EFFORT_OPTION, type ReviewEffort } from './parse-args.js';
import {
  git,
  gitOpt,
  gitProbe as gitExit,
  gitRaw,
  refExists,
  releaseWorktree,
} from './lib/git.js';
import type { NarrowSelection } from './lib/narrow-diff.js';
import { assembleSections, selectNarrowing } from './lib/narrow-diff.js';
import type {
  IncrementalScope,
  WidenedScope,
} from './lib/incremental-scope.js';
import { widenScope } from './lib/incremental-scope.js';
import { containedWorktreeReader } from './lib/worktree-reader.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from './lib/diff-flags.js';
import {
  REVIEW_TMP_DIR,
  reviewBranch,
  tmpFile,
  worktreePath,
} from './lib/paths.js';
import { planEffortField } from './lib/effort.js';
import {
  buildDiffPlan,
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
import { SHA_RE } from './lib/ledger.js';
import {
  appendRunSession,
  ledgerResumeCount,
  readResumeMarker,
  recordResume,
  recordRestart,
  RESUME_MAX,
} from './lib/run-ledger.js';
import {
  assessResume,
  type PreviousReport,
  type ResumeRefusal,
} from './lib/resume.js';
import {
  hasReviewDeadline,
  readBudgetStop,
  clearBudgetStop,
  clearRoundStamps,
} from './lib/deadline.js';
import { certifierMatchesRound, roundModelIdFrom } from './lib/round-model.js';
import {
  DEPS_CACHE_ENV,
  provisionWorktreeDependencies,
  type WorktreeDependencyProvision,
} from './lib/dep-provision.js';

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
   * Continue the interrupted run at this plan path when its state still
   * matches (worktree at `fetchedSha`, diff bytes unhashed-unchanged, live
   * head unmoved): keep the worktree, do NOT rewrite the plan — its mtime is
   * the run epoch every fence keys on — and re-announce the existing report.
   * When the state does not match, fall through to a fresh fetch; the flag
   * never fails a run that could start over.
   */
  resume?: boolean;
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
  /**
   * What the host dependency cache did to the worktree, when the environment
   * names one (`QWEN_REVIEW_DEPS_CACHE`, set on CI's persistent runners —
   * issue #10108). `provisioned: true` means the worktree already resolves
   * its dependencies (a link farm into the cache, npm's completeness marker
   * in place, prebuilt sibling `dist` copied in), so `build-test` skips its
   * install and probes can run tests without one. Anything else carries the
   * `reason` and the review behaves exactly as it did before the cache
   * existed. Absent entirely when no cache is configured (every local run).
   */
  dependencies?: WorktreeDependencyProvision;
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
  /** Source diff lines in the full merge-base range, including on an incremental round. */
  fullSrcDiffLines?: number;
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
   * in this report are the merge-base range narrowed to what changed since
   * the anchor, rather than the whole merge-base range.
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
   * (`behind-merge-base`), a merge base too stale to rule the clamp on
   * (`base-untrusted`), a capture that threw OR a base-side fault — the
   * base fetch or the merge-base resolution — failed (`capture-failed`), a
   * partitioner that refused to tile (`partition-failed`), or a narrowing
   * that found nothing it could publish (`nothing-to-narrow`). That last one
   * exists because the scope is BUILT from the PR's own diff rather than
   * checked against it, and it covers every shape the build can refuse,
   * deliberately alike: an "undo per feedback" round whose commits put lines
   * back the way the base had them, so the PR no longer displays the undone
   * FILE at all (a file the PR still carries publishes its section whole
   * instead of refusing); a capture on either side whose bytes do not
   * survive UTF-8; a delta the
   * parser cannot read; and the fail-closed refusal — the two captures key
   * the same change differently (a path or a rename git resolves differently
   * across the two ranges), so narrowing would drop a change the PR's diff
   * displays. Every shape keeps the full range: wider, never wrong.
   * On Aone the two ancestry-based reasons (`not-an-ancestor`,
   * `behind-merge-base`) never occur: an AGit-Flow update amends the head
   * in place and orphans the cached sha, so the anchor is ruled WITHOUT
   * ancestry (design D7) and the two heads' diff is read as the update's
   * delta.
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
    | 'nothing-to-narrow'
    | 'cross-model-anchor'
    | 'base-untrusted'
    | 'capture-failed'
    | 'partition-failed';
  /**
   * The left side of the range the published scope was assembled from, as a
   * FULL sha, present exactly when the report's diff is the narrowed scope
   * (`effective` and not `upToDate`). Downstream consumers that recompute
   * their own ranges read it — Agent 7's test-efficacy probe welds `--base`
   * into its brief. It is the merge base, never the anchor: the published
   * hunks are byte-identical hunks of `mergeBase..head`, so that range
   * covers every one of them and never a byte the PR's diff does not
   * display, while the anchor range can carry hunks an undo round netted
   * out of the PR's diff.
   */
  diffBase?: string;
  /**
   * Which files the published scope holds and why, present exactly when the
   * scope is the narrowed one. `deltaFiles` are what the round touched;
   * `interaction[]` are still-clean files the one-hop widening pulled back
   * in, each with the edges that did it, so a chunk brief can point its agent
   * at the seam rather than order a from-scratch re-review.
   */
  scope?: IncrementalScope;
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
 *
 * `noAncestry` is the AGit-Flow rule (Aone; design D7). Under AGit-Flow,
 * updating a CR AMENDS the single commit in place: the amended H2 has H1's
 * parent, never H1 itself, so the old head is orphaned and the
 * anchor-behind-head test fails for EVERY update — the amended head never
 * descends from the cached one. (The clamp additionally fails whenever the
 * update also rebased onto newer master, since the merge base then moves
 * past the cached head; a pure amend passes it.) Neither is asked: after
 * the fetch both heads are local, so `anchor..head` IS the update's delta
 * (for a pure amend, exactly the amended lines; if the author also rebased
 * onto newer master, the range additionally carries the rebase drift; the
 * narrowing join reads it only for which files changed and never lets a
 * drift byte reach the published scope, falling back to the full range via
 * `nothing-to-narrow` when the drift touched files outside the CR's diff).
 * The published scope is still assembled
 * from the PR's own diff by the narrowing step, so it cannot carry a hunk
 * the platform does not display, and the `base-untrusted` refusal stays —
 * it guards a capture against a stale base, not a lineage. The existence
 * checks also stay: an anchor the object store does not hold (a fresh
 * clone) cannot be diffed against.
 */
export function resolveIncrementalAnchor(
  rawSince: string,
  fetchedSha: string,
  probe: AnchorProbe,
  mergeBase: { sha: string | null; fetchFailed: boolean } | null = null,
  options: { noAncestry?: boolean } = {},
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
  // longer reach it and an error here really is the git surface. Not asked
  // at all under `noAncestry` — see the docstring's AGit-Flow paragraph:
  // an amend orphans the cached head, so the test would fail for every
  // update, and the two heads' diff is the update's delta anyway.
  if (!options.noAncestry && !probe.isAncestor(resolved, fetchedSha)) {
    return {
      incremental: { since, effective: false, reason: 'not-an-ancestor' },
      diffBase: null,
    };
  }
  // Only when a base was actually resolved: with `sha: null` there is no
  // clamp to rule, stale or otherwise, and the docstring's "a null `sha`
  // skips the clamp" holds — the delta range needs no base at all, so a
  // deleted or renamed base branch must not cost a valid anchor its scope.
  // NOT an ancestry test — it fires under `noAncestry` too: the narrowing
  // below assembles the published scope from the base-derived full capture,
  // and a base the run flagged possibly-stale is one every sibling guard
  // declines to rule on.
  if (mergeBase?.fetchFailed && mergeBase.sha != null) {
    return {
      incremental: { since, effective: false, reason: 'base-untrusted' },
      diffBase: null,
    };
  }
  // The clamp. Skipped under `noAncestry` with its sibling: on a rebase
  // onto newer master the merge base moves PAST the cached head, so the
  // clamp fires for every amended-and-rebased update — retiring the anchor
  // there would cost the full range even when the drift stays inside the
  // CR's files and the narrowing join could still scope (it reads the
  // delta for its file list only, so no drift byte is published; drift
  // beyond the CR's files falls back to the full range there anyway).
  if (
    !options.noAncestry &&
    mergeBase?.sha != null &&
    !probe.isAncestor(mergeBase.sha, resolved)
  ) {
    return {
      incremental: { since, effective: false, reason: 'behind-merge-base' },
      diffBase: null,
    };
  }
  return { incremental: { since, effective: true }, diffBase: resolved };
}

/** Count lines of `<ref>:<path>`, or 0 if it does not exist there. */
function fileLineCount(ref: string, path: string): number {
  try {
    const buf = gitRaw('show', `${ref}:${path}`);
    if (buf.length === 0) return 0;
    let n = 0;
    for (const b of buf) if (b === 0x0a) n++;
    // A final line without a trailing newline still counts.
    return buf[buf.length - 1] === 0x0a ? n : n + 1;
  } catch {
    return 0; // absent at this ref: created by the PR, or deleted by it
  }
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
  //
  // The exit status is KEPT (gitExit, not gitOpt), like the sibling probes,
  // but it splits nothing here: git exits 128 identically for a transient
  // fault and for a deterministic refusal (the base branch deleted on the
  // remote — the refspec fetch fails every time), so the bound on retrying
  // the deterministic member lives where the class is ruled — the demotion
  // arm below and SKILL.md's once-cap — never on the status.
  fetch: (remote, ref) =>
    gitExit(
      'fetch',
      remote,
      '--',
      `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`,
    ).status === 0 && refExists(`refs/remotes/${remote}/${ref}`),
  refExists,
  mergeBase: (a, b) => {
    // Three-way exit split like the anchor probes: exit 1 is the only
    // deterministic "no common ancestor"; any other status — an exit-128
    // fatal, the 120s timeout kill, a spawn failure — is the surface being
    // unavailable, thrown so the round demotes to the retryable class
    // instead of folding onto the same null and stamping the deterministic
    // reason. One member folds in anyway, and no exit-status resolution can
    // split it: git ALSO exits 1 when it cannot read the object store on
    // the walk, so a fault there is indistinguishable from an orphan
    // history. The arm below discloses it.
    //
    // `core.commitGraph=false` is #9092's pin, kept: the commit-graph is a
    // cache, and a stale or truncated one answers this walk from data the
    // object store no longer agrees with — a wrong merge base, which is the
    // one input every clamp and the whole narrowing are computed against.
    const { out, status } = gitExit(
      '-c',
      'core.commitGraph=false',
      'merge-base',
      a,
      b,
    );
    if (status === 0) return out;
    if (status === 1) return null;
    throw new GitUnavailable();
  },
};

function tryRemove(action: () => void): void {
  try {
    action();
  } catch {
    /* idempotent — silent on missing target */
  }
}

function cleanStale(prNumber: string): void {
  // The result is READ, because `releaseWorktree` can now refuse: an ancestor
  // symlink above the temp dir means the removal would land in whatever
  // checkout it names, so it declines and says so. Dropping that on the floor
  // left the sweep looking successful and the next `worktree add` wedged at a
  // path nobody was told about — the same "something that should be gone is
  // still there, and nothing said so" the cleanup path reports everywhere else.
  const { existed, freed, reason } = releaseWorktree(worktreePath(prNumber));
  if (existed && !freed) {
    writeStderrLine(
      `Could not free the stale worktree at ${worktreePath(prNumber)}: ${reason}`,
    );
  }
  const ref = reviewBranch(prNumber);
  if (refExists(ref)) {
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], {
        stdio: 'pipe',
        // Same reason as every other git spawn in this pipeline: a delete must
        // land in the repository the caller named, not the one the shell's
        // `GIT_DIR` points at.
        env: sanitizedGitEnv(),
      }),
    );
  }
}

/** sha256 of a file's raw bytes, or null when it cannot be read. */
function sha256OfFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

type ResumeOutcome =
  | { resumed: true }
  | { resumed: false; reason: ResumeRefusal; priorFetchedSha: string | null };

/**
 * The `--resume` fast path: rule on the interrupted attempt's state and, when
 * it holds, continue it — every probe is a fact this command gathers itself
 * (git, gh, file hashes, the CLI-written marker), never the orchestrator's
 * account. On a continuation the plan file is NOT touched: its mtime is the
 * run epoch that keeps the first attempt's records, stamps and transcripts
 * inside every reader's fence.
 */
function tryResume(
  args: FetchPrArgs,
  wt: string,
  platform: ReviewPlatformReader,
): ResumeOutcome {
  const { pr_number: prNumber, owner_repo: ownerRepo, out } = args;
  let prev: PreviousReport | null = null;
  try {
    prev = JSON.parse(readFileSync(out, 'utf8')) as PreviousReport;
  } catch {
    prev = null;
  }
  // An unreachable forge reads as "unmoved": the worktree and diff hashes
  // pin the content, and presubmit's headDrift re-checks before anything
  // posts. Only the live head OID is needed — a moved head is the one
  // upstream change resume refuses. The read goes through the same platform
  // reader the fresh path uses, so an Aone clone resolves the same way.
  let liveHeadSha: string | null = null;
  try {
    const oid = platform.getFetchMeta(Number(prNumber), ownerRepo).headRefOid;
    liveHeadSha = typeof oid === 'string' && oid !== '' ? oid : null;
  } catch {
    liveHeadSha = null;
  }
  // The resume cap: how many times this review has already been resumed.
  // Both counters are the CLI's own record; the marker is primary and the
  // session ledger cross-caps it, minus the original run's own first entry.
  const marker = readResumeMarker(out);
  const currentSessionId = process.env['QWEN_CODE_SESSION_ID']?.trim();
  const ledgerResumes = ledgerResumeCount(out, {
    excludeSessionId: currentSessionId,
  });
  const currentKey = currentSessionId?.toLowerCase();
  const markerResumes = marker.resumes.filter(
    (r) => r.sessionId.toLowerCase() !== currentKey,
  ).length;
  // `--porcelain` prints nothing on a clean tree; a null (the command could
  // not run) is treated as dirty. `--untracked-files=normal` explicitly, so
  // a `status.showUntrackedFiles=no` tuning cannot hide residue that is not
  // in the PR.
  const status = gitOpt(
    '-C',
    wt,
    'status',
    '--porcelain',
    '--untracked-files=normal',
  );
  const ruling = assessResume(prev, {
    prNumber,
    worktreeHeadSha: gitOpt('-C', wt, 'rev-parse', 'HEAD'),
    worktreeClean: status === null ? null : status.trim() === '',
    diffSha256OnDisk: sha256OfFile(tmpFile(`pr-${prNumber}`, 'diff.txt')),
    liveHeadSha,
    resumeCount: Math.max(markerResumes, ledgerResumes),
    requestedEffort: args.effort ?? null,
  });
  if (!ruling.ok) {
    return {
      resumed: false,
      reason: ruling.reason,
      priorFetchedSha:
        prev !== null && typeof prev.fetchedSha === 'string'
          ? prev.fetchedSha
          : null,
    };
  }

  // Budget hygiene: the continuation runs under a fresh deadline, so a
  // time-budget stop is the dead attempt's, not this run's, and is cleared.
  // A round-cap stop is about rounds, not time — it is the trusted CLI's own
  // record that the audit reached its round cap, so it stands, and the round
  // stamps stay with it. Any other stop is cleared with the stamps: the span
  // from the dead attempt's last stamp to the continuation's first admission
  // spans the death gap and would price a round at hours; without the stamps
  // the gate falls back to its conservative constant.
  const stop = readBudgetStop(out);
  const roundCapStands = stop !== null && stop.cause === 'round-cap';
  if (stop !== null && !roundCapStands) {
    clearBudgetStop(out);
  }
  if (!roundCapStands) {
    clearRoundStamps(out);
  }
  appendRunSession(out);
  recordResume(out);
  // Read the marker back: `recordResume` deduplicates by session, so a
  // second `--resume` in the SAME session is the same resume, and deriving
  // the number from the pre-write count would announce attempt 2 for it.
  const attempt = Math.max(1, readResumeMarker(out).resumes.length);
  // `restartsSpent` is the resume marker's ONE consumer beyond idempotency:
  // the resumed session initialises Step 7's once-per-review restart bound
  // from it — without a reader here, the recorded restart would silently
  // reset on every resume. `effort` names the level the continuation is
  // pinned to (the plan's, deliberately untouched), so a continuation never
  // silently runs at a level the caller did not expect.
  const pinnedEffort =
    prev !== null && typeof prev.effort === 'string' && prev.effort !== ''
      ? prev.effort
      : 'high';
  writeStdoutLine(
    JSON.stringify({
      resumed: true,
      resumeAttempt: attempt,
      restartsSpent: marker.restarts.length,
      effort: pinnedEffort,
      out,
    }),
  );
  writeStderrLine(
    `Resumed PR #${prNumber} review (resume ${attempt} of ${RESUME_MAX}): ` +
      `worktree, plan and the interrupted attempt's agent evidence are reused; ` +
      `the report at ${out} is unchanged, and the run continues at its ` +
      `recorded effort (${pinnedEffort}).`,
  );
  return { resumed: true };
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

    // A `--resume` rules before any destructive step: a continuation must
    // reach neither the cleanup below (the worktree is the state being
    // resumed) nor the plan write (its mtime is the run epoch). Platform
    // detection above is non-destructive and gives the resume probe's forge
    // read its auth. The lease already covers the resumed run — a
    // continuation keeps working in this worktree after this command
    // returns, and cleanup releases the lease with the rest. A refused
    // resume falls through to the fresh path and announces why; head
    // movement is recorded AFTER the fresh plan lands, so the marker entry
    // postdates the new epoch.
    let resumeRefusal: ResumeRefusal | null = null;
    let priorFetchedSha: string | null = null;
    if (args.resume) {
      const outcome = tryResume(args, wt, platform);
      if (outcome.resumed) return;
      resumeRefusal = outcome.reason;
      priorFetchedSha = outcome.priorFetchedSha;
      writeStdoutLine(
        JSON.stringify({ resumed: false, resumeRefused: outcome.reason }),
      );
      writeStderrLine(
        `Cannot resume PR #${prNumber} (${outcome.reason}); starting a fresh review.`,
      );
    }

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
        execFileSync('git', ['branch', '-D', ref], {
          stdio: 'pipe',
          // Same reason as every other git spawn in this pipeline: a delete must
          // land in the repository the caller named, not the one the shell's
          // `GIT_DIR` points at.
          env: sanitizedGitEnv(),
        }),
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
        execFileSync('git', ['branch', '-D', ref], {
          stdio: 'pipe',
          // Same reason as every other git spawn in this pipeline: a delete must
          // land in the repository the caller named, not the one the shell's
          // `GIT_DIR` points at.
          env: sanitizedGitEnv(),
        }),
      );
      throw new Error(
        `Failed to create worktree at ${wt}: ${(err as Error).message}`,
      );
    }

    // 4b. Provision the worktree's dependencies from the host cache, when the
    //     environment names one (CI's persistent runners do — issue #10108).
    //     A link farm takes seconds where the install it replaces does not
    //     fit an agent's tool budget, and it runs HERE so every agent —
    //     probes and verifiers included, not just Agent 7 — finds the tree
    //     already installed. Best-effort by contract: the provisioner
    //     records a reason instead of throwing, and the guard below exists
    //     only for the throw it promises not to make — a fetch that built a
    //     perfectly good worktree must not die on a cache fault whose
    //     fallback (the disclosed read-only round) is the pre-cache status
    //     quo. Absent from the report entirely when no cache is configured,
    //     so local reviews read the plan they always did.
    const depsCacheRoot = process.env[DEPS_CACHE_ENV];
    let dependencies: WorktreeDependencyProvision | undefined;
    if (depsCacheRoot) {
      // The entry's `dist` was built from the source revision its population
      // recorded; the provisioner vouches for it only when that IS the
      // worktree's merge base, so resolve the base here (step 5 re-resolves
      // on its own surface — the second fetch is a no-op round trip once the
      // tracking ref exists).
      let depsMergeBaseSha: string | null;
      try {
        depsMergeBaseSha = resolveMergeBase(
          remote,
          meta.baseRefName,
          `refs/heads/${ref}`,
          gitProbe,
        ).sha;
      } catch {
        depsMergeBaseSha = null;
      }
      try {
        dependencies = provisionWorktreeDependencies(
          wt,
          depsCacheRoot,
          depsMergeBaseSha,
        );
      } catch (err) {
        dependencies = {
          provisioned: false,
          source: null,
          reason: `provisioning threw: ${(err as Error).message}`,
          linked: 0,
          failed: 0,
          selfLinked: 0,
          distCopied: 0,
        };
      }
      writeStderrLine(
        dependencies.provisioned
          ? `Dependencies provisioned from ${dependencies.source}: ` +
              `${dependencies.linked} packages linked ` +
              `(${dependencies.selfLinked} workspace self-links), ` +
              `${dependencies.distCopied} prebuilt dist trees copied.`
          : `Dependencies NOT provisioned (${dependencies.reason}); ` +
              `build-test installs on its own path as before.`,
      );
    }

    mkdirSync(REVIEW_TMP_DIR, { recursive: true });

    // 5. Capture the diff to a file and partition it. The capture is decoded
    //    to UTF-8 text and written back as text, so a byte sequence that is
    //    not valid UTF-8 becomes U+FFFD — this file is READ, never applied:
    //    chunk agents read ranges out of it and `diffHashOf` hashes it. What
    //    the round trip does not do is normalise CRLF (that would rewrite
    //    every hunk of a CRLF file) or drop the trailing newline.
    let mergeBaseSha: string | null;
    let baseFetchFailed: boolean;
    /** The merge-base probe threw: the surface, not the history. */
    let mergeBaseUnavailable = false;
    try {
      ({ sha: mergeBaseSha, baseFetchFailed } = resolveMergeBase(
        remote,
        meta.baseRefName,
        // QUALIFIED — the head side is dwim-shadowable exactly like the
        // fetchedSha read above.
        `refs/heads/${ref}`,
        gitProbe,
      ));
    } catch (err) {
      if (!(err instanceof GitUnavailable)) throw err;
      // An exit other than the deterministic "no common ancestor" — the
      // probe's exit split throws it. The round degrades like any base-less
      // one; the fetch result is lost in the throw, and with no sha and the
      // retryable reason stamped below, nothing rules on it.
      mergeBaseSha = null;
      baseFetchFailed = false;
      mergeBaseUnavailable = true;
    }
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
          // The AGit-Flow rule (design D7): an Aone update AMENDS the single
          // CR commit in place and orphans the cached head, so the head test
          // refuses every update's anchor (the clamp fires only when the
          // update also rebased) — rule it without ancestry; the two heads'
          // diff is the update's delta. A force-pushed GitHub history keeps
          // the tests: there they are the detection.
          { noAncestry: platform.kind === 'aone' },
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
    /** The PR's own hunks, narrowed to what changed since the anchor. */
    let narrowed: Buffer | null = null;
    /** What the narrowing selected, before the widening adds to it. */
    let selection: NarrowSelection | null = null;
    /** The selection plus one import hop, and the record of why. */
    let widened: WidenedScope | null = null;
    if (anchor?.diffBase) {
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
      } else if (mergeBaseUnavailable) {
        // `git merge-base` could not answer: the probe's exit split throws on
        // every status except the deterministic exit-1 "no common ancestor"
        // — an exit-128 fatal, the 120s timeout kill, a spawn failure.
        // Something did fail, and the re-run re-runs exactly that probe, so
        // this is the retryable class — the same ruling the anchor probes'
        // GitUnavailable gets.
        demote('capture-failed');
      } else if (mergeBaseSha === null && baseFetchFailed) {
        // No merge base because the FETCH failed and no local base ref
        // remained to resolve one from. (A merge-base walk that failed on the
        // surface is the arm above, not this one.) The class has TWO members
        // the exit
        // status cannot split — git exits 128 for BOTH: a transient fault (a
        // fresh CI clone whose base fetch hit a network blip), where the
        // re-run re-runs exactly the component that failed and can succeed,
        // and a deterministic refusal (the base branch deleted on the remote
        // — the refspec fetch fails identically every time), where it never
        // will. Something did fail, so this keeps the retryable reason;
        // SKILL.md's recovery paragraph bounds the retry to ONCE so the
        // deterministic member cannot re-fail every round until the cap.
        demote('capture-failed');
      } else if (mergeBaseSha === null) {
        // No merge base although the fetch SUCCEEDED: `git merge-base` found
        // no common ancestor — an unrelated-history PR. There is no PR diff to
        // narrow against, so no scope is built; but nothing THREW, and calling
        // it `capture-failed` asserts an infrastructure fault that did not
        // happen and puts the round in the class SKILL.md's recovery flow
        // retries. A re-run reproduces this exactly, so it names the
        // deterministic reason instead. Exit 1 is the only "no common
        // ancestor" signal the probe keeps — every other exit takes the
        // retryable arm above. One member folds in anyway: git ALSO exits 1
        // when it cannot read the object store on the walk, so a fault there
        // stamps this reason at any exit-status resolution, and the
        // determinism claimed here is unprovable for that member.
        demote('nothing-to-narrow');
      } else if (fullBytes === null || fullText === null) {
        // A base WAS resolved and its capture threw — the 120s git timeout the
        // large long-lived PR `--since` exists for. That is infrastructure,
        // and a re-run can succeed, so this one keeps `capture-failed`.
        demote('capture-failed');
      } else if (
        (selection = selectNarrowing(fullBytes, deltaBytes)) === null
      ) {
        // The narrowing found nothing it could publish — all safe, because
        // keeping the full range costs a wider review and never a wrong one:
        // the "undo per feedback" round whose commits put lines back the way
        // the base had them, so the undone FILE no longer appears in
        // `base..head` at all (an undone file the PR's diff still carries
        // does not land here — the join fails closed and publishes its
        // section whole instead); a capture whose bytes do not survive
        // UTF-8; a delta the parser cannot read; and the fail-closed
        // refusal — the two captures key the same change differently (a path
        // or a rename), so narrowing would drop a change the PR's diff
        // displays.
        demote('nothing-to-narrow');
      } else if (
        // One import hop past what the round touched. The narrowing is sound
        // in one direction only: a caller cleared against the callee's OLD
        // shape is unchanged by definition, so no delta capture shows it, and
        // a scope holding only the touched files retires that seam at the
        // next re-anchor. The widening never narrows — with no edge to follow
        // it returns the narrowing's own paths — so the unwidened round is
        // the floor rather than a second path that could disagree with it.
        ((widened = widenScope({
          anchor: anchor.diffBase ?? anchor.incremental.since,
          selection,
          readWorktree: containedWorktreeReader(wt),
        })),
        (narrowed = assembleSections(selection, widened.paths)) === null)
      ) {
        // `assembleSections` selects nothing only when the widened set names
        // no section the full capture carries, which the guards above already
        // rule out — but it is the same "nothing to publish" either way, and
        // the full range is the safe answer to it.
        demote('nothing-to-narrow');
      } else {
        if (publish(narrowed)) {
          scopedDelta = true;
          anchor.incremental.scope = widened.scope;
          // The published hunks are byte-identical hunks of
          // `mergeBaseSha..head`, so that range is what downstream consumers
          // recomputing their own diffs must probe (Agent 7's test-efficacy
          // probe welds --base into its brief): it covers every published hunk
          // and never a byte the PR's diff does not display, while the anchor
          // range can carry hunks an undo round netted out of it.
          anchor.incremental.diffBase = mergeBaseSha;
        } else {
          // The scope was built but could not be written: degrade like any
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

    let fullSrcDiffLines: number | undefined;
    if (fullText !== null) {
      if (!scopedDelta) {
        fullSrcDiffLines = plan.srcDiffLines;
      } else {
        try {
          fullSrcDiffLines = buildDiffPlan(
            fullText,
            args.maxChunkLines,
          ).srcDiffLines;
        } catch {
          // Advisory measurement only; compose-review stays silent without it.
        }
      }
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
          // Compared NUMERICALLY: `toISOString()` output happens to sort
          // chronologically, but a forged extended-year form
          // (`"+275760-…"`) parses to the far future while sorting
          // lexicographically BEFORE any `"2026-…"` string — a string
          // comparison inherits exactly the forgery this bound rejects.
          Date.parse(prevSince) < Date.parse(auditSince)
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
      ...(dependencies ? { dependencies } : {}),
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
      ...(fullSrcDiffLines === undefined ? {} : { fullSrcDiffLines }),
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
    if (resumeRefusal === 'head-moved') {
      // The once-per-review restart bound, now a fact on disk. Recorded after
      // the plan write for the same fence reason as the session entry.
      recordRestart(
        out,
        `head-moved ${priorFetchedSha?.slice(0, 7) ?? 'unknown'}->${fetchedSha.slice(0, 7)}`,
      );
    }
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
      .option('resume', {
        type: 'boolean',
        default: false,
        describe:
          'Continue an interrupted run of this PR when its on-disk state still matches (worktree at the fetched SHA, diff bytes unchanged, PR head unmoved): keep the worktree, leave the plan untouched, and print {"resumed":true}. Falls through to a normal fresh fetch — printing {"resumed":false,"resumeRefused":"<reason>"} — whenever the state does not match.',
      })
      .option('effort', EFFORT_OPTION)
      .option('since', {
        type: 'string',
        describe:
          'Incremental anchor: the head sha the last clean review round ' +
          'covered (from the review cache, or the posted ledger marker). ' +
          'Validated against the fetched history here — an anchor that is ' +
          'unknown, or not an ancestor of the head, falls back to the full ' +
          'diff with the reason in the report. Ancestry is skipped on ' +
          'Aone, where an update AMENDS the single CR commit and orphans ' +
          "the cached head, so the two heads' diff is the update itself; " +
          'a valid anchor scopes the diff and the chunk plan to ' +
          "since..head. The decision is the report's `incremental` field.",
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
