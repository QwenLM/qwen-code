/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The parts of a review plan that `fetch-pr` and `plan-diff` both emit. Keeping
// them here means Step 3B's chunk agents, coverage receipts and anchor
// validation work identically whether the diff came from a PR worktree, a local
// working tree, or `gh pr diff` in cross-repo lightweight mode.

import { statSync } from 'node:fs';
import { writeStderrLine } from '../../../utils/stdioHelpers.js';
import { classifyHeavy } from './heavy.js';
import type { DiffChunk, DiffPlan, PathKind } from './diff-plan.js';

export interface FileMetric {
  path: string;
  kind: PathKind;
  /**
   * New-side line ranges this file's hunks occupy, 1-based inclusive.
   *
   * Step 7 anchors an inline comment at `(path, line)` and GitHub rejects the
   * whole review with a 422 if any line falls outside every hunk, so validation
   * is a lookup here rather than trial-and-error against the API.
   *
   * These are **hunk** ranges, which include the three context lines git prints
   * around every change. For "which lines did this PR write", use
   * `addedRanges` — see there.
   *
   * Pure-deletion hunks (`@@ -3,4 +2,0 @@`) are omitted: they occupy no new-side
   * line, nothing can be anchored in them, and nothing in them is new.
   */
  hunks: Array<{ newStart: number; newEnd: number }>;
  /**
   * New-side ranges the PR actually wrote — present only on `heavy` files.
   *
   * Step 3B's whole-file invariant agents are the only consumer, and they only
   * run on heavy files. Emitting them for every file inflates the report past
   * what one `read_file` returns, which is the same hole this design closes for
   * the diff itself.
   */
  addedRanges?: Array<{ start: number; end: number }>;
  addedLines: number;
  removedLines: number;
  changedLines: number;
  /** Lines in the pre-change file; 0 when created, or when unknown. */
  preLines: number;
  /** Lines in the post-change file; 0 for a deletion, a binary blob, or unknown. */
  fileLines: number;
  /** changedLines / fileLines, rounded to 2dp. 0 when fileLines is 0. */
  rewriteRatio: number;
  /**
   * True when the change is large enough that reviewing it hunk-by-hunk is the
   * wrong frame: the interactions are between the new lines themselves, which
   * may sit hundreds of lines apart. Such a file gets three agents that read it
   * whole and check lifecycle invariants. See SKILL.md Step 3B.
   */
  heavy: boolean;
  binary: boolean;
}

/** Everything a review plan says about a diff, regardless of where it came from. */
export interface PlanReport {
  diffLines: number;
  diffChars: number;
  /**
   * Diff lines in `source` files. The review topology is chosen from this, not
   * from `diffLines` — a 150-line production change shipping 800 lines of new
   * tests carries the risk of a small change, and neither do prose or lockfiles.
   */
  srcDiffLines: number;
  testDiffLines: number;
  docsDiffLines: number;
  generatedDiffLines: number;
  /** Contiguous, non-overlapping line ranges tiling the whole diff file. */
  chunks: DiffChunk[];
  files: FileMetric[];
}

/**
 * Build the shared half of a plan report.
 *
 * `postImageLines` resolves a path's line count in the post-change tree. It is
 * null when there is no tree to resolve against — a bare diff file — in which
 * case heaviness cannot be decided and no file is heavy.
 */
export function buildPlanReport(
  plan: DiffPlan,
  postImageLines: ((path: string) => number) | null,
): PlanReport {
  const files = plan.files.map((f): FileMetric => {
    const changedLines = f.addedLines + f.removedLines;
    const fileLines = f.binary || !postImageLines ? 0 : postImageLines(f.path);
    // Derived, not measured. `git show <base>:<path>` would need a second
    // process per file and, worse, would return nothing for a **renamed** file
    // — whose new path does not exist at the base — silently reporting
    // preLines 0 and classifying a wholesale rewrite as "not heavy". The
    // identity is exact for a complete unified diff and stays correct for
    // creations, deletions, and renames alike.
    const preLines = postImageLines
      ? Math.max(0, fileLines - f.addedLines + f.removedLines)
      : 0;
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
      hunks: f.hunks
        .filter((h) => h.newCount > 0)
        .map((h) => ({ newStart: h.newStart, newEnd: h.newEnd })),
      ...(heavy ? { addedRanges: f.addedRanges } : {}),
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

  return {
    diffLines: plan.diffLines,
    diffChars: plan.diffChars,
    srcDiffLines: plan.srcDiffLines,
    testDiffLines: plan.testDiffLines,
    docsDiffLines: plan.docsDiffLines,
    generatedDiffLines: plan.generatedDiffLines,
    chunks: plan.chunks,
    files,
  };
}

/**
 * Warn when the report itself is too large for one `read_file` call.
 *
 * The orchestrator reads this file the same way an agent reads a chunk, and it
 * truncates at the same ceiling — silently losing the tail of `chunks[]`, which
 * is the meta-version of the coverage hole this whole design closes. The report
 * stays pretty-printed so it can be paged by line; a compact one-line JSON
 * could not be paged at all.
 */
export function warnOnReportSize(path: string, cap: number): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size > cap) {
    writeStderrLine(
      `NOTE: the plan report is ${size} bytes, past what one read_file call ` +
        `returns (~${cap}). Page it with offset/limit until isTruncated is false.`,
    );
  }
}
