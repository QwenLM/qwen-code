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
// bypasses the 30 000-char shell cap) and run this.

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR } from './lib/paths.js';
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

interface PlanDiffArgs {
  diff_path: string;
  out: string;
  /** yargs camelCases `--max-chunk-lines`; the snake_case form does not exist. */
  maxChunkLines: number;
}

/** A plan for a diff nobody fetched: no worktree, no PR metadata. */
type PlanDiffResult = PlanReport & {
  diffPath: string;
  diffPathAbsolute: string;
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

  const plan = buildDiffPlan(diffText, args.maxChunkLines);
  const result: PlanDiffResult = {
    diffPath,
    diffPathAbsolute: resolve(diffPath),
    // No `git show` is possible here — there is no ref to resolve a path
    // against — so per-file line counts and heaviness are unavailable. Chunk
    // coverage, which is what Step 3B needs, is not.
    ...buildPlanReport(plan, null),
  };

  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeStdoutLine(`Wrote diff plan to ${out}`);
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
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe:
          'Target size, in diff lines, of each review chunk. A chunk boundary falls on a hunk boundary; a hunk larger than this is split only at a top-level declaration, never inside a function.',
      }),
  handler: (argv) => {
    runPlanDiff(argv as unknown as PlanDiffArgs);
  },
};
