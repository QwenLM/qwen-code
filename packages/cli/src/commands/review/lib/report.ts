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
  /**
   * This file's own section of the diff file, 1-based inclusive.
   *
   * An invariant agent reads the post-change file, where a deletion leaves no
   * trace: removing a `clearTimeout()`, a `Map.delete()`, or a counter
   * increment is invisible in the text it is given. Reading this range of the
   * diff shows it the `-` lines. Present only on `heavy` files, the only
   * agents that need it.
   */
  diffRange?: { startLine: number; endLine: number };
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
      ...(heavy
        ? {
            addedRanges: f.addedRanges,
            diffRange: { startLine: f.diffStart, endLine: f.diffEnd },
          }
        : {}),
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

/**
 * Serialize a plan report so it is both **pageable** and **small**.
 *
 * Those pull in opposite directions. Compact JSON is one enormous line, and
 * `read_file` pages at line boundaries, so a report that does not fit in one
 * call could never be read at all. Fully indented JSON pages fine but spends
 * four lines on `{ "startLine": 812, "endLine": 815 }`, and a heavily rewritten
 * file contributes hundreds of those: on PR #6457 — 7 files, one of them
 * rewritten — indentation alone pushed the report to 25 070 bytes, past the
 * ~25 000 a single read returns. The report that tells an agent how to page
 * everything else could not itself be read in one call.
 *
 * So indent the structure and inline the leaves. Same JSON, same semantics,
 * one range per line, 12% smaller.
 */
export function stringifyPlanReport(report: unknown): string {
  const indented = JSON.stringify(report, null, 2);
  // Collapse each two-field range onto one line. The patterns require unescaped
  // double quotes, and JSON escapes every quote inside a string value as `\"`,
  // so no path, ref, or message can be mistaken for a range.
  return (
    indented
      .replace(
        /\{\s*"start": (\d+),\s*"end": (\d+)\s*\}/g,
        '{ "start": $1, "end": $2 }',
      )
      .replace(
        /\{\s*"startLine": (\d+),\s*"endLine": (\d+)\s*\}/g,
        '{ "startLine": $1, "endLine": $2 }',
      )
      .replace(
        /\{\s*"newStart": (\d+),\s*"newEnd": (\d+)\s*\}/g,
        '{ "newStart": $1, "newEnd": $2 }',
      )
      .replace(
        /\{\s*"path": ("(?:[^"\\]|\\.)*"),\s*"newStart": (\d+),\s*"newEnd": (\d+)\s*\}/g,
        '{ "path": $1, "newStart": $2, "newEnd": $3 }',
      ) + '\n'
  );
}
