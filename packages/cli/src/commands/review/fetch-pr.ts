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
  READ_FILE_CHAR_CAP,
} from './lib/diff-plan.js';
import {
  buildPlanReport,
  warnOnReportSize,
  type PlanReport,
} from './lib/report.js';
import { resolveMergeBase, type GitProbe } from './lib/merge-base.js';

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

type FetchPrResult = PlanReport & {
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
  /** True when the base branch could not be fetched; `mergeBaseSha` may be stale. */
  baseFetchFailed: boolean;
  /** Project-relative path to the captured diff (null if capture or planning failed). */
  diffPath: string | null;
  /** Absolute path — `read_file` rejects relative paths. Agents use this. */
  diffPathAbsolute: string | null;
};

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
        // `diff.suppressBlankEmpty` has no command-line override, only `-c`.
        // With it set, a blank context line is printed as a physically empty
        // record instead of a lone space.
        '-c',
        'diff.suppressBlankEmpty=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=3',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        // `diff.renames=false` would report a move as delete + add, so the new
        // path's `preLines` would derive to 0 and a wholesale rewrite would
        // never be flagged heavy. `diff.relative` would strip the repo prefix
        // from every path when the command runs from a subdirectory.
        '--find-renames',
        '--no-relative',
        // `diff.ignoreSubmodules=all` hides a changed gitlink entirely — a
        // silent coverage hole — and `diff.submodule=log` replaces the whole
        // `diff --git` section with prose the parser cannot read.
        '--ignore-submodules=none',
        '--submodule=short',
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
    plan = buildDiffPlan('', args.maxChunkLines);
  }

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
    baseFetchFailed,
    diffPath,
    diffPathAbsolute,
    ...buildPlanReport(plan, (path) => fileLineCount(fetchedSha, path)),
  };

  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
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
