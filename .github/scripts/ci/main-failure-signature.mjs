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
/** Pre-dedupe marker, still used for runs whose failing tests are unknown. */
export const LEGACY_MARKER_PREFIX = 'qwen-main-ci-failure:';
export const SIGNATURE_MARKER_PREFIX = 'qwen-main-ci-failure-sig:';
/** Workflow-scoped bridge marker: the last search marker in both arms, so the
 * workflow fallback search reaches the newest matching issue when the
 * per-test and per-commit marker classes are disjoint (#12133). The workflow
 * pins `sort:created-desc`, so this marker is deliberately the extra query
 * after the per-test budget rather than a replacement for a test marker. */
export const WORKFLOW_MARKER_PREFIX = 'qwen-main-ci-failure-workflow:';
/** Derive the opaque, space-free bridge-marker payload from the workflow
 * name, so the emitted search token is a single colon-bearing term (#12133
 * fix sketch; R1-6). Every producer site calls this to guarantee an
 * identical value. */
export function workflowBridgeMarker(workflowName) {
  return `${WORKFLOW_MARKER_PREFIX}${testKey(workflowName)}`;
}
export const OCCURRENCE_MARKER = '<!-- qwen-main-ci-failure-occurrences -->';
export const MAX_OCCURRENCES = 10;

/** Markers to search issues by. GitHub search is a cost per query, and a run
 * with dozens of failures is an infra break, not a per-test regression. */
export const MAX_SEARCH_MARKERS = 5;

/** Failing tests listed in the issue body. A total-suite failure (expired
 * provider key, model outage) can fail every test at once; the body must stay
 * under GitHub's 65,536-character limit or `gh issue create` hard-fails. */
export const MAX_BODY_TESTS = 20;

// Vitest and pytest colourise their output and Actions stores the escapes
// verbatim, so failure lines arrive wrapped in SGR sequences.
// eslint-disable-next-line no-control-regex -- matches the ESC that opens one
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;
// Actions prefixes every log line with an RFC3339 timestamp.
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
const VITEST_FAIL_PATTERN = /^FAIL\s+(.+)$/;
// Anchoring on ` - ` rather than the first space keeps parametrized node ids
// whose parameters contain spaces (`test_x[case one]`).
const PYTEST_FAIL_PATTERN = /^FAILED\s+(.+?)(?:\s+-\s.*)?$/;
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
 * Parse the `name<TAB>step<TAB>step` lines the workflow writes from the run's
 * failed-job list. A lane that dies before printing any test result still
 * reports which job and which step failed — the only identity left for the
 * per-commit issue to carry. One field per step, because step names contain
 * commas — `Extract metadata (tags, labels) for Docker` — that a comma-joined
 * wire shreds.
 */
export function parseFailedJobs(tsv) {
  const jobs = [];
  for (const rawLine of tsv.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [name, ...steps] = line.split('\t');
    jobs.push({ name, steps });
  }
  return jobs;
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

export function analyzeLogs(workflowName, logTexts, failedJobs = []) {
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
    failedJobs,
    signature: tests.length
      ? failureSignature(
          workflowName,
          tests.map((t) => t.id),
        )
      : '',
    markers: tests.map((test) => `${TEST_MARKER_PREFIX}${test.key}`),
    searchMarkers: [
      ...tests
        .slice(0, MAX_SEARCH_MARKERS)
        .map((test) => `${TEST_MARKER_PREFIX}${test.key}`),
      workflowBridgeMarker(workflowName),
    ],
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
const ALSO_FAILING_HEADING = '## Also failing';
// The "## Also failing" list is machine-owned and rebuilt from the current
// failure set on every merge, so the previous one is stripped first. The block
// is the heading plus its contiguous bullet list — nothing else is ever written
// under it.
const ALSO_FAILING_BLOCK = /\n*##\s+Also failing\s*\n+(?:- [^\n]*\n?)+/;

// The same split/merge contract — head / recorded occurrences / tail around
// the marker, human text kept verbatim, occurrences newest-first and capped —
// is re-implemented in bash/awk by .github/scripts/image-build-failure-issue.sh
// for the build-and-publish-image workflow; a fix to one must reach the other.
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

function failedJobLines(failedJobs) {
  return failedJobs.map((job) => {
    if (!job.steps.length) return `  - \`${job.name}\``;
    const steps = job.steps.map((step) => `\`${step}\``).join(', ');
    return `  - \`${job.name}\` — failed in ${job.steps.length === 1 ? 'step' : 'steps'} ${steps}`;
  });
}

/**
 * A run that failed before any test result was reported — an install or build
 * break — has nothing to dedupe on, so it keeps the original per-commit marker
 * and title. The failed job and step still go in the body: they are what tells
 * a reader which lane broke when no test name survived to say so.
 */
function renderPerCommitBody({ analysis, occurrence }) {
  return [
    `<!-- ${LEGACY_MARKER_PREFIX}${occurrence.sha} -->`,
    `<!-- ${workflowBridgeMarker(analysis.workflow)} -->`,
    '',
    'A main-branch CI run failed on `main` before any test result was',
    'reported, so this issue is tracked per commit.',
    '',
    PER_COMMIT_HEADER_START,
    renderPerCommitHeader({ analysis, occurrence }),
    PER_COMMIT_HEADER_END,
    '',
    'This issue is labeled for autofix so the existing agent can create a repair PR.',
    '',
  ].join('\n');
}

export function renderIssueTitle({ analysis, occurrence }) {
  if (!analysis.tests.length) {
    return `Main CI failed: ${analysis.workflow} on ${String(occurrence.sha).slice(0, 12)}`;
  }
  return analysis.title;
}

function cappedTestLines(tests) {
  const lines = tests
    .slice(0, MAX_BODY_TESTS)
    .map((test) => `- \`${test.id}\``);
  if (tests.length > MAX_BODY_TESTS)
    lines.push(`- …and ${tests.length - MAX_BODY_TESTS} more`);
  return lines;
}

/**
 * Build the issue body: the create path when `existingBody` is empty, otherwise
 * a merge that keeps the existing prose (an agent's or a human's notes live
 * there) and only refreshes the machine-owned trailer.
 */
const RECURRENCE_HEADING_STRIP = /\n*##\s+Recurrences\s*$/;

// The per-commit identity block is machine-owned. The explicit delimiters
// keep human notes and identity-looking bullets outside the replacement range.
// The legacy parser below accepts the pre-delimiter shape for one migration,
// then every refreshed body is written in the delimited form.
const PER_COMMIT_HEADER_START = '<!-- qwen-main-ci-failure-header -->';
const PER_COMMIT_HEADER_END = '<!-- /qwen-main-ci-failure-header -->';
const PER_COMMIT_INTRO =
  'A main-branch CI run failed on `main` before any test result was\nreported, so this issue is tracked per commit.';
const PER_COMMIT_FOOTER =
  'This issue is labeled for autofix so the existing agent can create a repair PR.';

function parsePerCommitHeaderBlock(block) {
  const lines = block.trim().split('\n');
  const findField = (pattern) => {
    const index = lines.findIndex((line) => pattern.test(line));
    return {
      index,
      value: index === -1 ? undefined : lines[index].match(pattern)[1],
    };
  };
  const workflowField = findField(/^- Workflow: (.+)$/);
  const runField = findField(/^- Run: (\S+)$/);
  const runIdField = findField(/^- Run ID: (\S+)$/);
  const shaField = findField(/^- Commit: (\S+)$/);
  const workflow = workflowField.value;
  const runUrl = runField.value;
  const runId = runIdField.value;
  const sha = shaField.value;
  if (!workflow && !runUrl && !runId && !sha) return null;

  const failedJobLines = [];
  let failedJobRunId;
  const failedJobsIndex = lines.findIndex((line) =>
    /^- Failed jobs(?: \(last reported for run (\S+)\))?:$/.test(line),
  );
  if (failedJobsIndex !== -1) {
    failedJobRunId = lines[failedJobsIndex].match(
      /^- Failed jobs(?: \(last reported for run (\S+)\))?:$/,
    )[1];
    for (
      let index = failedJobsIndex + 1;
      lines[index]?.startsWith('  - ');
      index += 1
    ) {
      failedJobLines.push(lines[index]);
    }
  }
  const cursorAfterJobs =
    workflowField.index === -1
      ? -1
      : workflowField.index +
        1 +
        (failedJobsIndex === workflowField.index + 1
          ? 1 + failedJobLines.length
          : 0);
  const wellFormed =
    workflowField.index === 0 &&
    runField.index === cursorAfterJobs &&
    runIdField.index === runField.index + 1 &&
    shaField.index === runIdField.index + 1;
  const remainder = wellFormed
    ? shaField.index === -1
      ? []
      : lines.slice(shaField.index + 1)
    : lines;
  return {
    workflow,
    runUrl,
    runId,
    sha,
    wellFormed,
    failedJobLines,
    failedJobRunId,
    // Lines after the required identity fields are human-authored prose. They
    // are carried out of the machine block by replacePerCommitHeader so a
    // maintainer note cannot make an otherwise valid stub unadoptable.
    remainder,
  };
}

function extractPerCommitHeader(head) {
  const markedStart = head.indexOf(PER_COMMIT_HEADER_START);
  if (markedStart !== -1) {
    const contentStart = markedStart + PER_COMMIT_HEADER_START.length;
    const markedEnd = head.indexOf(PER_COMMIT_HEADER_END, contentStart);
    if (markedEnd !== -1) {
      const parsed = parsePerCommitHeaderBlock(
        head.slice(contentStart, markedEnd),
      );
      if (parsed) {
        return {
          ...parsed,
          replaceStart: markedStart,
          replaceEnd: markedEnd + PER_COMMIT_HEADER_END.length,
        };
      }
    }
  }

  // Existing issues created before the delimiters are still adopted when the
  // required identity fields are present in their canonical order. Trailing
  // notes are returned as remainder and preserved outside the replacement
  // range instead of making the machine state unadoptable.
  const legacyStart = head.indexOf(`${PER_COMMIT_INTRO}\n\n`);
  if (legacyStart === -1) return null;
  const contentStart = legacyStart + PER_COMMIT_INTRO.length + 2;
  const legacyEnd = head.indexOf(`\n\n${PER_COMMIT_FOOTER}`, contentStart);
  if (legacyEnd === -1) return null;
  const parsed = parsePerCommitHeaderBlock(head.slice(contentStart, legacyEnd));
  return parsed
    ? { ...parsed, replaceStart: contentStart, replaceEnd: legacyEnd }
    : null;
}

function renderPerCommitHeader({
  analysis,
  occurrence,
  failedJobLines: prior = [],
  priorRunId,
  priorFailedJobRunId,
}) {
  const jobs = analysis.failedJobs.length
    ? failedJobLines(analysis.failedJobs)
    : prior;
  const failedJobsHeading = jobs.length
    ? analysis.failedJobs.length
      ? '- Failed jobs:'
      : `- Failed jobs (last reported for run ${
          priorFailedJobRunId ?? priorRunId ?? 'unknown'
        }):`
    : null;
  return [
    `- Workflow: ${analysis.workflow}`,
    ...(failedJobsHeading ? [failedJobsHeading, ...jobs] : []),
    `- Run: ${occurrence.runUrl}`,
    `- Run ID: ${occurrence.runId}`,
    `- Commit: ${occurrence.sha}`,
  ].join('\n');
}

function replacePerCommitHeader(head, headerBlock, remainder = []) {
  const header = extractPerCommitHeader(head);
  if (!header?.wellFormed) return head;
  const replacement = [
    PER_COMMIT_HEADER_START,
    headerBlock,
    PER_COMMIT_HEADER_END,
  ].join('\n');
  const preservedRemainder = remainder.length
    ? `\n${remainder.join('\n')}`
    : '';
  return `${head.slice(0, header.replaceStart)}${replacement}${preservedRemainder}${head.slice(
    header.replaceEnd,
  )}`;
}

const LEGACY_MARKER_LINE_RE = new RegExp(
  `^<!-- ${LEGACY_MARKER_PREFIX}\\S+ -->$`,
);
const WORKFLOW_MARKER_LINE_RE = new RegExp(
  `^<!-- ${WORKFLOW_MARKER_PREFIX}\\S+ -->$`,
);
const MACHINE_MARKER_LINE_RE = /^<!-- \S+ -->$/;

/**
 * Return only the contiguous, whole-line marker block at the start of a
 * rendered head. Human notes may quote marker-shaped text, but that prose is
 * never machine state and must not change the body's classification.
 */
function topMachineMarkers(text) {
  const markers = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (markers.length) break;
      continue;
    }
    if (!MACHINE_MARKER_LINE_RE.test(line)) break;
    markers.push(line.slice('<!-- '.length, -' -->'.length));
  }
  return markers;
}

function hasMarkerLine(text, marker) {
  const expected = `<!-- ${marker} -->`;
  return String(text ?? '')
    .split('\n')
    .some((line) => line.trim() === expected);
}

function hasTopMarker(text, prefix) {
  return topMachineMarkers(text).some((marker) => marker.startsWith(prefix));
}

function stripPerCommitMachineLines(
  text,
  { removeLegacyMarkers = false } = {},
) {
  const fixedLines = new Set([
    ...PER_COMMIT_INTRO.split('\n'),
    ...PER_COMMIT_FOOTER.split('\n'),
  ]);
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (
        trimmed === PER_COMMIT_HEADER_START ||
        trimmed === PER_COMMIT_HEADER_END ||
        WORKFLOW_MARKER_LINE_RE.test(trimmed)
      ) {
        return false;
      }
      if (removeLegacyMarkers && LEGACY_MARKER_LINE_RE.test(trimmed)) {
        return false;
      }
      return !fixedLines.has(trimmed);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function preservedPerCommitProse(head, header) {
  const outsideMachineRange = [
    head.slice(0, header.replaceStart),
    header.remainder.join('\n'),
    head.slice(header.replaceEnd),
  ].join('\n');
  const prose = stripPerCommitMachineLines(outsideMachineRange, {
    removeLegacyMarkers: true,
  });
  return prose ? prose.split('\n') : [];
}

function appendPreviousFailedJobs(head, failedJobs, runId, workflow) {
  if (!failedJobs.length) return head;
  const section = [
    `## Previous failed jobs (${workflow}, last reported for run ${runId})`,
    '',
    ...failedJobLines(failedJobs),
  ].join('\n');
  const existing =
    /\n*## Previous failed jobs[^\n]*\n+(?: {2}- [^\n]*)(?:\n {2}- [^\n]*)*/;
  return existing.test(head)
    ? head.replace(existing, () => `\n\n${section}`)
    : `${head.trimEnd()}\n\n${section}`;
}

/**
 * The standard per-test head: signature + per-test markers, the prose, and
 * the identified failures. Shared by the create path and by the per-test
 * merge arm when it adopts a per-commit stub (R1-10), so the two spellings
 * cannot drift. R1-1: the workflow bridge is deliberately absent here — a
 * per-test body must never become reachable by the bridge search, or every
 * later distinct failure of the workflow would be absorbed into this issue
 * instead of filing its own, inverting the module's own dedupe contract
 * (#12133: two different failing tests still get separate issues).
 */
function renderPerTestHead({
  analysis,
  bodyMarkers,
  testLines,
  additionalMarkers = [],
  preservedFailedJobLines = [],
  preservedRemainder = [],
}) {
  return [
    `<!-- ${SIGNATURE_MARKER_PREFIX}${analysis.signature} -->`,
    ...bodyMarkers.map((marker) => `<!-- ${marker} -->`),
    ...additionalMarkers.map((marker) => `<!-- ${marker} -->`),
    '',
    `A main-branch \`${analysis.workflow}\` run failed on \`main\`.`,
    '',
    '## Failing tests',
    '',
    ...testLines,
    '',
    ...(preservedFailedJobLines.length
      ? ['## Previous failed jobs', '', ...preservedFailedJobLines, '']
      : []),
    ...preservedRemainder,
    ...(preservedRemainder.length ? [''] : []),
    'This issue is labeled for autofix so the existing agent can create a repair PR.',
    'It is deduped by failing test, so every later commit that hits the same',
    'failure is appended below instead of opening another issue.',
  ].join('\n');
}

/**
 * renderPerCommitBody never emits a recurrence bullet for its own filing:
 * a fresh stub records its first run only in the single-valued header
 * fields. Re-rendering those fields for a newer run (R1-2) would erase that
 * occurrence entirely, so it is promoted to a bullet first — a no-op when
 * the head carries no stub header, when the header run already has a
 * bullet, or when the plan re-records the header run itself (the merge
 * emits its bullet anyway). The bullet omits the timestamp the stub header
 * never recorded.
 */
function stubHeaderBullet(header, lines, occurrence) {
  const runId = header?.runId;
  if (!runId || runId === String(occurrence?.runId)) return lines;
  if (lines.some((line) => line.includes(`[run ${runId}]`))) return lines;
  const sha = String(header.sha ?? '').slice(0, 12);
  const runUrl = header.runUrl ?? '';
  return [...lines, `- \`${sha}\` · [run ${runId}](${runUrl})`];
}

/**
 * Rebuild the machine-owned recurrence list for a merge — shared by both
 * merge arms (R1-9) so the guards cannot drift between the copies again:
 * matching the `[run <id>]` link text rather than the run URL (`/301` is a
 * substring of `/3010`, so a URL match would silently delete an unrelated
 * run's line), and capping the list with a trim note that never re-enters
 * it. The caller supplies its own final prose; in particular the per-test
 * arm's "## Also failing" strip must never run on the per-commit arm,
 * where an adopted per-test body's list would be deleted with nothing
 * rebuilt in its place.
 */
function recurrenceBlock({ lines, occurrence, maxOccurrences }) {
  const kept = lines.filter(
    (line) => !line.includes(`[run ${occurrence.runId}]`),
  );
  const combined = [occurrenceLine(occurrence), ...kept];
  const nextLines = combined.slice(0, maxOccurrences);
  const footer = combined.length > nextLines.length ? ['', TRIMMED_NOTE] : [];
  return { nextLines, footer };
}

export function renderIssueBody({
  analysis,
  occurrence,
  maxOccurrences = MAX_OCCURRENCES,
  existingBody = '',
}) {
  if (!analysis.tests.length) {
    if (!existingBody.trim()) {
      return renderPerCommitBody({ analysis, occurrence });
    }
    // A workflow-scoped bridge marker can land this run on an issue filed
    // under a different commit (or by the per-test arm), so an existing body
    // no longer means "the same commit was already filed". Merge the new
    // occurrence into the recorded body — the run link, the failed job and
    // the new per-commit marker must be visible on the issue, or the
    // recurrence is silently lost while the log claims it was recorded
    // (#12133).
    //
    // R1-3: the bridge stays single-valued per body. The legacy sha marker
    // is workflow-agnostic, so one push sha can legitimately fail two watched
    // workflows and both reporters land on the same issue; the merge records
    // the occurrence, but a body that already carries a bridge — its own or
    // a foreign one — never gains this run's bridge. Otherwise one bad
    // same-sha merge turns the issue into a permanent cross-workflow sink
    // that every later unidentifiable failure of either workflow resolves
    // into, and nothing under .github/ ever closes it.
    const perCommitMarker = `${LEGACY_MARKER_PREFIX}${occurrence.sha}`;
    const workflowMarker = workflowBridgeMarker(analysis.workflow);
    const { head, lines, tail } = splitOccurrenceBlock(existingBody);
    const withoutHeading = head.replace(RECURRENCE_HEADING_STRIP, '');
    const existingHeader = extractPerCommitHeader(withoutHeading);
    // R1-2: re-render the single-valued header fields from the newest
    // occurrence, so the lane, step, commit, run and run-id lines always
    // describe the run being recorded — never a stale predecessor. The job
    // bullets stay in the head prose: splitOccurrenceBlock re-ingests every
    // `- ` line below the block marker as a recurrence, so they must not
    // move into it.
    const headerBlock = renderPerCommitHeader({
      analysis,
      occurrence,
      failedJobLines: existingHeader?.failedJobLines,
      priorRunId: existingHeader?.runId,
      priorFailedJobRunId: existingHeader?.failedJobRunId,
    });
    const ownsHeader =
      !existingHeader || existingHeader.workflow === analysis.workflow;
    const refreshed =
      existingHeader?.wellFormed && ownsHeader
        ? replacePerCommitHeader(
            withoutHeading,
            headerBlock,
            existingHeader.remainder,
          )
        : appendPreviousFailedJobs(
            withoutHeading,
            analysis.failedJobs,
            occurrence.runId,
            analysis.workflow,
          );
    // R1-8: the bridge funnels every unidentifiable failure of a workflow
    // onto one open issue, and every landing used to add one sha marker to
    // the head permanently — past GitHub's 65,536-character body limit,
    // `gh issue edit --body-file` hard-fails and recurrences of a still
    // broken `main` stop being recorded at all. Keep only the newest
    // MAX_OCCURRENCES sha markers: the newest, because the consumer searches
    // the current run's sha first and dropping it would stop same-commit
    // reruns from deduping; and never the workflow bridge, which is what
    // keeps this issue reachable by the bridge search at all.
    const markerLineRe = /^<!-- (qwen-main-ci-failure:\S+) -->$/;
    const shaMarkers = [
      ...new Set([
        ...refreshed
          .split('\n')
          .map((line) => line.trim().match(markerLineRe)?.[1])
          .filter(Boolean),
        perCommitMarker,
      ]),
    ].slice(-MAX_OCCURRENCES);
    const prose = refreshed
      .split('\n')
      .filter(
        (line) =>
          !markerLineRe.test(line.trim()) &&
          !WORKFLOW_MARKER_LINE_RE.test(line.trim()),
      )
      .join('\n')
      .replace(/^\n+/, '')
      .trimEnd();
    const workflowMarkers = topMachineMarkers(head).filter((marker) =>
      marker.startsWith(WORKFLOW_MARKER_PREFIX),
    );
    // The bridge is written only by renderPerCommitBody (R1-1) and granted
    // on merge only to a stub-shaped body that carries no bridge yet — the
    // pre-marker stubs this rollout has to adopt. A per-test body never
    // gains one, and a body already bridged (its own or a foreign one) is
    // left with the bridge it has.
    const adoptsStubShape =
      hasTopMarker(head, LEGACY_MARKER_PREFIX) &&
      !hasTopMarker(head, TEST_MARKER_PREFIX);
    const hasAnyBridge = hasTopMarker(head, WORKFLOW_MARKER_PREFIX);
    const headerCanBridge =
      existingHeader?.wellFormed &&
      hasTopMarker(head, LEGACY_MARKER_PREFIX) &&
      existingHeader.workflow === analysis.workflow &&
      Boolean(existingHeader?.runId && existingHeader?.sha);
    const canAdoptBridge = adoptsStubShape && !hasAnyBridge && headerCanBridge;
    const mergedHead = [
      ...shaMarkers.map((marker) => `<!-- ${marker} -->`),
      ...workflowMarkers.map((marker) => `<!-- ${marker} -->`),
      ...(canAdoptBridge ? [`<!-- ${workflowMarker} -->`] : []),
      '',
      prose,
    ].join('\n');
    const { nextLines, footer } = recurrenceBlock({
      lines: stubHeaderBullet(existingHeader, lines, occurrence),
      occurrence,
      maxOccurrences,
    });
    return [
      mergedHead,
      '',
      RECURRENCE_HEADING,
      '',
      OCCURRENCE_MARKER,
      ...nextLines,
      ...footer,
      ...(tail ? ['', tail] : []),
    ].join('\n');
  }

  // The body carries only the first MAX_SEARCH_MARKERS test markers; the
  // workflow-scoped bridge is an extra search query and is intentionally not
  // emitted on per-test bodies. A total-suite failure can fail every test at
  // once, and an unbounded body crosses GitHub's 65,536-character limit.
  const bodyMarkers = analysis.markers.slice(0, MAX_SEARCH_MARKERS);
  const testLines = cappedTestLines(analysis.tests);

  if (!existingBody.trim()) {
    return [
      renderPerTestHead({ analysis, bodyMarkers, testLines }),
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
  const withoutHeading = head.replace(RECURRENCE_HEADING_STRIP, '');

  // R1-10: a bridge match can land a per-test run on a per-commit stub, and
  // the adopted head would then contradict the issue it now tracks — the
  // stub's "no test result was reported" prose and identity block sitting
  // above an identified test, with no "## Failing tests" section at all.
  // Detect the stub by its machine-written sha marker and the absence of any
  // per-test marker, not by prose shape: everything the splitter does not
  // recognize as a bullet is human or agent prose kept verbatim, so a
  // prose-shaped key would discard handwritten notes. The stub head is
  // replaced with the standard per-test head and the stub's recorded run is
  // promoted to a bullet so the adoption loses no history.
  const adoptsStub =
    hasTopMarker(head, LEGACY_MARKER_PREFIX) &&
    !hasTopMarker(head, TEST_MARKER_PREFIX);
  const parsedStubHeader = adoptsStub ? extractPerCommitHeader(head) : null;
  const stubHeader =
    parsedStubHeader?.wellFormed && hasTopMarker(head, LEGACY_MARKER_PREFIX)
      ? parsedStubHeader
      : null;
  const legacyMarkers = adoptsStub
    ? topMachineMarkers(head).filter((marker) =>
        marker.startsWith(LEGACY_MARKER_PREFIX),
      )
    : [];
  const headProse = adoptsStub
    ? stubHeader
      ? renderPerTestHead({
          analysis,
          bodyMarkers,
          testLines,
          additionalMarkers: legacyMarkers,
          preservedFailedJobLines: stubHeader.failedJobLines,
          preservedRemainder: preservedPerCommitProse(
            withoutHeading,
            stubHeader,
          ),
        })
      : [
          renderPerTestHead({
            analysis,
            bodyMarkers,
            testLines,
            preservedRemainder: (() => {
              const retained = stripPerCommitMachineLines(withoutHeading);
              return retained ? retained.split('\n') : [];
            })(),
          }),
        ].join('\n\n')
    : withoutHeading;
  const adoptLines = adoptsStub
    ? stubHeader
      ? stubHeaderBullet(stubHeader, lines, occurrence)
      : lines
    : lines;
  const prose = headProse;

  // The "## Also failing" list is rebuilt from the current failure set below,
  // so strip the previous one first: a test that has since been fixed must
  // disappear instead of being listed forever.
  const strippedProse = prose.replace(ALSO_FAILING_BLOCK, '').trimEnd();

  // Record markers for tests that joined the failure set after the issue was
  // opened, so the next run still matches this issue on either test. R1-1:
  // the bridge is deliberately absent — a per-test body never becomes
  // reachable by the bridge search.
  const missingMarkers = bodyMarkers.filter(
    (marker) => !hasMarkerLine(strippedProse, marker),
  );
  const missingTests = testLines.filter(
    (line) =>
      line.startsWith('- `') &&
      !strippedProse.split('\n').some((candidate) => candidate === line),
  );
  const withMarkers = missingMarkers.length
    ? `${missingMarkers.map((marker) => `<!-- ${marker} -->`).join('\n')}\n${strippedProse}`
    : strippedProse;
  const withTests = missingTests.length
    ? `${withMarkers}\n\n${ALSO_FAILING_HEADING}\n\n${missingTests.join('\n')}`
    : withMarkers;

  const { nextLines, footer } = recurrenceBlock({
    lines: adoptLines,
    occurrence,
    maxOccurrences,
  });

  return [
    withTests,
    '',
    RECURRENCE_HEADING,
    '',
    OCCURRENCE_MARKER,
    ...nextLines,
    ...footer,
    ...(tail ? ['', tail] : []),
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

function readFailedJobs(path) {
  if (!path) return [];
  try {
    return parseFailedJobs(readFileSync(path, 'utf8'));
  } catch {
    // A missing jobs file costs the same precision a missing log does: the
    // per-commit body falls back to naming nothing but the run.
    return [];
  }
}

export function runCli(argv) {
  const [command, ...rest] = argv;
  const { options, positional } = parseArgs(rest);

  if (command === 'analyze') {
    const logTexts = positional.map((file) => readFileSync(file, 'utf8'));
    process.stdout.write(
      `${JSON.stringify(
        analyzeLogs(
          options.workflow ?? '',
          logTexts,
          readFailedJobs(options.jobs),
        ),
      )}\n`,
    );
    return;
  }

  // The title and body are emitted together so the privileged job that writes
  // the issue needs nothing but these two strings — it never reads the repo.
  if (command === 'plan') {
    const analysis = JSON.parse(readFileSync(options.analysis, 'utf8'));
    const existingBody = options.existing
      ? readFileSync(options.existing, 'utf8')
      : '';
    const occurrence = {
      sha: options.sha,
      runUrl: options['run-url'],
      runId: options['run-id'],
      at: options.at,
    };
    process.stdout.write(
      `${JSON.stringify({
        title: renderIssueTitle({ analysis, occurrence }),
        body: renderIssueBody({ analysis, existingBody, occurrence }),
        searchMarkers: analysis.tests.length
          ? analysis.searchMarkers
          : [
              `${LEGACY_MARKER_PREFIX}${occurrence.sha}`,
              workflowBridgeMarker(analysis.workflow),
            ],
      })}\n`,
    );
    return;
  }

  throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
