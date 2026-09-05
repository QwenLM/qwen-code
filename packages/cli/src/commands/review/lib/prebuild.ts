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
 * a probe started before Agent 7 finishes has an installed tree to run in —
 * with one window to respect: its build phase recompiles the closure
 * regardless, and the per-package build script pre-cleans `dist` before each
 * recompile, so between the pre-clean and `tsc` finishing, a probe that
 * imports a rebuilding sibling resolves against a missing or partial `dist`.
 * A probe overlapping Agent 7's build must target workspaces outside that
 * build closure; the win is the install and the probes, not a skipped build.
 * Nothing about what runs, or as whom, or with which environment, is decided
 * here — only WHEN.
 *
 * Opt-in by environment ({@link PREBUILD_ENV}), because a local review must
 * not pay a multi-minute blocking prefix nobody asked for — the SKILL's "do
 * not install here" rule stands for the interactive case, and CI's review
 * workflow sets the variable on its `Run review` step. The variable alone is
 * not sufficient: the prebuild runs inside `fetch-pr` — one shell-tool call —
 * and a call whose session default cannot carry the budget dies mid-install,
 * killing the whole review. CI welds a covering session default into the
 * agent home's settings where it welds the variable; a local run has
 * neither, so a local opt-in warns and skips ({@link prebuildCovered})
 * instead of dying. As with `QWEN_REVIEW_SANDBOX`, a value sourced from a
 * `.env` file is ignored: the reviewed repository's own `.qwen/.env` reaches
 * `process.env`, and what a PR can toggle about its own review is the
 * operator's decision, not the PR's.
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
import { loadSettings } from '../../../config/settings.js';
import { runBuildTest, type BuildTestReport } from '../build-test.js';
import { npmInstallComplete } from './npm-toolchain.js';

/**
 * Set to `1` to run the prebuild — the ONLY accepted value: the workflow's
 * cover gate compares the same literal, and a second grammar (`true`) would
 * run the prebuild without the session-shell cover welded for `1`. CI's
 * review workflow sets it on the `Run review` step;
 * `scripts/tests/qwen-pr-review-workflow.test.js` pins the workflow literal
 * against this constant.
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
 * Headroom the session-shell cover must carry ON TOP of the budget, in
 * seconds. The cover clock starts when the `fetch-pr` call spawns; the
 * budget clock starts only when the prebuild enters `runBuildTest`. Between
 * them sits the fetch prefix — PR-ref fetch, `gh` metadata, merge-base/base
 * fetch, diff capture, plan write — and after it the report rewrite and the
 * session-ledger append. A cover exactly equal to the budget therefore
 * expires first in the very hang case the budget exists for: `fetch-pr`
 * dies before it can record the outcome, and the fail-open contract breaks.
 * The same timer-vs-budget skew `BUILD_TEST_BUDGET_HEADROOM_S` exists for,
 * sized to the fetch prefix. Stays below the attempt's GNU timeout: budgets
 * floor at 90 minutes (`halve_budget_floor` in the review workflow) and the
 * budget gate refuses the opt-in under anything that cannot carry both.
 */
export const PREBUILD_COVER_HEADROOM_S = 600;

/**
 * The session-shell default a run must have before the prebuild may start:
 * the budget plus the cover headroom, in milliseconds. CI's review workflow
 * welds exactly this into the agent home's settings; nothing does locally.
 */
export const PREBUILD_COVER_MS =
  (PREBUILD_BUDGET_S + PREBUILD_COVER_HEADROOM_S) * 1000;

/**
 * Minimum remainder the attempt budget keeps for the fetch prefix and the
 * review itself when the prebuild is on, in seconds. The workflow's budget
 * gate refuses the opt-in when the effective attempt budget minus the
 * deadline reserve cannot carry `PREBUILD_BUDGET_S` plus this: worst case
 * the prebuild consumes its whole budget (the hang it exists to bound), and
 * an attempt that cannot then still run a review dies mid-`npm ci` — GNU
 * timeout, `OUTCOME='timeout'`, no retry — instead of degrading to the
 * pre-prebuild flow. Sized to the smallest measured end-to-end review (~30
 * minutes on a micro diff), which is also what the 90-minute halving floor
 * leaves exactly enough of.
 */
export const PREBUILD_ATTEMPT_MARGIN_S = 1800;

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
 * Only a real process variable counts — a switch a repository can flip
 * about its own review belongs to the operator — and the property holds in
 * two tiers. The closing tier is the loader's: `QWEN_REVIEW_PREBUILD` sits
 * in `PROJECT_ENV_HARDCODED_EXCLUSIONS`, so a project `.env` (the reviewed
 * checkout's `.qwen/.env` included) never writes the key into the
 * environment at all — necessary, because the registry consulted below is
 * per-process, and a CHILD process inherits a value with no provenance
 * attached. The check here stays as defence in depth for values this
 * process's own loader sourced from a user-scope file. Injected so a test
 * can pin the refusal without a `.env` on disk deciding the outcome.
 */
export function prebuildRequested(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): boolean {
  return env[PREBUILD_ENV]?.trim() === '1' && !fileSourced(PREBUILD_ENV);
}

/**
 * Whether the session shell default in force can carry the prebuild.
 *
 * The prebuild runs inside `fetch-pr` — one shell-tool call in the caller's
 * session — and that call's timer is the session default: per-call timeout
 * (the skill welds none on `fetch-pr`), then `tools.shell.defaultTimeoutMs`,
 * then the 120000ms built-in (`shell.ts`). CI's review workflow welds the
 * cover where it welds the opt-in; a local run has only the built-in, far
 * below the budget, and a prebuild started under it dies mid-install with
 * the whole `fetch-pr` call — the fail-open path never gets to record
 * anything.
 *
 * The gate reads BOTH settings merges, because the timer arms one and the
 * cover is welded where the other reads. Operator-controlled scopes only
 * (`skipWorkspaceSettings`): a repository must not GRANT its own review's
 * cover through `.qwen/settings.json`. And the full merge the shell tool
 * actually applies, where Workspace overrides User: a checkout carrying a
 * below-cover workspace value would otherwise REVOKE the welded cover under
 * the timer while this gate still certifies it. Both reads apply the
 * runtime gate `Config` applies to the value: only in-range integers reach
 * the shell tool, anything else falls back to the built-in.
 */
export function prebuildCovered(): boolean {
  let opOnly: unknown;
  let full: unknown;
  try {
    opOnly = loadSettings(undefined, { skipWorkspaceSettings: true }).merged
      .tools?.shell?.defaultTimeoutMs;
    full = loadSettings(undefined).merged.tools?.shell?.defaultTimeoutMs;
  } catch {
    // An unreadable settings file ends the review nowhere else this early;
    // it must not end it here either. No readable cover, no prebuild.
    return false;
  }
  const covers = (raw: unknown): boolean =>
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 2_147_483_647 &&
    // 0 is the settings-level disable-the-timer sentinel (shell.ts): a
    // call with no deadline at all carries any budget.
    (raw === 0 || raw >= PREBUILD_COVER_MS);
  return covers(opOnly) && covers(full);
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
