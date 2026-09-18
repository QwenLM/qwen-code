import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
  parseFailedJobsMeta,
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
  // A real already-filed body opens with the machine block; the verbatim
  // return is what a human's notes around it rely on. A body with NO
  // readable machine block is not echoed but re-rendered and preserved —
  // that fail-closed path is pinned beside the class-flip tests.
  const existingBody = `${renderIssueBody({ analysis, occurrence: OCCURRENCE })}\nTriage note.\n`;
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

test('flags the never-started class: every failed job ran zero steps', () => {
  // The observed signature of a runner that died after accepting the job
  // (E2E run 35051269368): a failed job whose step list is empty.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
  );
  assert.equal(analysis.neverStarted, true);
  assert.equal(analysis.standDown, true);
});

test('a failed job with executed steps is not the never-started class', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [
      { name: 'Build for E2E', steps: 0 },
      { name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 19 },
    ],
  );
  assert.equal(analysis.neverStarted, false);
});

test('no failed-job metadata at all is not the never-started class', () => {
  // The jobs fetch can fail outright; an unknown step count must never read
  // as zero, or a dead API would route real breaks into the re-run path.
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  assert.equal(analysis.neverStarted, false);
});

test('a filed never-started run reads as a fleet failure, off the autofix route', () => {
  // The body is rendered before the re-run's outcome is known, and it is
  // filed on every path — recurrence after a real re-run, a re-run request
  // that itself failed, a re-run skipped as superseded, a human's re-run —
  // so it must not claim a completed automatic re-run on any of them. The
  // fixture is the motivating incident's shape: a runner accepted the job
  // and died before its first step, which no commit can have caused — the
  // one arm allowed to say so.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [
      {
        name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
        steps: 0,
        runner_name: 'ecs-qwen-hk4-30',
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  // The per-commit marker stays the first line: plan dedupes on it.
  assert.ok(
    body.startsWith(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`),
  );
  assert.ok(body.includes('runner-fleet'));
  assert.ok(body.includes('no automatic re-run cleared it'));
  assert.ok(!body.includes('one automatic re-run'));
  assert.ok(!body.includes('labeled for autofix'));
  // The absolute claim is wrapped across two rendered lines, so match it on
  // the whitespace-normalized body or the assertion cannot fire.
  assert.ok(
    body.replace(/\n/g, ' ').includes('No commit can have caused this'),
  );
  assert.equal(analysis.standDown, true);
});

test('a run whose failed jobs executed steps keeps the autofix pitch', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [
      {
        name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
        steps: ['Run E2E tests'],
      },
    ],
    [
      {
        name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
        steps: 19,
        runner_name: 'ecs-qwen-hk4-30',
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.ok(body.includes('labeled for autofix'));
  assert.ok(!body.includes('runner-fleet'));
  // The host is the fleet branch's escalation datum; it must not leak into
  // the body pitched at the agent.
  assert.ok(!body.includes('ecs-qwen-hk4-30'));
});

test('the fleet body names the never-started jobs, their hosts and the run', () => {
  // Production feeds the fleet branch a non-empty failedJobs (the TSV
  // projection emits the bare job name for a job with no steps) and a meta
  // carrying the runner: the job, the host it died on and the run context
  // are the whole diagnostic content of the one issue a human gets.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: [] }],
    [
      {
        name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
        steps: 0,
        runner_name: 'ecs-qwen-hk4-30',
      },
    ],
  );
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });

  assert.ok(body.includes('- Failed jobs:'));
  assert.ok(
    body.includes(
      '  - `E2E Test (Linux) - sandbox:docker - shard 1/1` on `ecs-qwen-hk4-30`',
    ),
  );
  assert.ok(body.includes(`- Run: ${OCCURRENCE.runUrl}`));
  assert.ok(body.includes(`- Run ID: ${OCCURRENCE.runId}`));
  assert.ok(body.includes(`- Commit: ${OCCURRENCE.sha}`));
});

test('a setup-death fleet body names the failed step without contradicting itself', () => {
  // The meta projection counts repository steps, so a runner that died
  // during setup reads as never-started, while the TSV projection keeps the
  // runner-internal step that failed ('Set up job'). The body must not claim
  // zero executed steps in one line and name the failed step two lines
  // later: a failed Set up job points at runner setup or the runner image,
  // and a commit CAN break setup (e2e.yml consumes the repo-local composite
  // action and computes runs-on from a label expression), so the class
  // invariant is qualified for this shape.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [{ name: 'Build for E2E', steps: ['Set up job'] }],
    [{ name: 'Build for E2E', steps: 0, runner_name: 'ecs-qwen-hk4-9' }],
  );
  assert.equal(analysis.neverStarted, true);
  // A commit CAN break setup, so this arm stays on the autofix route.
  assert.equal(analysis.standDown, false);

  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(
    body.includes(
      '`Build for E2E` on `ecs-qwen-hk4-9` — failed in step `Set up job`',
    ),
  );
  assert.ok(!body.includes('no step of any failed job'));
  // The absolute claim must stay out of this arm in ANY wrapping: the flat
  // prose breaks it across lines, so assert on the normalized body.
  assert.ok(
    !body.replace(/\n/g, ' ').includes('No commit can have caused this'),
  );
  assert.ok(body.includes('runner setup'));
  assert.ok(body.includes('labeled for autofix'));
});

test('a fleet run no runner accepted does not absolve the commit', () => {
  // Zero counted steps is also what a job NO runner ever accepted produces
  // (GitHub leaves its step list empty and its runner_name null, and the job
  // concludes cancelled, so the failure-only TSV names nothing) — and that is
  // the one never-started shape a commit CAN cause, because the runner
  // selector is repository configuration. The body must name the shape and
  // the job without borrowing the pool-death arm's absolute claim.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
  );
  assert.equal(analysis.neverStarted, true);
  assert.equal(analysis.standDown, true);

  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const flat = body.replace(/\n/g, ' ');
  assert.ok(!flat.includes('No commit can have'));
  assert.ok(!flat.includes('the runner accepted each job'));
  assert.ok(body.includes('no runner ever accepted'));
  // The failure-only TSV is empty for this shape, so the job list rides the
  // meta population the class was computed over.
  assert.ok(body.includes('`E2E Test (Linux) - sandbox:docker - shard 1/1`'));
  assert.ok(!body.includes('labeled for autofix'));
});

test('a fleet run where only some failed jobs name a step stays qualified', () => {
  // The arm switch keys on SOME failed job naming a step: a mixed run — one
  // lane dead in setup, one lane dead before any step — must keep the
  // qualified prose, because a commit can have caused the setup death.
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [
      { name: 'Build for E2E', steps: ['Set up job'] },
      { name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: [] },
    ],
    [
      { name: 'Build for E2E', steps: 0, runner_name: 'ecs-qwen-hk4-9' },
      {
        name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
        steps: 0,
        runner_name: 'ecs-qwen-hk4-30',
      },
    ],
  );
  assert.equal(analysis.neverStarted, true);
  assert.equal(analysis.standDown, false);

  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(body.includes('died during runner setup'));
  assert.ok(!body.includes('the runner accepted each job'));
  assert.ok(
    !body.replace(/\n/g, ' ').includes('No commit can have caused this'),
  );
});

test('an existing pool-death fleet body is re-rendered when this run died in setup', () => {
  // The same-class early return keys on the ARM, not only the class: a
  // pool-death body frozen over a setup-death recurrence would keep
  // asserting no commit can have caused a failure a commit can cause. The
  // displaced body is preserved, so the absolute claim survives only inside
  // the collapsed block.
  const poolBody = renderIssueBody({
    analysis: analyzeLogs(
      'E2E Tests',
      [],
      [],
      [
        {
          name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
          steps: 0,
          runner_name: 'ecs-qwen-hk4-30',
        },
      ],
    ),
    occurrence: OCCURRENCE,
  });
  const setup = analyzeLogs(
    'E2E Tests',
    [],
    [{ name: 'Build for E2E', steps: ['Set up job'] }],
    [{ name: 'Build for E2E', steps: 0, runner_name: 'ecs-qwen-hk4-9' }],
  );
  const body = renderIssueBody({
    analysis: setup,
    occurrence: OCCURRENCE,
    existingBody: poolBody,
  });

  const fresh = body.slice(0, body.indexOf('<details>'));
  assert.ok(fresh.includes('failed in step `Set up job`'));
  assert.ok(!fresh.replace(/\n/g, ' ').includes('No commit can have'));
  assert.ok(body.includes('<details>'));
  assert.ok(body.includes(poolBody.trim()));
});

test('an existing fleet body is re-rendered when this run is ordinary, and preserved', () => {
  // The per-commit dedupe key is the sha alone and every watched workflow
  // runs on the same main commit, so an ordinary failure can find the fleet
  // issue a never-started run filed first. The body and the route both
  // follow THIS run's class: echoing the fleet prose while the route labels
  // the issue would dispatch the agent onto a stand-down notice. The
  // displaced fleet report is not destroyed — it names the dead host and any
  // triage notes a human wrote — it moves into a machine-owned collapsed
  // block below the fresh pitch.
  const fleetBody = renderIssueBody({
    analysis: analyzeLogs(
      'E2E Tests',
      [],
      [],
      [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
    ),
    occurrence: OCCURRENCE,
  });
  const analysis = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const body = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: fleetBody,
  });

  // The fresh ordinary pitch leads and names its own failed job…
  assert.ok(body.includes('labeled for autofix'));
  assert.ok(body.includes('`Test (windows-latest, Node 22.x)`'));
  // …and the displaced fleet body survives verbatim in the collapsed block.
  assert.ok(body.includes('<details>'));
  assert.ok(body.includes(fleetBody.trim()));
});

test('an existing ordinary body is re-rendered when this run never started, and preserved', () => {
  // The mirror: an ordinary failure filed and routed first, then a
  // never-started run on the same commit finds it. The fleet failure must
  // lead or it leaves no trace on the routed surface — and the displaced
  // ordinary report, the autofix pitch and the failed job it named, is
  // preserved verbatim rather than destroyed.
  const ordinaryBody = renderIssueBody({
    analysis: analyzeLogs(
      'Qwen Code CI',
      ['npm error code ERESOLVE'],
      [WINDOWS_JOB],
    ),
    occurrence: OCCURRENCE,
  });
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
  );
  const body = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: ordinaryBody,
  });

  assert.ok(body.includes('runner-fleet'));
  assert.ok(body.includes('<details>'));
  assert.ok(body.includes(ordinaryBody.trim()));
});

test('a class flip preserves notes written below the displaced body', () => {
  // The witness for why preservation is not optional: a maintainer's triage
  // notes live below the machine block, and a fleet run landing on an
  // ordinary issue must not delete them (or vice versa).
  const ordinaryBody = renderIssueBody({
    analysis: analyzeLogs(
      'Qwen Code CI',
      ['npm error code ERESOLVE'],
      [WINDOWS_JOB],
    ),
    occurrence: OCCURRENCE,
  });
  const withNotes = `${ordinaryBody}\n## Investigation\n\nPool host was replaced at 03:00Z.\n`;
  const analysis = analyzeLogs(
    'E2E Tests',
    [],
    [],
    [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
  );
  const body = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: withNotes,
  });

  assert.ok(body.includes('runner-fleet'));
  assert.ok(body.includes('Pool host was replaced at 03:00Z.'));
  assert.ok(body.includes('`Test (windows-latest, Node 22.x)`'));
});

test('a class flip survives notes written ABOVE the machine block', () => {
  // The mirror of the notes-below case: the machine block is anchored on its
  // opening marker line, not on an absolute offset, so prose a human
  // prepends must not push the class markers out of the read window — a
  // two-line prepend used to make a fleet body read as ordinary, and the
  // stale stand-down notice was echoed back under the ordinary run's route.
  const fleetBody = renderIssueBody({
    analysis: analyzeLogs(
      'E2E Tests',
      [],
      [],
      [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
    ),
    occurrence: OCCURRENCE,
  });
  const withNote = `Pool host hk4-30 was replaced at 03:00Z.\n\n${fleetBody}`;
  const body = renderIssueBody({
    analysis: analyzeLogs(
      'Qwen Code CI',
      ['npm error code ERESOLVE'],
      [WINDOWS_JOB],
    ),
    occurrence: OCCURRENCE,
    existingBody: withNote,
  });

  // The fresh ordinary pitch leads…
  assert.ok(body.includes('labeled for autofix'));
  assert.ok(body.indexOf('labeled for autofix') < body.indexOf('<details>'));
  // …the prepended note survives…
  assert.ok(body.includes('Pool host hk4-30 was replaced at 03:00Z.'));
  // …and the displaced fleet body is preserved verbatim in the collapsed
  // block.
  assert.ok(body.includes(fleetBody.trim()));
});

test('a body whose machine block is unreadable is re-rendered and preserved', () => {
  // Fail closed: with no marker line at all the class cannot be read, so the
  // body is never echoed under this run's route on a guess — the fresh
  // render leads and the unclassifiable prose is kept in the collapsed
  // block.
  const foreign = 'A human opened this issue by hand.\n\nNo markers here.\n';
  const body = renderIssueBody({
    analysis: analyzeLogs(
      'Qwen Code CI',
      ['npm error code ERESOLVE'],
      [WINDOWS_JOB],
    ),
    occurrence: OCCURRENCE,
    existingBody: foreign,
  });

  assert.ok(body.includes('labeled for autofix'));
  assert.ok(body.includes('<details>'));
  assert.ok(body.includes(foreign.trim()));
});

test('a preserved fleet block does not reclassify the ordinary body carrying it', () => {
  // The class check reads the OPENING marker lines only: after a
  // fleet→ordinary flip the body carries the displaced fleet prose (and its
  // marker) inside the collapsed block, so a whole-body substring check
  // would re-render on every later ordinary run — wiping the notes the merge
  // exists to keep.
  const fleetBody = renderIssueBody({
    analysis: analyzeLogs(
      'E2E Tests',
      [],
      [],
      [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
    ),
    occurrence: OCCURRENCE,
  });
  const ordinary = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const flipped = renderIssueBody({
    analysis: ordinary,
    occurrence: OCCURRENCE,
    existingBody: fleetBody,
  });
  assert.ok(flipped.includes('<details>'));

  const again = renderIssueBody({
    analysis: ordinary,
    occurrence: OCCURRENCE,
    existingBody: flipped,
  });
  assert.equal(again, flipped);
});

test('an existing fleet body is kept verbatim when this run also never started', () => {
  // The same-class fleet quadrant: during a standing outage a second
  // workflow's never-started run on the same commit must not overwrite the
  // first fleet body — that is where a human's triage notes live, and the
  // second workflow's name and dead host are not worth them.
  const fleetBody = renderIssueBody({
    analysis: analyzeLogs(
      'E2E Tests',
      [],
      [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: [] }],
      [
        {
          name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
          steps: 0,
          runner_name: 'ecs-qwen-hk4-30',
        },
      ],
    ),
    occurrence: OCCURRENCE,
  });
  const withNotes = `${fleetBody}\n## Investigation\n\nPool host ecs-qwen-hk4-30 was drained.\n`;
  const second = analyzeLogs(
    'Qwen Code CI',
    [],
    [{ name: 'Build for E2E', steps: [] }],
    [{ name: 'Build for E2E', steps: 0, runner_name: 'ecs-qwen-hk5-12' }],
  );
  assert.equal(second.neverStarted, true);

  const body = renderIssueBody({
    analysis: second,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: withNotes,
  });

  assert.equal(body, withNotes);
});

test('parseFailedJobsMeta carries the runner name when the projection has it', () => {
  assert.deepEqual(
    parseFailedJobsMeta(
      JSON.stringify([
        { name: 'a', steps: 0, runner_name: 'ecs-qwen-hk4-30' },
        { name: 'b', steps: 7, runner_name: '' },
        { name: 'c', steps: 7, runner_name: null },
        { name: 'd', steps: 7 },
      ]),
    ),
    [
      { name: 'a', steps: 0, runner_name: 'ecs-qwen-hk4-30' },
      { name: 'b', steps: 7 },
      { name: 'c', steps: 7 },
      { name: 'd', steps: 7 },
    ],
  );
});

test('parseFailedJobsMeta keeps only well-formed entries', () => {
  assert.deepEqual(
    parseFailedJobsMeta(
      JSON.stringify([
        { name: 'a', steps: 0 },
        { name: 'b', steps: 7 },
        { name: 'c', steps: -1 },
        { name: 'd', steps: 1.5 },
        { name: 'e' },
        { steps: 0 },
        null,
      ]),
    ),
    [
      { name: 'a', steps: 0 },
      { name: 'b', steps: 7 },
    ],
  );
  assert.deepEqual(parseFailedJobsMeta('not json'), []);
  assert.deepEqual(parseFailedJobsMeta('{"not":"an array"}'), []);
});

test('runCli analyze classifies from the meta file the workflow writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-meta-'));
  const metaPath = join(dir, 'failed-jobs-meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify([
      { name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 },
    ]),
  );

  const analysis = JSON.parse(
    captureStdout([
      'analyze',
      '--workflow',
      'E2E Tests',
      '--jobs-meta',
      metaPath,
    ]),
  );
  assert.equal(analysis.neverStarted, true);
});

test('runCli analyze without a readable meta file files normally', () => {
  const analysis = JSON.parse(
    captureStdout([
      'analyze',
      '--workflow',
      'E2E Tests',
      '--jobs-meta',
      join(tmpdir(), 'sig-meta-no-such-file.json'),
    ]),
  );
  assert.equal(analysis.neverStarted, false);
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

test('runCli plan carries a never-started analysis into the fleet body', () => {
  // The route flag and the filed prose leave the analyze job by two
  // different files — never_started is jq'd from analysis.json into
  // GITHUB_OUTPUT, the body is re-rendered by a second `plan` invocation —
  // so pin the class across the plan boundary itself. No --existing: an
  // existing body is a deliberate passthrough on this path.
  const dir = mkdtempSync(join(tmpdir(), 'sig-plan-fleet-'));
  const analysisPath = join(dir, 'analysis.json');
  writeFileSync(
    analysisPath,
    JSON.stringify(
      analyzeLogs(
        'E2E Tests',
        [],
        [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: [] }],
        [{ name: 'E2E Test (Linux) - sandbox:docker - shard 1/1', steps: 0 }],
      ),
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

  assert.ok(planned.body.includes('runner-fleet'));
  assert.ok(!planned.body.includes('labeled for autofix'));
  assert.deepEqual(planned.searchMarkers, [
    `${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha}`,
  ]);
});
