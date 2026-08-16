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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  DEFAULT_COMMAND_TIMEOUT_S,
  DEFAULT_WHOLE_CALL_BUDGET_S,
} from './lib/build-budget.js';
import { failingFilesOf } from './lib/failing-files.js';
import { npmToolchainAdapter, TEST_COMMAND_RE } from './lib/npm-toolchain.js';
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
   * Test files the runner named as failing, measured off the UNTRIMMED output
   * at capture time. Absent when the command named none.
   *
   * `output` is bounded, and a failing suite's FAIL lines do not fit inside the
   * bound: measured on a live review of PR #9113, a `packages/core` run whose
   * rescued summary line read `Test Files  11 failed` reached `test-delta` with
   * exactly ONE FAIL line still in the report. Everything downstream that
   * attributes a failure — `test-delta`'s netNew/shared sets above all — was
   * re-parsing that bounded text, so ten failing files were invisible to the
   * measurement: absent from `shared` (understating what is pre-existing) and
   * absent from `netNew` (the direction that loses a failure the PR caused).
   * The raw text exists here and nowhere else; record the set while it does.
   */
  failingFiles?: string[];
  /**
   * The deadline the command was actually given (ms) — the whole-call budget
   * shortens it below the per-command default, and the timeout note must
   * quote the number that fired, not the flag default.
   */
  deadlineMs?: number;
  /**
   * True when the deadline this command got was shortened by the whole-call
   * budget rather than being its own — i.e. it was started with less time than
   * `--timeout` allows.
   *
   * A clamped timeout is a PROVISIONAL result: the command was not too slow,
   * the call was too late. Measured on PR #9113, `npm test
   * --workspace="packages/cli"` was admitted with 286s of a 300s deadline and
   * killed — half the whole call spent to learn nothing, and the suite was
   * recorded as timed-out rather than as still-to-run, so nothing downstream
   * could retry it. `--resume` reads this flag and re-runs those commands with
   * a full deadline in the next call.
   */
  clamped?: boolean;
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
  /**
   * The run this report belongs to: the tree it ran in, and the commit the
   * plan fetched (absent for a local review, whose plan carries no sha).
   *
   * This is what `--resume` verifies, because the report's PATH is not an
   * identity: `--out` is stable per PR across review rounds, `fetch-pr`'s
   * stale-sweep removes only the worktree and branch ref, and the review's
   * own cleanup runs post-review — so a round that dies between the report
   * write and cleanup (the interrupted state `--resume` exists for) leaves a
   * well-shaped report behind for the NEXT round to find. Resuming it would
   * keep the old commit's passing entries on the new round's tree —
   * certifying old-commit passes for the new commit — and skip the install
   * the fresh worktree never had.
   *
   * `plan` is the per-round discriminator every mode has. A LOCAL review
   * recreates nothing the other two clauses can see — its plan carries no
   * sha, and its worktree is the project root, never destroyed — so a stale
   * report from an interrupted local round matched all three and certified
   * pre-edit results for the edited tree. Every round writes its plan afresh
   * (capture-local locally, fetch-pr for a PR), so the plan file's mtime
   * separates rounds in both modes; within one round nothing rewrites it
   * between the fresh call and a resume.
   *
   * `tree` is the part path and sha cannot supply: `fetch-pr` DESTROYS and
   * recreates the worktree every round, at the same path, for the same sha —
   * so a stale report from an interrupted round matches both and is admitted
   * onto a bare tree with no node_modules and no dist, whose every suite then
   * fails with resolution errors framed as candidate PR Criticals. The inode
   * and birth time of the worktree root name the INSTANCE: a recreated
   * directory keeps the path and changes both. No legitimate continuation
   * crosses a recreation — the valid resumes all happen inside one round,
   * on the tree the first call ran in.
   */
  run?: {
    sha?: string;
    root: string;
    tree?: { ino: number; birth: number };
    /** The plan file's mtimeMs, rounded — the per-round discriminator. */
    plan?: number;
  };
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

/**
 * Exported for the one thing an injected `exec` cannot cover: that the failing
 * set is measured HERE, off the raw text, and survives a trim that drops the
 * FAIL lines it was parsed from.
 */
export function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): CommandResult {
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
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Parsed from `raw`, not from the trimmed field below — that is the whole
  // point (see CommandResult.failingFiles). Omitted when empty so an install or
  // a build, which name no test file, does not carry an empty list; a consumer
  // reads absent as "this seam supplied no measurement" and falls back to
  // re-parsing `output`, exactly as it did before this field existed.
  const failingFiles = failingFilesOf(raw, cwd);
  return {
    command,
    exitCode: r.status,
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    output: trimOutput(raw),
    deadlineMs,
    ...(failingFiles.length > 0 ? { failingFiles } : {}),
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
   * Whole-call wall-clock budget in seconds. Defaults to what the shell tool's
   * hard 600s ceiling leaves usable (`DEFAULT_WHOLE_CALL_BUDGET_S`), floored at
   * one per-command deadline. Measured from the top of the call — install and
   * build time count against it. The closure's per-command deadlines SUM, and a
   * large one sums past the tool timeout the brief welds onto the call — whose
   * outer kill discards the report. Suites the budget cannot reach are named in
   * `notRun`, and `--resume` continues them in the next call.
   */
  budget?: number;
  /**
   * Continue the run recorded in `--out` instead of starting a new one.
   *
   * The ceiling is per CALL, not per run: one shell invocation cannot exceed
   * 600s, and this repo needs more than that to finish its suites (install 24s
   * + the builds + `packages/core` 106s + `packages/cli` 401s, before four more
   * suites). A resumed call skips install and build — the tree is already
   * installed and compiled by the call being continued — and runs the suites
   * that call could not reach (`testScope.notRun`) plus any it started with a
   * budget-clamped deadline and killed (`clamped`). Results merge into the same
   * report, so every consumer keeps reading one artifact.
   */
  resume?: boolean;
  /**
   * How to run a command. Injectable so the tests can build the states that are
   * hard to force out of real npm — chiefly the one that cost a live review: an
   * install that exits non-zero and leaves a working `node_modules` behind.
   */
  exec?: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

/** The plan's fetched commit, when it has one — a local plan does not. */
function planShaFrom(planPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as {
      fetchedSha?: unknown;
    };
    return typeof parsed?.fetchedSha === 'string' && parsed.fetchedSha
      ? parsed.fetchedSha
      : undefined;
  } catch {
    // changedFilesFrom throws the descriptive error for an unreadable plan;
    // this reader must not race it to a worse one.
    return undefined;
  }
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

/**
 * The report a `--resume` call continues, read from where it will be rewritten.
 *
 * Refusing is the whole value: a resume with no report to continue would run
 * install and build inside a budget the caller sized for suites, and produce a
 * report that looks like a complete run of a tree it never finished compiling.
 */
function previousReport(out: string | undefined): BuildTestReport {
  if (!out) {
    throw new Error(
      'build-test: --resume needs --out — it continues the run recorded there.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(out, 'utf8'));
  } catch (err) {
    throw new Error(
      `build-test: --resume cannot read the report it would continue ` +
        `(${out}): ${(err as Error).message}. Run build-test without ` +
        `--resume first.`,
    );
  }
  // The base gate FIRST, and nothing may read a field before it: `JSON.parse`
  // returns `null` for the literal `null`, and reading `.testScope` off that
  // throws a raw TypeError from inside the function whose entire purpose is to
  // refuse with a named fix.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `build-test: --resume expected a build-test report at ${out}, and that ` +
        `file is not one. Run build-test without --resume first.`,
    );
  }
  const shape = parsed as {
    test?: unknown;
    build?: unknown;
    timedOut?: unknown;
    testScope?: { workspaces?: unknown; notRun?: unknown };
  };
  // Every array the continuation walks, and every ELEMENT of the two it walks
  // per-item. `test: [null]` cleared a gate that checked only `Array.isArray`
  // and then died on `reading 'clamped'` — the same stack trace the gate
  // exists to replace, one layer deeper.
  const commandsOk = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.every(
      (e) =>
        !!e &&
        typeof e === 'object' &&
        !Array.isArray(e) &&
        typeof (e as { command?: unknown }).command === 'string' &&
        (e as { command: string }).command.length > 0,
    );
  // `testScope` is optional — a build-only or single-root report carries none —
  // but a PRESENT one is walked for both of its lists, so a truthy non-object
  // (or a scope whose lists are not lists) has to be refused here rather than
  // becoming a `.filter of undefined` inside the merge.
  // The identity the resume gate walks — validated HERE, like every other
  // field the continuation reads: `tree: null` slipped past a gate that
  // checked only presence shapes and crashed on `null.ino` inside the very
  // check that exists to refuse with a named fix.
  const runShape = (parsed as { run?: unknown }).run;
  const runOk =
    runShape === undefined ||
    (typeof runShape === 'object' &&
      runShape !== null &&
      !Array.isArray(runShape) &&
      typeof (runShape as { root?: unknown }).root === 'string' &&
      (runShape as { root: string }).root.length > 0 &&
      ((runShape as { sha?: unknown }).sha === undefined ||
        typeof (runShape as { sha?: unknown }).sha === 'string') &&
      ((runShape as { plan?: unknown }).plan === undefined ||
        typeof (runShape as { plan?: unknown }).plan === 'number') &&
      ((): boolean => {
        const tree = (runShape as { tree?: unknown }).tree;
        return (
          tree === undefined ||
          (typeof tree === 'object' &&
            tree !== null &&
            !Array.isArray(tree) &&
            typeof (tree as { ino?: unknown }).ino === 'number' &&
            typeof (tree as { birth?: unknown }).birth === 'number')
        );
      })());
  // The other fields the continuation walks: `affected` seeds the
  // affected-first ordering (`new Set(...)` throws on a non-iterable),
  // `notBuilt` gates the unbuilt-tree refusal (`.length` on `true` skips the
  // refusal SILENTLY and runs suites against packages that were never
  // compiled — the worst direction), and the two caveat strings are coerced
  // into prose the agent's brief quotes.
  // Element shapes too, not only the lists: `notRun` entries become shell
  // commands (`npm test --workspace=<dir>`), so a `[null]` that cleared an
  // arrays-only check crashed in the escaper instead of refusing here.
  // Non-empty, not merely string-typed: a '' workspace becomes the command
  // `npm test --workspace=""`, which npm resolves to the root suite — a
  // different measurement wearing the requested one's name.
  const strings = (v: unknown): boolean =>
    Array.isArray(v) && v.every((e) => typeof e === 'string' && e.length > 0);
  const affectedOk = strings((parsed as { affected?: unknown }).affected);
  const notBuiltShape = (parsed as { notBuilt?: unknown }).notBuilt;
  const notBuiltOk = notBuiltShape === undefined || strings(notBuiltShape);
  const scope = shape.testScope;
  const scopeOk =
    scope === undefined ||
    (typeof scope === 'object' &&
      scope !== null &&
      !Array.isArray(scope) &&
      strings(scope.workspaces) &&
      (scope.notRun === undefined || strings(scope.notRun)) &&
      ((scope as { caveat?: unknown }).caveat === undefined ||
        typeof (scope as { caveat?: unknown }).caveat === 'string') &&
      ((scope as { liveCaveat?: unknown }).liveCaveat === undefined ||
        typeof (scope as { liveCaveat?: unknown }).liveCaveat === 'string'));
  if (
    !commandsOk(shape.test) ||
    !commandsOk(shape.build) ||
    !strings(shape.timedOut) ||
    !affectedOk ||
    !notBuiltOk ||
    !scopeOk ||
    !runOk
  ) {
    throw new Error(
      `build-test: --resume expected a build-test report at ${out}, and that ` +
        `file is not one. Run build-test without --resume first.`,
    );
  }
  // Shape is not authorship. The identity check pins a report to this run's
  // tree/sha/plan — an edited-in-place report keeps all three — and the
  // continuation re-executes clamped `test[].command` strings VERBATIM under
  // `shell: true`. So the commands themselves are held to the grammar the
  // emitter can produce, the same policy test-delta applies before re-running
  // report-derived commands. Checked over every entry, not only the clamped
  // ones: `clamped` is a field of the same untrusted file, and a report
  // carrying any command this emitter cannot write is not this emitter's.
  const alien = (shape.test as Array<{ command: string }>).find(
    (t) => !TEST_COMMAND_RE.test(t.command),
  );
  if (alien) {
    throw new Error(
      `build-test: --resume refuses the report at ${out}: test command ` +
        `${JSON.stringify(alien.command)} is not one build-test itself runs ` +
        `(npm test [--workspace="<dir>"]), so the report is not a build-test ` +
        `run this command can continue. Run build-test without --resume ` +
        `first.`,
    );
  }
  return parsed as BuildTestReport;
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
  const runIdentity: {
    sha?: string;
    root: string;
    tree?: { ino: number; birth: number };
    plan?: number;
  } = {
    ...((sha) => (sha ? { sha } : {}))(planShaFrom(args.plan)),
    root,
    ...(() => {
      try {
        return { plan: Math.round(statSync(args.plan).mtimeMs) };
      } catch {
        // changedFilesFrom already threw the descriptive error for an
        // unreadable plan; an unstatable one cannot reach here.
        return {};
      }
    })(),
    ...(() => {
      try {
        const st = statSync(root);
        // birthtimeMs is 0 on filesystems that do not record it, and an
        // immediate delete-and-recreate at the same path CAN reuse the inode
        // (measured on ext4) — so on such filesystems this fingerprint may
        // collide across instances. The plan mtime below is the discriminator
        // that still separates ROUNDS there; the fingerprint adds instance
        // separation where the filesystem supports it. Rounded: a serialized
        // float that re-parses a hair off must not fail an honest same-tree
        // resume.
        return { tree: { ino: st.ino, birth: Math.round(st.birthtimeMs) } };
      } catch {
        // No tree to fingerprint is no tree to build in; the adapter's own
        // errors say that better than a stat failure here could.
        return {};
      }
    })(),
  };
  // A resumed call continues a report; without one there is nothing to
  // continue, and silently starting a fresh run would re-install and re-build
  // inside a budget the caller sized for suites alone. Fail loudly instead.
  if (args.resume && args.buildOnly) {
    // The continuation dispatch would win and silently ignore the flag: a
    // resume runs suites and skips builds, a build-only probe runs builds and
    // skips suites — together they name no work at all.
    throw new Error(
      'build-test: --resume and --build-only contradict each other — a ' +
        'continuation reuses the build and runs the remaining suites. Drop ' +
        'one of the two.',
    );
  }
  const previous = args.resume ? previousReport(args.out) : undefined;
  if (previous) {
    // The report must be THIS run's, not merely well-shaped: the out path is
    // stable across rounds and nothing sweeps it on an interrupted round, so a
    // stale report is exactly what an interrupted round leaves behind. A
    // report with no identity at all cannot prove it belongs here — it
    // predates the stamp, or something else wrote it — and the safe reading
    // is the same as a mismatch.
    const prev = previous.run;
    // The tree fingerprint mismatches when EITHER side has one and the other
    // does not, or both do and they differ. Both-absent passes: a filesystem
    // that yields no stat cannot be held to a fingerprint it never produced.
    const treeMismatch =
      (prev?.tree === undefined) !== (runIdentity.tree === undefined) ||
      (prev?.tree !== undefined &&
        runIdentity.tree !== undefined &&
        (prev.tree.ino !== runIdentity.tree.ino ||
          prev.tree.birth !== runIdentity.tree.birth));
    const planMismatch = (prev?.plan ?? null) !== (runIdentity.plan ?? null);
    if (
      !prev ||
      prev.root !== runIdentity.root ||
      (prev.sha ?? null) !== (runIdentity.sha ?? null) ||
      treeMismatch ||
      planMismatch
    ) {
      throw new Error(
        `build-test: --resume found a report at ${args.out} from a different ` +
          `run (${
            prev
              ? treeMismatch && prev.root === runIdentity.root
                ? `it ran in a PREVIOUS instance of ${prev.root} — the ` +
                  `worktree has been recreated since (fetch-pr rebuilds it ` +
                  `every round), so its installed and compiled state is gone`
                : planMismatch &&
                    prev.root === runIdentity.root &&
                    !treeMismatch
                  ? `it ran against a previous round's plan — each round ` +
                    `captures its own, so its results describe the tree ` +
                    `before this round's changes`
                  : `it ran in ${prev.root}${prev.sha ? ` at ${prev.sha}` : ''}`
              : 'it records no run identity'
          }; this run is in ${runIdentity.root}${
            runIdentity.sha ? ` at ${runIdentity.sha}` : ''
          }). Continuing it would certify another round's results for this ` +
          `one. Run build-test without --resume first.`,
      );
    }
  }
  const runArgs = {
    root,
    changedFiles,
    timeout: args.timeout,
    install: args.install,
    buildOnly: args.buildOnly,
    budget: args.budget,
    previous,
    exec: args.exec ?? run,
  };
  const { adapter, applicable } = selectToolchainAdapter(
    root,
    toolchainAdapters,
  );
  if (!adapter) {
    // A continuation must never answer with a FRESH report. The handler writes
    // whatever this returns to `--out`, which for a resume is the very file
    // the run was asked to continue — so a wrong or pruned `--worktree` would
    // replace an in-flight report (its install record, its passed suites, its
    // clamped entries) with `{"toolchain":"unsupported"}`, and the chain is
    // dead even after the path is fixed. Throwing reaches the handler's catch,
    // which writes nothing. The adapter's own refusals already preserve the
    // input by spreading it; these returns predate `--resume` and do not.
    if (previous) {
      throw new Error(
        `build-test: --resume cannot continue the run recorded at ` +
          `${args.out}: no supported toolchain applies at ${root}. The report ` +
          `is left untouched — check --worktree, then resume again.`,
      );
    }
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
      return { ...npmToolchainAdapter.run(runArgs), run: runIdentity };
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
  return { ...adapter.run(runArgs), run: runIdentity };
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
        default: DEFAULT_COMMAND_TIMEOUT_S,
        describe:
          'Per-command deadline in seconds. Kept strictly below the 600s (600000ms) ' +
          "tool timeout the agent's brief welds onto the whole call, so a single hung " +
          "command's own deadline fires — and build-test reports it as data — before " +
          'the outer shell kill would discard the report. The default is sized to ' +
          "this repo's slowest single command (`npm test --workspace=packages/cli`, " +
          'measured at 401s): a deadline below the slowest suite is not a margin, it ' +
          'is a guaranteed timeout. Commands that would SUM past the whole call are ' +
          'stopped and disclosed instead — see --budget and --resume.',
      })
      .option('budget', {
        type: 'number',
        describe:
          'Whole-call wall-clock budget in seconds, measured from the top of ' +
          'the call — install and build time count against it (default: ' +
          `${DEFAULT_WHOLE_CALL_BUDGET_S}s, what the shell tool's hard 600s ` +
          'ceiling leaves after headroom for process startup and the report ' +
          'write). A suite still gets whatever remains — a partial attempt is ' +
          'signal where a never-attempted suite is none — but a kill at that ' +
          'boundary is recorded as clamped: provisional, not "too slow", and ' +
          '--resume gives it a full deadline in the next call. Only suites the ' +
          'budget cannot attempt at all are named notRun. A partial report ' +
          'survives where the outer shell kill would discard the whole one.',
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
      })
      .option('resume', {
        type: 'boolean',
        default: false,
        describe:
          'Continue the run recorded in --out instead of starting a new one: ' +
          'skip install and build (the tree is already installed and compiled) ' +
          'and run the suites the previous call left in notRun, plus any it ' +
          'started with a budget-shortened deadline and killed. Results merge ' +
          'into the same report. The 600s ceiling is per CALL, so this is how a ' +
          'repo whose suites do not fit one call still finishes them.',
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
