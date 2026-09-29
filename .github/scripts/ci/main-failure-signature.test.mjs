import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_MARKER_PREFIX,
  MAX_BODY_TESTS,
  MAX_OCCURRENCES,
  MAX_SEARCH_MARKERS,
  OCCURRENCE_MARKER,
  TEST_MARKER_PREFIX,
  analyzeLogs,
  extractFailingTests,
  failureSignature,
  renderIssueBody,
  renderIssueTitle,
  runCli,
  shortenForTitle,
  testKey,
} from './main-failure-signature.mjs';

const ESC = '\u001B';

// Verbatim shape of the lines Actions stored for E2E run 3354 (timestamp
// prefix + SGR escapes + the failure printed once inline and twice in the
// summary), so the parser is tested against the real log format.
const VITEST_LOG = [
  `2026-07-27T02:37:25.9531933Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m sdk-typescript/tool-control.test.ts${ESC}[2m > ${ESC}[22mTool Control Parameters (E2E)${ESC}[2m > ${ESC}[22mallowedTools parameter${ESC}[2m > ${ESC}[22mshould auto-approve specific path patterns with allowedTools`,
  `2026-07-27T02:37:25.9823239Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m sdk-typescript/tool-control.test.ts${ESC}[2m > ${ESC}[22mTool Control Parameters (E2E)${ESC}[2m > ${ESC}[22mallowedTools parameter${ESC}[2m > ${ESC}[22mshould auto-approve specific path patterns with allowedTools`,
  `2026-07-27T02:37:25.9861349Z ${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m`,
].join('\n');

const VITEST_TEST_ID =
  'sdk-typescript/tool-control.test.ts > Tool Control Parameters (E2E) > allowedTools parameter > should auto-approve specific path patterns with allowedTools';

test('extracts a vitest failure from a real Actions log line', () => {
  assert.deepEqual(extractFailingTests(VITEST_LOG), [VITEST_TEST_ID]);
});

test('extracts pytest node ids without the varying error message', () => {
  const log = [
    '2026-07-27T02:37:25.9531933Z FAILED packages/sdk-python/tests/test_client.py::test_stream - AssertionError: assert 3 == 4',
    '2026-07-27T02:37:25.9531933Z FAILED packages/sdk-python/tests/test_client.py::test_stream - AssertionError: assert 7 == 4',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), [
    'packages/sdk-python/tests/test_client.py::test_stream',
  ]);
});

test('keeps the full pytest node id when parameters contain spaces', () => {
  const log = [
    'FAILED tests/t.py::test_x[case one] - AssertionError: boom',
    'FAILED tests/t.py::test_x[case two] - AssertionError: boom',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), [
    'tests/t.py::test_x[case one]',
    'tests/t.py::test_x[case two]',
  ]);
});

// Verbatim lines of SDK Java run 36382763760 (the duplicate-V16 merge of
// #12940): one inline Surefire line per errored test, each preceded by the
// class-level summary line that names no method and must not register.
const MAVEN_LOG = [
  '2026-09-28T05:40:26.0787691Z [ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.592 s <<< FAILURE! -- in com.alibaba.qwen.code.managedagent.ManagedSessionOperationMigrationTest',
  '2026-09-28T05:40:26.0790051Z [ERROR] com.alibaba.qwen.code.managedagent.ManagedSessionOperationMigrationTest.finishesLifecycleCommandsThatWaitedBeforeTheUpgrade -- Time elapsed: 0.569 s <<< ERROR!',
  '2026-09-28T05:40:26.2087318Z [ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.060 s <<< FAILURE! -- in com.alibaba.qwen.code.managedagent.ManagedEventIdentityMigrationTest',
  '2026-09-28T05:40:26.2115597Z [ERROR] com.alibaba.qwen.code.managedagent.ManagedEventIdentityMigrationTest.backfillsTheIdentityThatTheSnapshotUses -- Time elapsed: 0.058 s <<< ERROR!',
].join('\n');

test('extracts surefire failures without the elapsed time', () => {
  assert.deepEqual(extractFailingTests(MAVEN_LOG), [
    'com.alibaba.qwen.code.managedagent.ManagedSessionOperationMigrationTest.finishesLifecycleCommandsThatWaitedBeforeTheUpgrade',
    'com.alibaba.qwen.code.managedagent.ManagedEventIdentityMigrationTest.backfillsTheIdentityThatTheSnapshotUses',
  ]);
});

test('extracts a surefire assertion failure, deduped across matrix legs', () => {
  const log = [
    '[ERROR] com.example.LedgerTest.totals -- Time elapsed: 0.011 s <<< FAILURE!',
    '[ERROR] com.example.LedgerTest.totals -- Time elapsed: 0.009 s <<< FAILURE!',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), ['com.example.LedgerTest.totals']);
});

test('keeps two same-named tests from different packages distinct', () => {
  // The Surefire id is the dedupe identity, so the package prefix must
  // survive: sdk-java already carries the same simple test class name in two
  // Maven modules, and reducing to `Class.method` would merge them into one
  // issue.
  const log = [
    '[ERROR] com.a.SessionTest.closes -- Time elapsed: 0.10 s <<< ERROR!',
    '[ERROR] com.b.SessionTest.closes -- Time elapsed: 0.11 s <<< ERROR!',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), [
    'com.a.SessionTest.closes',
    'com.b.SessionTest.closes',
  ]);
  const analysis = analyzeLogs('SDK Java', [log]);
  assert.equal(analysis.markers.length, 2);
  assert.notEqual(analysis.markers[0], analysis.markers[1]);
});

test('ignores a Maven error line whose payload is not a Java id', () => {
  assert.deepEqual(
    extractFailingTests(
      '[ERROR] model refused the request -- Time elapsed: 1.2 s <<< ERROR!',
    ),
    [],
  );
});

test('keeps the parameterized tail of a Surefire id', () => {
  assert.deepEqual(
    extractFailingTests(
      '[ERROR] com.example.FooTest.bar(java.util.List)[1] -- Time elapsed: 0.10 s <<< ERROR!',
    ),
    ['com.example.FooTest.bar(java.util.List)[1]'],
  );
});

const FLYWAY_GUARD = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-flyway-migrations.js',
);

// The Flyway fixtures are CAPTURED from the guard, never typed by hand: a
// drift between the producer's message and this consumer's pattern must
// redden here — silently surviving a reworded producer is the failure this
// module exists to end. The captured stderr is then rendered the way a
// downloaded Actions log carries it: the runner consumes the ::error::
// command, writes ##[error] in its place, and timestamps every line.
function captureGuardLog(moduleDir) {
  const result = spawnSync(process.execPath, [FLYWAY_GUARD, moduleDir], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `guard stderr: ${result.stderr}`);
  const raw = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('::error::'))
    .map((line) => `2026-09-29T00:00:00.0000000Z ${line}`)
    .join('\n');
  return { raw, tagged: raw.replaceAll('::error::', '##[error]') };
}

function planSearchMarkers(log, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'sig-flyway-plan-'));
  const analysisPath = join(dir, 'analysis.json');
  writeFileSync(analysisPath, JSON.stringify(analyzeLogs('SDK Java', [log])));
  return JSON.parse(
    captureStdout([
      'plan',
      '--analysis',
      analysisPath,
      '--sha',
      sha,
      '--run-url',
      `https://github.com/QwenLM/qwen-code/actions/runs/${sha}`,
      '--run-id',
      sha,
      '--at',
      '2026-09-29T00:00:00Z',
    ]),
  ).searchMarkers;
}

test('a Flyway guard red files one issue, not one per stacked merge', () => {
  // Two SQL files claiming one version in one module: the #12940 shape.
  const dir = mkdtempSync(join(tmpdir(), 'sig-flyway-'));
  const moduleDir = join(dir, 'managed-agent-server');
  const migrationDir = join(moduleDir, 'src/main/resources/db/migration');
  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(join(migrationDir, 'V16__a.sql'), '');
  writeFileSync(join(migrationDir, 'V16__b.sql'), '');

  const log = captureGuardLog(moduleDir);
  const id = `flyway duplicate version 16 in ${moduleDir}`;
  // The ##[error] form is what a downloaded job log carries; the raw
  // ::error:: form is what the guard prints. Both must extract.
  assert.deepEqual(extractFailingTests(log.tagged), [id]);
  assert.deepEqual(extractFailingTests(log.raw), [id]);

  // The marker keys on the collision, not the commit: two merges stacked on
  // the standing red resolve to the same issue.
  assert.deepEqual(
    planSearchMarkers(log.tagged, '1111111111111'),
    planSearchMarkers(log.tagged, '2222222222222'),
  );
});

test('a Flyway guard blind-spot red also files one issue, not one per stacked merge', () => {
  // A renamed migration location and a missing module directory are standing
  // reds that name no test: without their own stable identity the plan falls
  // back to the sha-keyed per-commit marker and each stacked merge opens a
  // fresh issue.
  const dir = mkdtempSync(join(tmpdir(), 'sig-flyway-moved-'));
  const moduleDir = join(dir, 'managed-agent-server');
  // A db/migration* sibling marks the module as owning migrations while the
  // configured SQL location stays empty — the guard's "location moved" mode.
  mkdirSync(join(moduleDir, 'src/main/resources/db/migrations'), {
    recursive: true,
  });

  const moved = captureGuardLog(moduleDir);
  assert.deepEqual(extractFailingTests(moved.tagged), [
    `flyway found no migration under src/main/resources/db/migration in ${moduleDir}`,
  ]);
  assert.deepEqual(
    planSearchMarkers(moved.tagged, '1111111111111'),
    planSearchMarkers(moved.tagged, '2222222222222'),
  );

  const absentDir = join(dir, 'absent-module');
  const absent = captureGuardLog(absentDir);
  assert.deepEqual(extractFailingTests(absent.tagged), [
    `flyway no such Maven module directory in ${absentDir}`,
  ]);
  assert.deepEqual(
    planSearchMarkers(absent.tagged, '1111111111111'),
    planSearchMarkers(absent.tagged, '2222222222222'),
  );
});

test('ignores Maven error lines that name no test', () => {
  // Also verbatim from run 36382763760: the goal failure, the run-level
  // tally, and the help pointer carry no `Class.method` failure line.
  const log = [
    '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.6:test (default-test) on project qwen-managed-agent-server:',
    '[ERROR] Tests run: 153, Failures: 0, Errors: 88, Skipped: 0',
    '[ERROR] -> [Help 1]',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), []);
});

test('an SDK Java analysis titles the issue by the failing test', () => {
  const analysis = analyzeLogs('SDK Java', [MAVEN_LOG]);
  assert.equal(
    analysis.title,
    'Main CI failed: SDK Java — ManagedSessionOperationMigrationTest.finishesLifecycleCommandsThatWaitedBeforeTheUpgrade (+1 more)',
  );
});

test('keeps first-seen order across several failures', () => {
  const log = [
    ' FAIL  cli/b.test.ts > second',
    ' FAIL  cli/a.test.ts > first',
    ' FAIL  cli/b.test.ts > second',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), [
    'cli/b.test.ts > second',
    'cli/a.test.ts > first',
  ]);
});

test('ignores the word FAIL in a test subprocess own output', () => {
  const log = [
    '2026-07-27T02:37:25.9531933Z stdout | FAIL because the model refused',
    '2026-07-27T02:37:25.9531933Z FAIL',
    '2026-07-27T02:37:25.9531933Z FAILED to reach the sandbox registry',
  ].join('\n');
  assert.deepEqual(extractFailingTests(log), []);
});

test('reports no failing tests for an infra break with no test output', () => {
  const analysis = analyzeLogs('E2E Tests', [
    '2026-07-27T02:37:25.9531933Z npm error code ERESOLVE',
  ]);
  assert.deepEqual(analysis.tests, []);
  assert.equal(analysis.signature, '');
  assert.equal(analysis.title, '');
  assert.deepEqual(analysis.markers, []);
});

test('merges the failures of every failed matrix leg', () => {
  const analysis = analyzeLogs('E2E Tests', [
    VITEST_LOG,
    VITEST_LOG,
    ' FAIL  cli/other.test.ts > macOS only',
  ]);
  assert.deepEqual(
    analysis.tests.map((entry) => entry.id),
    [VITEST_TEST_ID, 'cli/other.test.ts > macOS only'],
  );
  assert.deepEqual(analysis.markers, [
    `${TEST_MARKER_PREFIX}${testKey(VITEST_TEST_ID)}`,
    `${TEST_MARKER_PREFIX}${testKey('cli/other.test.ts > macOS only')}`,
  ]);
  assert.match(analysis.title, /^Main CI failed: E2E Tests — sdk-typescript/);
  assert.match(analysis.title, /\(\+1 more\)$/);
});

test('title keeps the file and the case, collapsing the suite chain', () => {
  assert.equal(
    shortenForTitle(VITEST_TEST_ID),
    'sdk-typescript/tool-control.test.ts > … > should auto-approve specific path patterns with allowedTools',
  );
  assert.equal(
    shortenForTitle('a.test.ts > only case'),
    'a.test.ts > only case',
  );
  assert.equal(
    shortenForTitle(`a.test.ts > ${'x'.repeat(200)}`).length,
    110,
    'a single very long segment is still truncated',
  );
});

test('caps the markers used for issue search', () => {
  const log = Array.from(
    { length: 9 },
    (_unused, index) => ` FAIL  cli/a.test.ts > case ${index}`,
  ).join('\n');
  const analysis = analyzeLogs('E2E Tests', [log]);
  assert.equal(analysis.markers.length, 9);
  assert.equal(analysis.searchMarkers.length, 5);
});

test('signature is stable across runs and independent of report order', () => {
  const forward = failureSignature('E2E Tests', ['a > 1', 'b > 2']);
  assert.equal(forward, failureSignature('E2E Tests', ['b > 2', 'a > 1']));
  assert.notEqual(forward, failureSignature('E2E Tests', ['a > 1']));
  assert.notEqual(forward, failureSignature('SDK Python', ['a > 1', 'b > 2']));
});

test('signature ignores whitespace noise in a test id', () => {
  assert.equal(testKey('a  >   b'), testKey('a > b'));
});

/** Occurrence lines live after the marker; the failing-test list uses the
 * same bullet shape, so tests must read the block, not the whole body. */
function occurrenceLines(body) {
  return body
    .slice(body.indexOf(OCCURRENCE_MARKER))
    .split('\n')
    .filter((line) => line.startsWith('- `'));
}

const OCCURRENCE = {
  sha: 'af7a9ec12722ab34',
  runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/301',
  runId: '301',
  at: '2026-07-27T02:42:08Z',
};

test('creates a body carrying every dedupe marker and the first recurrence', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.match(body, /<!-- qwen-main-ci-failure-sig:[0-9a-f]{12} -->/);
  assert.ok(body.includes(`<!-- ${analysis.markers[0]} -->`));
  assert.ok(body.includes(`- \`${VITEST_TEST_ID}\``));
  assert.ok(body.includes(OCCURRENCE_MARKER));
  assert.ok(
    body.includes(
      '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 301](https://github.com/QwenLM/qwen-code/actions/runs/301)',
    ),
  );
});

test('the body stays bounded on a total-suite failure', () => {
  const log = Array.from(
    { length: 400 },
    (_unused, index) => ` FAIL  cli/suite.test.ts > case ${index}`,
  ).join('\n');
  const analysis = analyzeLogs('E2E Tests', [log]);
  assert.equal(analysis.tests.length, 400);

  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(
    body.length < 65536,
    `body is ${body.length} chars, must stay under GitHub's 65,536 limit`,
  );
  assert.ok(body.includes(`- …and ${400 - MAX_BODY_TESTS} more`));
  const markerCount = (body.match(new RegExp(TEST_MARKER_PREFIX, 'g')) ?? [])
    .length;
  assert.ok(
    markerCount <= MAX_SEARCH_MARKERS,
    `body carries ${markerCount} markers, at most ${MAX_SEARCH_MARKERS}`,
  );
});

test('merging prepends the new recurrence and keeps existing prose', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const existing = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const withNotes = existing.replace(
    '## Recurrences',
    '## Investigation\n\nThe assertion depends on model output.\n\n## Recurrences',
  );

  const merged = renderIssueBody({
    analysis,
    existingBody: withNotes,
    occurrence: {
      ...OCCURRENCE,
      sha: 'b0ce7dc51999',
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
      at: '2026-07-27T03:20:00Z',
    },
  });

  assert.ok(merged.includes('The assertion depends on model output.'));
  assert.deepEqual(occurrenceLines(merged), [
    '- `b0ce7dc51999` · 2026-07-27T03:20:00Z · [run 302](https://github.com/QwenLM/qwen-code/actions/runs/302)',
    '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 301](https://github.com/QwenLM/qwen-code/actions/runs/301)',
  ]);
});

test('merging a re-run of the same run does not duplicate its line', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const existing = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const merged = renderIssueBody({
    analysis,
    existingBody: existing,
    occurrence: { ...OCCURRENCE, at: '2026-07-27T04:00:00Z' },
  });

  assert.deepEqual(occurrenceLines(merged), [
    '- `af7a9ec12722` · 2026-07-27T04:00:00Z · [run 301](https://github.com/QwenLM/qwen-code/actions/runs/301)',
  ]);
});

test('re-running one run keeps another run whose id it is a prefix of', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const existing = renderIssueBody({
    analysis,
    occurrence: {
      ...OCCURRENCE,
      runId: '3010',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/3010',
    },
  });

  // Run 301 is a re-run; `/301` is a substring of `/runs/3010`, so matching on
  // the URL would delete run 3010's line. Matching on `[run 301]` must not.
  const merged = renderIssueBody({
    analysis,
    existingBody: existing,
    occurrence: { ...OCCURRENCE },
  });

  assert.deepEqual(occurrenceLines(merged), [
    '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 301](https://github.com/QwenLM/qwen-code/actions/runs/301)',
    '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 3010](https://github.com/QwenLM/qwen-code/actions/runs/3010)',
  ]);
});

test('falls back to a per-commit issue when no test can be identified', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const title = renderIssueTitle({ analysis, occurrence: OCCURRENCE });
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.equal(title, 'Main CI failed: E2E Tests on af7a9ec12722');
  assert.ok(body.includes(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`));
  assert.ok(body.includes('tracked per commit'));
  assert.ok(body.includes(`- Run: ${OCCURRENCE.runUrl}`));
  // No recurrence machinery on this path: each commit gets its own issue.
  assert.ok(!body.includes(OCCURRENCE_MARKER));
});

test('the per-commit path leaves an already-filed body untouched', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const existingBody = 'whatever the previous run wrote\n';
  assert.equal(
    renderIssueBody({ analysis, occurrence: OCCURRENCE, existingBody }),
    existingBody,
  );
});

test('a title for identified tests names the test, not the commit', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  assert.equal(
    renderIssueTitle({ analysis, occurrence: OCCURRENCE }),
    analysis.title,
  );
  assert.ok(
    !renderIssueTitle({ analysis, occurrence: OCCURRENCE }).includes('af7a9ec'),
  );
});

test('merging keeps notes written below the machine block', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  // GitHub's editor and the autofix agent both append at the very end, i.e.
  // after the occurrence block rather than before it.
  const existing = `${renderIssueBody({ analysis, occurrence: OCCURRENCE })}
## Investigation

The assertion depends on model output.

- not an occurrence line
`;

  const merged = renderIssueBody({
    analysis,
    existingBody: existing,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
  });

  assert.ok(merged.includes('## Investigation'));
  assert.ok(merged.includes('The assertion depends on model output.'));
  assert.ok(merged.includes('- not an occurrence line'));
  assert.deepEqual(occurrenceLines(merged), [
    '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 302](https://github.com/QwenLM/qwen-code/actions/runs/302)',
    '- `af7a9ec12722` · 2026-07-27T02:42:08Z · [run 301](https://github.com/QwenLM/qwen-code/actions/runs/301)',
  ]);
  // The kept prose sits above the refreshed block, so the trailer stays last.
  assert.ok(
    merged.indexOf('## Investigation') < merged.indexOf(OCCURRENCE_MARKER),
  );
  // The heading is stripped from kept prose and re-emitted once with the
  // machine block — repeated merges must not accumulate duplicate headings.
  assert.equal(merged.split('## Recurrences').length, 2);
  // Markers are deduped: the body carries each one exactly once.
  assert.equal(
    (merged.match(new RegExp(TEST_MARKER_PREFIX, 'g')) ?? []).length,
    analysis.tests.length,
  );
});

test('repeated merges do not accumulate headings or duplicate markers', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  for (let index = 2; index <= 6; index += 1) {
    body = renderIssueBody({
      analysis,
      existingBody: body,
      occurrence: {
        ...OCCURRENCE,
        runId: String(300 + index),
        runUrl: `https://github.com/QwenLM/qwen-code/actions/runs/${300 + index}`,
      },
    });
  }

  assert.equal(
    body.split('## Recurrences').length,
    2,
    'exactly one Recurrences heading after five merges',
  );
  assert.equal(
    (body.match(new RegExp(TEST_MARKER_PREFIX, 'g')) ?? []).length,
    analysis.tests.length,
    'each marker appears exactly once',
  );
});

test('merging records a test that joined the failure set later', () => {
  const first = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const existing = renderIssueBody({ analysis: first, occurrence: OCCURRENCE });

  const second = analyzeLogs('E2E Tests', [
    VITEST_LOG,
    ' FAIL  channel-plugin.test.ts > remembers pineapple',
  ]);
  const merged = renderIssueBody({
    analysis: second,
    existingBody: existing,
    occurrence: { ...OCCURRENCE, runId: '303', runUrl: '.../runs/303' },
  });

  assert.ok(merged.includes(`<!-- ${second.markers[1]} -->`));
  assert.ok(
    merged.includes('- `channel-plugin.test.ts > remembers pineapple`'),
  );
  // The already-recorded test is not repeated.
  assert.equal(
    merged.split(`- \`${VITEST_TEST_ID}\``).length - 1,
    1,
    'the original failing test is listed exactly once',
  );
});

test('"Also failing" is rebuilt from the live failure set, not appended', () => {
  const first = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const joined = analyzeLogs('E2E Tests', [
    VITEST_LOG,
    ' FAIL  channel-plugin.test.ts > remembers pineapple',
  ]);
  let body = renderIssueBody({ analysis: first, occurrence: OCCURRENCE });
  body = renderIssueBody({
    analysis: joined,
    existingBody: body,
    occurrence: { ...OCCURRENCE, runId: '303', runUrl: '.../runs/303' },
  });
  body = renderIssueBody({
    analysis: joined,
    existingBody: body,
    occurrence: { ...OCCURRENCE, runId: '304', runUrl: '.../runs/304' },
  });

  // One heading and one listing of the extra test, however many merges ran.
  assert.equal(body.split('## Also failing').length - 1, 1);
  assert.equal(
    body.split('- `channel-plugin.test.ts > remembers pineapple`').length - 1,
    1,
  );
});

test('a test that joined then got fixed drops out of "Also failing"', () => {
  const first = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const joined = analyzeLogs('E2E Tests', [
    VITEST_LOG,
    ' FAIL  channel-plugin.test.ts > remembers pineapple',
  ]);
  const withExtra = renderIssueBody({
    analysis: joined,
    existingBody: renderIssueBody({ analysis: first, occurrence: OCCURRENCE }),
    occurrence: { ...OCCURRENCE, runId: '303', runUrl: '.../runs/303' },
  });
  assert.ok(
    withExtra.includes('- `channel-plugin.test.ts > remembers pineapple`'),
  );

  // The extra test is fixed; only the original failure recurs.
  const merged = renderIssueBody({
    analysis: first,
    existingBody: withExtra,
    occurrence: { ...OCCURRENCE, runId: '304', runUrl: '.../runs/304' },
  });

  assert.ok(
    !merged.includes('- `channel-plugin.test.ts > remembers pineapple`'),
  );
  assert.ok(!merged.includes('## Also failing'));
  // The original failing test is still listed exactly once.
  assert.equal(merged.split(`- \`${VITEST_TEST_ID}\``).length - 1, 1);
});

test('the capped-summary line is not listed as a fake "Also failing" bullet', () => {
  const makeLog = (count) =>
    Array.from(
      { length: count },
      (_unused, index) => ` FAIL  cli/suite.test.ts > case ${index}`,
    ).join('\n');

  const first = analyzeLogs('E2E Tests', [makeLog(MAX_BODY_TESTS + 5)]);
  const second = analyzeLogs('E2E Tests', [makeLog(MAX_BODY_TESTS + 3)]);

  const body = renderIssueBody({ analysis: first, occurrence: OCCURRENCE });
  const merged = renderIssueBody({
    analysis: second,
    existingBody: body,
    occurrence: { ...OCCURRENCE, runId: '303', runUrl: '.../runs/303' },
  });

  assert.ok(
    !merged.includes('- …and 3 more'),
    'summary line must not appear as a test bullet',
  );
});

test('the recurrence list is bounded and the trim note never re-enters it', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  for (let index = 2; index <= MAX_OCCURRENCES + 4; index += 1) {
    body = renderIssueBody({
      analysis,
      existingBody: body,
      occurrence: {
        ...OCCURRENCE,
        sha: `sha${index}`.padEnd(12, '0'),
        runId: String(300 + index),
        runUrl: `https://github.com/QwenLM/qwen-code/actions/runs/${300 + index}`,
        at: `2026-07-27T0${index % 10}:00:00Z`,
      },
    });
  }

  const lines = occurrenceLines(body);
  assert.equal(lines.length, MAX_OCCURRENCES);
  assert.match(lines[0], /run 314/);
  assert.equal(body.split('_Older recurrences trimmed._').length - 1, 1);
});

test('runCli plan --existing merges recorded recurrences from the file', () => {
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const existing = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  const dir = mkdtempSync(join(tmpdir(), 'sig-cli-'));
  const analysisPath = join(dir, 'analysis.json');
  const existingPath = join(dir, 'existing.md');
  writeFileSync(analysisPath, JSON.stringify(analysis));
  writeFileSync(existingPath, existing);

  const planned = JSON.parse(
    captureStdout([
      'plan',
      '--analysis',
      analysisPath,
      '--existing',
      existingPath,
      '--sha',
      'b0ce7dc51999',
      '--run-url',
      'https://github.com/QwenLM/qwen-code/actions/runs/302',
      '--run-id',
      '302',
      '--at',
      '2026-07-27T03:20:00Z',
    ]),
  );

  // The existing body's run-301 line must survive: a broken --existing path
  // would produce a create-path body with only the new run.
  assert.ok(planned.body.includes('[run 301]'));
  assert.ok(planned.body.includes('[run 302]'));
  assert.equal(planned.title, analysis.title);
});

// A lane that dies before printing any test result — the case the per-commit
// path exists for — still reports which job and which step failed. That identity
// is the only thing standing between an actionable issue and a stub naming
// nothing but a commit.
const WINDOWS_JOB = {
  name: 'Test (windows-latest, Node 22.x)',
  steps: ['Run tests and generate reports'],
};

function captureStdout(argv) {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    runCli(argv);
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test('the per-commit body names the failing job and step', () => {
  const analysis = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.ok(body.includes('- Failed jobs:'));
  assert.ok(
    body.includes(
      '  - `Test (windows-latest, Node 22.x)` — failed in step `Run tests and generate reports`',
    ),
  );
  // Naming the job does not turn this into the deduped path: same marker, same
  // title, still no recurrence machinery.
  assert.ok(body.includes(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`));
  assert.ok(body.includes('tracked per commit'));
  assert.ok(body.includes(`- Run: ${OCCURRENCE.runUrl}`));
  assert.ok(!body.includes(OCCURRENCE_MARKER));
  assert.equal(
    renderIssueTitle({ analysis, occurrence: OCCURRENCE }),
    'Main CI failed: Qwen Code CI on af7a9ec12722',
  );
});

test('the test-keyed body names the failed job and step too', () => {
  // A red that names its tests still needs the lane: a guard's diagnosis (the
  // colliding files) lives only in the job log, and the per-test bullets
  // alone do not say which job broke.
  const analysis = analyzeLogs(
    'SDK Java',
    [MAVEN_LOG],
    [
      {
        name: 'Flyway migration version uniqueness',
        steps: ['Check Flyway migration versions are unique'],
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.ok(body.includes('## Failing tests'));
  assert.ok(
    body.includes(
      '  - `Flyway migration version uniqueness` — failed in step `Check Flyway migration versions are unique`',
    ),
  );
});

test('a test-keyed body with no reported jobs has no dangling heading', () => {
  // The failed-jobs conditional's false branch: an unconditional spread
  // would leave a "- Failed jobs:" heading with no bullets under it.
  const analysis = analyzeLogs('SDK Java', [MAVEN_LOG]);
  assert.deepEqual(analysis.failedJobs, []);
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(body.includes('## Failing tests'));
  assert.ok(!body.includes('- Failed jobs:'));
});

test('merge rebuilds the failed-jobs block from the current run', () => {
  // The block is machine-owned like "## Also failing": a later recurrence of
  // the same failure can break in a different lane, and the body must point
  // at the lane whose log holds THAT run's diagnosis.
  const flywayLane = {
    name: 'Flyway migration version uniqueness',
    steps: ['Check Flyway migration versions are unique'],
  };
  const databaseLane = {
    name: 'Runtime Broker and Managed Agent MariaDB / Java 21',
    steps: ['Run Managed Agent tests, Checkstyle, and MySQL integration'],
  };
  const created = renderIssueBody({
    analysis: analyzeLogs('SDK Java', [MAVEN_LOG], [flywayLane]),
    occurrence: OCCURRENCE,
  });
  assert.ok(created.includes('`Flyway migration version uniqueness`'));

  const merged = renderIssueBody({
    analysis: analyzeLogs('SDK Java', [MAVEN_LOG], [databaseLane]),
    existingBody: created,
    occurrence: { ...OCCURRENCE, runId: '302', runUrl: '.../runs/302' },
  });
  assert.ok(
    merged.includes(
      '  - `Runtime Broker and Managed Agent MariaDB / Java 21` — failed in step `Run Managed Agent tests, Checkstyle, and MySQL integration`',
    ),
  );
  assert.ok(!merged.includes('Flyway migration version uniqueness'));
  assert.equal(merged.split('- Failed jobs:').length - 1, 1);

  // A recurrence whose failed-job list is unknown drops the block rather
  // than freezing a stale lane name.
  const unknown = renderIssueBody({
    analysis: analyzeLogs('SDK Java', [MAVEN_LOG]),
    existingBody: merged,
    occurrence: { ...OCCURRENCE, runId: '303', runUrl: '.../runs/303' },
  });
  assert.ok(!unknown.includes('- Failed jobs:'));

  // And a run filed without the data gains the block once a recurrence
  // reports it.
  const gained = renderIssueBody({
    analysis: analyzeLogs('SDK Java', [MAVEN_LOG], [databaseLane]),
    existingBody: renderIssueBody({
      analysis: analyzeLogs('SDK Java', [MAVEN_LOG]),
      occurrence: OCCURRENCE,
    }),
    occurrence: { ...OCCURRENCE, runId: '304', runUrl: '.../runs/304' },
  });
  assert.ok(gained.includes('- Failed jobs:'));
  assert.ok(
    gained.includes('`Runtime Broker and Managed Agent MariaDB / Java 21`'),
  );
});

test('a job with several failed steps lists every one of them', () => {
  const analysis = analyzeLogs(
    'Qwen Code CI',
    [],
    [
      {
        name: 'Test (ubuntu-latest, Node 22.x)',
        steps: ['Run ESLint', 'Run tests and generate reports'],
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(
    body.includes(
      'failed in steps `Run ESLint`, `Run tests and generate reports`',
    ),
  );
});

test('a job whose failed step is unknown is still named', () => {
  const analysis = analyzeLogs(
    'Qwen Code CI',
    [],
    [{ name: 'Test (macos-latest, Node 22.x)', steps: [] }],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(body.includes('  - `Test (macos-latest, Node 22.x)`'));
  assert.ok(!body.includes('failed in step'));
});

test('every failed job of a multi-lane run is named', () => {
  const analysis = analyzeLogs(
    'Qwen Code CI',
    [],
    [
      WINDOWS_JOB,
      {
        name: 'Test (macos-latest, Node 22.x)',
        steps: ['Install dependencies'],
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(body.includes('`Test (windows-latest, Node 22.x)`'));
  assert.ok(body.includes('`Test (macos-latest, Node 22.x)`'));
});

test('the per-commit body names no job when the run reported none', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  assert.deepEqual(analysis.failedJobs, []);
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(!body.includes('- Failed jobs:'));
});

test('runCli analyze parses the failed-jobs TSV the workflow writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-jobs-'));
  const jobsPath = join(dir, 'failed-jobs.tsv');
  // A blank line (and one carrying nothing but a tab) must not become an empty
  // bullet, and a job with no failed step must survive without one.
  writeFileSync(
    jobsPath,
    [
      'Test (windows-latest, Node 22.x)\tRun tests and generate reports',
      // One field per failed step, so a name carrying a comma survives intact.
      'Test (ubuntu-latest, Node 22.x)\tRun ESLint, Prettier and tsc\tRun tests',
      '\t',
      'Test (macos-latest, Node 22.x)\t',
      '',
    ].join('\n'),
  );

  const analysis = JSON.parse(
    captureStdout([
      'analyze',
      '--workflow',
      'Qwen Code CI',
      '--jobs',
      jobsPath,
    ]),
  );

  assert.deepEqual(analysis.failedJobs, [
    {
      name: 'Test (windows-latest, Node 22.x)',
      steps: ['Run tests and generate reports'],
    },
    {
      name: 'Test (ubuntu-latest, Node 22.x)',
      steps: ['Run ESLint, Prettier and tsc', 'Run tests'],
    },
    { name: 'Test (macos-latest, Node 22.x)', steps: [] },
  ]);
  assert.deepEqual(analysis.tests, []);
});

test('runCli analyze still plans when the jobs file is missing', () => {
  const analysis = JSON.parse(
    captureStdout([
      'analyze',
      '--workflow',
      'Qwen Code CI',
      '--jobs',
      join(tmpdir(), 'sig-jobs-no-such-file.tsv'),
    ]),
  );
  assert.deepEqual(analysis.failedJobs, []);
});

test('runCli plan renders the named job into the filed body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-plan-'));
  const analysisPath = join(dir, 'analysis.json');
  writeFileSync(
    analysisPath,
    JSON.stringify(
      analyzeLogs('Qwen Code CI', ['npm error code ERESOLVE'], [WINDOWS_JOB]),
    ),
  );

  const planned = JSON.parse(
    captureStdout([
      'plan',
      '--analysis',
      analysisPath,
      '--sha',
      OCCURRENCE.sha,
      '--run-url',
      OCCURRENCE.runUrl,
      '--run-id',
      OCCURRENCE.runId,
      '--at',
      OCCURRENCE.at,
    ]),
  );

  assert.ok(planned.body.includes('`Test (windows-latest, Node 22.x)`'));
  assert.deepEqual(planned.searchMarkers, [
    `${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha}`,
  ]);
});
