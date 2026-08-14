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
import { createReviewWorktreeLease } from '../../services/review-worktree-lease.js';
import { ensureAuthenticated, gh, setGhHost } from './lib/gh.js';
import type { ReviewEffort } from './parse-args.js';
import { git, gitOpt, gitRaw, refExists, releaseWorktree } from './lib/git.js';
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
import { hasReviewDeadline } from './lib/deadline.js';
import { appendRunSession } from './lib/run-ledger.js';
import { SHA_RE } from './lib/ledger.js';

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
   * Present when `--since <sha>` was passed: the incremental-review scoping
   * decision, validated HERE so the orchestrator never hand-runs git against
   * an anchor. `effective: true` without `upToDate` means the diff and plan
   * in this report cover `since..fetchedSha` instead of the merge-base range.
   * `upToDate: true` means nothing has landed since the anchor (the anchor is
   * the head, or the commits since it change no bytes) — the diff and plan
   * then cover the FULL range, because the flows that continue past an
   * up-to-date anchor (a model change, `--comment`) run a full review.
   * `effective: false` carries the reason the anchor was refused — a rebase
   * or force-push (`not-an-ancestor`), a sha this history has never seen
   * (`unknown-commit`), an anchor older than the merge base that would
   * scope WIDER than the PR's diff (`behind-merge-base`), a delta carrying
   * hunks the PR's own diff does not contain (`hunks-outside-pr-diff` — an
   * "undo per feedback" revert makes an in-range anchor produce them), a
   * merge base too stale to rule the clamp on (`base-untrusted`), a delta
   * capture that failed (`capture-failed`), or a delta the partitioner
   * refused to tile (`partition-failed`) — and in every one of those the
   * diff and plan are the full range. **`full-range-unavailable` is the
   * single exception and the single planless reason**: it is stamped over
   * whatever refused the anchor whenever the run ends with no captured diff
   * at all, so a reader can key the degraded flow on the reason alone
   * rather than having to cross-check `diffPath` (the underlying refusal is
   * named on stderr).
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
    | 'base-untrusted'
    | 'capture-failed'
    | 'partition-failed'
    | 'full-range-unavailable';
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
}

/** The git questions the anchor ruling asks, injectable for tests. */
export interface AnchorProbe {
  /** `git cat-file -e <sha>^{commit}` — does this history hold the anchor? */
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
 * `mergeBase`, when available, is the clamp: an anchor that is an ancestor
 * of the head but OLDER than the merge base would scope a range strictly
 * WIDER than the PR's own diff (`anchor..head` = the PR plus a slice of base
 * history) — re-reviewing already-landed hunks whose comments fall outside
 * every hunk of GitHub's PR diff, where a single one 422s the whole Create
 * Review call. Reachable non-adversarially: commits from the PR branch
 * landing in the base between rounds move the merge base past the cached
 * anchor. A null `sha` skips the clamp, consistent with the capture path's
 * base-free design — but a `fetchFailed` base REFUSES the anchor: the clamp
 * would then be ruling on a base resolved from a possibly stale local ref,
 * and every sibling guard here (`isEmptyDiff`, `isCollapsedFromUpstream`)
 * declines to rule in that state rather than ruling on it.
 */
export function resolveIncrementalAnchor(
  since: string,
  fetchedSha: string,
  probe: AnchorProbe,
  mergeBase: { sha: string | null; fetchFailed: boolean } | null = null,
): { incremental: IncrementalDecision; diffBase: string | null } {
  // The SAME shape predicate the ledger marker applies, imported rather than
  // restated: an anchor the marker will not carry must not be one the fetch
  // accepts, or the cache path and the marker path drift apart.
  if (!SHA_RE.test(since) || !probe.commitExists(since)) {
    return {
      incremental: { since, effective: false, reason: 'unknown-commit' },
      diffBase: null,
    };
  }
  if (!probe.isAncestor(since, fetchedSha)) {
    return {
      incremental: { since, effective: false, reason: 'not-an-ancestor' },
      diffBase: null,
    };
  }
  const resolved = probe.resolveCommit(since);
  if (resolved === null) {
    // cat-file saw it but rev-parse cannot name it — treat as unknown rather
    // than let an effective:true ride a full-range diff and misstate scope.
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
 * Every hunk of `inner` falls inside a hunk of `outer`, per file, on the NEW
 * side — both diffs end at the same head commit, so their post-image line
 * numbers are directly comparable.
 *
 * This is the containment an ancestry clamp cannot give. An anchor can be a
 * proper ancestor of the head and still produce a delta whose hunks are
 * absent from the PR's own diff: an "undo per feedback" commit reverts some
 * of the previous round's lines back to base content, so those lines are
 * changed in `anchor..head` and unchanged in `base..head`. A comment
 * anchored on such a hunk 422s the whole Create Review call.
 */
export function hunksContainedIn(inner: string, outer: string): boolean {
  const innerSections = diffSections(inner);
  const outerSections = diffSections(outer);
  // A section this parser could not name (a path with spaces, a shape it
  // does not model) is not a section it may vouch for: fail closed to the
  // full range rather than scope on an unparsed diff.
  if (innerSections === null || outerSections === null) return false;
  for (const [file, hunks] of innerSections) {
    const covering = outerSections.get(file);
    // The PATH check, not just the hunk check: a section with no hunks at
    // all — a mode change, a binary replacement, a pure rename — carries no
    // range to compare, and a deletion carries none on the new side. Each
    // used to pass vacuously, which is how a delta whose only content is a
    // file the PR's own diff never mentions became the review's scope.
    if (!covering) return false;
    for (const [start, end] of hunks) {
      if (!covering.some(([s, e]) => s <= start && end <= e)) return false;
    }
  }
  return true;
}

/**
 * `path -> post-image [start, end]` per hunk, one entry per file SECTION —
 * including sections that carry no hunk at all, which map to an empty list.
 *
 * Null when any section's path cannot be named unambiguously; the caller
 * fails closed on it.
 *
 * Structure is recognized only OUTSIDE hunk bodies. Inside a hunk, `+++ b/x`
 * and `@@ … @@` are ordinary added content — an embedded diff fixture is
 * exactly that — and reading them as structure silently re-attributes every
 * later hunk, corrupting the very oracle this check exists to be. Both
 * sibling parsers in this codebase already guard it (`countDiffChangedLines`
 * below tracks `inHunk`; `parseAddedLines` in `test-efficacy.ts` documents
 * the same hazard), and the first cut of this one did not.
 */
function diffSections(
  diffText: string,
): Map<string, Array<[number, number]>> | null {
  const out = new Map<string, Array<[number, number]>>();
  let file: string | null = null;
  // Body lines still owed to the current hunk, old side and new side.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diffText.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk body: consume, never interpret. `\` is the
      // "no newline at end of file" marker and consumes nothing.
      if (line.startsWith('\\')) continue;
      if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      // `diff --git a/X b/Y`. The b-path names the section for every shape
      // that has one — a deletion still reads `diff --git a/F b/F` — so it
      // keys mode-only, binary and rename sections too, which have no
      // `+++` line at all. A path containing ` b/` cannot be split here;
      // the whole diff is then unparsed rather than half-understood.
      const rest = line.slice('diff --git '.length);
      const halves = rest.split(' b/');
      if (halves.length !== 2 || !rest.startsWith('a/')) return null;
      file = halves[1];
      if (!out.has(file)) out.set(file, []);
      continue;
    }
    if (!line.startsWith('@@') || file === null) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const start = Number(m[3]);
    const count = m[4] === undefined ? 1 : Number(m[4]);
    oldLeft = oldCount;
    newLeft = count;
    // A pure deletion hunk has count 0 and sits BETWEEN two post-image
    // lines; give it the zero-width range at its position so it can still
    // be matched against a covering hunk.
    out.get(file)!.push([start, start + Math.max(count, 1) - 1]);
  }
  return out;
}

/** The real git surface `resolveMergeBase` runs against. */
const gitProbe: GitProbe = {
  fetch: (remote, ref) => gitOpt('fetch', remote, ref) !== null,
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

async function runFetchPr(args: FetchPrArgs): Promise<void> {
  const { pr_number: prNumber, owner_repo: ownerRepo, remote, out } = args;

  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }

  ensureAuthenticated();

  const ref = reviewBranch(prNumber);
  const wt = worktreePath(prNumber);
  createReviewWorktreeLease({
    sessionId: process.env['QWEN_CODE_SESSION_ID'],
    promptId: process.env['QWEN_CODE_PROMPT_ID'],
    target: `pr-${prNumber}`,
    repositoryRoot: process.cwd(),
    worktreePath: wt,
    branch: ref,
  });

  // 1. Clean any stale worktree / branch from an earlier run.
  cleanStale(prNumber);

  // 2. Fetch PR HEAD into a unique local ref.
  try {
    git('fetch', remote, `pull/${prNumber}/head:${ref}`);
  } catch (err) {
    throw new Error(
      `Failed to fetch PR #${prNumber} from remote "${remote}": ${(err as Error).message}`,
    );
  }
  const fetchedSha = git('rev-parse', ref);

  // 3. Fetch PR metadata via gh CLI. Cross-repo flag tells the LLM whether
  //    to switch into lightweight mode.
  let meta: PrMetadata;
  try {
    const json = gh(
      'pr',
      'view',
      prNumber,
      '--repo',
      ownerRepo,
      '--json',
      'headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,isCrossRepository,body',
    );
    meta = JSON.parse(json) as PrMetadata;
  } catch (err) {
    // Roll back the fetched ref so the next run starts clean.
    tryRemove(() =>
      execFileSync('git', ['branch', '-D', ref], { stdio: 'pipe' }),
    );
    throw new Error(
      `Failed to fetch PR #${prNumber} metadata: ${(err as Error).message}`,
    );
  }

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

  // 5. Capture the diff to a file and partition it. Written as raw bytes:
  //    CRLF normalisation would rewrite every hunk of a CRLF file, and the
  //    diff must keep its trailing newline to stay a valid patch.
  const { sha: mergeBaseSha, baseFetchFailed } = resolveMergeBase(
    remote,
    meta.baseRefName,
    ref,
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
  const readRange = (left: string): string | null => {
    try {
      return gitRaw(
        ...PINNED_DIFF_CONFIG,
        'diff',
        ...PINNED_DIFF_FLAGS,
        `${left}..${fetchedSha}`,
      ).toString('utf8');
    } catch (err) {
      writeStderrLine(`Failed to capture diff: ${(err as Error).message}`);
      return null;
    }
  };
  /** Publish a range as THE reviewed diff — the file write and both paths. */
  const publish = (text: string): void => {
    diffText = text;
    writeFileSync(diffRel, text);
    diffPath = diffRel;
    diffPathAbsolute = resolve(diffRel);
    // Digest of what was WRITTEN, not of what was captured. The capture is
    // read-only now and a round may read two ranges before publishing one, so
    // hashing at capture time would report a digest for bytes no reader ever
    // sees.
    diffSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
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
  const sinceArg = Array.isArray(args.since)
    ? (args.since as string[])[args.since.length - 1]
    : args.since;
  if (sinceArg !== undefined) {
    anchor = resolveIncrementalAnchor(
      sinceArg,
      fetchedSha,
      {
        commitExists: (sha) =>
          gitOpt('cat-file', '-e', `${sha}^{commit}`) !== null,
        isAncestor: (a, b) =>
          gitOpt('merge-base', '--is-ancestor', a, b) !== null,
        resolveCommit: (sha) => gitOpt('rev-parse', `${sha}^{commit}`),
      },
      { sha: mergeBaseSha, fetchFailed: baseFetchFailed },
    );
  }
  /** Refuse the anchor, keeping every demotion one shape. */
  const demote = (reason: NonNullable<IncrementalDecision['reason']>): void => {
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
  const fullText = mergeBaseSha === null ? null : readRange(mergeBaseSha);
  if (mergeBaseSha === null) {
    writeStderrLine(
      `Could not resolve merge-base of ${meta.baseRefName} and ${ref}; ` +
        `agents will have to fall back to running \`git diff\` themselves.`,
    );
  }
  /** True when the FINAL published diff is the incremental delta. */
  let scopedDelta = false;
  if (anchor?.diffBase) {
    const delta = readRange(anchor.diffBase);
    if (delta === null) {
      // Infrastructure, not anchor validity — but the report must not claim
      // an incremental scope the capture never produced.
      demote('capture-failed');
    } else if (delta.trim() === '') {
      // Commits since the anchor change no bytes: nothing new to review.
      // Same outcome as anchor-at-head, and the full range is published
      // below for the flows that continue anyway (a model change,
      // --comment).
      anchor.incremental.upToDate = true;
    } else if (fullText !== null && !hunksContainedIn(delta, fullText)) {
      // Ancestry containment is not HUNK containment. An ordinary "undo per
      // feedback" commit reverts some of the anchor round's lines back to
      // base content: the delta then carries hunks the PR's own diff does
      // NOT contain, agents review them, and one comment anchored there
      // 422s the entire Create Review call — all-or-nothing, taking every
      // other finding with it. The clamp cannot see this (it compares
      // history, not content), so the delta is checked against the PR's
      // diff before it is allowed to be the review's scope.
      demote('hunks-outside-pr-diff');
    } else {
      publish(delta);
      scopedDelta = true;
      // The scoped range's left side, full-sha, for downstream consumers
      // that recompute their own diffs (Agent 7's test-efficacy probe welds
      // --base into its brief) — without it they would probe the full
      // merge-base range on a delta-scoped round.
      anchor.incremental.diffBase = anchor.diffBase;
    }
  }
  if (!scopedDelta) {
    if (fullText !== null) publish(fullText);
    // `upToDate` promises the report carries the FULL-range diff and plan
    // (the flows that continue past it — a model change, --comment — run
    // full). A full-range capture that failed or never ran breaks that
    // promise, so the ruling is demoted rather than left overclaiming — and
    // under its own reason: `capture-failed` names a DELTA capture failure,
    // and the degraded state here is a different fact (no plan exists at
    // all, not a fallback to a full one).
    if (anchor?.incremental.upToDate && diffPath === null) {
      demote('full-range-unavailable');
    }
  }
  // `buildDiffPlan` throws when the chunks do not tile the diff — a coverage
  // hole. That must be loud, but it must not take the whole review with it: the
  // throw would fire after the worktree exists and before any report is
  // written. Degrade to the documented `diffPath: null` path instead, which
  // tells the skill to fall back and warn the user that coverage is partial.
  let plan;
  try {
    plan = buildDiffPlan(diffText, args.maxChunkLines);
  } catch (err) {
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
    if (scopedDelta && fullText !== null && fullText.trim() !== '') {
      try {
        plan = buildDiffPlan(fullText, args.maxChunkLines);
        publish(fullText);
        scopedDelta = false;
        writeStderrLine(
          'Retried the partition over the full range, which tiled; the ' +
            'round is a full review.',
        );
      } catch {
        // Both ranges refuse to tile — keep the diff-less report.
      }
    }
    // Whether or not the retry rescued the plan, the ruling cannot stand:
    // an `incremental: {effective: true}` over a full-range (or diff-less)
    // plan would send Agent 7 to a delta base while every other reader uses
    // the merge base — one round, two scopes.
    if (anchor?.incremental.effective) demote('partition-failed');
  }
  // Every refusal that ends with NO diff at all reports the planless reason,
  // whatever refused the anchor first. The contract downstream reads is "one
  // reason names the degraded flow" — three shapes (a partition failure, a
  // delta throw with the full-range capture also failing, a delta throw with
  // no merge base) used to publish `capture-failed` over a zero-chunk plan
  // while the skill's per-reason bullet said the full range was in hand. The
  // original refusal is not lost: the status line below names it.
  const anchorRefusal = anchor?.incremental.reason;
  if (anchor && !anchor.incremental.effective && diffPath === null) {
    demote('full-range-unavailable');
  }
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
          : `Incremental anchor ${inc.since.slice(0, 10)} refused (${anchorRefusal}); ${
              diffPath !== null
                ? 'reviewing the full diff.'
                : 'no diff could be captured — coverage will be partial.'
            }`,
    );
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
    // emptied PR went unflagged because its own delta was not empty.
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
    // review — both flags are full-range facts and are skipped on a delta.
    ...(isCollapsedFromUpstream({
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

/** Changed (+/-) lines in a unified diff — headers excluded. */
export function countDiffChangedLines(diffText: string): number {
  // POSITION, not prefix shape. Guessing by prefix (`^-(?!--)`) has to exclude
  // every line starting `--`, and a DELETED line whose own content starts `--`
  // arrives as `--- …`: markdown rules and YAML document markers, SQL and Lua
  // comments, a `--flag` in a script. Each one silently dropped a real changed
  // line, and every drop pushes the ratio toward a false `collapsedFromUpstream`
  // (the disclosure fires when the recomputed count comes in LOW).
  //
  // Inside a hunk the position is unambiguous — `---`/`+++` cannot be file
  // headers there — so track hunk state and count every `+`/`-` line in it.
  let n = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    // `diff --git` opens the next file's header block; `\ No newline at end of
    // file` is a marker, not content, and git emits it inside the hunk.
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+') || line.startsWith('-')) n++;
  }
  return n;
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
          'GitHub host for this PR (GitHub Enterprise). Routes every gh call in this command via GH_HOST; omit for github.com.',
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
      }),
  handler: async (argv) => {
    setGhHost((argv as { host?: string }).host);
    await runFetchPr(argv as unknown as FetchPrArgs);
  },
};
