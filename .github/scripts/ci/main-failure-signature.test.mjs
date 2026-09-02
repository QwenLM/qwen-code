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
  const markerCount = (
    body.match(new RegExp(TEST_MARKER_PREFIX, 'g')) ?? []
  ).length;
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

  let output = '';
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    runCli([
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
    ]);
  } finally {
    process.stdout.write = original;
  }

  const planned = JSON.parse(output);
  // The existing body's run-301 line must survive: a broken --existing path
  // would produce a create-path body with only the new run.
  assert.ok(planned.body.includes('[run 301]'));
  assert.ok(planned.body.includes('[run 302]'));
  assert.equal(planned.title, analysis.title);
});
