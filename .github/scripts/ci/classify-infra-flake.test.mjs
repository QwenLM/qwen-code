import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RPC_TIMEOUT_SIGNATURE,
  classify,
  countCaughtUnhandled,
  countRpcTimeouts,
  failingWorkspaceDirs,
  junitTotals,
  peakLoad,
  runCli,
  warningLine,
} from './classify-infra-flake.mjs';

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

test('fails closed when junit reports failures', () => {
  const verdict = classify({
    logText: ALL_GREEN_RPC_LOG,
    readJunit: (relative) =>
      relative === 'packages/cli/junit.xml' ? junit(2) : junit(),
  });
  assert.equal(verdict.tolerated, false);
  assert.match(verdict.reason, /packages\/cli\/junit\.xml reports 2 failure/);
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
  assert.equal(junitTotals('not xml'), null);
  assert.equal(junitTotals(''), null);
});

test('attributes nested workspaces to their full packages path', () => {
  const log = `${TS}npm error path /_work/qwen-code/qwen-code/packages/channels/base`;
  assert.deepEqual(failingWorkspaceDirs(log), ['packages/channels/base']);
});

test('normalizes ANSI escapes and Actions timestamps', () => {
  const decorated = [
    `${TS}${ESC}[41m${ESC}[1mVitest caught 1 unhandled error during the test run.${ESC}[22m${ESC}[49m`,
    `${TS}${ESC}[31mError: ${RPC_TIMEOUT_SIGNATURE}${ESC}[39m`,
    `${TS}npm error path /_work/qwen-code/qwen-code/packages/cli`,
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
  const files = new Map([
    ['/log.txt', ALL_GREEN_RPC_LOG],
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
    assert.throws(
      () => runCli(['--log'], { readFileSync: read }),
      /--log is required|--<name> <value>/,
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
