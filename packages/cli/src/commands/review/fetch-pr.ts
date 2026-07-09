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
//      range instead of running `git diff` themselves: shell output is capped
//      at 30 000 chars (head 1/5 + tail 4/5), which on a large PR hides most
//      of the diff from every agent at once. See `lib/diff-plan.ts`.
//   6. Emit a single JSON report describing the resulting state, which the
//      LLM reads to drive the rest of Step 1.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, gh } from './lib/gh.js';
import { git, gitOpt, gitRaw, refExists } from './lib/git.js';
import {
  REVIEW_TMP_DIR,
  reviewBranch,
  tmpFile,
  worktreePath,
} from './lib/paths.js';
import {
  buildDiffPlan,
  DEFAULT_MAX_CHUNK_LINES,
  type DiffChunk,
  type DiffPlan,
  type PathKind,
} from './lib/diff-plan.js';

interface PrMetadata {
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isCrossRepository: boolean;
}

interface FetchPrArgs {
  pr_number: string;
  owner_repo: string;
  remote: string;
  out: string;
  /** yargs camelCases `--max-chunk-lines`; the snake_case form does not exist. */
  maxChunkLines: number;
}

interface FetchPrResult {
  prNumber: string;
  ownerRepo: string;
  remote: string;
  ref: string;
  fetchedSha: string;
  worktreePath: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  diffStat: { files: number; additions: number; deletions: number };
  /** Merge-base of the PR head and its base branch — the diff's left side. */
  mergeBaseSha: string | null;
  /** Project-relative path to the captured diff (null if capture failed). */
  diffPath: string | null;
  /** Absolute path — `read_file` rejects relative paths. Agents use this. */
  diffPathAbsolute: string | null;
  diffLines: number;
  diffChars: number;
  /**
   * Diff lines in `source` files. The review topology is chosen from this, not
   * from `diffLines` — a 150-line production change shipping 800 lines of new
   * tests carries the risk of a small change.
   */
  srcDiffLines: number;
  testDiffLines: number;
  generatedDiffLines: number;
  /** Contiguous, non-overlapping line ranges tiling the whole diff file. */
  chunks: DiffChunk[];
  /** Per-file rewrite metrics. `heavy` files get whole-file invariant agents. */
  files: FileMetric[];
}

interface FileMetric {
  path: string;
  kind: PathKind;
  /**
   * New-side line ranges this file's hunks occupy, 1-based inclusive.
   *
   * Step 7 anchors an inline comment at `(path, line)`, and GitHub rejects the
   * whole review with a 422 if any line falls outside every hunk. Shipping the
   * ranges here makes that check a lookup. Without it the model has been seen
   * probing GitHub instead — posting throwaway reviews to discover which
   * anchors stick, which leaves junk comments on the PR.
   */
  hunks: Array<{ newStart: number; newEnd: number }>;
  addedLines: number;
  removedLines: number;
  changedLines: number;
  /** Lines in the pre-change file; 0 when the PR creates it. */
  preLines: number;
  /** Lines in the post-change file; 0 for a deletion or a binary blob. */
  fileLines: number;
  /** changedLines / fileLines, rounded to 2dp. 0 when fileLines is 0. */
  rewriteRatio: number;
  /**
   * True when the change is large enough that reviewing it hunk-by-hunk is the
   * wrong frame: the interactions are between the new lines themselves, which
   * may sit hundreds of lines apart. Such a file gets an agent that reads it
   * whole and checks lifecycle invariants. See SKILL.md Step 3B.
   */
  heavy: boolean;
  binary: boolean;
}

/**
 * Heaviness thresholds.
 *
 * Only `source` files qualify. The invariant checklist is about a long-lived
 * stateful object — its fields, timers, collections, error taxonomy. A test
 * file has none of that, and three whole-file agents on one would be spent
 * for nothing.
 *
 * A file must already have existed at some real size (`HEAVY_MIN_PRE_LINES`) —
 * a brand-new file has `rewriteRatio` 1.0 by definition but is not a *rewrite*,
 * and its chunk agents already own every line of it. On top of that it must be
 * either mostly-new (`HEAVY_REWRITE_RATIO`) or changed in sheer volume
 * (`HEAVY_CHANGED_LINES`), which catches a big edit to a very large file whose
 * ratio stays low.
 */
const HEAVY_MIN_PRE_LINES = 300;
const HEAVY_REWRITE_RATIO = 0.4;
const HEAVY_CHANGED_LINES = 800;

/**
 * Pure heaviness rule, extracted so it can be tested without a git repo.
 *
 * The threshold is compared against the **exact** ratio; only the reported
 * `rewriteRatio` is rounded to 2dp. Rounding first would smear the boundary —
 * 399/1000 rounds to 0.40 and would clear a 0.40 threshold it does not meet.
 */
export function classifyHeavy(input: {
  preLines: number;
  fileLines: number;
  changedLines: number;
  binary: boolean;
  kind: PathKind;
}): { rewriteRatio: number; heavy: boolean } {
  const { preLines, fileLines, changedLines, binary, kind } = input;
  const exactRatio = fileLines > 0 ? changedLines / fileLines : 0;
  const heavy =
    !binary &&
    kind === 'source' &&
    preLines >= HEAVY_MIN_PRE_LINES &&
    (exactRatio >= HEAVY_REWRITE_RATIO || changedLines >= HEAVY_CHANGED_LINES);
  return { rewriteRatio: Math.round(exactRatio * 100) / 100, heavy };
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

function fileMetrics(plan: DiffPlan, headSha: string): FileMetric[] {
  return plan.files.map((f) => {
    const changedLines = f.addedLines + f.removedLines;
    const fileLines = f.binary ? 0 : fileLineCount(headSha, f.path);
    // Derived, not measured. `git show <base>:<path>` would need a second
    // process per file and, worse, would return nothing for a **renamed**
    // file — whose new path does not exist at the base — silently reporting
    // preLines 0 and classifying a wholesale rewrite as "not heavy". The
    // identity is exact for a complete unified diff (verified against every
    // file of PR #6457) and stays correct for creations, deletions, and
    // renames alike.
    const preLines = Math.max(0, fileLines - f.addedLines + f.removedLines);
    const { rewriteRatio, heavy } = classifyHeavy({
      preLines,
      fileLines,
      changedLines,
      binary: f.binary,
      kind: f.kind,
    });
    return {
      path: f.path,
      kind: f.kind,
      hunks: f.hunks.map((h) => ({ newStart: h.newStart, newEnd: h.newEnd })),
      addedLines: f.addedLines,
      removedLines: f.removedLines,
      changedLines,
      preLines,
      fileLines,
      rewriteRatio,
      heavy,
      binary: f.binary,
    };
  });
}

/**
 * Resolve the left side of the review diff.
 *
 * Prefers the remote-tracking ref (`origin/main`) because a CI checkout has no
 * local base branch. Returns null when neither resolves — the caller degrades
 * to a diff-less report rather than failing the whole review.
 */
function resolveMergeBase(
  remote: string,
  baseRefName: string,
  headRef: string,
): string | null {
  gitOpt('fetch', remote, baseRefName);
  for (const candidate of [`${remote}/${baseRefName}`, baseRefName]) {
    if (!refExists(candidate)) continue;
    const mb = gitOpt('merge-base', candidate, headRef);
    if (mb) return mb;
  }
  return null;
}

function tryRemove(action: () => void): void {
  try {
    action();
  } catch {
    /* idempotent — silent on missing target */
  }
}

function cleanStale(prNumber: string): void {
  const wt = worktreePath(prNumber);
  if (existsSync(wt)) {
    tryRemove(() =>
      execFileSync('git', ['worktree', 'remove', wt, '--force'], {
        stdio: 'pipe',
      }),
    );
  }
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

  // 1. Clean any stale worktree / branch from an earlier run.
  cleanStale(prNumber);

  // 2. Fetch PR HEAD into a unique local ref.
  const ref = reviewBranch(prNumber);
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
      'headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,isCrossRepository',
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
  const wt = worktreePath(prNumber);
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
  const mergeBaseSha = resolveMergeBase(remote, meta.baseRefName, ref);
  const diffRel = tmpFile(`pr-${prNumber}`, 'diff.txt');
  let diffPath: string | null = null;
  let diffPathAbsolute: string | null = null;
  let diffText = '';
  if (mergeBaseSha) {
    try {
      // Pin every knob that user config could turn: `color.diff=always` would
      // inject ANSI escapes that make every `diff --git` line unrecognisable
      // (the plan would come back with zero chunks); `diff.external` and
      // textconv filters emit output that is not a unified diff at all;
      // `diff.mnemonicPrefix` renames the `a/`/`b/` prefixes to `i/`/`w/`;
      // `diff.context` changes how many lines each hunk carries.
      const buf = gitRaw(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=3',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        `${mergeBaseSha}..${fetchedSha}`,
      );
      writeFileSync(diffRel, buf);
      diffText = buf.toString('utf8');
      diffPath = diffRel;
      diffPathAbsolute = resolve(diffRel);
    } catch (err) {
      writeStderrLine(`Failed to capture diff: ${(err as Error).message}`);
    }
  } else {
    writeStderrLine(
      `Could not resolve merge-base of ${meta.baseRefName} and ${ref}; ` +
        `agents will have to fall back to running \`git diff\` themselves.`,
    );
  }
  const plan = buildDiffPlan(diffText, args.maxChunkLines);

  // 6. Emit the report.
  const result: FetchPrResult = {
    prNumber,
    ownerRepo,
    remote,
    ref,
    fetchedSha,
    worktreePath: wt,
    baseRefName: meta.baseRefName,
    headRefName: meta.headRefName,
    isCrossRepository: meta.isCrossRepository,
    diffStat: {
      files: meta.changedFiles,
      additions: meta.additions,
      deletions: meta.deletions,
    },
    mergeBaseSha,
    diffPath,
    diffPathAbsolute,
    diffLines: plan.diffLines,
    diffChars: plan.diffChars,
    srcDiffLines: plan.srcDiffLines,
    testDiffLines: plan.testDiffLines,
    generatedDiffLines: plan.generatedDiffLines,
    chunks: plan.chunks,
    files: fileMetrics(plan, fetchedSha),
  };

  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeStdoutLine(`Wrote fetch-pr report to ${out}`);
  if (diffPath) writeStdoutLine(`Wrote review diff to ${diffPath}`);
  // Surface diff stats to stderr so a human running the command interactively
  // sees something useful even without inspecting the JSON.
  writeStderrLine(
    `PR #${prNumber} (${ownerRepo}): ${meta.changedFiles} files, +${meta.additions}/-${meta.deletions}, base=${meta.baseRefName}, head=${meta.headRefName}`,
  );
  writeStderrLine(
    `Diff: ${plan.diffLines} lines (${plan.srcDiffLines} source, ` +
      `${plan.testDiffLines} test, ${plan.generatedDiffLines} generated) ` +
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
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe:
          'Target size, in diff lines, of each review chunk. A chunk boundary falls on a hunk boundary; a hunk larger than this is split only at a top-level declaration, never inside a function.',
      }),
  handler: async (argv) => {
    await runFetchPr(argv as unknown as FetchPrArgs);
  },
};
