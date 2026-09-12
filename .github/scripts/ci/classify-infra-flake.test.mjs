import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RPC_TIMEOUT_SIGNATURE,
  classify,
  countCaughtUnhandled,
  countRpcTimeouts,
  expectedLegNames,
  failingWorkspaceDirs,
  junitTotals,
  normalizeLog,
  peakLoad,
  runCli,
  startedLegNames,
  warningLine,
  workspaceSections,
} from './classify-infra-flake.mjs';
import { stripLogDecoration } from './main-failure-signature.mjs';

const TS = '2026-09-05T08:53:44.1714368Z ';
const ESC = '\u001B';

function junit(failures = 0, tests = 28672) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="vitest tests" tests="${tests}" failures="${failures}" errors="0" time="3702.09">\n` +
    '</testsuites>\n'
  );
}

// Verbatim shape of the cli leg of run 33952837177 (job 101270751814,
// ecs-qwen-hk5-2): 1014 files and 28582 tests passed, three RPC timeouts,
// exit 1, no FAIL line anywhere. Vitest prints the error text once per
// unhandled error, so "caught 3" is followed by three signature lines — the
// equality the classifier requires is the same one the real log satisfies.
const RPC_ERROR = `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`;
const ALL_GREEN_RPC_LOG = [
  `${TS}⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯`,
  `${TS}Vitest caught 3 unhandled errors during the test run.`,
  `${TS}This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.`,
  `${TS}⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯`,
  RPC_ERROR,
  `${TS} Test Files  1014 passed (1014)`,
  `${TS}      Tests  28582 passed | 90 skipped (28672)`,
  `${TS}     Errors  3 errors`,
  `${TS}⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯`,
  RPC_ERROR,
  `${TS}⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯`,
  RPC_ERROR,
  `${TS}JUNIT report written to /_work/qwen-code/qwen-code/packages/cli/junit.xml`,
  `${TS}npm error Lifecycle script \`test:ci\` failed with error:`,
  `${TS}npm error code 1`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
  `${TS}npm error command sh -c vitest run --retry=2`,
  `${TS}Vitest caught 1 unhandled error during the test run.`,
  RPC_ERROR,
  `${TS} Test Files  643 passed | 1 skipped (644)`,
  `${TS}      Tests  23521 passed | 10 skipped (23531)`,
  `${TS}     Errors  1 error`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
].join('\n');

const junitFor = (present) => (relative) => {
  if (!present.includes(relative)) {
    throw Object.assign(new Error(`ENOENT: ${relative}`), { code: 'ENOENT' });
  }
  return junit();
};

test('tolerates an all-green run that exited on starved worker RPC only', () => {
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
    runnerName: 'ecs-qwen-hk5-2',
  });
  assert.equal(verdict.tolerated, true, verdict.reason);
  assert.equal(verdict.rpcTimeouts, 4);
  assert.deepEqual(verdict.workspaces, ['packages/cli', 'packages/core']);
});

test('counts the RPC signature and vitest own unhandled tally', () => {
  assert.equal(countRpcTimeouts(ALL_GREEN_RPC_LOG), 4);
  // 3 from the cli project plus 1 from core, matching the four signatures.
  assert.equal(countCaughtUnhandled(ALL_GREEN_RPC_LOG), 4);
});

test('keeps a run red when a test actually failed', () => {
  // The web-shell leg of the same run: one real FAIL next to the RPC timeouts.
  const log = `${ALL_GREEN_RPC_LOG}\n${TS} FAIL  components/MessageList.dom.test.tsx > MessageList — turn collapse (DOM) > drops the anchor instead of re-expanding when the user collapsed the anchored turn\n${TS}npm error path /_work/qwen-code/qwen-code/packages/web-shell`;
  const verdict = classify({
    logText: log,
    readJunit: junitFor([
      'packages/cli/junit.xml',
      'packages/core/junit.xml',
      'packages/web-shell/junit.xml',
    ]),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /test\(s\) actually failed/);
  assert.match(verdict.reason, /MessageList\.dom\.test\.tsx/);
});

test('keeps a run red when an unrelated unhandled error rides along', () => {
  // The archive-safety class: a minipass `write after end` escaping an
  // unawaited stream is a real defect, and it must not pass on the strength
  // of an RPC timeout that happens to share the run.
  const log = [
    `${TS}Vitest caught 2 unhandled errors during the test run.`,
    `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
    `${TS}⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯`,
    `${TS}Error: write after end`,
    `${TS} Test Files  211 passed (211)`,
    `${TS}      Tests  9480 passed (9480)`,
    `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
  ].join('\n');
  const verdict = classify({
    logText: log,
    readJunit: junitFor(['packages/core/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /something else escaped/);
  assert.equal(verdict.caughtUnhandled, 2);
  assert.equal(verdict.rpcTimeouts, 1);
});

// More signature lines than vitest's own tally: the shape a truncated capture
// leaves when a project's `Vitest caught N` line is lost and its signatures
// survive — the two counts are read from merged streams whose lines are not
// atomic, so the equality gate has to refuse in this direction too.
const SHORT_TALLY_LOG = [
  `${TS}Vitest caught 1 unhandled error during the test run.`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS} Test Files  1014 passed (1014)`,
  `${TS}      Tests  28582 passed (28582)`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
].join('\n');

test('keeps a run red when signatures outnumber vitest own tally', () => {
  assert.equal(countRpcTimeouts(SHORT_TALLY_LOG), 2);
  assert.equal(countCaughtUnhandled(SHORT_TALLY_LOG), 1);
  const verdict = classify({
    logText: SHORT_TALLY_LOG,
    readJunit: junitFor(['packages/cli/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /something else escaped/);
  assert.equal(verdict.rpcTimeouts, 2);
  assert.equal(verdict.caughtUnhandled, 1);
});

test('keeps a run red when no RPC timeout is present', () => {
  // The healthy hosted-runner shape: load 5.9, no worker starvation, and a
  // genuine assertion failure doing its job.
  const log = [
    `${TS} FAIL  src/acp-integration/acpAgent.test.ts > QwenAgent runtime-root pinning choke point > routes every per-request runtime-root pin through runWithPinnedRuntimeBaseDir`,
    `${TS}AssertionError: acpAgent.ts must not name runWithAcpRuntimeOutputDir directly.`,
    `${TS} Test Files  1 failed | 1010 passed (1011)`,
    `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
  ].join('\n');
  const verdict = classify({
    logText: log,
    readJunit: junitFor(['packages/cli/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /carries no/);
});

test('fails closed when a blamed workspace wrote no junit', () => {
  // A worker OOM-killed or segfaulted leaves no report. Reading that absence
  // as "nothing failed" is the one mistake that would green a real break.
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: junitFor(['packages/cli/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /packages\/core wrote no junit\.xml/);
});

test('fails closed on a blamed workspace outside packages/', () => {
  // `npm run test:ci:workspaces` runs the integrations/* workspaces too, so
  // npm can blame one of them. A blame line the pattern drops is a dead
  // workspace that is never junit-checked, tolerated on the strength of an
  // unrelated leg's RPC timeout.
  const log = `${ALL_GREEN_RPC_LOG}\n${TS}npm error path /_work/qwen-code/qwen-code/integrations/external-context`;
  assert.deepEqual(failingWorkspaceDirs(log), [
    'packages/cli',
    'packages/core',
    'integrations/external-context',
  ]);
  const verdict = classify({
    logText: log,
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(
    verdict.reason,
    /integrations\/external-context wrote no junit\.xml/,
  );
});

test('fails closed when junit reports failures', () => {
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: (relative) =>
      relative === 'packages/cli/junit.xml' ? junit(2) : junit(),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /packages\/cli\/junit\.xml reports 2 failure/);
});

test('fails closed when a blamed workspace recorded zero tests', () => {
  // What vitest writes when its include matched nothing: a well-formed report
  // with tests="0" and a non-zero exit. "No failure recorded" is not evidence
  // that anything ran.
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: (relative) =>
      relative === 'packages/core/junit.xml'
        ? '<testsuites name="vitest tests" tests="0" failures="0" errors="0" time="0"></testsuites>'
        : junit(),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(
    verdict.reason,
    /packages\/core\/junit\.xml reports 0 test\(s\)/,
  );
});

test('fails closed when a blamed workspace junit was truncated mid-write', () => {
  // The realistic shape when the host this step is measuring runs out of disk
  // or the reporter is killed mid-write: the <testsuites> start tag never
  // closes, so junitTotals returns null. This is the only caller of that null,
  // and without the branch that consumes it `totals.tests` throws a TypeError
  // out of classify and out of runCli — an uncaught crash where the lane needs
  // a refusal, and no unit-level pin of junitTotals can see it.
  const truncated =
    '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="vitest tests" tests="23531" failures="0"';
  assert.equal(junitTotals(truncated), null);
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: (relative) =>
      relative === 'packages/core/junit.xml' ? truncated : junit(),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(
    verdict.reason,
    /packages\/core\/junit\.xml carries no <testsuites> totals/,
  );
});

test('fails closed when npm blamed no workspace', () => {
  const log = [
    `${TS}Vitest caught 1 unhandled error during the test run.`,
    `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  ].join('\n');
  const verdict = classify({ logText: log, readJunit: junitFor([]) });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /npm named no failing workspace/);
});

test('fails closed without a junit reader', () => {
  const verdict = classify({ logText: ALL_GREEN_RPC_LOG });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /no junit reader supplied/);
});

test('reads totals only from a well-formed testsuites root', () => {
  assert.deepEqual(junitTotals(junit()), { tests: 28672, failures: 0 });
  assert.deepEqual(junitTotals(junit(3)), { tests: 28672, failures: 3 });
  assert.equal(junitTotals('<testsuites tests="5"></testsuites>'), null);
  // Both halves of the refuse guard: a reporter that stopped emitting `tests`
  // is a shape change under us, and absence must never be read as zero.
  assert.equal(
    junitTotals('<testsuites failures="0" errors="0" time="1"></testsuites>'),
    null,
  );
  // Real vitest junit nests per-file <testsuite> elements carrying their own
  // counters. Only the root's totals describe the run, so a root that omits
  // them is refused even though a child's counters are readable.
  assert.equal(
    junitTotals(
      '<testsuites name="vitest tests"><testsuite tests="5" failures="0"></testsuite></testsuites>',
    ),
    null,
  );
  assert.equal(junitTotals('not xml'), null);
  assert.equal(junitTotals(''), null);
});

test('attributes nested workspaces to their full packages path', () => {
  const log = `${TS}npm error path /_work/qwen-code/qwen-code/packages/channels/base`;
  assert.deepEqual(failingWorkspaceDirs(log), ['packages/channels/base']);
});

test('attributes every workspace root the root package.json declares', () => {
  // `npm run test:ci:workspaces` walks exactly the root package.json
  // `workspaces` list, so that list — not the comment above the pattern — is
  // the source of truth for NPM_ERROR_PATH_PATTERN's alternation. A root the
  // pattern drops produces a blame line the classifier ignores, and the
  // workspace it names is then never junit-checked: the run is tolerated on
  // the strength of a different leg's RPC timeout. Reading the expectation
  // from package.json turns "a new workspace root was added" into a red test
  // instead of a comment that has to be remembered in the same commit.
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  const roots = [
    ...new Set(
      pkg.workspaces
        .filter((entry) => !entry.startsWith('!'))
        .map((entry) => entry.split('/')[0]),
    ),
  ];
  assert.ok(roots.length > 0, 'root package.json declares no workspaces');
  for (const root of roots) {
    const log = `${TS}npm error path /_work/qwen-code/qwen-code/${root}/some-workspace`;
    assert.deepEqual(
      failingWorkspaceDirs(log),
      [`${root}/some-workspace`],
      `NPM_ERROR_PATH_PATTERN drops the "${root}" workspace root declared in ` +
        'package.json — add it to the alternation in the same commit',
    );
  }
});

test('derives the walk from the root package.json, its exclusions and the script filter', () => {
  // `expectedLegNames` is the completeness gate's expectation, so its three
  // inputs each have a failure mode worth pinning: a `dir/*` entry has to be
  // enumerated (a leg dropped from the expectation is a leg whose absence the
  // gate cannot see), a `!` entry has to be removed (counting one refuses every
  // complete run, and the tolerance silently stops firing), and a workspace
  // without `test:ci` has to be skipped because `--if-present` skips it too.
  const files = new Map([
    [
      'r/package.json',
      JSON.stringify({
        workspaces: ['packages/*', 'integrations/x', '!packages/skip'],
      }),
    ],
    [
      'r/packages/a/package.json',
      JSON.stringify({ name: 'a-pkg', scripts: { 'test:ci': 'vitest run' } }),
    ],
    [
      'r/packages/b/package.json',
      JSON.stringify({ name: 'b-pkg', scripts: { test: 'vitest run' } }),
    ],
    [
      'r/packages/skip/package.json',
      JSON.stringify({
        name: 'skip-pkg',
        scripts: { 'test:ci': 'vitest run' },
      }),
    ],
    [
      'r/integrations/x/package.json',
      JSON.stringify({ name: 'x-pkg', scripts: { 'test:ci': 'vitest run' } }),
    ],
  ]);
  const read = (path) => {
    const value = files.get(path);
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return value;
  };
  const dirs = new Map([['r/packages', ['a', 'b', 'skip', 'NOTES.md']]]);
  const listDir = (path) => {
    const entries = dirs.get(path);
    if (!entries) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return entries.map((name) => ({
      name,
      isDirectory: () => !name.endsWith('.md'),
    }));
  };
  assert.deepEqual(expectedLegNames('r', read, listDir), ['a-pkg', 'x-pkg']);
});

test('returns null rather than an invented expectation on a glob it cannot expand', () => {
  // Null is "gate unavailable", not "no legs expected": classify skips the
  // completeness check instead of refusing every run against an expectation of
  // zero. The next test is what keeps the unavailable case from being silent.
  const read = (path) => {
    if (path === join('r', 'package.json')) {
      return JSON.stringify({ workspaces: ['packages/**'] });
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
  const listDir = () => {
    throw new Error('a ** glob must not be enumerated as a single level');
  };
  assert.equal(expectedLegNames('r', read, listDir), null);
  assert.equal(expectedLegNames('/no-such-root-here'), null);
});

test('pins the derived walk against this repo own package.json', () => {
  // Same contract as the NPM_ERROR_PATH_PATTERN test above, on the other side
  // of the gate: if the root `workspaces` list ever takes a shape
  // `expectedLegNames` returns null for, the completeness gate goes unavailable
  // in production with nothing red to say so. Reading the expectation from the
  // real root turns that into a failing test instead.
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  const expected = expectedLegNames(repoRoot);
  assert.ok(
    Array.isArray(expected),
    'expectedLegNames returned null for this repo — the workspaces list took a ' +
      'shape it cannot expand, so the completeness gate is now unavailable',
  );
  assert.ok(
    expected.length >= 20,
    `derived only ${expected.length} legs; npm's walk of this root starts 22`,
  );
  // A negated entry npm skips must not be counted: it would refuse every
  // complete run, which is fail-closed but leaves the tolerance permanently
  // dead with only a refusal to explain why.
  for (const entry of pkg.workspaces.filter((item) => item.startsWith('!'))) {
    const dir = entry.slice(1);
    let name;
    try {
      name = JSON.parse(
        readFileSync(new URL(`../../../${dir}/package.json`, import.meta.url)),
      ).name;
    } catch {
      continue; // nothing on disk to be wrongly counted
    }
    assert.ok(
      !expected.includes(name),
      `"${dir}" is negated in the workspaces list but ${name} is in the expectation`,
    );
  }
});

test('refuses a capture whose walk never reached every declared leg', () => {
  // R2-2's surviving arm. `test:ci:workspaces` is `cross-env … npm run test:ci
  // --workspaces --if-present --`, and cross-env 7.0.3 rewrites a child that
  // died by signal into exit 1 (`crossEnvExitCode = signal === 'SIGINT' ? 0 :
  // 1`), so when the OOM killer takes the npm that walks the workspaces the
  // lane's gate still sees RC=1 and hands classify() a prefix. The legs after
  // the kill printed nothing — no banner, no blame line, no junit — so every
  // per-leg gate passes on the one leg that did report.
  const CLI = '@qwen-code/qwen-code';
  const CORE = '@qwen-code/qwen-code-core';
  const SHELL = '@qwen-code/web-shell';
  const banner = (name) => `${TS}> ${name}@0.20.0 test:ci`;
  const readJunit = junitFor(['packages/cli/junit.xml']);
  // cli's leg in full, then core's banner and nothing after it: core was
  // running when the producer died, so the walk never reached web-shell.
  const truncated = [
    banner(CLI),
    ALL_GREEN_RPC_LOG.split(
      `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
    )[0],
    banner(CORE),
  ].join('\n');

  assert.deepEqual([...startedLegNames(truncated)].sort(), [CLI, CORE].sort());

  // Precondition, and the reason this gate is the only one that sees the arm:
  // with no expectation supplied the same prefix is certified. Deleting the
  // completeness check leaves this assertion passing and reds the next one.
  const unguarded = classify({ logText: truncated, readJunit });
  assert.equal(
    unguarded.tolerated,
    true,
    `the fixture is no longer a clean prefix: ${unguarded.reason}`,
  );

  const verdict = classify({
    logText: truncated,
    readJunit,
    expectedLegs: [CLI, CORE, SHELL],
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /walk is incomplete/);
  assert.deepEqual(verdict.missingLegs, [SHELL]);

  // And the same capture with the missing leg's banner present is tolerated
  // again, so the refusal is about the walk and not about the fixture.
  assert.equal(
    classify({
      logText: `${truncated}\n${banner(SHELL)}`,
      readJunit,
      expectedLegs: [CLI, CORE, SHELL],
    }).tolerated,
    true,
  );
});

test('keeps the tolerance alive on a complete walk of the declared legs', () => {
  // The direction the completeness gate must not break: a run where every
  // declared leg announced itself is still tolerated, banners and all. Uses the
  // expectation derived from this repo, not a hand-written one, so the two
  // halves of the gate are pinned against the same source of truth.
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const expected = expectedLegNames(repoRoot);
  assert.ok(Array.isArray(expected) && expected.length > 0);
  const banners = expected.map((name) => `${TS}> ${name}@0.20.0 test:ci`);
  const verdict = classify({
    logText: [...banners, ALL_GREEN_RPC_LOG].join('\n'),
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
    runnerName: 'ecs-qwen-hk5-2',
    expectedLegs: expected,
  });
  assert.equal(verdict.tolerated, true, verdict.reason);
  assert.deepEqual(verdict.workspaces, ['packages/cli', 'packages/core']);
});

test('normalizes ANSI escapes and Actions timestamps', () => {
  // The escapes sit INSIDE the spans the patterns match, not only around
  // them: a log fetched through the API has vitest colourizing the count and
  // the RPC method name, and a leading SGR on the blame line. Wrapping-only
  // escapes would leave every assertion below green with the strip removed.
  const decorated = [
    `${TS}${ESC}[41mVitest caught ${ESC}[1m1${ESC}[22m unhandled error during the test run.${ESC}[49m`,
    `${TS}${ESC}[31mError: [vitest-worker]: Timeout calling ${ESC}[1m"onTaskUpdate"${ESC}[22m${ESC}[39m`,
    `${TS}${ESC}[31mnpm error path /_work/qwen-code/qwen-code/packages/cli${ESC}[39m`,
  ].join('\n');
  assert.equal(countRpcTimeouts(decorated), 1);
  assert.equal(countCaughtUnhandled(decorated), 1);
  assert.deepEqual(failingWorkspaceDirs(decorated), ['packages/cli']);
});

test('takes the peak 1-minute load from the DFSAMPLE timeline', () => {
  const samples = [
    'DFSAMPLE 07:33:36 tmpdir[/var/tmp/x] load[184.77 178.57 172.20] hosttests[44]',
    'DFSAMPLE 08:53:48 tmpdir[/var/tmp/x] load[236.42 234.69 229.50] hosttests[74]',
    'DFSAMPLE 09:26:25 tmpdir[/var/tmp/x] load[202.28 211.84 218.56] hosttests[59]',
  ].join('\n');
  assert.equal(peakLoad(samples), 236.42);
  assert.equal(peakLoad(''), null);
  assert.equal(peakLoad('DFSAMPLE 07:33:36 load[not-a-number]'), null);
  // The regex accepts `1.2.3` but Number() rejects it, so this is the only
  // input that reaches the isFinite guard: without it `peak` becomes NaN,
  // which warningLine's `=== null` test does not catch and would print
  // "peak host load NaN," into the annotation.
  assert.equal(peakLoad('DFSAMPLE 07:33:36 load[1.2.3]'), null);
});

test('carries the load evidence into a single-line warning', () => {
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
    runnerName: 'ecs-qwen-hk5-2',
    samplesText:
      'DFSAMPLE 08:53:48 tmpdir[/var/tmp/x] load[236.42 234.69 229.50] hosttests[74]',
  });
  assert.equal(verdict.tolerated, true, verdict.reason);
  const line = warningLine(verdict);
  // A newline would terminate the workflow command and leak the remainder
  // into the log as ordinary text.
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith('::warning::'));
  assert.match(line, /ecs-qwen-hk5-2/);
  assert.match(line, /236\.42/);
  assert.match(line, /#10879/);
  // Scoped to the leg, not to the step: the step runs `npm run test:scripts`
  // after this line is written and takes RC from it, so a step-scoped claim
  // would be the job's only annotation on a step that then reddens for an
  // unrelated real reason. Reverting the wording to "Test step tolerated …
  // Every test passed" reds these two.
  assert.ok(!line.includes('Test step tolerated'));
  assert.ok(!line.includes('Every test passed'));
  assert.match(line, /^::warning::Workspaces leg tolerated /);
  assert.match(line, /Every workspace test passed; that exit came from/);
});

test('omits load and runner from the warning when unknown', () => {
  const line = warningLine({
    rpcTimeouts: 2,
    workspaces: ['packages/cli'],
    peakLoad: null,
    runnerName: '',
  });
  assert.ok(!line.includes('\n'));
  assert.ok(!line.includes('peak host load'));
  assert.match(line, /2 vitest worker/);
});

test('runCli exits 0 on a tolerated verdict and 1 otherwise', () => {
  const SAMPLES =
    'DFSAMPLE 08:53:48 tmpdir[/var/tmp/x] load[236.42 234.69 229.50] hosttests[74]';
  const files = new Map([
    ['/log.txt', ALL_GREEN_RPC_LOG],
    ['/samples.log', SAMPLES],
    ['packages/cli/junit.xml', junit()],
    ['packages/core/junit.xml', junit()],
  ]);
  const read = (path) => {
    if (!files.has(path))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(path);
  };
  const lines = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  // Each invocation's own output, so an assertion can name the call that
  // produced it rather than searching the whole transcript.
  const call = (argv) => {
    const from = lines.length;
    const code = runCli(argv, { readFileSync: read });
    return { code, out: lines.slice(from) };
  };
  try {
    assert.equal(
      runCli(['--log', '/log.txt', '--root', '.'], { readFileSync: read }),
      0,
    );
    assert.equal(
      runCli(['--log', '/log.txt', '--root', '/elsewhere'], {
        readFileSync: read,
      }),
      1,
    );
    // The lane passes `--samples "$DISK_SAMPLES"` (ci.yml), so the load figure
    // has to survive the argv plumbing into the annotation — it is the whole
    // point of emitting one.
    const withSamples = call([
      '--log',
      '/log.txt',
      '--root',
      '.',
      '--samples',
      '/samples.log',
    ]);
    assert.equal(withSamples.code, 0);
    assert.match(withSamples.out.join(''), /peak host load 236\.42/);
    // A sampler that never wrote its file — the ENOSPC this same step documents
    // — must not cost the verdict: readOrEmpty swallows it, so the run stays
    // tolerated instead of throwing out of runCli into a false red.
    const noSamples = call([
      '--log',
      '/log.txt',
      '--root',
      '.',
      '--samples',
      '/missing-samples.log',
    ]);
    assert.equal(noSamples.code, 0);
    assert.ok(
      noSamples.out.some((line) => line.startsWith('::warning::')),
      'an unreadable samples file must not suppress the annotation',
    );
    // Two guards, two inputs, two assertions. `runCli(['--log'])` reaches the
    // pair guard — the one ci.yml's invocation depends on, since a workflow
    // edit that drops a value must throw rather than parse the next flag as
    // that value's flag name. `--log is required` is only reachable with
    // well-formed pairs. One alternation over both messages let either guard
    // be deleted with the suite still green: without the pair guard,
    // `runCli(['--log'])` falls through to the missing-log throw, which the
    // alternation also accepted.
    assert.throws(
      () => runCli(['--log'], { readFileSync: read }),
      /expected --<name> <value> pairs/,
    );
    assert.throws(
      () => runCli(['--root', '.'], { readFileSync: read }),
      /--log is required/,
    );
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.ok(
    lines.some((line) => line.startsWith('::warning::')),
    'a tolerated verdict must be announced, never silent',
  );
});

// The two counts classify() gates on are whole-log sums, so a log whose
// signatures all sit in ONE leg's output still balances them while a second
// leg exited for a reason nobody checked. Both fixtures below are green-junit,
// no-FAIL, count-balanced runs; the only thing that keeps them red is the
// per-workspace section requirement.

// cli printed a complete green summary and exited 1 with no RPC timeout of
// its own; core is the leg that starved.
const SIGNATURES_ONLY_IN_SECOND_SECTION_LOG = [
  `${TS} Test Files  1014 passed (1014)`,
  `${TS}      Tests  28582 passed (28582)`,
  `${TS}npm error code 1`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
  `${TS}Vitest caught 1 unhandled error during the test run.`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS} Test Files  643 passed (644)`,
  `${TS}      Tests  23521 passed (23521)`,
  `${TS}npm error code 1`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
].join('\n');

// core flushed a complete junit, then died in the post-reporter window (137 is
// a signal death, not vitest's own exit). Nothing in the log distinguishes it
// from a starved worker except whose section the timeout is in.
const POST_JUNIT_DEATH_LOG = [
  `${TS}Vitest caught 3 unhandled errors during the test run.`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS} Test Files  1014 passed (1014)`,
  `${TS}JUNIT report written to /_work/qwen-code/qwen-code/packages/cli/junit.xml`,
  `${TS}npm error code 1`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
  `${TS} Test Files  643 passed (644)`,
  `${TS}      Tests  23521 passed (23521)`,
  `${TS}JUNIT report written to /_work/qwen-code/qwen-code/packages/core/junit.xml`,
  `${TS}npm error code 137`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
].join('\n');

test('refuses a leg whose own npm section carries no RPC timeout', () => {
  // Balanced counts, no FAIL line, both junits clean: without the per-section
  // requirement this returns tolerated and the annotation names packages/cli
  // as a leg whose "worker IPC starv[ed] on CPU".
  assert.equal(countRpcTimeouts(SIGNATURES_ONLY_IN_SECOND_SECTION_LOG), 1);
  assert.equal(countCaughtUnhandled(SIGNATURES_ONLY_IN_SECOND_SECTION_LOG), 1);
  const verdict = classify({
    logText: SIGNATURES_ONLY_IN_SECOND_SECTION_LOG,
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /packages\/cli/);
  assert.match(verdict.reason, /own npm section/);
});

test('refuses a leg killed after it flushed a complete green junit', () => {
  assert.equal(countRpcTimeouts(POST_JUNIT_DEATH_LOG), 3);
  assert.equal(countCaughtUnhandled(POST_JUNIT_DEATH_LOG), 3);
  const verdict = classify({
    logText: POST_JUNIT_DEATH_LOG,
    readJunit: junitFor(['packages/cli/junit.xml', 'packages/core/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /packages\/core/);
  assert.match(verdict.reason, /own npm section/);
  // cli IS attributable, so the refusal has to name core and not stop at the
  // first workspace: a fix that refused on any section would also pass the two
  // assertions above while never tolerating the real all-green shape.
  assert.equal(
    countRpcTimeouts(
      workspaceSections(POST_JUNIT_DEATH_LOG).get('packages/cli'),
    ),
    3,
  );
});

test('attributes each blamed workspace the section npm printed for it', () => {
  const sections = workspaceSections(ALL_GREEN_RPC_LOG);
  assert.deepEqual([...sections.keys()], ['packages/cli', 'packages/core']);
  // 3 from the cli leg plus 1 from core — the split the tolerated fixture's
  // `rpcTimeouts === 4` already assumes, now pinned per workspace.
  assert.equal(countRpcTimeouts(sections.get('packages/cli')), 3);
  assert.equal(countRpcTimeouts(sections.get('packages/core')), 1);
});

// The log being classified is the code under test's own stdout, so text a test
// prints is PR-controlled. Vitest attributes printed output to a `stdout |`
// region; counting inside one lets a leg's real non-RPC unhandled error be
// balanced by printed copies of the signature and the tally.
const PRINTED_EVIDENCE_LOG = [
  `${TS}Vitest caught 1 unhandled error during the test run.`,
  `${TS}⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯⎯`,
  `${TS}Error: write after end`,
  `${TS} Test Files  211 passed (211)`,
  `${TS}      Tests  9480 passed (9480)`,
  `${TS}stdout | src/replay-ci-log.test.ts > replays a captured CI log`,
  `${TS}Vitest caught 1 unhandled error during the test run.`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS}Error: ${RPC_TIMEOUT_SIGNATURE}`,
  `${TS}npm error path /_work/qwen-code/qwen-code/packages/core`,
].join('\n');

test('never counts a signature or a tally a test printed itself', () => {
  // Counting the printed region balances the equality gate at 2 === 2 while the
  // only real unhandled error is a `write after end` — the archive-safety class
  // the module header says must stay fatal.
  assert.equal(countRpcTimeouts(PRINTED_EVIDENCE_LOG), 0);
  assert.equal(countCaughtUnhandled(PRINTED_EVIDENCE_LOG), 1);
  const verdict = classify({
    logText: PRINTED_EVIDENCE_LOG,
    readJunit: junitFor(['packages/core/junit.xml']),
  });
  assert.equal(verdict.tolerated, false);
});

test('keeps npm blame lines that follow a captured-output region', () => {
  // The over-strip guard: if `npm error` did not end a captured region, the
  // blame line above would be swallowed with the printed text, no workspace
  // would be attributable, and every run would refuse — the tolerance would
  // stop firing with nothing red to say so.
  const sections = workspaceSections(PRINTED_EVIDENCE_LOG);
  assert.deepEqual([...sections.keys()], ['packages/core']);
  assert.match(sections.get('packages/core'), /^npm error path/m);
});

test('normalizes via the shared transport strip, not a private copy', () => {
  // The knowledge "an Actions log line is an RFC3339 prefix plus SGR escapes"
  // lives in main-failure-signature.mjs. A second copy here would keep this
  // suite green on its own fixture while the anchored /^npm error path …/
  // silently stopped matching production logs.
  const decorated = `${TS}${ESC}[31mnpm error path /_work/x/packages/cli${ESC}[39m`;
  assert.equal(normalizeLog(decorated), stripLogDecoration(decorated));
  assert.equal(
    normalizeLog(`plain\n${decorated}`),
    ['plain', stripLogDecoration(decorated)].join('\n'),
  );
  const source = readFileSync(
    new URL('./classify-infra-flake.mjs', import.meta.url),
    'utf8',
  );
  for (const name of ['ANSI_PATTERN', 'LOG_TIMESTAMP_PATTERN']) {
    assert.ok(
      !new RegExp(`const ${name}\\b`).test(source),
      `classify-infra-flake.mjs re-declares ${name} — import stripLogDecoration ` +
        'from main-failure-signature.mjs instead, so a transport change is fixed once',
    );
  }
});

test('annotates a refused verdict, not stderr alone', () => {
  // The release lane's sibling step annotates both outcomes; a bare stderr line
  // in a hundred-thousand-line log is not where an operator looks for the
  // reason a rerun would or would not help.
  const files = new Map([
    ['/log.txt', ALL_GREEN_RPC_LOG],
    ['packages/cli/junit.xml', junit()],
  ]);
  const read = (path) => {
    if (!files.has(path))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(path);
  };
  const lines = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  let code;
  try {
    // core's junit is missing, so this refuses on a named workspace.
    code = runCli(['--log', '/log.txt', '--root', '.'], { readFileSync: read });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.equal(code, 1);
  const annotation = lines.find((line) => line.startsWith('::error title='));
  assert.ok(
    annotation,
    'a refused verdict must surface as a titled annotation, not only stderr',
  );
  // One line: a newline would terminate the workflow command and leak the
  // remainder into the log as ordinary text.
  assert.equal(annotation.split('\n').length, 2, 'trailing newline only');
  assert.match(annotation, /did not tolerate it::/);
  assert.match(annotation, /wrote no junit\.xml/);
  // The stderr line stays: it is what a local invocation reads.
  assert.ok(
    lines.some((line) => line.startsWith('infra-flake: not tolerated')),
  );
});

const SCRIPT_PATH = fileURLToPath(
  new URL('./classify-infra-flake.mjs', import.meta.url),
);

test('carries the verdict across the process boundary the lane spawns', () => {
  // Every case above calls runCli in-process and compares its return value, so
  // the module-scope `process.exitCode = runCli(...)` — the line that makes that
  // return the lane's exit status — is executed by none of them. Dropping the
  // assignment keeps this suite green while the script exits 0 on a refusal, and
  // ci.yml's `&& RC=0` then greens the required Test check on a run where tests
  // failed. Spawn it the way the lane does, flags included.
  const root = mkdtempSync(join(tmpdir(), 'infra-flake-cli-'));
  try {
    const logPath = join(root, 'test-ci-workspaces.log');
    const samplesPath = join(root, 'disk-samples.log');
    writeFileSync(logPath, ALL_GREEN_RPC_LOG);
    writeFileSync(
      samplesPath,
      'DFSAMPLE 08:53:48 tmpdir[/var/tmp/x] load[236.42 234.69 229.50] hosttests[74]',
    );
    for (const workspace of ['packages/cli', 'packages/core']) {
      mkdirSync(join(root, workspace), { recursive: true });
      writeFileSync(join(root, workspace, 'junit.xml'), junit());
    }
    const spawn = () =>
      spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--log',
          logPath,
          '--root',
          root,
          '--samples',
          samplesPath,
          '--runner-name',
          'ecs-qwen-hk5-2',
        ],
        { encoding: 'utf8' },
      );

    const tolerated = spawn();
    assert.equal(tolerated.status, 0, tolerated.stderr);
    assert.match(tolerated.stdout, /^::warning::Workspaces leg tolerated/m);
    assert.match(tolerated.stdout, /peak host load 236\.42/);

    // The completeness gate, end to end: nothing above crosses the process
    // boundary on it, because the expectation is derived inside `runCli` from
    // `--root` and never appears in argv. Dropping `expectedLegs:` from the
    // classify() call in runCli leaves every unit test green and reds this.
    //
    // The temp root has had no package.json until here, which is also the
    // documented unavailable case: no expectation, no gate, tolerated above.
    // Now give it a root that declares three legs and a capture where only two
    // announced themselves — the shape a producer killed mid-walk leaves.
    const pkg = (name) =>
      JSON.stringify({ name, version: '1.0.0', scripts: { 'test:ci': 'x' } });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    for (const [dir, name] of [
      ['packages/cli', 'cli-pkg'],
      ['packages/core', 'core-pkg'],
      ['packages/web-shell', 'web-shell-pkg'],
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), pkg(name));
    }
    const banner = (name) => `> ${name}@1.0.0 test:ci`;
    writeFileSync(
      logPath,
      [banner('cli-pkg'), ALL_GREEN_RPC_LOG, banner('core-pkg')].join('\n'),
    );
    const incomplete = spawn();
    assert.equal(incomplete.status, 1, incomplete.stdout);
    assert.match(
      incomplete.stderr,
      /^infra-flake: not tolerated — the workspace walk is incomplete — 1 of 3 leg\(s\) npm should have started never printed a banner \(web-shell-pkg\)/m,
    );
    assert.match(incomplete.stdout, /^::error title=/m);

    // The same capture with the third banner is tolerated again, so the
    // refusal above is about the walk and not about the new package.json files.
    writeFileSync(
      logPath,
      [
        banner('cli-pkg'),
        ALL_GREEN_RPC_LOG,
        banner('core-pkg'),
        banner('web-shell-pkg'),
      ].join('\n'),
    );
    const complete = spawn();
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /^::warning::Workspaces leg tolerated/m);

    // One failing junit turns the same log into a refusal: exit 1 is what the
    // lane's `&& RC=0` reads, and the reason has to reach both streams — the
    // annotation for the job page, the stderr line for a local invocation.
    writeFileSync(join(root, 'packages/cli/junit.xml'), junit(2));
    const refused = spawn();
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(
      refused.stderr,
      /^infra-flake: not tolerated — packages\/cli\/junit\.xml reports 2 failure/m,
    );
    assert.match(refused.stdout, /^::error title=/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
