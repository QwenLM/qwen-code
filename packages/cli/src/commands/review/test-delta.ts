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
  trimOutput,
  type BuildTestReport,
  type CommandResult,
} from './build-test.js';

// eslint-disable-next-line no-control-regex -- ESC is the character under test
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Test files a runner named as failing, out of one command's output.
 *
 * Two shapes cover vitest and jest, the runners build-test drives:
 * `FAIL  src/x.test.ts > name` (both, in the failure section) and vitest's
 * per-file `❯ src/x.test.ts (12 tests | 3 failed)` progress line. Matching is
 * on the path token, so a `FAIL` line whose path was truncated mid-token by
 * output trimming simply does not match — an unparsed failure surfaces as a
 * count mismatch in the caller's disclosure, never as an invented path.
 */
export function failingFilesOf(output: string): string[] {
  const text = output.replace(ANSI_SGR_RE, '');
  const files = new Set<string>();
  const re =
    /(?:^|\s)(?:FAIL\s+|❯\s+)(?:\|[^|]+\|\s+)?([\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b([^\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // The `❯` progress line lists every file; only a failing one counts.
    if (m[0].trimStart().startsWith('❯') && !/failed/.test(m[2] ?? ''))
      continue;
    files.add(m[1]);
  }
  return [...files].sort();
}

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
   * True when neither side's failing files could be parsed although the
   * command failed — the delta for this command proves nothing, and the
   * path-based judgment stays in force. Disclosed, never silently dropped.
   */
  unparsed: boolean;
}

export interface TestDeltaReport {
  entries: DeltaEntry[];
  /** Union across entries, deduplicated. */
  netNew: string[];
  shared: string[];
  note: string;
}

export interface TestDeltaArgs {
  report: string;
  baseline: string;
  out?: string;
  timeout: number;
  /** Test seam — production spawns the real command. */
  exec?: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

// Mirrors build-test's run() on the three properties its comments call out as
// deliberate — reviewed live when this reimplementation diverged on all three:
// stdin ignored (a rerun that asks a question hangs to the deadline), timeout
// read from error.code with the SIGTERM/null-status fallback (the substring
// form misses a maxBuffer kill, which would flow into the base-green Critical
// path), and trimmed output (a failing monorepo suite is hundreds of KB that
// would otherwise land verbatim in the report Agent 7 reads).
function run(command: string, cwd: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  const r = spawnSync(command, {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildRunEnv(process.env),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = r.error as (Error & { code?: string }) | undefined;
  const timedOut =
    err?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null);
  return {
    command,
    exitCode: timedOut ? null : (r.status ?? null),
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    output: trimOutput(`${r.stdout ?? ''}${r.stderr ?? ''}`),
  };
}

/**
 * Whole-command budget, mirroring test-efficacy's: the tool ceiling is 600s,
 * and three failed commands at the 300s per-command default would blow past it
 * with NO report written — discarding the base install+build just paid for.
 * Commands the budget cannot fit are disclosed, never silently dropped.
 */
const TOTAL_BUDGET_MS = 540_000;

export function runTestDelta(args: TestDeltaArgs): TestDeltaReport {
  const exec = args.exec ?? run;
  const baseline = resolve(args.baseline);
  const empty = (note: string): TestDeltaReport => ({
    entries: [],
    netNew: [],
    shared: [],
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

  const startedAt = Date.now();
  const skippedForBudget: string[] = [];
  const entries: DeltaEntry[] = [];
  for (const t of failed) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 5_000) {
      skippedForBudget.push(t.command);
      continue;
    }
    const prFailingFiles = failingFilesOf(t.output ?? '');
    const base = exec(
      t.command,
      baseline,
      Math.min(args.timeout * 1000, remaining),
    );
    const baseFailingFiles = base.timedOut ? [] : failingFilesOf(base.output);
    const unparsed =
      prFailingFiles.length === 0 && baseFailingFiles.length === 0;
    // A base run that never finished attributes NOTHING: with its failing set
    // unknowable, promoting the PR side's failures to net-new would
    // manufacture the strongest evidence this command produces out of an
    // infrastructure timeout. The files stay unattributed (neither list), and
    // the note says why.
    // ...and so does a base rerun that failed without naming a single failing
    // file: an install/toolchain failure exits non-zero with no FAIL lines, and
    // reading that as "base is green" would promote every PR-side failure to
    // net-new off a base that never ran its tests (reviewed live on this PR).
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
    });
  }

  const netNew = [...new Set(entries.flatMap((e) => e.netNew))].sort();
  const shared = [...new Set(entries.flatMap((e) => e.shared))].sort();
  const unparsed = entries.filter((e) => e.unparsed).length;
  const timedOut = entries.filter((e) => e.base.timedOut).length;

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
      `${unparsed} command(s) failed but named no parseable failing file on either side — no delta for those; judge them by the diff as before`,
    );
  }
  if (timedOut) {
    parts.push(
      `${timedOut} base-side rerun(s) timed out — infrastructure, not evidence`,
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
