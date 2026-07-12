/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review capture-local`: capture the working tree's diff — staged,
// unstaged, and untracked — and partition it into review chunks, in one pass.
// The local counterpart of `fetch-pr`.
//
// This used to be a `git diff` command line typed out in the skill prompt, with
// ten flags to pin and a redirect to dodge the 30 000-char shell cap. Two things
// were wrong with that. The flags drifted from the ones `fetch-pr` pins (they
// now live in `lib/diff-flags.ts`, shared). And the command it told the model to
// run — `git diff HEAD` — cannot see an untracked file, so every brand-new file
// in the working tree went unreviewed and a working tree whose only change was a
// new file reported "no changes to review".

import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { captureLocalDiff, type SkippedFile } from './lib/local-diff.js';
import { buildDiffPlan, READ_FILE_CHAR_CAP } from './lib/diff-plan.js';
import {
  buildPlanReport,
  warnOnReportSize,
  stringifyPlanReport,
  type PlanReport,
} from './lib/report.js';

interface CaptureLocalArgs {
  out: string;
  file?: string;
  target: string;
  untracked: boolean;
}

type CaptureLocalResult = PlanReport & {
  diffPath: string;
  diffPathAbsolute: string;
  /** Untracked files whose contents are in the diff — `git diff` shows none. */
  untrackedFiles: string[];
  /** Untracked files that were NOT reviewed. Named, never silently dropped. */
  skippedFiles: SkippedFile[];
};

function runCaptureLocal(args: CaptureLocalArgs): void {
  const { out, file, target } = args;

  const capture = captureLocalDiff({
    file,
    includeUntracked: args.untracked,
  });
  const diffText = capture.diff.toString('utf8');

  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  const diffPath = tmpFile(target, 'diff.txt');
  // Write the bytes, not the string: a re-encode would rewrite the content of
  // every hunk touching a file git handed us in a non-UTF-8 encoding.
  writeFileSync(diffPath, capture.diff);

  const plan = buildDiffPlan(diffText);
  const result: CaptureLocalResult = {
    diffPath,
    diffPathAbsolute: resolve(diffPath),
    // No ref to `git show` a pre-change file out of, so per-file line counts and
    // heaviness are unavailable — same as `plan-diff`. Chunk coverage, which is
    // what the topology needs, is not.
    ...buildPlanReport(plan, null),
    untrackedFiles: capture.untracked,
    skippedFiles: capture.skipped,
  };

  writeFileSync(out, stringifyPlanReport(result), 'utf8');
  writeStdoutLine(`Wrote diff to ${diffPath} and plan to ${out}`);

  if (capture.unbornHead) {
    writeStderrLine(
      'Note: this repo has no commits yet — diffing against the empty tree, ' +
        'so every file reads as new.',
    );
  }
  if (capture.untracked.length > 0) {
    writeStderrLine(
      `Included ${capture.untracked.length} untracked file(s) that no ` +
        `\`git diff\` would show: ${capture.untracked.join(', ')}`,
    );
  }
  for (const s of capture.skipped) {
    writeStderrLine(
      `WARNING: untracked file ${s.path} was NOT reviewed — ${s.reason}. ` +
        `List it under "Not reviewed" in the review output.`,
    );
  }
  if (plan.diffLines === 0) {
    // The genuinely-empty case: nothing staged, nothing unstaged, nothing
    // untracked. An empty plan gives the agents nothing to read, and a review
    // over nothing returns a clean verdict.
    writeStderrLine(
      'WARNING: the working tree is clean — 0 chunks. There is nothing to ' +
        'review; do not run the review agents.',
    );
  }
  writeStderrLine(
    `Diff: ${plan.diffLines} lines (${plan.srcDiffLines} source, ` +
      `${plan.testDiffLines} test, ${plan.docsDiffLines} docs, ` +
      `${plan.generatedDiffLines} generated) -> ${plan.chunks.length} review chunk(s)`,
  );
  warnOnReportSize(out, READ_FILE_CHAR_CAP);
}

export const captureLocalCommand: CommandModule = {
  command: 'capture-local',
  describe:
    'Capture staged + unstaged + untracked changes as one diff and partition it into review chunks',
  builder: (yargs) =>
    yargs
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path for the chunk plan (will be overwritten)',
      })
      .option('file', {
        type: 'string',
        describe:
          'Scope the capture to a single path (a `/review <file-path>` target)',
      })
      .option('target', {
        type: 'string',
        default: 'local',
        describe:
          'Target suffix for the diff file name (`local`, or a filename for a file-path review)',
      })
      .option('untracked', {
        type: 'boolean',
        default: true,
        describe:
          'Include untracked, non-ignored files. On by default: `git diff` cannot see them, so without this a brand-new file goes unreviewed.',
      }),
  handler: (argv) => {
    runCaptureLocal(argv as unknown as CaptureLocalArgs);
  },
};
