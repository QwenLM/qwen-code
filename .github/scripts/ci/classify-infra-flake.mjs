#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractFailingTests,
  stripLogDecoration,
} from './main-failure-signature.mjs';

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
 * ECS) bound a test, not the collector channel — the RPC's own budget is
 * birpc's `DEFAULT_TIMEOUT = 6e4`, which vitest 3.2.7 does not override at its
 * `createBirpc` call site, and the message is its `onTimeoutError` hook
 * (`[vitest-worker]: Timeout calling "<fn>"`). So raising the budget is not a
 * config knob this lane owns: it is a change to the pinned vitest, and one the
 * worker→collector channel would still lose under 200+ load. The 110-minute
 * step ceiling never engages: no job in that sample was cancelled, and the
 * longest test step finished on its own at 96m55s.
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
 * workspace, that workspace wrote a junit.xml, and its totals report at least
 * one test and zero failures — a worker that was OOM-killed or segfaulted
 * writes no junit and stays red. Any real `FAIL` line anywhere in the log also
 * keeps the run red, because junit's `failures` counter is per file and a
 * suite that died during collection can leave a file's totals at zero. The
 * unhandled-error count vitest itself prints must equal the number of RPC
 * timeouts, so an unrelated unhandled error riding along in the same run is
 * never masked by them — and both counts are taken after dropping the regions
 * vitest attributes to a test's own `stdout`/`stderr`, because this log is the
 * code under test's output, and text a test printed is not evidence about the
 * runner. Attribution is per workspace as well as per run: every blamed
 * workspace must carry an RPC timeout in the section npm printed for it, so a
 * leg that died *after* flushing a clean junit is not certified on the
 * strength of a neighbouring leg's timeout.
 *
 * And the evidence set must be complete, because every gate above is only as
 * good as the capture it reads. A producer that dies mid-walk leaves a prefix:
 * the legs after the kill printed nothing, so they are absent rather than
 * suspicious, and per-leg attribution certifies the one leg that did report.
 * npm prints a `> <name>@<version> test:ci` banner for every leg it starts and
 * no marker at all when the walk ends — an ordinary lifecycle failure just
 * stops after the last leg — so the started set compared against the legs the
 * root `package.json` declares is the only completeness evidence the capture
 * carries. A missing leg refuses; see `expectedLegNames`.
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
 * are matched; the macOS and Windows legs do not call this classifier. The
 * alternation spans every workspace glob in the root package.json
 * (`packages/*`, `packages/channels/*`, `integrations/*`): a blame line this
 * pattern drops names a workspace that is then never junit-checked, so a
 * workspace root added later must be added here in the same commit. */
const NPM_ERROR_PATH_PATTERN =
  /^npm error path .*?\/((?:packages|integrations)\/\S+)$/gm;

const TESTSUITES_OPEN_PATTERN = /<testsuites\b[^>]*>/;

/** Vitest prints a test's own captured output under one of these headers. */
const CAPTURED_OUTPUT_HEADER = /^\s*(?:stdout|stderr) \| /;

/**
 * Line shapes only the reporter or npm emits, so one of them ends a captured
 * region. `npm error` must be here: a trailing captured block is often the
 * last thing a leg prints before npm's blame block, and swallowing that block
 * would leave `failingWorkspaceDirs` empty and refuse every run — the
 * tolerance would stop firing with nothing red to say so.
 *
 * Not here on purpose: `Vitest caught`. A printed copy of the tally is
 * textually identical to vitest's own, so treating it as an exit would let a
 * test end the region early and have its later printed lines counted.
 */
const CAPTURED_OUTPUT_EXIT =
  /^\s*(?:\u23af{3,}|Test Files\b|Tests\s|\u276f)|^npm error\b/;

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
    .map((line) => stripLogDecoration(line))
    .join('\n');
}

/**
 * Drop the regions vitest attributes to a test's own `stdout`/`stderr`. This
 * log is the code under test's output, so anything a test prints is
 * PR-controlled text: left in, it is indistinguishable from the runner's own
 * report, and printed copies of the signature and the tally balance the
 * equality gate below while a real non-RPC unhandled error rides through.
 * `main-failure-signature.mjs` guards its FAIL gate the same way.
 *
 * Residual limit, stated rather than solved: the region boundaries are text
 * too, so a test that prints one of the exit shapes can still end a region
 * early. What this closes is the accidental case — a log fixture, an
 * error-message assertion or a replayed CI log in a tee'd workspace — and it
 * only ever lowers the counts, which pushes every gate toward refusal.
 */
export function stripCapturedOutput(normalizedText) {
  const kept = [];
  let capturing = false;
  for (const line of String(normalizedText ?? '').split('\n')) {
    if (capturing) {
      if (!CAPTURED_OUTPUT_EXIT.test(line)) continue;
      capturing = false;
    }
    if (CAPTURED_OUTPUT_HEADER.test(line)) {
      capturing = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** RPC-timeout signatures in the runner's own output, not in printed text. */
export function countRpcTimeouts(logText) {
  const own = stripCapturedOutput(normalizeLog(logText));
  return own.split(RPC_TIMEOUT_SIGNATURE).length - 1;
}

/** Sum of vitest's own per-project unhandled-error tallies. */
export function countCaughtUnhandled(logText) {
  let total = 0;
  for (const match of stripCapturedOutput(normalizeLog(logText)).matchAll(
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
 * The log text npm printed on each blamed workspace's own behalf, keyed by
 * workspace dir: everything between the previous `npm error path` line (or the
 * log start) and this one, blame line included. npm prints a failing
 * workspace's error block immediately after that workspace's own output and
 * then continues to the next workspace, so exactly one attributable section
 * per blamed workspace exists in the real log — and a leg's RPC timeouts sit
 * in its own section, not in a neighbour's.
 */
export function workspaceSections(logText) {
  const log = stripCapturedOutput(normalizeLog(logText));
  const sections = new Map();
  let start = 0;
  for (const match of log.matchAll(NPM_ERROR_PATH_PATTERN)) {
    const end = match.index + match[0].length;
    const workspace = match[1];
    const section = (sections.get(workspace) ?? '') + log.slice(start, end);
    sections.set(workspace, section);
    start = end;
  }
  return sections;
}

/** npm's per-leg banner, printed when it *starts* a workspace script:
 * `> <name>@<version> test:ci`. Measured on npm 11.17.0 against `npm run
 * test:ci --workspaces --if-present --`: one banner per leg, before that leg's
 * own output, and the walk continues past a failing leg rather than aborting.
 * Extra arguments passed after `--` land on the command line *below* the
 * banner, so the banner text itself does not vary with `--retry`. */
const NPM_LEG_BANNER_PATTERN = /^> (\S+)@\S+ test:ci$/gm;

/** Package names of the legs the capture shows npm starting. */
export function startedLegNames(logText) {
  const names = new Set();
  for (const match of stripCapturedOutput(normalizeLog(logText)).matchAll(
    NPM_LEG_BANNER_PATTERN,
  )) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Package names of the legs `npm run test:ci --workspaces --if-present` starts:
 * every entry of the root `package.json` `workspaces` list — minus its `!`
 * exclusions — whose own package.json declares `test:ci`. That list is npm's
 * own source of truth for the walk, so it is the only expectation the
 * completeness gate can be measured against without asking npm at runtime.
 *
 * Returns null when the expectation cannot be derived: an unreadable root, or a
 * `workspaces` entry whose glob this helper does not expand — it reads a bare
 * directory and a single-level `dir/*`, which is all the root declares today.
 * Null means "gate unavailable", not "no legs expected", and `classify` then
 * skips the completeness check rather than inventing an expectation. The
 * derivation itself is pinned against this repo's own package.json by
 * classify-infra-flake.test.mjs, so a glob shape this helper cannot read turns
 * a test red instead of silently dropping the gate.
 */
export function expectedLegNames(
  root,
  read = readFileSync,
  listDir = readdirSync,
) {
  const GLOB_CHARS = /[*?[\]{}]/;
  try {
    const pkg = JSON.parse(read(join(root, 'package.json'), 'utf8'));
    const entries = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
    if (entries.length === 0) return null;
    const excluded = new Set();
    const dirs = [];
    for (const entry of entries) {
      const negative = entry.startsWith('!');
      const pattern = negative ? entry.slice(1) : entry;
      if (pattern.endsWith('/*') && !GLOB_CHARS.test(pattern.slice(0, -2))) {
        const parent = pattern.slice(0, -2);
        for (const child of listDir(join(root, parent), {
          withFileTypes: true,
        })) {
          if (!child.isDirectory()) continue;
          const dir = join(parent, child.name);
          if (negative) excluded.add(dir);
          else dirs.push(dir);
        }
      } else if (!GLOB_CHARS.test(pattern)) {
        if (negative) excluded.add(pattern);
        else dirs.push(pattern);
      } else {
        return null;
      }
    }
    const names = new Set();
    for (const dir of dirs) {
      if (excluded.has(dir)) continue;
      let workspace;
      try {
        workspace = JSON.parse(read(join(root, dir, 'package.json'), 'utf8'));
      } catch {
        continue; // no package.json: not a workspace npm would run
      }
      if (
        typeof workspace.name === 'string' &&
        workspace.scripts?.['test:ci']
      ) {
        names.add(workspace.name);
      }
    }
    return [...names];
  } catch {
    return null;
  }
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
 * @param options.expectedLegs  optional package names the walk should have
 *                              started (see `expectedLegNames`); omitted or
 *                              null skips the completeness gate
 */
export function classify(options = {}) {
  const {
    logText,
    readJunit,
    samplesText = '',
    runnerName = '',
    expectedLegs = null,
  } = options;
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

  // Completeness before attribution: everything below reads only the legs this
  // capture happens to contain. `test:ci:workspaces` is `cross-env … npm run
  // test:ci --workspaces --if-present --`, and cross-env rewrites a child that
  // died by signal into exit 1 (`crossEnvExitCode = signal === 'SIGINT' ? 0 :
  // 1`, cross-env 7.0.3), so the producer's status cannot distinguish "every
  // leg ran and these failed" from "the OOM killer took npm mid-walk" — both
  // reach this function as RC=1. The legs after the kill printed nothing at
  // all, so they are absent rather than suspicious: refusing on a leg that
  // never announced itself is the only gate that sees a prefix.
  if (Array.isArray(expectedLegs) && expectedLegs.length > 0) {
    const started = startedLegNames(log);
    const missing = expectedLegs.filter((name) => !started.has(name));
    if (missing.length > 0) {
      return refuse(
        `the workspace walk is incomplete — ${missing.length} of ${expectedLegs.length} ` +
          `leg(s) npm should have started never printed a banner ` +
          `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}), ` +
          `so this capture is a prefix of the run`,
        { missingLegs: missing },
      );
    }
  }

  const sections = workspaceSections(log);

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
    // "No test failed" and "no test ran" are different claims. A workspace
    // whose include matched nothing — a renamed test directory, a narrowed
    // glob — exits 1 having written a well-formed report with tests="0", and
    // certifying that as "every test passed" would green a suite that has
    // silently stopped existing.
    if (!totals.tests) {
      return refuse(
        `${workspace}/junit.xml reports ${totals.tests} test(s) — nothing was recorded`,
        { workspaces },
      );
    }
    if (totals.failures !== 0) {
      return refuse(
        `${workspace}/junit.xml reports ${totals.failures} failure(s)`,
        { workspaces },
      );
    }
    // The two counts above are whole-log sums, and a clean junit only proves
    // this leg recorded no failing test — not that the exit came from its own
    // starved worker. A leg that dies *after* flushing that junit (vitest's
    // process-level unhandledRejection handler sets exitCode 1 and exits
    // without going through the tally; a coverage write or a heap abort lands
    // in the same post-reporter window) would otherwise be certified on the
    // strength of a different leg's timeout, and `warningLine` would then name
    // it as a leg whose "worker IPC starv[ed] on CPU". So require the
    // signature in the section npm printed for this workspace.
    const ownSignatures = countRpcTimeouts(sections.get(workspace) ?? '');
    if (ownSignatures === 0) {
      return refuse(
        `${workspace} exited nonzero with no "${RPC_TIMEOUT_SIGNATURE}" in its own npm section`,
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

/**
 * The single-line annotation the lane emits when a verdict is tolerated.
 *
 * Scoped to the leg that was classified, not to the step: the step runs
 * `npm run test:scripts` *after* this line is written and takes its own exit
 * code from that leg, so a step-scoped claim — "Test step tolerated", "Every
 * test passed" — can end up the job's only annotation on a step that then
 * reddens for an unrelated real reason, pointing a triager at pool capacity
 * for a failure a test caused. The refusal path keeps its step-scoped title
 * because a refusal leaves RC non-zero, which skips that second leg.
 */
export function warningLine(verdict) {
  const load =
    verdict.peakLoad === null ? '' : ` peak host load ${verdict.peakLoad},`;
  const runner = verdict.runnerName ? ` on ${verdict.runnerName},` : '';
  return (
    `::warning::Workspaces leg tolerated a runner-capacity artifact:${runner}${load} ` +
    `${verdict.rpcTimeouts} vitest worker "onTaskUpdate" RPC timeout(s) with 0 failing tests ` +
    `(${verdict.workspaces.join(', ')}). Every workspace test passed; that exit came from ` +
    `worker IPC starving on CPU. The pool is over capacity — see #10879.`
  );
}

export function runCli(
  argv,
  {
    readFileSync: read = readFileSync,
    readdirSync: listDir = readdirSync,
  } = {},
) {
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
    // Derived from the checkout `--root` names, never from the log: the log is
    // the artifact being judged complete, so it cannot supply its own
    // expectation. Null (an unreadable root, or a workspace glob this helper
    // does not expand) skips that gate rather than inventing an expectation.
    expectedLegs: expectedLegNames(root, read, listDir),
    readJunit: (relative) => read(join(root, relative), 'utf8'),
  });

  if (!verdict.tolerated) {
    process.stderr.write(`infra-flake: not tolerated — ${verdict.reason}\n`);
    // The step is red either way, but the reason is the part an operator
    // needs, and one stderr line in a hundred-thousand-line log is not where
    // they look. The release lane's sibling step annotates its refusals for
    // exactly this reason ("Workspace tests exited 1 on a Vitest transport
    // timeout"). Whitespace is collapsed to keep the annotation on one line: a
    // newline would terminate the workflow command and leak the remainder into
    // the log as ordinary text.
    const reason = String(verdict.reason).replace(/\s+/g, ' ');
    process.stdout.write(
      `::error title=Test step failed; the infra-flake classifier did not tolerate it::${reason}\n`,
    );
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
