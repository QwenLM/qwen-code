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
  renderIssueBody,
  renderIssueTitle,
  runCli,
  shortenForTitle,
  testKey,
  workflowBridgeMarker,
  WORKFLOW_MARKER_PREFIX,
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
  assert.equal(analysis.searchMarkers.length, MAX_SEARCH_MARKERS + 1);
  assert.deepEqual(
    analysis.searchMarkers.slice(0, MAX_SEARCH_MARKERS),
    analysis.markers.slice(0, MAX_SEARCH_MARKERS),
  );
  assert.equal(
    analysis.searchMarkers.at(-1),
    workflowBridgeMarker('E2E Tests'),
  );
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

test('the per-commit path leaves an already-recorded run untouched', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  // First plan against the bare stub: the workflow bridge can match it even
  // though its commit differs, so the run gets recorded on the stub body.
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const recorded = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: stub,
  });
  assert.ok(recorded.includes('[run 301]'));
  // Re-planning the same run against the recorded body is a no-op: the
  // occurrence line is deduped and both dedupe markers are already present.
  const replanned = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: recorded,
  });
  assert.equal(replanned, recorded);
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
  // Notes written below the occurrence block stay below it; otherwise a quoted
  // marker in the note could become machine state on the next merge.
  assert.ok(
    merged.indexOf('## Investigation') > merged.indexOf(OCCURRENCE_MARKER),
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

const MACOS_JOB = {
  name: 'Test (macos-latest, Node 20.x)',
  steps: ['Install dependencies'],
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

  assert.ok(body.includes('<!-- qwen-main-ci-failure-header -->'));
  assert.ok(body.includes('<!-- /qwen-main-ci-failure-header -->'));
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
  // The workflow-scoped bridge marker rides as an extra search marker so a
  // per-commit stub stays reachable without dropping the fifth test marker.
  assert.deepEqual(planned.searchMarkers, [
    `${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha}`,
    workflowBridgeMarker('Qwen Code CI'),
  ]);
  assert.ok(
    planned.body.includes(`<!-- ${workflowBridgeMarker('Qwen Code CI')} -->`),
  );
});

test('plan writes exactly the searched test markers and workflow bridge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-plan-markers-'));
  const analysisPath = join(dir, 'analysis.json');
  const logs = Array.from(
    { length: MAX_SEARCH_MARKERS + 2 },
    (_unused, index) => ` FAIL  cli/case-${index}.test.ts > case ${index}`,
  );
  const analysis = analyzeLogs('Qwen Code CI', logs);
  writeFileSync(analysisPath, JSON.stringify(analysis));

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

  assert.deepEqual(planned.searchMarkers, [
    ...analysis.markers.slice(0, MAX_SEARCH_MARKERS),
    workflowBridgeMarker('Qwen Code CI'),
  ]);
  for (const marker of analysis.markers.slice(0, MAX_SEARCH_MARKERS)) {
    assert.ok(planned.body.includes(`<!-- ${marker} -->`));
  }
});

// The workflow-scoped bridge marker is the last search marker in both arms
// (per-test and per-commit): restoring the body download re-activated a dedupe
// class disjoint from the per-commit stubs filed since gh 2.97, so a search
// must be able to reach the most recent failure issue of the same workflow
// regardless of which marker class it was filed under (#12133).
test('plan appends a workflow-scoped bridge marker to both search arms', () => {
  const BRIDGE = workflowBridgeMarker('E2E Tests');

  // Per-test arm: the bridge follows the test markers (the VITEST_LOG fixture
  // has one failing test, so one test marker remains ahead of it).
  const analysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  assert.equal(analysis.searchMarkers.length, 2);
  assert.equal(analysis.searchMarkers[0], analysis.markers[0]);
  assert.equal(analysis.searchMarkers[1], BRIDGE);
  assert.ok(
    analysis.searchMarkers
      .slice(0, 1)
      .every((marker) => marker.startsWith('qwen-main-ci-failure-test:')),
  );
  // R1-6: every marker must be a single space-free token — the consumer
  // interpolates it unquoted into `--search "${marker} in:body"`, and every
  // watched workflow name contains spaces.
  assert.ok(analysis.searchMarkers.every((marker) => !/\s/.test(marker)));
  // R1-1: searched, but never written — a per-test body must not become
  // reachable by the bridge search, or every later distinct failure of the
  // workflow would be absorbed into it instead of filing its own issue.
  const body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  assert.ok(!body.includes(`<!-- ${BRIDGE} -->`));

  // Per-commit arm: the bridge rides alongside the legacy per-commit marker.
  const dir = mkdtempSync(join(tmpdir(), 'sig-bridge-'));
  const analysisPath = join(dir, 'analysis.json');
  writeFileSync(
    analysisPath,
    JSON.stringify(
      analyzeLogs('E2E Tests', ['npm error code ERESOLVE'], [WINDOWS_JOB]),
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
  const workflowBridge = workflowBridgeMarker('E2E Tests');
  assert.deepEqual(planned.searchMarkers, [
    `qwen-main-ci-failure:${OCCURRENCE.sha}`,
    workflowBridge,
  ]);
  assert.ok(planned.searchMarkers.every((marker) => !/\s/.test(marker)));
  assert.ok(planned.body.includes(`<!-- ${workflowBridge} -->`));
});

// R1-1: the bridge carries workflow identity only, so a body filed for one
// failing test must never carry the last search marker of a disjoint failure
// of the same workflow — otherwise that failure would be absorbed into this
// issue instead of filing its own.
test('a body for one failing test never carries a disjoint failure’s last search marker', () => {
  const analysisA = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const bodyA = renderIssueBody({
    analysis: analysisA,
    occurrence: OCCURRENCE,
  });
  const disjointLog = VITEST_LOG.replaceAll(
    'Tool Control Parameters (E2E)',
    'Sandbox Control (E2E)',
  );
  const analysisB = analyzeLogs('E2E Tests', [disjointLog]);
  assert.notEqual(analysisB.markers[0], analysisA.markers[0]);
  const lastSearchMarker = analysisB.searchMarkers.at(-1);
  assert.equal(lastSearchMarker, workflowBridgeMarker('E2E Tests'));
  assert.ok(!bodyA.includes(`<!-- ${lastSearchMarker} -->`));
});

// A workflow-scoped bridge marker can land a per-commit run on an issue
// filed under a DIFFERENT commit (the per-commit stub of the same workflow).
// The new run must then be recorded on that issue — run link, failed job and
// the new per-commit marker — instead of the body being returned verbatim
// while the log claims it was recorded (#12133 Critical).
test('runCli plan records a bridge-matched run on the per-commit stub body', () => {
  const earlier = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const existingBody = renderIssueBody({
    analysis: earlier,
    occurrence: OCCURRENCE,
  });
  // R1-2: the merged run must carry a different failed job from the stub's,
  // so the header refresh is observable at all.
  const latest = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [MACOS_JOB],
  );

  const dir = mkdtempSync(join(tmpdir(), 'sig-bridge-merge-'));
  const analysisPath = join(dir, 'analysis.json');
  const existingPath = join(dir, 'existing.md');
  writeFileSync(analysisPath, JSON.stringify(latest));
  writeFileSync(existingPath, existingBody);

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

  // The new run must be visible on the issue, and both dedupe markers for
  // future searches must be present.
  assert.ok(planned.body.includes('[run 302]'));
  assert.ok(planned.body.includes('b0ce7dc51999'));
  assert.ok(
    planned.body.includes('<!-- qwen-main-ci-failure:b0ce7dc51999 -->'),
  );
  assert.ok(
    planned.body.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`),
  );
  // The original stub's own marker survives the merge.
  assert.ok(
    planned.body.includes(`<!-- qwen-main-ci-failure:${OCCURRENCE.sha} -->`),
  );
  // R1-2: the single-valued header fields must describe the newest run —
  // its lane and step rendered into the head, the stale ones gone.
  assert.ok(planned.body.includes('Test (macos-latest, Node 20.x)'));
  assert.ok(planned.body.includes('Install dependencies'));
  assert.ok(planned.body.includes('- Run ID: 302'));
  assert.ok(planned.body.includes('- Commit: b0ce7dc51999'));
  assert.ok(!planned.body.includes('- Run ID: 301'));
  assert.ok(!planned.body.includes('windows-latest'));
  // R1-2: the stub never emitted a bullet for its own occurrence, so the
  // merge must promote its recorded run before the header is re-rendered.
  assert.ok(planned.body.includes('[run 301]'));
});

// R1-3: the legacy per-commit marker is workflow-agnostic, so one push sha
// can fail two watched workflows and both reporters land on the same issue.
// The merge records the occurrence but must never add a second bridge: a
// body carrying two workflows' bridges becomes a permanent cross-workflow
// sink that nothing under .github/ ever closes.
test('a foreign-workflow merge records the run but never adds its bridge', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  });
  const foreign = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const merged = renderIssueBody({
    analysis: foreign,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: stub,
  });
  const bridgeComments =
    merged.match(new RegExp(`<!-- ${WORKFLOW_MARKER_PREFIX}\\S+ -->`, 'g')) ??
    [];
  assert.equal(bridgeComments.length, 1);
  assert.equal(
    bridgeComments[0],
    `<!-- ${workflowBridgeMarker('E2E Tests')} -->`,
  );
  assert.ok(merged.includes('- Workflow: E2E Tests'));
  assert.ok(!merged.includes('- Workflow: Qwen Code CI'));
  assert.ok(merged.includes('[run 302]'));
  // the same merge again stays single-valued
  const remergd = renderIssueBody({
    analysis: foreign,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: merged,
  });
  assert.equal(
    (
      remergd.match(
        new RegExp(`<!-- ${WORKFLOW_MARKER_PREFIX}\\S+ -->`, 'g'),
      ) ?? []
    ).length,
    1,
  );
});

test('a bridge-less stub only adopts a bridge for its recorded workflow', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const bridge = `<!-- ${workflowBridgeMarker('E2E Tests')} -->`;
  const bridgeLessStub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  }).replace(`${bridge}\n`, '');
  const foreign = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const merged = renderIssueBody({
    analysis: foreign,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: bridgeLessStub,
  });
  assert.ok(
    !merged.includes(`<!-- ${workflowBridgeMarker('Qwen Code CI')} -->`),
  );
  assert.ok(!merged.includes(bridge));
  assert.ok(merged.includes('[run 302]'));

  const secondForeign = renderIssueBody({
    analysis: foreign,
    occurrence: { ...OCCURRENCE, runId: '303' },
    existingBody: merged,
  });
  assert.ok(
    !secondForeign.includes(`<!-- ${workflowBridgeMarker('Qwen Code CI')} -->`),
  );
  assert.ok(secondForeign.includes('- Workflow: E2E Tests'));
});

test('a foreign per-commit merge records its failed lane without claiming the bridge', () => {
  const owner = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const bridgeLessStub = renderIssueBody({
    analysis: owner,
    occurrence: OCCURRENCE,
  }).replace(`<!-- ${workflowBridgeMarker('E2E Tests')} -->\n`, '');
  const foreign = analyzeLogs(
    'Qwen Code CI',
    ['npm error code ERESOLVE'],
    [MACOS_JOB],
  );
  const merged = renderIssueBody({
    analysis: foreign,
    occurrence: { ...OCCURRENCE, runId: '302' },
    existingBody: bridgeLessStub,
  });

  assert.ok(merged.includes('- Workflow: E2E Tests'));
  assert.ok(merged.includes('macos-latest'));
  assert.ok(
    merged.includes(
      '## Previous failed jobs (Qwen Code CI, last reported for run 302)',
    ),
  );
  assert.ok(
    !merged.includes(`<!-- ${workflowBridgeMarker('Qwen Code CI')} -->`),
  );
});

test('a legacy stub is parsed and migrated without losing its bridge', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const legacy = [
    `<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`,
    'A main-branch CI run failed on `main` before any test result was',
    'reported, so this issue is tracked per commit.',
    '',
    '- Workflow: E2E Tests',
    '- Run: https://github.com/QwenLM/qwen-code/actions/runs/301',
    '- Run ID: 301',
    '- Commit: af7a9ec12722ab34',
    '',
    'This issue is labeled for autofix so the existing agent can create a repair PR.',
    '',
    '## Recurrences',
    '',
    OCCURRENCE_MARKER,
  ].join('\n');
  const merged = renderIssueBody({
    analysis,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: legacy,
  });

  assert.ok(merged.includes('<!-- qwen-main-ci-failure-header -->'));
  assert.ok(merged.includes('<!-- /qwen-main-ci-failure-header -->'));
  assert.ok(merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  assert.ok(
    merged.includes(
      '- Run: https://github.com/QwenLM/qwen-code/actions/runs/302',
    ),
  );
  assert.ok(!merged.includes('- Run ID: 301'));
  assert.ok(merged.includes('before any test result was'));
  assert.equal(
    (
      merged.match(
        /This issue is labeled for autofix so the existing agent can create a repair PR\./g,
      ) ?? []
    ).length,
    1,
  );
  assert.ok(merged.includes('[run 302]'));
});

test('a delimited per-commit header stays replaceable across repeated merges', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  let merged = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  merged = renderIssueBody({
    analysis,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: merged,
  });
  merged = renderIssueBody({
    analysis,
    occurrence: { ...OCCURRENCE, runId: '303' },
    existingBody: merged,
  });

  assert.equal(
    (merged.match(/<!-- qwen-main-ci-failure-header -->/g) ?? []).length,
    1,
  );
  assert.equal(
    (merged.match(/<!-- \/qwen-main-ci-failure-header -->/g) ?? []).length,
    1,
  );
  assert.ok(merged.includes('- Run ID: 303'));
  assert.ok(!merged.includes('- Run ID: 302'));
});

test('a note between legacy identity bullets survives without refreshing the header', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [MACOS_JOB],
  );
  const existing = [
    `<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`,
    'A main-branch CI run failed on `main` before any test result was',
    'reported, so this issue is tracked per commit.',
    '',
    '- Workflow: E2E Tests',
    '- Run: https://github.com/QwenLM/qwen-code/actions/runs/301',
    '- Maintainer note: keep this identity context.',
    '- Run ID: 301',
    '- Commit: af7a9ec12722ab34',
    '',
    'This issue is labeled for autofix so the existing agent can create a repair PR.',
    '',
    '## Recurrences',
    '',
    OCCURRENCE_MARKER,
  ].join('\n');
  const merged = renderIssueBody({
    analysis,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: existing,
  });

  assert.ok(merged.includes('- Maintainer note: keep this identity context.'));
  assert.ok(merged.includes('macos-latest'));
  assert.ok(
    merged.includes(
      '## Previous failed jobs (E2E Tests, last reported for run 302)',
    ),
  );
  assert.ok(merged.includes('- Run ID: 301'));
  assert.ok(merged.includes('- Commit: af7a9ec12722ab34'));
  assert.ok(!merged.includes('- Run ID: 302'));
  assert.ok(
    merged.includes(
      '- Run: https://github.com/QwenLM/qwen-code/actions/runs/301',
    ),
  );
  // An identity block containing a human bullet is not well-formed machine
  // state, so it records the run without promoting a bridge from it.
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  assert.ok(merged.includes('macos-latest'));
  assert.ok(merged.includes('[run 301]'));
  assert.ok(merged.includes('[run 302]'));
});

test('a per-commit merge preserves prior failed jobs when the latest run has none', () => {
  const previous = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const latest = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  let merged = renderIssueBody({
    analysis: latest,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: renderIssueBody({
      analysis: previous,
      occurrence: OCCURRENCE,
    }),
  });
  merged = renderIssueBody({
    analysis: latest,
    occurrence: {
      ...OCCURRENCE,
      runId: '303',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/303',
    },
    existingBody: merged,
  });
  assert.match(merged, /^- Failed jobs \(last reported for run 301\):$/m);
  assert.ok(merged.includes('windows-latest'));
  assert.ok(merged.includes('- Run ID: 303'));
  assert.ok(!merged.match(/^- Failed jobs:$/m));
});

test('a malformed per-commit head keeps failed-job prose stable across merges', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  let merged = [
    `<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`,
    'Human context before the failed-job history.',
    '',
    '## Previous failed jobs (last reported for run 301)',
    '',
    '  - old job',
    '',
    'Keep this note after the machine-owned section.',
    '',
    '## Recurrences',
    '',
    OCCURRENCE_MARKER,
  ].join('\n');
  for (const runId of ['302', '303', '304']) {
    merged = renderIssueBody({
      analysis,
      occurrence: {
        ...OCCURRENCE,
        runId,
        runUrl: `https://github.com/QwenLM/qwen-code/actions/runs/${runId}`,
      },
      existingBody: merged,
    });
    assert.ok(
      merged.includes('Keep this note after the machine-owned section.'),
    );
    assert.ok(merged.includes('`Test (windows-latest, Node 22.x)`'));
  }
  assert.equal((merged.match(/## Previous failed jobs/g) ?? []).length, 1);
});

test('machine header promotion ignores human identity-looking bullets above it', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const existing = [
    'Maintainer note: keep this context while the issue is open.',
    '- Run: https://example.invalid/runs/human-note',
    '- Run ID: 999',
    '- Commit: human-note-sha',
    '',
    stub,
  ].join('\n');
  const merged = renderIssueBody({
    analysis,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: existing,
  });
  assert.ok(merged.includes('Maintainer note: keep this context'));
  assert.ok(merged.includes('- Run: https://example.invalid/runs/human-note'));
  assert.ok(merged.includes('- Run ID: 999'));
  assert.ok(merged.includes('- Commit: human-note-sha'));
  assert.ok(merged.includes('[run 301]'));
  assert.ok(!merged.includes('[run 999]'));
  assert.ok(merged.includes('[run 302]'));
});

// R1-8: the bridge funnels every unidentifiable failure of a workflow onto
// one open issue, so the per-commit sha markers must stay capped — keeping
// the newest, never the bridge — or the body crosses GitHub's 65,536-char
// limit and `gh issue edit --body-file` stops recording recurrences at all.
test('per-commit sha markers stay capped at MAX_OCCURRENCES, newest kept', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  for (let run = 302; run <= 331; run += 1) {
    body = renderIssueBody({
      analysis,
      existingBody: body,
      occurrence: {
        ...OCCURRENCE,
        sha: `b0ce7dc51999${String(run).padStart(4, '0')}`,
        runId: String(run),
        runUrl: `https://github.com/QwenLM/qwen-code/actions/runs/${run}`,
      },
    });
  }
  const shaMarkerLines = body
    .split('\n')
    .filter((line) =>
      /^<!-- qwen-main-ci-failure:[0-9a-f]+ -->$/.test(line.trim()),
    );
  assert.equal(shaMarkerLines.length, MAX_OCCURRENCES);
  assert.ok(body.includes('<!-- qwen-main-ci-failure:b0ce7dc519990331 -->'));
  assert.ok(!body.includes('<!-- qwen-main-ci-failure:af7a9ec12722ab34 -->'));
  assert.ok(body.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
});

// R1-9: the shared recurrence tail must keep the per-test arm's guard — run
// 301 and run 3010 are distinct runs even though one id is the other's URL
// prefix — on the per-commit arm too.
test('a per-commit merge keeps runs whose ids are prefixes of each other', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  let body = renderIssueBody({
    analysis,
    existingBody: stub,
    occurrence: {
      ...OCCURRENCE,
      runId: '3010',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/3010',
    },
  });
  body = renderIssueBody({
    analysis,
    existingBody: body,
    occurrence: OCCURRENCE,
  });
  assert.ok(body.includes('[run 301]'));
  assert.ok(body.includes('[run 3010]'));
});

// R1-9: the per-commit arm's recurrence list must be capped with exactly one
// trim note, like the per-test arm's.
test('a per-commit merge caps the recurrence list and emits one trim note', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  let body = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    maxOccurrences: 2,
  });
  for (const runId of ['302', '303']) {
    body = renderIssueBody({
      analysis,
      existingBody: body,
      occurrence: { ...OCCURRENCE, runId },
      maxOccurrences: 2,
    });
  }
  assert.equal((body.match(/_Older recurrences trimmed\._/g) ?? []).length, 1);
  assert.ok(body.includes('[run 303]'));
  assert.ok(body.includes('[run 302]'));
});

// R1-10: a per-test run reaching a per-commit stub must rewrite the adopted
// head — the stub's "no test result was reported" prose and identity block
// contradict an issue that now tracks an identified test.
test('a per-test run adopting a per-commit stub rewrites the stub head', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  }).replace(
    '<!-- /qwen-main-ci-failure-header -->',
    '- Note: preserve the maintainer context.\n<!-- /qwen-main-ci-failure-header -->',
  );
  const testRun = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const merged = renderIssueBody({
    analysis: testRun,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: stub,
  });
  assert.ok(!merged.includes('before any test result was'));
  assert.ok(merged.includes('## Failing tests'));
  assert.ok(merged.includes(`- \`${testRun.tests[0].id}\``));
  assert.ok(
    merged.includes(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`),
  );
  assert.ok(merged.includes('windows-latest'));
  assert.ok(merged.includes('- Note: preserve the maintainer context.'));
  assert.ok(merged.includes('[run 301]'));
  assert.ok(merged.includes('[run 302]'));
  // R1-1: the adopted issue is a per-test issue now — it must not stay
  // reachable by the bridge search.
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
});

test('marker-shaped prose cannot block per-commit stub adoption', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  });
  const quotedMarker = `<!-- ${TEST_MARKER_PREFIX}quoted-human-note -->`;
  const poisoned = stub.replace(
    'A main-branch CI run failed',
    `A maintainer note quotes ${quotedMarker}.\n\nA main-branch CI run failed`,
  );
  const testRun = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const merged = renderIssueBody({
    analysis: testRun,
    occurrence: { ...OCCURRENCE, runId: '302' },
    existingBody: poisoned,
  });

  assert.ok(merged.includes('## Failing tests'));
  assert.ok(merged.includes(quotedMarker));
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  assert.ok(
    merged.includes(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`),
  );
});

test('whole-line prose markers do not change either arm of stub adoption', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const bridge = `<!-- ${workflowBridgeMarker('E2E Tests')} -->`;
  const quote = `<!-- ${TEST_MARKER_PREFIX}quoted-head-line -->`;
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE })
    .replace(bridge, '')
    .concat(`\n## Investigation\n${quote}\n`);
  for (const next of [analysis, analyzeLogs('E2E Tests', [VITEST_LOG])]) {
    const body = renderIssueBody({
      analysis: next,
      occurrence: { ...OCCURRENCE, runId: '302' },
      existingBody: stub,
    });
    assert.ok(body.includes(`## Investigation\n${quote}`));
    assert.ok(body.includes('[run 301]'));
    assert.equal(body.includes(bridge), next.tests.length === 0);
    assert.equal(body.includes('## Failing tests'), next.tests.length > 0);
    assert.equal(
      body.includes('before any test result was'),
      next.tests.length === 0,
    );
  }
});

test('unique noncanonical headers migrate only their human remainder', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE }).replace(
    '- Run ID: 301',
    '\n- Maintainer note: preserve me\n- Run ID: 301',
  );
  body = body.replace('- Run:', '  - also reproduces locally\n- Run:');
  for (const runId of ['302', '303', '304']) {
    body = renderIssueBody({
      analysis: analyzeLogs('E2E Tests', [VITEST_LOG]),
      occurrence: { ...OCCURRENCE, runId },
      existingBody: body,
    });
    assert.ok(body.includes('## Failing tests'));
    assert.ok(!/^- (?:Workflow|Run|Run ID|Commit|Failed jobs):/m.test(body));
    assert.equal(body.split('Test (windows-latest, Node 22.x)').length - 1, 1);
    assert.equal(body.split('- Maintainer note: preserve me').length - 1, 1);
    assert.equal(body.split('  - also reproduces locally').length - 1, 1);
  }
});

test('foreign merges and adoption keep one failed-job section and human notes', () => {
  for (const annotated of [false, true]) {
    const stubAnalysis = analyzeLogs(
      'E2E Tests',
      ['npm error code ERESOLVE'],
      [WINDOWS_JOB],
    );
    let body = renderIssueBody({
      analysis: stubAnalysis,
      occurrence: OCCURRENCE,
    });
    if (annotated) body = body.replace('- Run ID: 301', '\n- Run ID: 301');
    body = renderIssueBody({
      analysis: analyzeLogs(
        'Qwen Code CI',
        ['npm error code ERESOLVE'],
        [MACOS_JOB],
      ),
      occurrence: { ...OCCURRENCE, runId: '302' },
      existingBody: body,
    });
    body = body.replace(
      '## Recurrences',
      '  - also reproduces locally\n\n## Recurrences',
    );
    for (const [runId, analysis] of [
      ['303', analyzeLogs('E2E Tests', [VITEST_LOG])],
      [
        '304',
        analyzeLogs('SDK Python', ['npm error code ERESOLVE'], [WINDOWS_JOB]),
      ],
      ['305', analyzeLogs('E2E Tests', [VITEST_LOG])],
    ]) {
      body = renderIssueBody({
        analysis,
        occurrence: { ...OCCURRENCE, runId },
        existingBody: body,
      });
      assert.equal((body.match(/## Previous failed jobs/g) ?? []).length, 1);
      assert.equal(
        body.split('Test (windows-latest, Node 22.x)').length - 1,
        1,
      );
      assert.equal(body.split('  - also reproduces locally').length - 1, 1);
      assert.ok(!body.includes('Qwen Code CI, last reported for run 302'));
    }
  }
});

test('fenced identity quotes remain prose across repeated per-commit merges', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const quote = `<!-- ${TEST_MARKER_PREFIX}quoted-fence -->`;
  const note = `## Investigation\n\`\`\`text\n${quote}\n\`\`\``;
  let body =
    renderIssueBody({ analysis, occurrence: OCCURRENCE }) + '\n' + note;
  for (const runId of ['302', '303']) {
    body = renderIssueBody({
      analysis,
      occurrence: { ...OCCURRENCE, runId },
      existingBody: body,
    });
    assert.ok(!body.split('\n\n')[0].includes(TEST_MARKER_PREFIX));
    assert.ok(body.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
    assert.ok(body.includes(note));
  }
});

test('adoption preserves unharvested SHA lines without duplicating harvested keys', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const first = `<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`;
  const second = `<!-- ${LEGACY_MARKER_PREFIX}second-sha -->`;
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  for (const existingBody of [
    '<!-- autofix:paused -->\n\n' + stub.replace(first, `${first}\n${second}`),
    stub.replace(first, `${first}\nHuman separator\n${second}`),
  ]) {
    const body = renderIssueBody({
      analysis: analyzeLogs('E2E Tests', [VITEST_LOG]),
      occurrence: { ...OCCURRENCE, runId: '302' },
      existingBody,
    });
    assert.ok(body.includes('## Failing tests'));
    assert.ok(!body.includes('before any test result was'));
    for (const marker of [first, second])
      assert.equal(body.split(marker).length - 1, 1);
    assert.ok(!body.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  }
});

test('marker-shaped prose below recurrences cannot block per-commit stub adoption', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  });
  const quotedMarker = `<!-- ${TEST_MARKER_PREFIX}quoted-tail -->`;
  const withTail = `${stub}\n\nA maintainer note quotes ${quotedMarker}.`;
  const testRun = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const merged = renderIssueBody({
    analysis: testRun,
    occurrence: { ...OCCURRENCE, runId: '302' },
    existingBody: withTail,
  });

  assert.ok(merged.includes('## Failing tests'));
  assert.ok(merged.includes(quotedMarker));
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  assert.ok(
    merged.includes(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`),
  );
});

test('a malformed stub is retained below the adopted per-test head', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: OCCURRENCE,
  })
    .replace(
      '- Run: https://github.com/QwenLM/qwen-code/actions/runs/301',
      '- Human note before identity',
    )
    .replace('- Run ID: 301', '- Run ID: 301\n- Commit: human-note-sha');
  const testRun = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const merged = renderIssueBody({
    analysis: testRun,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: stub,
  });

  assert.ok(merged.includes('## Failing tests'));
  assert.ok(merged.includes('- Human note before identity'));
  assert.ok(merged.includes('- Workflow: E2E Tests'));
  assert.ok(merged.includes('- Run ID: 301'));
  assert.ok(merged.includes('- Commit: human-note-sha'));
  assert.ok(!merged.includes('before any test result was'));
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  assert.equal(
    (
      merged.match(
        /This issue is labeled for autofix so the existing agent can create a repair PR\./g,
      ) ?? []
    ).length,
    1,
  );
});

// R1-10 mirror: a per-commit run landing on a per-test body keeps the
// per-test head — the identified test's section survives.
test('a per-test body keeps its shape under a per-commit merge', () => {
  const testAnalysis = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const perTestBody = renderIssueBody({
    analysis: testAnalysis,
    occurrence: OCCURRENCE,
  });
  const commitRun = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const merged = renderIssueBody({
    analysis: commitRun,
    occurrence: {
      ...OCCURRENCE,
      runId: '302',
      runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
    },
    existingBody: perTestBody,
  });
  assert.ok(merged.includes('## Failing tests'));
  assert.ok(merged.includes(`- \`${testAnalysis.tests[0].id}\``));
  assert.ok(merged.includes('[run 302]'));
  assert.ok(merged.includes('## Previous failed jobs'));
  assert.ok(merged.includes('last reported for run 302'));
  assert.ok(merged.includes('windows-latest'));
  // R1-1: the per-test body must not gain the bridge from this merge.
  assert.ok(!merged.includes(`<!-- ${workflowBridgeMarker('E2E Tests')} -->`));
  const third = renderIssueBody({
    analysis: testAnalysis,
    occurrence: OCCURRENCE,
    existingBody: merged,
  });
  assert.equal((third.match(/## Failing tests/g) ?? []).length, 1);
  assert.equal((third.match(/qwen-main-ci-failure-sig:/g) ?? []).length, 1);
});

test('annotated stubs retain their bridge and promote unambiguous identity', () => {
  const stubAnalysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const bridge = `<!-- ${workflowBridgeMarker('E2E Tests')} -->`;
  const stub =
    'Triage: p0\n' +
    renderIssueBody({ analysis: stubAnalysis, occurrence: OCCURRENCE }).replace(
      '- Run ID: 301',
      '- Maintainer note: preserve me\n- Run ID: 301',
    );
  const next = {
    ...OCCURRENCE,
    runId: '302',
    runUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/302',
  };
  const recorded = renderIssueBody({
    analysis: stubAnalysis,
    occurrence: next,
    existingBody: stub,
  });
  assert.ok(recorded.includes(bridge));
  const adopted = renderIssueBody({
    analysis: analyzeLogs('E2E Tests', [VITEST_LOG]),
    occurrence: next,
    existingBody: stub,
  });
  assert.ok(adopted.includes('[run 301]'));
  assert.ok(adopted.includes('Triage: p0'));
  assert.ok(adopted.includes('- Maintainer note: preserve me'));
  assert.ok(!adopted.includes(bridge));
  assert.ok(!adopted.includes('before any test result was'));
  assert.ok(
    adopted.indexOf(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`) <
      adopted.indexOf('## Failing tests'),
  );
});

test('ambiguous identity never fabricates a recurrence', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE }).replace(
    '- Run ID: 301',
    '- Run ID: 999\n- Run ID: 301',
  );
  for (const nextAnalysis of [
    analysis,
    analyzeLogs('E2E Tests', [VITEST_LOG]),
  ]) {
    const merged = renderIssueBody({
      analysis: nextAnalysis,
      occurrence: { ...OCCURRENCE, runId: '302' },
      existingBody: stub,
    });
    assert.ok(!merged.includes('[run 999]'));
    assert.ok(!merged.includes('[run 301]'));
    assert.ok(merged.includes('[run 302]'));
  }
});

test('backtick notes survive recurrence trimming and failed-job replacement', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  body = renderIssueBody({
    analysis,
    occurrence: { ...OCCURRENCE, runId: '302' },
    existingBody: body,
  });
  const notes = [
    '- `npm ci` also fails locally',
    '- `packages/core` is affected',
  ];
  body += '\n' + notes.join('\n');
  body = body.replace(
    '- Run ID: 302',
    '- Maintainer note: context\n- Run ID: 302',
  );
  body = body.replace(
    '## Recurrences',
    '## Previous failed jobs\n\n  - also reproduces locally\n\n## Recurrences',
  );
  for (let id = 303; id < 320; id++) {
    body = renderIssueBody({
      analysis,
      occurrence: { ...OCCURRENCE, runId: String(id) },
      existingBody: body,
    });
    for (const note of notes) assert.ok(body.includes(note));
    assert.ok(body.includes('  - also reproduces locally'));
  }
});

test('tail bridges cannot leak into per-test bodies or multiply on stubs', () => {
  const analysis = analyzeLogs(
    'E2E Tests',
    ['npm error code ERESOLVE'],
    [WINDOWS_JOB],
  );
  let body = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  body = renderIssueBody({
    analysis,
    occurrence: { ...OCCURRENCE, runId: '302' },
    existingBody: body,
  });
  const bridge = `<!-- ${workflowBridgeMarker('E2E Tests')} -->`;
  body += '\nHuman tail\n' + bridge;
  for (const nextAnalysis of [
    analysis,
    analyzeLogs('E2E Tests', [VITEST_LOG]),
  ]) {
    const merged = renderIssueBody({
      analysis: nextAnalysis,
      occurrence: { ...OCCURRENCE, runId: '303' },
      existingBody: body,
    });
    assert.equal(
      merged.split(bridge).length - 1,
      nextAnalysis.tests.length ? 0 : 1,
    );
    assert.ok(merged.includes('Human tail'));
  }
});

test('alternating merge modes keep one normalized head and bounded history', () => {
  const perTest = analyzeLogs('E2E Tests', [VITEST_LOG]);
  const perCommit = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  let body = renderIssueBody({ analysis: perTest, occurrence: OCCURRENCE });
  for (let id = 302; id < 342; id++) {
    body = renderIssueBody({
      analysis: id % 2 ? perTest : perCommit,
      occurrence: { ...OCCURRENCE, runId: String(id), sha: `sha${id}` },
      existingBody: body,
    });
    assert.equal((body.match(/## Failing tests/g) ?? []).length, 1);
    assert.equal((body.match(/qwen-main-ci-failure-sig:/g) ?? []).length, 1);
    assert.ok(!body.includes(WORKFLOW_MARKER_PREFIX));
    assert.ok(body.length < 5000);
  }
});

test('quoted SHA lines outside the first marker block are not harvested or capped', () => {
  const analysis = analyzeLogs('E2E Tests', ['npm error code ERESOLVE']);
  const stub = renderIssueBody({ analysis, occurrence: OCCURRENCE });
  const note =
    '## Investigation\n' +
    Array.from(
      { length: 12 },
      (_, id) => `<!-- ${LEGACY_MARKER_PREFIX}quoted${id} -->`,
    ).join('\n');
  const merged = renderIssueBody({
    analysis,
    occurrence: OCCURRENCE,
    existingBody: stub + '\n' + note,
  });
  assert.ok(merged.includes(note));
  assert.ok(
    merged.startsWith(`<!-- ${LEGACY_MARKER_PREFIX}${OCCURRENCE.sha} -->`),
  );
  assert.ok(!merged.split('\n\n')[0].includes('quoted'));
});
