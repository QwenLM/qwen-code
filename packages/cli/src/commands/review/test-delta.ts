/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review test-delta`: rerun the PR side's FAILED test commands on the
// base tree, and report the failing-file sets' difference — so "pre-existing"
// becomes a measurement instead of a judgment.
//
// Agent 7's brief has always said: correlate each failure with the diff — a
// failure in a file the PR changed is a Critical, one in a file it did not
// touch is pre-existing. That is a judgment by PATH, and it is the weakest kind
// of evidence this pipeline still leans on. It misclassifies in both
// directions: an environment-sensitive test fails in a file the PR happens to
// touch (filed as a Critical it did not cause), and a PR breaks a test in a
// file it never touched (waved through as pre-existing — the exact failure
// shape `base-tree` exists to catch).
//
// With a built base tree the question is decidable: run the SAME command there.
// A failure that reproduces on base predates the PR, whatever file it lives in.
// A failure only the PR side shows is the PR's — same caveat.
//
// Two disciplines, both measured on live maintainer verification runs:
//
//   - **Compare failing FILE SETS, not counts.** A flaky suite fails different
//     TESTS on two runs of the same tree (observed live: the same branch's
//     AuthDialog failures changed names between runs), so absolute counts are
//     noise. The failing-file set is stable enough to diff, and an EMPTY
//     net-new set is the strongest "pre-existing" statement available.
//   - **Only failed commands are rerun.** A green PR-side suite has nothing to
//     attribute, and base's suite was green before the PR existed — running it
//     would measure nothing about the diff. The base run costs exactly one run
//     per PR-side failure.
//
// The PR side's failing files are parsed from the build-test report's already
// captured output, not from a rerun — the report is the record of what
// actually failed, and `trimOutput` keeps the failure section (the tail) plus
// rescued summary lines. A file this cannot parse is disclosed, never guessed.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  buildRunEnv,
  spawnTimedOut,
  trimOutput,
  type BuildTestReport,
  type CommandResult,
} from './build-test.js';
import { failingFilesOf } from './lib/failing-files.js';

/**
 * The exact shapes `build-test` emits for a test command — and the only ones
 * this command will hand to a shell.
 *
 * The report is a FILE this reads and then executes from, with `shell: true`,
 * in the base worktree. Nothing else in the pipeline re-executes a string it
 * read back off disk, so nothing else has to care where that string came from;
 * this does. The workspace token is a directory, and a directory is a name a
 * pull request can choose: `packages/x";curl …|sh;"` is a legal path in git
 * and on Linux, and it round-trips through the report into a shell.
 *
 * Restricting to the emitter's own grammar costs nothing real — `build-test`
 * produces `npm test` and `npm test --workspace="<dir>"`, both matched here —
 * and anything outside it is skipped and disclosed rather than run, which is
 * the same treatment every other thing this command cannot do gets.
 */
const RERUNNABLE_COMMAND_RE = /^npm test(?: --workspace="[\w@./-]+")?$/;

/** `trimOutput`'s own marker — the one signal that a stored output is partial. */
const TRIM_MARKER_RE = /\.\.\. \[\d+ characters omitted/;

// The failing-file parser lives in lib/ because build-test needs it too: the
// PR side has to be measured off its UNTRIMMED output, at capture time.
// Re-exported here for the callers (and tests) that have always found it here.
export { failingFilesOf, relativeToRoot } from './lib/failing-files.js';

/** One rerun: the same command, in the base tree. */
export interface DeltaEntry {
  command: string;
  /** Failing test files parsed from the PR-side report's captured output. */
  prFailingFiles: string[];
  /** Failing test files from the base-side rerun. */
  baseFailingFiles: string[];
  /** Failing on the PR side only — the PR's own, by measurement. */
  netNew: string[];
  /** Failing on BOTH sides — pre-existing, whatever file the diff touches. */
  shared: string[];
  base: CommandResult;
  /**
   * True when the PR side named no parseable failing file although the
   * command failed — the delta for this command proves nothing, and the
   * path-based judgment stays in force. Disclosed, never silently dropped.
   */
  unparsed: boolean;
  /**
   * True when the PR side had to be re-parsed out of the TRIMMED stored
   * output — the report carried no capture-time `failingFiles` (or a
   * malformed one) AND the trim marker is present. A report whose set was
   * measured before the trim never sets this. When it is set, the loss cuts
   * BOTH ways: a missing file understates `shared` when base fails it too,
   * and understates `netNew` — the direction that loses a failure the PR
   * caused — when only the PR side does.
   */
  prTruncated: boolean;
}

export interface TestDeltaReport {
  entries: DeltaEntry[];
  /** Union across entries, deduplicated. */
  netNew: string[];
  shared: string[];
  /**
   * Commands the whole-command budget could not fit — their failures stay
   * unattributed. A STRUCTURED field, not prose only: `mutants.skippedForBudget`
   * and `hunks.skippedForBudget` are what Agent 7's brief teaches a reader to
   * check, and an equivalent discoverable only by substring-matching `note` is
   * the silent cap the same brief rules out.
   */
  skippedForBudget: string[];
  note: string;
}

export interface TestDeltaArgs {
  report: string;
  baseline: string;
  out?: string;
  /**
   * The PR worktree the report's failures were produced in — its root is
   * stripped so both sides compare as repo-relative paths. Named for yargs'
   * camel-cased `--pr-worktree`; a field named for the flag itself would read
   * `undefined` on every real invocation.
   */
  prWorktree?: string;
  timeout: number;
  /** Test seam — production spawns the real command. */
  exec?: (command: string, cwd: string, timeoutMs: number) => BaseRunResult;
  /** Injectable clock, for tests only — the budget math cannot be driven to
   *  its cutoff in real time. Matches `test-efficacy`'s seam; without it a
   *  test has to reassign the global `Date.now`. */
  now?: () => number;
}

/**
 * A base-side rerun, plus what it measured BEFORE its output was bounded.
 *
 * `output` is trimmed for the report, and `trimOutput` rescues only module
 * errors and runner summaries out of the omitted middle — not the per-file
 * `FAIL` lines this command parses. A base suite with a failure section over
 * the tail budget would therefore lose failing files into the gap, and a
 * SHORTER base set is the dangerous direction: `netNew` is the PR side minus
 * the base side, so every file trimming hid becomes a fabricated Critical
 * attributed to this PR by "measurement". Parse the raw text, report the
 * bounded one.
 */
export interface BaseRunResult extends CommandResult {
  /** Parsed from the untrimmed output. Absent from a seam that predates this. */
  failingFiles?: string[];
}

// Mirrors build-test's run() on the three properties its comments call out as
// deliberate — reviewed live when this reimplementation diverged on all three:
// stdin ignored (a rerun that asks a question hangs to the deadline), timeout
// read from error.code with the SIGTERM/null-status fallback (the substring
// form misses a maxBuffer kill, which would flow into the base-green Critical
// path), and trimmed output (a failing monorepo suite is hundreds of KB that
// would otherwise land verbatim in the report Agent 7 reads).
function run(command: string, cwd: string, timeoutMs: number): BaseRunResult {
  const started = Date.now();
  const r = spawnSync(command, {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildRunEnv(process.env),
    maxBuffer: 64 * 1024 * 1024,
    // build-test's, deliberately: "a build that asks a question is a build that
    // hangs until the deadline" — and this reruns those same commands.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The sibling's predicate, not a weaker re-derivation: an external SIGTERM
  // (container stop, cancelled CI job) sets neither an ETIMEDOUT message nor
  // an exit code, so the substring form reported timedOut:false with empty
  // output and fed straight into the base-green path.
  const timedOut = spawnTimedOut(r);
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    command,
    exitCode: timedOut ? null : (r.status ?? null),
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    failingFiles: timedOut ? [] : failingFilesOf(raw, cwd),
    // Bounded like build-test's: this lands in `entries[].base.output`, which
    // is JSON.stringify'd to --out, and the verdict fields sit AFTER it — an
    // untrimmed megabyte pushes exactly what the command produces past any
    // reader's truncation.
    output: trimOutput(raw),
  };
}

/**
 * Whole-command budget, mirroring test-efficacy's. `--timeout` is PER COMMAND,
 * so three failed commands at the 300s default is 900s against the 600s tool
 * ceiling — killed with NO report written, discarding the base-tree install and
 * build just paid for. Commands the budget cannot fit are disclosed, never
 * silently dropped.
 */
const TOTAL_BUDGET_MS = 540_000;

/** The CLI default, reused when a programmatic caller omits `--timeout`. */
const DEFAULT_TIMEOUT_S = 300;

export function runTestDelta(args: TestDeltaArgs): TestDeltaReport {
  const exec = args.exec ?? run;
  const baseline = resolve(args.baseline);
  const empty = (note: string): TestDeltaReport => ({
    entries: [],
    netNew: [],
    shared: [],
    skippedForBudget: [],
    note,
  });

  let report: BuildTestReport;
  try {
    report = JSON.parse(readFileSync(args.report, 'utf8')) as BuildTestReport;
  } catch (err) {
    return empty(
      `cannot read the build-test report ${args.report}: ${(err as Error).message}`,
    );
  }
  if (!existsSync(baseline)) {
    return empty(
      `the base tree ${baseline} does not exist — run \`qwen review base-tree\` first`,
    );
  }

  // Failed for real: a timeout is an infrastructure result and reruns as one.
  const failed = (report.test ?? []).filter(
    (t) => !t.timedOut && t.exitCode !== 0,
  );
  if (failed.length === 0) {
    return empty(
      'no PR-side test command failed — there is nothing to attribute, and the base run would measure nothing',
    );
  }

  // A programmatic caller may omit `timeout`; `NaN * 1000` reaches spawnSync as
  // an invalid deadline. Fall back to the CLI's own default.
  const perCommandMs =
    (Number.isFinite(args.timeout) ? args.timeout : DEFAULT_TIMEOUT_S) * 1000;
  const now = args.now ?? Date.now;
  const startedAt = now();
  const skippedForBudget: string[] = [];
  /** Reruns killed by a deadline the BUDGET shortened, not by their own. */
  const budgetClamped: string[] = [];
  const entries: DeltaEntry[] = [];
  /** Commands that did not match the emitter's grammar, so were never run. */
  const skippedUnrecognised: string[] = [];
  for (const t of failed) {
    if (!RERUNNABLE_COMMAND_RE.test(t.command)) {
      skippedUnrecognised.push(t.command);
      continue;
    }
    const remaining = TOTAL_BUDGET_MS - (now() - startedAt);
    // PRICE the slot against how long the command actually took on the PR
    // side, the way test-efficacy prices a mutant run against the measured
    // baseline. A flat 5s floor admits a command with six seconds left, whose
    // guaranteed timeout `budgetClamped` below then has to explain after the
    // fact — cheaper, and honester, not to start a rerun the window cannot
    // hold. `seconds` is the PR side's own duration; the base tree is built
    // and warm, so it is the closest estimate available. Floored so a
    // sub-second command still gets a usable window, and capped by the
    // per-command deadline so a slow command is not skipped for wanting more
    // than it would ever be given.
    const estimateMs = Math.max((t.seconds ?? 0) * 1000, 30_000);
    if (remaining < Math.min(estimateMs, perCommandMs)) {
      skippedForBudget.push(t.command);
      continue;
    }
    // Prefer the set build-test measured off its untrimmed output; fall back to
    // re-parsing the bounded report only for a report written before that field
    // existed. Same precedence the base side uses below, and for the same
    // reason: the trim is lossy and the capture site is not.
    //
    // Shape-checked here because this is the one consumer and the report is a
    // file anything may have edited: a `failingFiles` that is not a string
    // array reached `.filter` as-is and threw where the honest reading is
    // "this seam supplied no measurement" — the same fallback an absent field
    // has always taken.
    // Non-empty too: the producer OMITS the field when nothing failed to
    // parse, so an empty array can only be hand-made — and taking it as
    // authoritative would skip the reparse and understate both sets.
    const measured =
      Array.isArray(t.failingFiles) &&
      t.failingFiles.length > 0 &&
      t.failingFiles.every((f) => typeof f === 'string')
        ? t.failingFiles
        : undefined;
    const prFailingFiles =
      measured ?? failingFilesOf(t.output ?? '', args.prWorktree ?? '');
    // A clamped deadline is not the same fact as a slow command: if the
    // budget cut this rerun short, "timed out — infrastructure" would send the
    // reader hunting a hang that is really an exhausted budget. Record which.
    const clamped = remaining < perCommandMs;
    const base = exec(t.command, baseline, Math.min(perCommandMs, remaining));
    if (base.timedOut && clamped) budgetClamped.push(t.command);
    // Prefer what the run itself measured off the untrimmed text; fall back to
    // re-parsing the bounded output only for a seam that supplies neither.
    const baseFailingFiles = base.timedOut
      ? []
      : (base.failingFiles ?? failingFilesOf(base.output, baseline));
    // The PR side is what netNew/shared are derived from, so a PR side that
    // parsed NOTHING attributes nothing — regardless of what the base rerun
    // managed to parse. Requiring both sides to be empty silently dropped a
    // failed command whose FAIL lines the trim had scattered.
    const unparsed = prFailingFiles.length === 0;
    // Only when the PR side had to be re-parsed out of build-test's STORED
    // output, which that command trimmed. A report that carries `failingFiles`
    // was measured before the trim, so its set is complete and the disclosure
    // would be a false alarm.
    //
    // When the fallback IS in use the loss cuts both ways, and the earlier
    // wording ("`shared`, not `netNew`") understated it: a file the trim
    // dropped is missing from `shared` when base fails it too, and missing from
    // `netNew` when only the PR side does — the direction that loses a failure
    // the PR caused. Hence the capture-time field; this is the legacy seam.
    const prTruncated =
      measured === undefined && TRIM_MARKER_RE.test(t.output ?? '');
    // A base run that never finished attributes NOTHING: with its failing set
    // unknowable, promoting the PR side's failures to net-new would
    // manufacture the strongest evidence this command produces out of an
    // infrastructure timeout. The files stay unattributed (neither list), and
    // the note says why.
    // ...and so does a base rerun that FAILED without naming a single failing
    // file. An unbuilt base tree, a missing node_modules, a workspace the PR
    // ADDED (so `npm test --workspace=…` cannot resolve on base), an ENOBUFS
    // truncation: each exits non-zero with zero FAIL lines, indistinguishable
    // here from a green base. Reading it as green promotes every PR-side
    // failure to netNew — the strongest evidence this command emits,
    // manufactured from a base that never ran a test.
    const baseUnusable =
      base.timedOut || (base.exitCode !== 0 && baseFailingFiles.length === 0);
    entries.push({
      command: t.command,
      prFailingFiles,
      baseFailingFiles,
      netNew: baseUnusable
        ? []
        : prFailingFiles.filter((f) => !baseFailingFiles.includes(f)),
      shared: baseUnusable
        ? []
        : prFailingFiles.filter((f) => baseFailingFiles.includes(f)),
      base,
      unparsed,
      prTruncated,
    });
  }

  const netNew = [...new Set(entries.flatMap((e) => e.netNew))].sort();
  const shared = [...new Set(entries.flatMap((e) => e.shared))].sort();
  const unparsed = entries.filter((e) => e.unparsed).length;
  const timedOut = entries.filter((e) => e.base.timedOut).length;
  const truncated = entries.filter((e) => e.prTruncated).length;

  const parts: string[] = [];
  if (netNew.length) {
    parts.push(
      `${netNew.length} failing file(s) do NOT fail on base — the PR's own by measurement: ${netNew.join(', ')}`,
    );
  }
  if (shared.length) {
    parts.push(
      `${shared.length} failing file(s) also fail on base — pre-existing, whatever files the diff touches: ${shared.join(', ')}`,
    );
  }
  if (unparsed) {
    parts.push(
      `${unparsed} command(s) failed but named no parseable failing file — no delta for those; judge them by the diff as before`,
    );
  }
  if (skippedUnrecognised.length) {
    parts.push(
      `${skippedUnrecognised.length} failed command(s) were not rerun because they are not the shape \`build-test\` emits (${skippedUnrecognised.join(', ')}) — this command executes what the report names, so it executes only that grammar; their failures stay unattributed, judge them by the diff`,
    );
  }
  if (truncated) {
    parts.push(
      `${truncated} command(s) reached this from a report that trimmed their PR-side output and recorded no failing-file set, so their failing-file list may be partial — a file the trim dropped is missing from BOTH lists: unattributed, never invented`,
    );
  }
  const unusable = entries.filter(
    (e) =>
      !e.unparsed &&
      e.prFailingFiles.length > 0 &&
      e.netNew.length === 0 &&
      e.shared.length === 0 &&
      !e.base.timedOut,
  );
  if (unusable.length) {
    parts.push(
      `${unusable.length} command(s) could not be attributed — the base rerun ${unusable
        .map(
          (e) =>
            `\`${e.command}\` failed (exit ${e.base.exitCode}) without naming a failing file, so it did not measure the base (an unbuilt tree, a missing install, a workspace absent at base)`,
        )
        .join('; ')}; judge those failures by the diff as before`,
    );
  }
  if (timedOut) {
    parts.push(
      `${timedOut} base-side rerun(s) timed out — infrastructure, not evidence` +
        (budgetClamped.length
          ? ` (${budgetClamped.length} of them on a deadline the whole-command budget shortened, not their own: ${budgetClamped.join(', ')} — a rerun with budget to spare may still measure them)`
          : ''),
    );
  }
  if (skippedForBudget.length) {
    parts.push(
      `${skippedForBudget.length} failed command(s) not rerun — the whole-command budget was exhausted (${skippedForBudget.join(', ')}); their failures stay unattributed, judge them by the diff`,
    );
  }
  return {
    entries,
    netNew,
    shared,
    skippedForBudget,
    note: parts.join('. ') || 'nothing to report',
  };
}

export const testDeltaCommand: CommandModule = {
  command: 'test-delta',
  describe:
    "Rerun the PR side's failed test commands on the base tree and report which failing files are the PR's own (net-new) vs pre-existing (shared)",
  builder: (yargs) =>
    yargs
      .option('report', {
        type: 'string',
        demandOption: true,
        describe:
          "Agent 7's build-test report (its failed commands and outputs)",
      })
      .option('baseline', {
        type: 'string',
        demandOption: true,
        describe: 'The BUILT base tree from `qwen review base-tree`',
      })
      .option('pr-worktree', {
        type: 'string',
        describe:
          "The PR worktree the report's failures were produced in — its root " +
          'is stripped so both sides compare as repo-relative paths',
      })
      .option('out', { type: 'string', describe: 'Write the JSON report here' })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe: 'Per-command deadline in seconds, as build-test',
      }),
  handler: (argv) => {
    const args = argv as unknown as TestDeltaArgs;
    const report = runTestDelta(args);
    if (args.out) {
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
    }
    writeStdoutLine(JSON.stringify(report, null, 2));
    writeStderrLine(`test-delta: ${report.note}`);
  },
};
