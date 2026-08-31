/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review plan-diff`: partition an already-captured diff file into review
// chunks and emit the same plan `fetch-pr` emits.
//
// Step 3B's chunk agents are defined as "one per entry in `chunks[]`", and only
// `fetch-pr` produced a chunk plan. A local-diff review, or a cross-repo review
// in lightweight mode, therefore routed into a topology it had no chunk list
// for — no receipts, no tiling guarantee, and the orchestrator left to improvise
// line ranges. Those two paths now capture their diff to a file (redirection
// bypasses Shell model-output truncation) and run this.

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR } from './lib/paths.js';
import { planEffortField } from './lib/effort.js';
import { HOSTNAME_RE } from './lib/gh.js';
import { EFFORT_OPTION, type ReviewEffort } from './parse-args.js';
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
import { operatorReviewSettings } from './lib/review-settings.js';
import { hasReviewDeadline } from './lib/deadline.js';

interface PlanDiffArgs {
  diff_path: string;
  out: string;
  /** yargs camelCases `--max-chunk-lines`; the snake_case form does not exist. */
  maxChunkLines: number;
  /** The PR this diff came from — passed ONLY after `pr-context` succeeded. */
  pr?: number;
  repo?: string;
  /** The PR's host — recorded so Agent 0's evidence fetch is welded with it. */
  host?: string;
  effort?: ReviewEffort;
}

/** A plan for a diff nobody fetched: no worktree — and PR identity only when
 *  the caller resolved one (--pr/--repo, lightweight cross-repo mode). Declared
 *  here so a refactor away from the conditional spread cannot silently drop the
 *  fields the roster's Agent-0 requirement reads. */
type PlanDiffResult = PlanReport & {
  diffPath: string;
  diffPathAbsolute: string;
  prNumber?: string;
  ownerRepo?: string;
  /** The PR's host, when the caller passed one (GitHub Enterprise). */
  host?: string;
  /** The review's effort, recorded so the roster reads one value everywhere. */
  effort?: ReviewEffort;
};

function runPlanDiff(args: PlanDiffArgs): void {
  const { diff_path: diffPath, out } = args;

  let diffText: string;
  try {
    diffText = readFileSync(diffPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read diff file ${diffPath}: ${(err as Error).message}`,
    );
  }

  // Exactly one of the pair is a call error: the roster requires Agent 0 only
  // when the plan carries both, and a plan with half an identity would silently
  // drop the requirement the caller meant to add. (No `plan-diff:` prefix here
  // — the handler's catch prepends it once; a doubled prefix is a bug.)
  if ((args.pr === undefined) !== (args.repo === undefined)) {
    throw new TypeError(
      '--pr and --repo go together — the roster requires the ' +
        'issue-fidelity agent only when the plan carries the full PR identity.',
    );
  }

  // The plan is a file on disk and the role-0 weld interpolates this host
  // unquoted into a shell command the agent runs verbatim — validate before
  // recording, as fetch-pr's handler does via setGhHost's HOSTNAME_RE.
  // A NON-EMPTY all-whitespace `--host` must be rejected, not dropped from
  // the plan (dropping would route the welded evidence fetch at github.com).
  const host =
    args.host === undefined || args.host === '' ? undefined : args.host.trim();
  if (host !== undefined && !HOSTNAME_RE.test(host)) {
    throw new TypeError(
      `--host is not a hostname: ${JSON.stringify(args.host)}`,
    );
  }

  const plan = buildDiffPlan(diffText, args.maxChunkLines);
  const result: PlanDiffResult = {
    diffPath,
    diffPathAbsolute: resolve(diffPath),
    // The PR identity, when the caller resolved one. This is what lets the
    // roster require Agent 0 on a lightweight cross-repo review — a diff-only
    // plan without it cannot demand an agent nobody could build. Passed only
    // when `pr-context` succeeded, so its presence doubles as the
    // context-availability signal.
    ...(args.pr !== undefined && args.repo !== undefined
      ? {
          prNumber: String(args.pr),
          ownerRepo: args.repo,
          // The host rides along so the welded Agent 0 command routes at the
          // Enterprise host — a lightweight run never executes fetch-pr, the
          // other writer of this fact. Validated above (HOSTNAME_RE).
          ...(host !== undefined ? { host } : {}),
        }
      : {}),
    // No `git show` is possible here — there is no ref to resolve a path
    // against — so per-file line counts and heaviness are unavailable. Chunk
    // coverage, which is what Step 3B needs, is not.
    ...buildPlanReport(plan, null, {
      operatorRoundCap: operatorReviewSettings().reverseAuditRounds,
      hasDeadline: hasReviewDeadline(process.env),
    }),
    ...planEffortField(args.effort),
  };

  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  writeFileSync(out, stringifyPlanReport(result), 'utf8');
  writeStdoutLine(`Wrote diff plan to ${out}`);
  if (plan.diffLines === 0) {
    // A file-path review of an unchanged file lands here. An empty plan gives
    // the chunk agents nothing to read, and a review over nothing returns a
    // clean verdict. The skill has a no-diff branch; say so loudly in case it
    // is skipped.
    writeStderrLine(
      `WARNING: the diff is empty — 0 chunks. Reviewing from this plan would ` +
        `examine no code. Review the file's current contents instead.`,
    );
  }
  writeStderrLine(
    `Diff: ${plan.diffLines} lines (${plan.srcDiffLines} source, ` +
      `${plan.testDiffLines} test, ${plan.docsDiffLines} docs, ` +
      `${plan.generatedDiffLines} generated) -> ${plan.chunks.length} review chunk(s)`,
  );
  warnOnReportSize(out, READ_FILE_CHAR_CAP);
}

export const planDiffCommand: CommandModule = {
  command: 'plan-diff <diff_path>',
  describe:
    'Partition a captured diff file into review chunks and write the plan as JSON',
  builder: (yargs) =>
    yargs
      .positional('diff_path', {
        type: 'string',
        demandOption: true,
        describe: 'Path to a unified diff captured with the pinned flags',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('pr', {
        type: 'number',
        describe:
          'The PR number this diff came from (lightweight cross-repo mode). ' +
          'Pass together with --repo, and ONLY after pr-context succeeded — ' +
          'it makes the roster require the issue-fidelity agent.',
      })
      .option('repo', {
        type: 'string',
        describe: 'owner/repo of the PR, together with --pr',
      })
      .option('host', {
        type: 'string',
        describe:
          "The PR's host (GitHub Enterprise), together with --pr/--repo — " +
          "recorded into the plan so Agent 0's issue-evidence fetch routes " +
          'at it; github.com when omitted',
      })
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe:
          'Target size, in diff lines, of each review chunk. A chunk boundary falls on a hunk boundary; a hunk larger than this is split only at a top-level declaration, never inside a function.',
      })
      .option('effort', EFFORT_OPTION),
  handler: (argv) => {
    // The sibling handlers' contract: usage errors (a TypeError — the
    // malformed --host above) exit 2, everything else exits 1 — never an
    // uncaught crash banner for a repairable invocation.
    try {
      runPlanDiff(argv as unknown as PlanDiffArgs);
    } catch (err) {
      // writeStderrLineSafe, not writeStderrLine: a broken stderr (an
      // early-exited reader) must not let the throw escape the catch and
      // lose the exit-2/exit-1 classification this handler exists to give.
      writeStderrLineSafe(`plan-diff: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
