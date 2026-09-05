#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractFailingTests } from './main-failure-signature.mjs';

/**
 * Decide whether a red `npm run test:ci:workspaces` was caused by the runner
 * rather than by the code, so the Test job can say so instead of reporting a
 * failure that no test produced.
 *
 * Vitest reports a worker whose `onTaskUpdate` RPC went unanswered as a
 * run-level *unhandled error* and exits 1 for it even when every test passed.
 * That RPC is worker→collector IPC, so it starves on CPU contention, not on
 * elapsed time. On the shared `ecs-qwen` pool — measured at load 218–270 with
 * 37–74 concurrent vitest processes per host — five of thirteen consecutive
 * red Test jobs on 2026-09-05 had zero failing tests: cli printed
 * `Test Files 1014 passed (1014)` and core `643 passed | 1 skipped`, then each
 * exited 1 on one to three of these timeouts.
 *
 * Nothing already in the lane covers it. `--retry=2` retries individual tests,
 * while this is reported after the run. `testTimeout`/`hookTimeout` (60s on
 * ECS) bound a test, not the collector channel — the RPC's own budget is a
 * fixed 60s (#10438). The 110-minute step ceiling never engages: no job in
 * that sample was cancelled, and the longest test step finished on its own at
 * 96m55s.
 *
 * The sanctioned fix elsewhere in this repo is `dangerouslyIgnoreUnhandledErrors`,
 * which every vitest config already carries as `process.platform !== 'linux'`
 * and scripts/tests/unit-vitest-configs.test.ts pins. Linux is deliberately
 * left fatal, and rightly: packages/core/src/extension/archive-safety.test.ts
 * documents a minipass `write after end` that escaped as an uncaught exception
 * under CPU contention and exited an all-green suite non-zero (release run
 * 33576013293). That one was a real defect in an unawaited stream, so the
 * remedy was to fix the test, not to stop looking. Flipping the flag on Linux
 * would swallow the next one too.
 *
 * That is the distinction this classifier exists to draw. `onTaskUpdate` is
 * vitest's own worker IPC and carries no information about the code under
 * test; an escaping product exception does. So tolerate the former by name and
 * keep the latter fatal — which a whole-run boolean cannot express.
 *
 * Tolerating is only safe on positive evidence, so every branch below fails
 * closed. The exit is attributed to a workspace only when npm named that
 * workspace, that workspace wrote a junit.xml, and its totals report zero
 * failures — a worker that was OOM-killed or segfaulted writes no junit and
 * stays red. Any real `FAIL` line anywhere in the log also keeps the run red,
 * because junit's `failures` counter is per file and a suite that died during
 * collection can leave a file's totals at zero. And the unhandled-error count
 * vitest itself prints must equal the number of RPC timeouts, so an unrelated
 * unhandled error riding along in the same run is never masked by them.
 *
 * The verdict is a warning, never silence: the pool being over capacity is the
 * actual defect, and a green job that hides it would remove the only pressure
 * to fix it (#10879).
 */

export const RPC_TIMEOUT_SIGNATURE =
  '[vitest-worker]: Timeout calling "onTaskUpdate"';

/** Vitest's own tally, printed once per project: "Vitest caught 3 unhandled
 * errors during the test run." Summed across projects and compared against
 * the RPC-timeout count, it proves no *other* unhandled error is present. */
const CAUGHT_UNHANDLED_PATTERN =
  /Vitest caught (\d+) unhandled errors? during the test run/g;

/** Only the Linux `test` leg runs on the ECS pool, so only POSIX separators
 * are matched; the macOS and Windows legs do not call this classifier. */
const NPM_ERROR_PATH_PATTERN = /^npm error path .*\/(packages\/\S+)$/gm;

const TESTSUITES_OPEN_PATTERN = /<testsuites\b[^>]*>/;

// eslint-disable-next-line no-control-regex -- matches the ESC that opens an SGR sequence
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/**
 * Strip what the log transport adds rather than what the runner printed. The
 * job's own `tee` captures bare npm output, but the same classifier is useful
 * against a log fetched later through the API, where Actions has prefixed
 * every line with an RFC3339 timestamp. `extractFailingTests` normalizes
 * internally too, so passing it already-cleaned text is a no-op.
 */
export function normalizeLog(logText) {
  return String(logText ?? '')
    .split('\n')
    .map((line) =>
      line.replace(ANSI_PATTERN, '').replace(LOG_TIMESTAMP_PATTERN, ''),
    )
    .join('\n');
}

export function countRpcTimeouts(logText) {
  return normalizeLog(logText).split(RPC_TIMEOUT_SIGNATURE).length - 1;
}

/** Sum of vitest's own per-project unhandled-error tallies. */
export function countCaughtUnhandled(logText) {
  let total = 0;
  for (const match of normalizeLog(logText).matchAll(
    CAUGHT_UNHANDLED_PATTERN,
  )) {
    total += Number(match[1]);
  }
  return total;
}

/** Workspace dirs npm blamed for a non-zero lifecycle exit, first-seen order. */
export function failingWorkspaceDirs(logText) {
  const dirs = new Set();
  for (const match of normalizeLog(logText).matchAll(NPM_ERROR_PATH_PATTERN)) {
    dirs.add(match[1]);
  }
  return [...dirs];
}

/**
 * The `<testsuites>` root totals, or null when the document does not carry
 * them. Vitest always writes `tests`/`failures`/`errors`/`time` and never
 * increments `errors` — run-level unhandled errors do not reach junit at all,
 * which is precisely why `failures` is the authoritative "did a test fail".
 */
export function junitTotals(xml) {
  const open = TESTSUITES_OPEN_PATTERN.exec(String(xml ?? ''))?.[0];
  if (!open) return null;
  const attr = (name) => {
    const match = new RegExp(`\\b${name}="(\\d+)"`).exec(open);
    return match ? Number(match[1]) : null;
  };
  const totals = { tests: attr('tests'), failures: attr('failures') };
  // A missing counter means the reporter's shape changed under us. Refuse
  // rather than read absence as zero — that is the one mistake here which
  // would turn a real regression green.
  return totals.tests === null || totals.failures === null ? null : totals;
}

/** Peak 1-minute load from the lane's DFSAMPLE lines, for the warning text. */
export function peakLoad(samplesText) {
  let peak = null;
  for (const match of String(samplesText ?? '').matchAll(
    /DFSAMPLE \S+ .*load\[([\d.]+)/g,
  )) {
    const load = Number(match[1]);
    if (Number.isFinite(load) && (peak === null || load > peak)) peak = load;
  }
  return peak;
}

function refuse(reason, detail = {}) {
  return { tolerated: false, reason, ...detail };
}

/**
 * @param options.logText       combined npm output of the failing run
 * @param options.readJunit     (workspaceRelativePath) => file contents; throws when absent
 * @param options.samplesText   optional DFSAMPLE lines, for the warning only
 * @param options.runnerName    optional, for the warning only
 */
export function classify(options = {}) {
  const { logText, readJunit, samplesText = '', runnerName = '' } = options;
  if (typeof readJunit !== 'function') {
    return refuse('no junit reader supplied');
  }

  const log = normalizeLog(logText);
  const rpcTimeouts = countRpcTimeouts(log);
  if (rpcTimeouts === 0) {
    return refuse(`log carries no "${RPC_TIMEOUT_SIGNATURE}"`);
  }

  // Every unhandled error vitest counted must be one of the RPC timeouts.
  // Without this, a real escaping exception (the archive-safety
  // `write after end` class) that happens to share a run with a starved
  // worker would ride through on the worker's behalf.
  const caughtUnhandled = countCaughtUnhandled(log);
  if (caughtUnhandled !== rpcTimeouts) {
    return refuse(
      `vitest counted ${caughtUnhandled} unhandled error(s) but only ${rpcTimeouts} ` +
        `are "${RPC_TIMEOUT_SIGNATURE}" — something else escaped`,
      { rpcTimeouts, caughtUnhandled },
    );
  }

  const failingTests = extractFailingTests(log);
  if (failingTests.length > 0) {
    return refuse(
      `${failingTests.length} test(s) actually failed: ${failingTests
        .slice(0, 3)
        .join(' | ')}`,
      { failingTests },
    );
  }

  const workspaces = failingWorkspaceDirs(log);
  if (workspaces.length === 0) {
    return refuse('npm named no failing workspace to attribute the exit to');
  }

  for (const workspace of workspaces) {
    let xml;
    try {
      xml = readJunit(join(workspace, 'junit.xml'));
    } catch {
      return refuse(
        `${workspace} wrote no junit.xml — a worker that died, not one whose RPC starved`,
        { workspaces },
      );
    }
    const totals = junitTotals(xml);
    if (!totals) {
      return refuse(`${workspace}/junit.xml carries no <testsuites> totals`, {
        workspaces,
      });
    }
    if (totals.failures !== 0) {
      return refuse(
        `${workspace}/junit.xml reports ${totals.failures} failure(s)`,
        { workspaces },
      );
    }
  }

  return {
    tolerated: true,
    reason:
      `${rpcTimeouts} "${RPC_TIMEOUT_SIGNATURE}" timeout(s) with 0 failing tests ` +
      `across ${workspaces.join(', ')}`,
    rpcTimeouts,
    workspaces,
    peakLoad: peakLoad(samplesText),
    runnerName,
  };
}

/** The single-line annotation the lane emits when a verdict is tolerated. */
export function warningLine(verdict) {
  const load =
    verdict.peakLoad === null ? '' : ` peak host load ${verdict.peakLoad},`;
  const runner = verdict.runnerName ? ` on ${verdict.runnerName},` : '';
  return (
    `::warning::Test step tolerated a runner-capacity artifact:${runner}${load} ` +
    `${verdict.rpcTimeouts} vitest worker "onTaskUpdate" RPC timeout(s) with 0 failing tests ` +
    `(${verdict.workspaces.join(', ')}). Every test passed; the exit came from worker IPC ` +
    `starving on CPU. The pool is over capacity — see #10879.`
  );
}

export function runCli(argv, { readFileSync: read = readFileSync } = {}) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error(
        `expected --<name> <value> pairs, got ${JSON.stringify(argv.slice(index, index + 2))}`,
      );
    }
    args.set(argv[index].slice(2), argv[index + 1]);
  }
  const logPath = args.get('log');
  const root = args.get('root') ?? '.';
  if (!logPath) throw new Error('--log is required');

  const samplesPath = args.get('samples');
  const verdict = classify({
    logText: read(logPath, 'utf8'),
    samplesText: samplesPath ? readOrEmpty(read, samplesPath) : '',
    runnerName: args.get('runner-name') ?? '',
    readJunit: (relative) => read(join(root, relative), 'utf8'),
  });

  if (!verdict.tolerated) {
    process.stderr.write(`infra-flake: not tolerated — ${verdict.reason}\n`);
    return 1;
  }
  process.stdout.write(`${warningLine(verdict)}\n`);
  return 0;
}

function readOrEmpty(read, path) {
  try {
    return read(path, 'utf8');
  } catch {
    // The samples file is best-effort evidence for the warning text; a lane
    // whose TMPDIR refused the write still deserves a correct verdict.
    return '';
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`infra-flake: ${error.message}\n`);
    process.exitCode = 1;
  }
}
