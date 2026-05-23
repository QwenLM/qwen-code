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
import type { Argv } from 'yargs';
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
   *
   * Optional at the type level because legacy fetch-pr reports written before
   * this field was introduced parse without it — the runtime treats the
   * undefined case as falsy (`if (report.commentMode)`) and falls through to
   * the findings-count check. Keeping the type honest forces callers to
   * handle the missing case explicitly rather than getting silently-wrong
   * `=== false` comparisons or default-destructuring behavior on stale state.
   */
  commentMode?: boolean;
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
        `Preserve any \`--remote <remote>\` (fork-via-upstream workflows) and ` +
        `\`--comment\` flags from the original \`/review\` invocation — ` +
        `omitting them on re-run silently changes the session shape ` +
        `(\`--remote\` defaults to \`origin\`; \`--comment\` resets the ` +
        `report's commentMode and re-enables interactive autofix).\n\n` +
        `Do NOT use \`gh pr checkout\`, \`git checkout <branch>\`, \`git switch\`, ` +
        `\`git pull\`, or \`git reset --hard\` — they mutate the user's working tree. ` +
        `\`fetch-pr\` creates an isolated worktree at ${worktreePath(prNumber)} ` +
        `and writes the JSON report this command needs.`,
    );
  }
  return report;
}

/**
 * Like `requireFetchReport`, but additionally checks that the report was
 * written for the same `owner/repo`. Without this binding, a stale
 * `pr-<n>-fetch.json` left over from reviewing PR #N in repo A can satisfy
 * a `/review N` invocation pointed at repo B, and downstream subcommands
 * proceed as if a worktree had been fetched for B.
 *
 * Same recovery message shape as `requireFetchReport` — the LLM driver can
 * always fix the mismatch by re-running `fetch-pr` with the right repo arg.
 */
export function requireFetchReportFor({
  prNumber,
  ownerRepo,
}: {
  prNumber: string | number;
  ownerRepo: string;
}): FetchReport {
  const report = requireFetchReport(prNumber);
  // GitHub treats owner/repo slugs as case-insensitive — `Owner/Repo` and
  // `owner/repo` are the same repository. Mirroring the precedent set by
  // `presubmit.ts` for the self-PR username compare. Without this, a
  // fetch-pr run with the URL casing (`Owner/Repo`) would spuriously fail
  // the gate when a downstream subcommand received the canonical casing
  // from `gh repo view`.
  if (report.ownerRepo.toLowerCase() !== ownerRepo.toLowerCase()) {
    const path = fetchReportPath(prNumber);
    throw new Error(
      `Fetch-pr report for PR #${prNumber} is bound to a different repo.\n` +
        `  report.ownerRepo: ${report.ownerRepo}\n` +
        `  this command's owner_repo: ${ownerRepo}\n\n` +
        `Re-run \`qwen review fetch-pr ${prNumber} ${ownerRepo} --out ${path}\` ` +
        `to refresh the session for the correct repo. Preserve any ` +
        `\`--remote\` / \`--comment\` flags from the original \`/review\` ` +
        `invocation.`,
    );
  }
  return report;
}

/**
 * Shape of the `--pr` / `--owner-repo` flags every PR-gated review
 * subcommand accepts. Kept as a structural type so we can use a yargs Argv
 * shape OR a hand-built object from a test.
 */
export interface PrSessionArgs {
  pr?: string;
  'owner-repo'?: string;
}

/**
 * Attaches just `--owner-repo` (without `--pr`). `autofix-gate` takes the PR
 * number via its `<target>` positional (`pr-<n>`) but still needs the
 * owner/repo binding, so it uses this helper directly. `addPrSessionOptions`
 * composes this on top of `--pr` for the load-rules/deterministic case.
 */
export function addOwnerRepoOption<T>(yargs: Argv<T>): Argv<T> {
  return yargs.option('owner-repo', {
    type: 'string',
    describe:
      'PR owner/repo (e.g. "octo/repo"). Required for PR-target reviews so the session report can be bound to this repo and stale reports for the same PR number in another repo are rejected.',
  });
}

/**
 * Attaches `--pr` and `--owner-repo` to a yargs builder. Every PR-gated
 * review subcommand that takes the PR number as a flag (load-rules,
 * deterministic) accepts exactly this pair; keeping the option definitions
 * in one place stops the help text and describe strings from drifting
 * between subcommands as the contract evolves.
 */
export function addPrSessionOptions<T>(yargs: Argv<T>): Argv<T> {
  return addOwnerRepoOption(
    yargs.option('pr', {
      type: 'string',
      describe:
        'PR number — when provided, validates that an active fetch-pr session exists for the same owner/repo (requires --owner-repo). Omit for local-uncommitted or file-path reviews.',
    }),
  );
}

/**
 * Single source of truth for the "PR review needs a bound session" gate.
 * Throws with `requireFetchReport` / `requireFetchReportFor` recovery
 * messages if the gate fails; returns the report when it passes; returns
 * null when the caller didn't pass `--pr` at all (local / file review).
 */
export function requirePrSessionFromArgs(
  args: PrSessionArgs,
): FetchReport | null {
  if (!args.pr) {
    return null;
  }
  const ownerRepo = args['owner-repo'];
  if (!ownerRepo) {
    throw new Error(
      '--owner-repo is required when --pr is set (must match the repo `fetch-pr` was run against).',
    );
  }
  return requireFetchReportFor({ prNumber: args.pr, ownerRepo });
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
