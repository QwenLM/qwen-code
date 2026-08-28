/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prebuild: install and compile the review worktree BEFORE any agent runs.
 *
 * The worktree `fetch-pr` builds is a bare checkout. Every agent that decides
 * the right evidence is "run the test" — a chunk agent's probe, a verifier's
 * scratch tree — finds no `node_modules` and no built sibling `dist`, and a
 * full install plus the prerequisite builds does not fit inside an agent's
 * tool budget. So each of them burned its budget on a doomed install and the
 * round downgraded to a read-only audit with a "tool budget reached"
 * disclosure (issue #10108: PR #9729 rounds 13 and 15, PR #9940's own review,
 * which could not run the very tests that PR added).
 *
 * This module is NOT a second install path. It calls Agent 7's own
 * `build-test` — `runBuildTest` with `--install --build-only` — so the tree is
 * installed and its scoped closure compiled by exactly the command, sandbox
 * policy, environment and toolchain adapter Agent 7 would run minutes later,
 * with one difference: it runs here, on the orchestrator's clock, with a
 * budget sized to a workflow step instead of a shell tool call. Agent 7 then
 * finds npm's completeness marker, so its own install phase is a no-op, and
 * every probe started before Agent 7 finishes has a tree to run in — its
 * build phase recompiles the closure regardless, because the per-package
 * build script pre-cleans `dist`, so the win is the install and the probes,
 * not a skipped build. Nothing about what runs, or as whom, or with which
 * environment, is decided here — only WHEN.
 *
 * Opt-in by environment ({@link PREBUILD_ENV}), because a local review must
 * not pay a multi-minute blocking prefix nobody asked for — the SKILL's "do
 * not install here" rule stands for the interactive case, and CI's review
 * workflow sets the variable on its `Run review` step. As with
 * `QWEN_REVIEW_SANDBOX`, a value sourced from a `.env` file is ignored: the
 * reviewed repository's own `.qwen/.env` reaches `process.env`, and what a PR
 * can toggle about its own review is the operator's decision, not the PR's.
 *
 * Fail-open by contract. Whatever the prebuild could not do, Agent 7's
 * `build-test` does on its own path exactly as before this module existed:
 * the install gate it reads is npm's own marker, written only by a complete
 * `npm ci`, so a prebuild that timed out, failed, or never ran leaves Agent 7
 * the bare tree it always had. The outcome is recorded as data in the fetch
 * report (`dependencies`) — never a finding, never a throw.
 */

import { writeFileSync } from 'node:fs';
import { isFileSourcedEnvKey } from '../../../config/environment.js';
import { runBuildTest, type BuildTestReport } from '../build-test.js';
import { npmInstallComplete } from './npm-toolchain.js';

/**
 * Set to `1` (or `true`) to run the prebuild. CI's review workflow sets it on
 * the `Run review` step; `scripts/tests/qwen-pr-review-workflow.test.js`
 * pins the workflow literal against this constant.
 */
export const PREBUILD_ENV = 'QWEN_REVIEW_PREBUILD';

/**
 * Whole-call budget for the prebuild, in seconds.
 *
 * Sized to a workflow step, not a tool call: `build-test`'s default budget is
 * what a 600s shell tool leaves usable, which is the ceiling this module
 * exists to escape. Thirty minutes is one sixth of the default review timeout
 * (180 minutes in `qwen-code-pr-review.yml`) and several times the measured
 * cost — the persistent pool installs and builds this repository in about
 * four minutes, a hosted runner in about five. The budget only ever matters
 * when something hangs, and then it bounds the loss instead of the review's
 * own deadline doing so.
 */
export const PREBUILD_BUDGET_S = 1800;

/**
 * Per-command deadline for the prebuild, in seconds. Twenty minutes: the
 * install is the longest single command, and it must not be cut short by a
 * deadline sized to a tool call — a timed-out `npm ci` leaves a partial tree
 * that `build-test` removes, which is the bare tree Agent 7 always had.
 */
export const PREBUILD_COMMAND_TIMEOUT_S = 1200;

/** What the prebuild did to the worktree — the fetch report's `dependencies`. */
export interface WorktreeDependencies {
  /**
   * npm's completeness marker is present: the worktree holds a complete
   * `node_modules`, and Agent 7's install phase is a no-op.
   */
  installed: boolean;
  /**
   * `build-test` reported the install and the scoped build closure green,
   * with nothing cut short by the budget: the sibling `dist` outputs a probe
   * resolves against are compiled from THIS tree.
   */
  built: boolean;
  /**
   * Why the run did what it did, in one line — `build-test`'s own note, or
   * the error when the call could not complete. Empty on a clean run.
   */
  note: string;
  /**
   * `build-test`'s full report for this run — the same shape Agent 7 writes,
   * so a reader diagnosing a failed prebuild reads one format. Null when the
   * report could not be written (the outcome above still stands).
   */
  report: string | null;
  durationMs: number;
}

/**
 * Whether this run asked for the prebuild.
 *
 * Only a real process variable counts: the environment loader applies the
 * reviewed checkout's `.qwen/.env`, and a switch a repository can flip about
 * its own review belongs to the operator. Injected so a test can pin the
 * file-sourced refusal without a `.env` on disk deciding the outcome.
 */
export function prebuildRequested(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): boolean {
  const raw = env[PREBUILD_ENV]?.trim().toLowerCase();
  return (raw === '1' || raw === 'true') && !fileSourced(PREBUILD_ENV);
}

export interface PrebuildArgs {
  /** The fetch report just written — `build-test` reads its file list. */
  plan: string;
  /** The review worktree to install and build in. */
  worktree: string;
  /** Where to write `build-test`'s report for this run. */
  report: string;
  /** Test seam: the build step. Production runs the real `runBuildTest`. */
  run?: (args: Parameters<typeof runBuildTest>[0]) => BuildTestReport;
  /** Test seam: the clock. */
  now?: () => number;
}

/**
 * Install and build the worktree through Agent 7's `build-test`, and say
 * what happened. Never throws: a prebuild that could not complete is the
 * pre-prebuild status quo with a reason attached, and a fetch that built a
 * perfectly good worktree must not die on it.
 */
export function prebuildWorktree(args: PrebuildArgs): WorktreeDependencies {
  const now = args.now ?? Date.now;
  const run = args.run ?? runBuildTest;
  const start = now();
  let report: BuildTestReport | null = null;
  let reportPath: string | null = null;
  let note: string;
  try {
    report = run({
      plan: args.plan,
      worktree: args.worktree,
      out: args.report,
      timeout: PREBUILD_COMMAND_TIMEOUT_S,
      budget: PREBUILD_BUDGET_S,
      install: true,
      // The tests are Agent 7's to run, against its own deadline and with
      // its own resume chain; what every other agent needs from this call is
      // an installed tree and a compiled closure.
      buildOnly: true,
    });
    note = report.note;
    try {
      writeFileSync(args.report, JSON.stringify(report, null, 2));
      reportPath = args.report;
    } catch {
      // The report file is a convenience for whoever reads the fetch report
      // next; the outcome below is measured off the tree and the returned
      // report, not off this write.
    }
  } catch (err) {
    // `runBuildTest` throws on an unreadable or malformed plan — the file
    // this command wrote a moment ago — and on a refused continuation. Both
    // are infrastructure results: record them, and let Agent 7 take its own
    // path as before.
    note = `prebuild did not run: ${(err as Error).message}`;
  }
  const installed = npmInstallComplete(args.worktree);
  // The same rule `base-tree` applies to the merge-base tree: `ok: true` is
  // not a compiled closure — an `unsupported` hand-off and an npm scope with
  // nothing to build both return it with zero build commands run, and
  // `notBuilt` names what a truncated budget never compiled. A probe against
  // packages that were never built manufactures resolution failures that
  // read as defects in the diff.
  const built =
    report !== null &&
    report.ok &&
    report.toolchain === 'npm' &&
    report.build.length > 0 &&
    (report.notBuilt?.length ?? 0) === 0;
  return {
    installed,
    built,
    note,
    report: reportPath,
    durationMs: Math.max(0, now() - start),
  };
}
