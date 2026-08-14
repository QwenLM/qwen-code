/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review build-test`: run the project's own build and tests over the code
// the PR actually changed, and report what happened as data.
//
// Agent 7's brief was a paragraph. It named `npm run build`, then `npm test`, and
// set a 120-second timeout on each. Measured against the harness's own subagent
// transcripts — the record the agent does not write — that paragraph produced
// **139 command timeouts across 89 review sessions, 71 of them `npm run build`**.
// On this repo a cold full build takes 125 seconds. The deadline the skill set was
// five seconds short of the command the skill mandated, so *every* high-effort
// review spent two minutes proving nothing, and then spent several more model
// turns discovering the timeout, ruling it "environmental", and improvising a
// narrower command — which is the command it should have been handed.
//
// Three things are therefore decided here rather than in prose:
//
//   - **The scope.** A two-file PR in one package does not need the other fifteen
//     built. The plan report names every changed file; the root package.json names
//     the workspaces; the build set follows. For PR #6866 that is 6 packages, not
//     19 — 65 seconds, not 125.
//
//   - **The widening.** A workspace's declared dependencies UNDER-approximate what
//     its compile needs: `vscode-ide-companion` maps a tsconfig path straight into
//     `../cli/src`, so its typecheck compiles CLI sources and needs a package it
//     never declares. Modelling that statically over-approximates instead (all of
//     the CLI's dependencies get dragged in). So the set is not predicted — it is
//     *corrected*: build it, and when the compiler says `TS2307: Cannot find module
//     '@scope/pkg'` about a workspace package, add that package and try again.
//     It converges on the minimal correct set and needs to model nothing.
//
//   - **The deadline.** A command that runs out of time is an infrastructure
//     result, not a defect in the diff, and it is reported as one. A review must
//     never file "the build timed out" as a Critical against a PR.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { npmToolchainAdapter } from './lib/npm-toolchain.js';
import {
  selectToolchainAdapter,
  type ReviewToolchainAdapter,
} from './lib/toolchain.js';
import { type TestScope } from './lib/workspace-scope.js';

/**
 * The root toolchains build-test can select. One today; the registry exists so
 * the next one is a registration rather than another branch in this file.
 */
export const toolchainAdapters: readonly ReviewToolchainAdapter[] = [
  npmToolchainAdapter,
];

/** A command this run actually executed, and what it did. */
export interface CommandResult {
  command: string;
  /** `null` when the command was killed by the deadline. */
  exitCode: number | null;
  seconds: number;
  timedOut: boolean;
  /** Trimmed output: enough to correlate a failure with the diff. */
  output: string;
  /**
   * The deadline the command was actually given (ms) — the whole-call budget
   * shortens it below the per-command default, and the timeout note must
   * quote the number that fired, not the flag default.
   */
  deadlineMs?: number;
}

export interface BuildTestReport {
  /** The scoped toolchain that ran, or `unsupported` when selection was unsafe. */
  toolchain: 'npm' | 'unsupported';
  /** Workspace dirs the diff changed. */
  affected: string[];
  /** What was built, dependencies first — after any widening. */
  buildSet: string[];
  /**
   * Packages the whole-call budget stopped BEFORE their build ran, when that
   * happened. Structural for the same reason `notRun` is: a tree missing
   * these was never fully compiled, and consumers of this report
   * (`base-tree`'s availability gate) must be able to see that without
   * parsing prose.
   */
  notBuilt?: string[];
  /** Packages the compiler asked for that the dependency graph had not predicted. */
  widenedWith: string[];
  install: CommandResult | null;
  build: CommandResult[];
  test: CommandResult[];
  /**
   * What the test phase covered, so the review can state exactly what was and
   * was not run: `workspaces` lists exactly the suites the run executes, and
   * `caveat` — when present — says why that set may be incomplete. Only set
   * for workspace monorepos on a test-running call: a single-package repo's
   * one suite IS its full suite, and a build-only probe runs no tests, so
   * neither may claim a scoping decision it never made.
   */
  testScope?: TestScope;
  /**
   * True when every build and test command exited 0. An install that exits non-zero
   * but leaves a usable tree (a failed `prepare` hook) does NOT set this false — the
   * build below is the authoritative signal, and the `note` explains the install.
   */
  ok: boolean;
  /**
   * Commands killed by the deadline. These are NOT findings: a review must not
   * file "the build timed out" as a defect in someone's pull request.
   */
  timedOut: string[];
  /** Why the run did what it did, in one line — rendered into the agent's report. */
  note: string;
}

/** Output kept per command: the head and tail, which is where a failure names itself. */
const KEEP_HEAD = 2_000;
const KEEP_TAIL = 6_000;

/**
 * Did this spawn die on its deadline?
 *
 * Exported so `test-delta`'s rerun asks the SAME question rather than
 * re-deriving it — a copy there used `error.message.includes('ETIMEDOUT')`,
 * which misses an external SIGTERM and fed a silent "base is green".
 */
export function spawnTimedOut(r: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
}): boolean {
  return (
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (r.signal === 'SIGTERM' && r.status === null)
  );
}

/** The module-resolution errors the widening loop reads to grow the build set. */
const MODULE_ERROR_RE = /Cannot find module '[^']+'|Could not resolve "[^"]+"/;

/**
 * Runner summary lines, rescued from a trimmed middle like module errors are.
 *
 * On a FAILING suite the failure details land in the tail and push the
 * `Tests  3 failed | 1132 passed` summary into the omitted middle — measured on
 * a live review of PR #8176, where `test-plan`'s count check found no summary
 * anywhere in an 8 000-char report of a 3-failure run. The summary is the one
 * line that says what the whole run amounted to; keep it.
 */
const RUNNER_SUMMARY_RE = /^\s*(?:Tests?|Test Files):?\s+\d/;

/** SGR color sequences — stripped per line before the summary test, because a
 *  real runner interleaves them BETWEEN tokens (`Tests\x1b[2m  \x1b[22m3 failed`),
 *  where no anchored pattern can step over them. The rescued line itself keeps
 *  its original bytes. */
// eslint-disable-next-line no-control-regex -- ESC is the character under test
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

export function trimOutput(s: string): string {
  if (s.length <= KEEP_HEAD + KEEP_TAIL) return s;
  const middle = s.slice(KEEP_HEAD, s.length - KEEP_TAIL);
  // Rescue module-resolution errors from the omitted middle. The widening loop
  // reads this trimmed output to decide what to add to the build set — a `Cannot
  // find module` line lost to trimming (a long TypeScript log can push one past the
  // head and before the tail) would end the widening early and surface a real
  // graph gap as a false build error. Report stays bounded; the signal survives.
  // CAPPED: the rescue exists to save a handful of summary/module-error lines,
  // and an uncapped predicate made the whole trim a no-op on 40k lines of
  // `Test <n>: …` prose (measured in review — 1.6 MB in, 1.6 MB out). Past the
  // cap the trim's bounded-output contract wins and the rest stays omitted.
  const RESCUE_MAX = 40;
  const rescued = middle
    .split('\n')
    .filter(
      (l) =>
        MODULE_ERROR_RE.test(l) ||
        RUNNER_SUMMARY_RE.test(l.replace(ANSI_SGR_RE, '')),
    )
    .slice(0, RESCUE_MAX);
  const omitted = s.length - KEEP_HEAD - KEEP_TAIL;
  const marker = rescued.length
    ? `\n\n... [${omitted} characters omitted; module-resolution errors and runner summaries kept] ...\n${rescued.join('\n')}\n\n`
    : `\n\n... [${omitted} characters omitted] ...\n\n`;
  return s.slice(0, KEEP_HEAD) + marker + s.slice(-KEEP_TAIL);
}

/**
 * The environment every build/test/install command runs under.
 *
 * `QWEN_SKIP_PREPARE` is the load-bearing entry, and it is exported and tested so
 * a future edit to this env cannot silently drop it. Without it, `npm ci` builds
 * the whole project through this repo's `prepare` hook — `npm run build` + `npm
 * run bundle` over every workspace, ~190s — which is entirely wasted, because this
 * command does its own *scoped* build right after. `prepare.js` reads this exact
 * flag, and its own comment names this exact case: "Release workflow jobs set this
 * when they run explicit build/bundle steps after npm ci." In a TUI A/B on PR
 * #6866 the install-time full build was the single largest thing left in Agent 7.
 * Harmless on any repo that does not read it.
 */
export function buildRunEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: '1',
    npm_config_yes: 'true',
    QWEN_SKIP_PREPARE: '1',
  };
}

function run(command: string, cwd: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  // spawnSync validates `timeout` as an unsigned integer: the adapters'
  // budget arithmetic can hand it a fractional value (a decimal --timeout
  // or --budget), which throws ERR_OUT_OF_RANGE and kills the whole call
  // with no report, or zero, which arms no kill timer at all. Coerce once
  // at the one boundary every command crosses.
  const deadlineMs = Math.max(1, Math.round(timeoutMs));
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: deadlineMs,
    maxBuffer: 64 * 1024 * 1024,
    // A build that asks a question is a build that hangs until the deadline.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildRunEnv(),
  });
  // `spawnSync` sets `error.code === 'ETIMEDOUT'` when the deadline fired — that is
  // the authoritative signal. The `SIGTERM`/null-status pair is only a fallback: it
  // also matches an external SIGTERM (a container stop), and it misses a non-default
  // `killSignal`. Check the authoritative one first.
  const timedOut = spawnTimedOut(r);
  return {
    command,
    exitCode: r.status,
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    output: trimOutput(`${r.stdout ?? ''}${r.stderr ?? ''}`),
    deadlineMs,
  };
}

export { unresolvedWorkspaceDeps } from './lib/npm-toolchain.js';

interface BuildTestArgs {
  plan: string;
  worktree: string;
  out?: string;
  timeout: number;
  install: boolean;
  /**
   * Build, then stop — do not run the changed workspaces' tests.
   *
   * For the merge-base tree an A/B probe compares against. Base's tests were
   * green before this PR existed and running them measures nothing about it;
   * what the probe needs from that tree is a compiled `dist/` to run against,
   * and paying for the suite twice is the difference between an A/B a reviewer
   * will use and one they will skip. Defaults false, so the PR-side call is
   * unchanged.
   */
  buildOnly?: boolean;
  /**
   * Whole-call wall-clock budget in seconds (default: 2× `timeout` − 30s of
   * headroom for process startup and the report write, floored at one
   * per-command deadline). Measured from the top of the call — install and
   * build time count against it. The closure's per-command deadlines SUM, and
   * a large one sums past the tool timeout the brief welds onto the call —
   * whose outer kill discards the report. Each suite is attempted with
   * whatever of this budget remains (a suite killed at the boundary is
   * reported as a timeout — infrastructure, not a finding); only suites never
   * attempted are named in `notRun`.
   */
  budget?: number;
  /**
   * How to run a command. Injectable so the tests can build the states that are
   * hard to force out of real npm — chiefly the one that cost a live review: an
   * install that exits non-zero and leaves a working `node_modules` behind.
   */
  exec?: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

/** The changed files, from whichever plan report produced them. */
function changedFilesFrom(planPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `build-test: cannot read the plan ${planPath}: ${(err as Error).message}`,
    );
  }
  // A plan that parses to `null`, a number, or an array would otherwise reach
  // `report.files` and throw a raw `TypeError` past the descriptive-error path the
  // neighbouring cases get. Name the real problem instead.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `build-test: the plan ${planPath} is not a JSON object (got ` +
        `${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}).`,
    );
  }
  const report = parsed as { files?: Array<{ path?: unknown }> };
  const files = Array.isArray(report.files) ? report.files : [];
  return files
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export function runBuildTest(args: BuildTestArgs): BuildTestReport {
  // yargs `type: 'number'` coerces `--timeout abc` to NaN rather than
  // rejecting it; NaN defeats every budget-floor comparison and reaches
  // spawnSync as an invalid deadline — ERR_OUT_OF_RANGE with no report.
  // Reject both flags at the one boundary every call crosses.
  if (!Number.isFinite(args.timeout)) {
    throw new Error(
      `build-test: --timeout must be a finite number of seconds (got ${String(args.timeout)}).`,
    );
  }
  if (args.budget !== undefined && !Number.isFinite(args.budget)) {
    throw new Error(
      `build-test: --budget must be a finite number of seconds (got ${String(args.budget)}).`,
    );
  }
  const root = resolve(args.worktree);
  const changedFiles = changedFilesFrom(args.plan);
  const runArgs = {
    root,
    changedFiles,
    timeout: args.timeout,
    install: args.install,
    buildOnly: args.buildOnly,
    budget: args.budget,
    exec: args.exec ?? run,
  };
  const { adapter, applicable } = selectToolchainAdapter(
    root,
    toolchainAdapters,
  );
  if (!adapter) {
    if (applicable.length > 1) {
      // Unreachable with one registered adapter, and deliberately kept: the
      // selection contract is "exactly one, or nothing", and the second
      // adapter must land in a file that already refuses to guess between
      // them rather than one that has to grow the branch.
      return {
        toolchain: 'unsupported',
        affected: [],
        buildSet: [],
        widenedWith: [],
        install: null,
        build: [],
        test: [],
        ok: true,
        timedOut: [],
        note:
          'More than one toolchain applies at the repository root. build-test will ' +
          'not guess which one owns this diff, so it ran nothing — report the ' +
          'ambiguity as a handoff instead of substituting ad hoc build or test ' +
          'commands.',
      };
    }
    // A root package.json marks an npm-shaped repo that npm's own gate refused
    // (an unmodeled workspace glob, workspaces that resolve to no package, or
    // no root build/test script). Delegate the handoff to the npm adapter so
    // the report carries its precise reason instead of the generic one — an
    // agent told "no npm project here" about a repo that IS one gets a worse
    // steer than the shape it cannot scope named. run() returns its
    // unsupported report before executing any command on every root where
    // applies() is false.
    if (existsSync(join(root, 'package.json'))) {
      return npmToolchainAdapter.run(runArgs);
    }
    return {
      toolchain: 'unsupported',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        'No supported npm project here to scope. Fall back to the ' +
        'build/test precedence in your brief — installing dependencies first — ' +
        'and give each command a deadline it can actually meet.',
    };
  }
  return adapter.run(runArgs);
}

export const buildTestCommand: CommandModule = {
  command: 'build-test',
  describe:
    'Build the workspaces the diff changes (and what they compile against), ' +
    'test those plus their dependents, with a deadline the commands can ' +
    'actually meet',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the plan report from fetch-pr / plan-diff / capture-local',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe:
          'The tree to build in — the PR worktree for a PR review, or the project ' +
          'root for a local review. Never a PR-mode build of the main checkout.',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe:
          'Per-command deadline in seconds. Kept strictly below the 600s (600000ms) ' +
          "tool timeout the agent's brief welds onto the whole call, so a single hung " +
          "command's own deadline fires — and build-test reports it as data — before " +
          'the outer shell kill would discard the report. Commands that would SUM ' +
          'past the whole call are stopped and disclosed instead — see --budget.',
      })
      .option('budget', {
        type: 'number',
        describe:
          'Whole-call wall-clock budget in seconds, measured from the top of ' +
          'the call — install and build time count against it (default: 2× ' +
          '--timeout minus 30s of headroom for process startup and the report ' +
          'write). Each suite is attempted with whatever of the budget ' +
          'remains — a suite killed at the boundary is a timeout, reported as ' +
          'infrastructure — and only suites never attempted are named notRun. ' +
          'A partial report survives where the outer shell kill would discard ' +
          'the whole one.',
      })
      .option('install', {
        type: 'boolean',
        default: true,
        describe:
          'Fetch dependencies first: `npm ci` when node_modules is absent',
      })
      .option('build-only', {
        type: 'boolean',
        default: false,
        describe:
          "Build, then stop — skip the changed workspaces' tests. For the " +
          'merge-base tree an A/B probe compares against, whose suite says ' +
          'nothing about this PR.',
      }),
  handler: (argv) => {
    const args = argv as unknown as BuildTestArgs;
    try {
      const report = runBuildTest(args);
      if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
    } catch (err) {
      // `changedFilesFrom` throws a descriptive message on a missing/unreadable/
      // invalid plan. Surface that message and exit cleanly, rather than letting a
      // raw stack trace reach the agent as the whole of Agent 7's result.
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
