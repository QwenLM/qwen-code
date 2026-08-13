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
  /** The incremental anchor — the head the last clean round reviewed. */
  since?: string;
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
   * (`unknown-commit`), or a delta capture that failed (`capture-failed`) —
   * and the diff and plan are the full range.
   */
  incremental?: IncrementalDecision;
};

export interface IncrementalDecision {
  since: string;
  effective: boolean;
  upToDate?: boolean;
  reason?: 'unknown-commit' | 'not-an-ancestor' | 'capture-failed';
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
 */
export function resolveIncrementalAnchor(
  since: string,
  fetchedSha: string,
  probe: AnchorProbe,
): { incremental: IncrementalDecision; diffBase: string | null } {
  if (!/^[0-9a-f]{7,64}$/i.test(since) || !probe.commitExists(since)) {
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
  // callers distinguish "captured empty" from "could not capture".
  const captureRange = (left: string): string | null => {
    try {
      const buf = gitRaw(
        ...PINNED_DIFF_CONFIG,
        'diff',
        ...PINNED_DIFF_FLAGS,
        `${left}..${fetchedSha}`,
      );
      writeFileSync(diffRel, buf);
      diffPath = diffRel;
      diffPathAbsolute = resolve(diffRel);
      diffSha256 = createHash('sha256').update(buf).digest('hex');
      return buf.toString('utf8');
    } catch (err) {
      writeStderrLine(`Failed to capture diff: ${(err as Error).message}`);
      return null;
    }
  };

  // The incremental anchor rules first: an effective anchor scopes the diff
  // to `since..head` and the merge base is not consulted for the capture at
  // all (the range needs no base, so a failed base fetch does not cost the
  // incremental path). Every refusal falls back to the full range with its
  // reason in the report — never silently.
  let anchor: {
    incremental: IncrementalDecision;
    diffBase: string | null;
  } | null = null;
  if (args.since !== undefined) {
    anchor = resolveIncrementalAnchor(args.since, fetchedSha, {
      commitExists: (sha) =>
        gitOpt('cat-file', '-e', `${sha}^{commit}`) !== null,
      isAncestor: (a, b) =>
        gitOpt('merge-base', '--is-ancestor', a, b) !== null,
      resolveCommit: (sha) => gitOpt('rev-parse', `${sha}^{commit}`),
    });
  }
  /** True when the FINAL captured diff is the incremental delta. */
  let scopedDelta = false;
  if (anchor?.diffBase) {
    const delta = captureRange(anchor.diffBase);
    if (delta === null) {
      // Infrastructure, not anchor validity — but the report must not claim
      // an incremental scope the capture never produced.
      anchor.incremental = {
        since: anchor.incremental.since,
        effective: false,
        reason: 'capture-failed',
      };
    } else if (delta.trim() === '') {
      // Commits since the anchor change no bytes: nothing new to review.
      // Same outcome as anchor-at-head, and the full range is captured below
      // for the flows that continue anyway (a model change, --comment).
      anchor.incremental.upToDate = true;
    } else {
      diffText = delta;
      scopedDelta = true;
    }
  }
  if (!scopedDelta) {
    if (mergeBaseSha) {
      diffText = captureRange(mergeBaseSha) ?? '';
    } else {
      writeStderrLine(
        `Could not resolve merge-base of ${meta.baseRefName} and ${ref}; ` +
          `agents will have to fall back to running \`git diff\` themselves.`,
      );
    }
  }
  if (anchor) {
    const inc = anchor.incremental;
    writeStderrLine(
      inc.upToDate
        ? `Incremental: anchor ${inc.since.slice(0, 10)} is up to date with the head — nothing new to review.`
        : scopedDelta
          ? `Incremental: scoped to ${inc.since.slice(0, 10)}..${fetchedSha.slice(0, 10)}.`
          : `Incremental anchor ${inc.since.slice(0, 10)} refused (${inc.reason}); reviewing the full diff.`,
    );
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
    ...(!scopedDelta && isEmptyDiff({ diffPath, baseFetchFailed, diffText })
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
    ...(!scopedDelta &&
    isCollapsedFromUpstream({
      diffText,
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
