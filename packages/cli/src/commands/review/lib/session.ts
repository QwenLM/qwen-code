/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Session-state helpers for the `qwen review` subcommands.
//
// `fetch-pr` writes a JSON report at a canonical path. Downstream subcommands
// (`pr-context`, `presubmit`, `deterministic`, `autofix-gate`) read that
// report to verify the review session is properly set up — i.e. the worktree
// exists and the user's working tree was not bypassed by `gh pr checkout` or
// equivalent. When the report is missing, the subcommand refuses to run with
// a clear error pointing back at `fetch-pr`. This makes the worktree flow a
// hard precondition rather than a prose rule that a weakly instruction-
// following model can skip.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpFile, worktreePath } from './paths.js';

/** Schema written by `qwen review fetch-pr` — read by every downstream step. */
export interface FetchReport {
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
  /**
   * Set to true when the user invoked `/review <pr> --comment`. Persisted in
   * the report so downstream subcommands (notably `autofix-gate`) get a
   * deterministic answer instead of relying on the LLM driver to remember the
   * flag and gate Step 8 correctly.
   */
  commentMode: boolean;
}

/** Canonical fetch-pr report path. SKILL.md prescribes this exact path. */
export function fetchReportPath(prNumber: string | number): string {
  return tmpFile(`pr-${prNumber}`, 'fetch.json');
}

/** Returns the report or null if missing / unparseable. */
export function readFetchReport(prNumber: string | number): FetchReport | null {
  const path = fetchReportPath(prNumber);
  if (!existsSync(path)) return null;
  // readFileSync moved inside the try so EACCES / EISDIR / etc. on a present
  // file degrade to "no report" rather than throwing past the recovery
  // pointer in requireFetchReport.
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FetchReport;
  } catch {
    return null;
  }
}

/**
 * Hard precondition: returns the report or throws with a message that tells
 * the LLM driver exactly how to recover.
 */
export function requireFetchReport(prNumber: string | number): FetchReport {
  const report = readFetchReport(prNumber);
  if (!report) {
    const path = fetchReportPath(prNumber);
    throw new Error(
      `Missing fetch-pr report for PR #${prNumber} (expected at ${path}).\n\n` +
        `The /review skill MUST start with:\n` +
        `  qwen review fetch-pr ${prNumber} <owner>/<repo> --out ${path}\n\n` +
        `Do NOT use \`gh pr checkout\`, \`git checkout <branch>\`, \`git switch\`, ` +
        `\`git pull\`, or \`git reset --hard\` — they mutate the user's working tree. ` +
        `\`fetch-pr\` creates an isolated worktree at ${worktreePath(prNumber)} ` +
        `and writes the JSON report this command needs.`,
    );
  }
  return report;
}

/**
 * Refuse to operate on a worktree path that doesn't match the fetch-pr report.
 * Catches the case where the LLM tries to run the deterministic / autofix step
 * against a path it picked manually instead of `report.worktreePath`.
 */
export function ensureWorktreeMatches(
  report: FetchReport,
  providedWorktree: string,
): void {
  const expected = resolve(report.worktreePath);
  const got = resolve(providedWorktree);
  if (expected !== got) {
    throw new Error(
      `Worktree path mismatch for PR #${report.prNumber}.\n` +
        `  fetch-pr report worktreePath: ${report.worktreePath}\n` +
        `  this command's worktree arg:  ${providedWorktree}\n\n` +
        `Use the worktreePath from the fetch-pr report, not a manually-chosen directory.`,
    );
  }
}
