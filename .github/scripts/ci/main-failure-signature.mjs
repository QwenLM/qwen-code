#!/usr/bin/env node
/**
 * Turn the logs of a failed main-branch CI run into a stable failure signature.
 *
 * `main-ci-failure-issue.yml` used to dedupe on the commit SHA, so a standing
 * red opened one fresh issue per merged commit (six duplicates for a single
 * broken E2E test on 2026-07-26). Deduping on *what broke* collapses those into
 * one issue that records each recurrence instead.
 *
 * Every failing test gets its own `qwen-main-ci-failure-test:<key>` marker in
 * the issue body, so an issue is matched when the current failure set overlaps
 * the recorded one at all — `[A]` then `[A, B]` updates the issue that already
 * tracks A rather than opening a second one.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TEST_MARKER_PREFIX = 'qwen-main-ci-failure-test:';
export const SIGNATURE_MARKER_PREFIX = 'qwen-main-ci-failure-sig:';
export const OCCURRENCE_MARKER = '<!-- qwen-main-ci-failure-occurrences -->';
export const MAX_OCCURRENCES = 10;

/** Markers to search issues by. GitHub search is a cost per query, and a run
 * with dozens of failures is an infra break, not a per-test regression. */
export const MAX_SEARCH_MARKERS = 5;

// Vitest and pytest colourise their output and Actions stores the escapes
// verbatim, so failure lines arrive wrapped in SGR sequences.
// eslint-disable-next-line no-control-regex -- matches the ESC that opens one
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;
// Actions prefixes every log line with an RFC3339 timestamp.
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
const VITEST_FAIL_PATTERN = /^FAIL\s+(.+)$/;
const PYTEST_FAIL_PATTERN = /^FAILED\s+(\S+)/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?\b|\.py\b/;

function cleanLine(line) {
  return line
    .replace(ANSI_PATTERN, '')
    .replace(LOG_TIMESTAMP_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect the failing test identifiers a runner reported, first-seen order.
 * Both runners print their failures more than once (inline plus summary), and a
 * matrix leg repeats them per job, so identifiers are deduped.
 */
export function extractFailingTests(logText) {
  const seen = new Set();
  for (const rawLine of String(logText ?? '').split('\n')) {
    const line = cleanLine(rawLine);
    const vitest = VITEST_FAIL_PATTERN.exec(line);
    const pytest = PYTEST_FAIL_PATTERN.exec(line);
    if (!vitest && !pytest) continue;

    // pytest -q appends ` - <error message>`; the message varies run to run and
    // would defeat deduping, so keep only the `file::test` node id.
    const id = vitest ? vitest[1].trim() : pytest[1].trim();

    // Guard against the phrase appearing in a test's own captured stdout: a
    // real failure line names a test file, or a vitest `file > suite > case`.
    if (!TEST_FILE_PATTERN.test(id) && !id.includes(' > ')) continue;
    seen.add(id);
  }
  return [...seen];
}

export function testKey(testId) {
  return createHash('sha256')
    .update(String(testId).replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 12);
}

/**
 * A signature over the whole failure set, recorded in the body for humans
 * comparing two issues. Matching is done with the per-test markers, which
 * tolerate a failure set that grows or shrinks between runs.
 */
export function failureSignature(workflowName, testIds) {
  const keys = testIds.map(testKey).sort();
  return createHash('sha256')
    .update(`${workflowName}\n${keys.join('\n')}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Titles are read in issue lists, so keep the two parts that identify the
 * failure — the file and the test case — and collapse the suite chain between
 * them (`file > Suite > nested > case` is routinely over 140 characters).
 */
export function shortenForTitle(testId, limit = 110) {
  const segments = testId.replace(/\s+/g, ' ').trim().split(' > ');
  const collapsed =
    segments.length > 2
      ? [segments[0], '…', segments.at(-1)].join(' > ')
      : segments.join(' > ');
  return collapsed.length <= limit
    ? collapsed
    : `${collapsed.slice(0, limit - 1)}…`;
}

export function analyzeLogs(workflowName, logTexts) {
  const tests = [];
  for (const logText of logTexts) {
    for (const id of extractFailingTests(logText)) {
      if (!tests.some((test) => test.id === id))
        tests.push({ id, key: testKey(id) });
    }
  }

  const extra = tests.length > 1 ? ` (+${tests.length - 1} more)` : '';
  return {
    workflow: workflowName,
    tests,
    signature: tests.length
      ? failureSignature(
          workflowName,
          tests.map((t) => t.id),
        )
      : '',
    markers: tests.map((test) => `${TEST_MARKER_PREFIX}${test.key}`),
    searchMarkers: tests
      .slice(0, MAX_SEARCH_MARKERS)
      .map((test) => `${TEST_MARKER_PREFIX}${test.key}`),
    title: tests.length
      ? `Main CI failed: ${workflowName} — ${shortenForTitle(tests[0].id)}${extra}`
      : '',
  };
}

function occurrenceLine({ sha, runUrl, runId, at }) {
  const shortSha = String(sha ?? '').slice(0, 12);
  return `- \`${shortSha}\` · ${at} · [run ${runId}](${runUrl})`;
}

const TRIMMED_NOTE = '_Older recurrences trimmed._';
const RECURRENCE_HEADING = '## Recurrences';

function splitOccurrenceBlock(body) {
  const index = body.indexOf(OCCURRENCE_MARKER);
  if (index === -1) return { head: body.trimEnd(), lines: [], tail: '' };

  const head = body.slice(0, index).trimEnd();
  const rest = body.slice(index + OCCURRENCE_MARKER.length).split('\n');

  // Occurrence lines always open with the short SHA in backticks, so the
  // trimmed-note line never re-enters the list and accumulates. Anything else
  // was written by a human or the autofix agent below the block: it is kept
  // verbatim as `tail` and re-emitted above the refreshed block.
  const lines = [];
  let cursor = 0;
  for (; cursor < rest.length; cursor += 1) {
    const line = rest[cursor].trim();
    if (!line || line === TRIMMED_NOTE) continue;
    if (!line.startsWith('- `')) break;
    lines.push(line);
  }

  return { head, lines, tail: rest.slice(cursor).join('\n').trim() };
}

/**
 * Build the issue body: the create path when `existingBody` is empty, otherwise
 * a merge that keeps the existing prose (an agent's or a human's notes live
 * there) and only refreshes the machine-owned trailer.
 */
export function renderIssueBody({
  analysis,
  occurrence,
  maxOccurrences = MAX_OCCURRENCES,
  existingBody = '',
}) {
  const testLines = analysis.tests.map((test) => `- \`${test.id}\``);

  if (!existingBody.trim()) {
    const head = [
      `<!-- ${SIGNATURE_MARKER_PREFIX}${analysis.signature} -->`,
      ...analysis.markers.map((marker) => `<!-- ${marker} -->`),
      '',
      `A main-branch \`${analysis.workflow}\` run failed on \`main\`.`,
      '',
      '## Failing tests',
      '',
      ...testLines,
      '',
      'This issue is labeled for autofix so the existing agent can create a repair PR.',
      'It is deduped by failing test, so every later commit that hits the same',
      'failure is appended below instead of opening another issue.',
    ].join('\n');
    return [
      head,
      '',
      RECURRENCE_HEADING,
      '',
      OCCURRENCE_MARKER,
      occurrenceLine(occurrence),
      '',
    ].join('\n');
  }

  const { head, lines, tail } = splitOccurrenceBlock(existingBody);
  // The heading belongs to the machine block and is re-emitted with it, so kept
  // prose can never end up between the heading and its list.
  const withoutHeading = head.replace(/\n*##\s+Recurrences\s*$/, '');
  const prose = tail ? `${withoutHeading}\n\n${tail}` : withoutHeading;

  // Record markers for tests that joined the failure set after the issue was
  // opened, so the next run still matches this issue on either test.
  const missingMarkers = analysis.markers.filter(
    (marker) => !prose.includes(marker),
  );
  const missingTests = testLines.filter((line) => !prose.includes(line));
  const withMarkers = missingMarkers.length
    ? `${missingMarkers.map((marker) => `<!-- ${marker} -->`).join('\n')}\n${prose}`
    : prose;
  const withTests = missingTests.length
    ? `${withMarkers}\n\n## Also failing\n\n${missingTests.join('\n')}`
    : withMarkers;

  // A re-run of the same run must not add a second line for it.
  const kept = lines.filter((line) => !line.includes(`/${occurrence.runId}`));
  const combined = [occurrenceLine(occurrence), ...kept];
  const nextLines = combined.slice(0, maxOccurrences);
  const footer = combined.length > nextLines.length ? ['', TRIMMED_NOTE] : [];

  return [
    withTests,
    '',
    RECURRENCE_HEADING,
    '',
    OCCURRENCE_MARKER,
    ...nextLines,
    ...footer,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function runCli(argv) {
  const [command, ...rest] = argv;
  const { options, positional } = parseArgs(rest);

  if (command === 'analyze') {
    const logTexts = positional.map((file) => readFileSync(file, 'utf8'));
    process.stdout.write(
      `${JSON.stringify(analyzeLogs(options.workflow ?? '', logTexts))}\n`,
    );
    return;
  }

  if (command === 'body') {
    const analysis = JSON.parse(readFileSync(options.analysis, 'utf8'));
    const existingBody = options.existing
      ? readFileSync(options.existing, 'utf8')
      : '';
    process.stdout.write(
      renderIssueBody({
        analysis,
        existingBody,
        occurrence: {
          sha: options.sha,
          runUrl: options['run-url'],
          runId: options['run-id'],
          at: options.at,
        },
      }),
    );
    return;
  }

  throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
