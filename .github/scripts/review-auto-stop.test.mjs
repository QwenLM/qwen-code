import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_WINDOW, decideAutoStop, readMarker } from './review-auto-stop.mjs';

/** A posted review body carrying a ledger marker. */
const body = (round, fresh, floor = 'o', extra = {}) =>
  `prose\n\n<!-- qwen-review-ledger ${JSON.stringify({
    v: 1,
    round,
    findings: [],
    ...(fresh === null ? {} : { fresh }),
    ...(floor === null ? {} : { floor }),
    ...extra,
  })} -->`;

/**
 * The shape that DOES stop, newest first: four consecutive rounds whose
 * first-time counts never fall. Every test below starts here and changes one
 * thing, so each assertion measures the condition it names — an arm that
 * would have continued for a second reason proves nothing about the first.
 */
const STOPPING = [body(6, 3), body(5, 3), body(4, 2), body(3, 2)];

test('the baseline shape stops the automatic trigger', () => {
  const d = decideAutoStop(STOPPING);
  assert.equal(d.stop, true);
  assert.match(d.reason, /did not fall across 3 consecutive/);
  // The reason states the measurement, so an operator can check it.
  assert.match(d.reason, /r3=2 → r4=2 → r5=3 → r6=3/);
  assert.equal(d.evidence.window, DEFAULT_WINDOW);
});

test('one falling step is convergence, and keeps the trigger', () => {
  const d = decideAutoStop([body(6, 1), ...STOPPING.slice(1)]);
  assert.equal(d.stop, false);
  assert.match(d.reason, /fell from 3 to 1 at round 6/);
});

test('a settled round is the observation, not the symptom', () => {
  const d = decideAutoStop([body(6, 0), ...STOPPING.slice(1)]);
  assert.equal(d.stop, false);
  assert.match(d.reason, /no first-time findings/);
});

test('too few published rounds is unevaluable, never diverging', () => {
  const d = decideAutoStop(STOPPING.slice(0, 3));
  assert.equal(d.stop, false);
  assert.match(d.reason, /only 3 round\(s\)/);
});

test('a gap in the rounds is a trend over work nobody can see', () => {
  const d = decideAutoStop([body(7, 3), body(5, 3), body(4, 2), body(3, 2)]);
  assert.equal(d.stop, false);
  assert.match(d.reason, /not consecutive/);
});

test('a posture change is not loop behaviour', () => {
  const d = decideAutoStop([body(6, 3, 'c'), body(5, 3, 'o'), body(4, 2, 'o'), body(3, 2, 'o')]);
  assert.equal(d.stop, false);
  assert.match(d.reason, /posting floor changed/);
  // Two recorded floors that AGREE are not a change.
  assert.equal(decideAutoStop(STOPPING.map((b) => b)).stop, true);
  // An unrecorded floor is not a change either — a pre-field marker must not
  // silence the rule, and must not be read as a different posture.
  const mixedAbsent = [body(6, 3, null), body(5, 3), body(4, 2), body(3, 2)];
  assert.equal(decideAutoStop(mixedAbsent).stop, true);
});

test('a round with no first-time count cannot be compared', () => {
  const d = decideAutoStop([body(6, null), ...STOPPING.slice(1)]);
  assert.equal(d.stop, false);
  assert.match(d.reason, /recorded no first-time count/);
});

test('the window is the callers number, and only the callers', () => {
  // Two steps of flatness stop a caller that tolerates two; the same
  // evidence keeps a caller that tolerates four.
  assert.equal(decideAutoStop(STOPPING, { window: 2 }).stop, true);
  assert.equal(decideAutoStop(STOPPING, { window: 4 }).stop, false);
  // A nonsense window falls back to the default rather than to "stop".
  assert.equal(decideAutoStop(STOPPING, { window: 0 }).stop, true);
  assert.equal(decideAutoStop(STOPPING, { window: -1 }).stop, true);
});

test('unreadable telemetry keeps reviewing', () => {
  // Every doubt continues: a body with no marker, a malformed one, a
  // truncated one, and a wrong-version one all read as "cannot evaluate".
  for (const bad of [
    'no marker at all',
    '<!-- qwen-review-ledger {not json} -->',
    '<!-- qwen-review-ledger {"v":1,"round":6,"fresh":3}',
    '<!-- qwen-review-ledger {"v":2,"round":6,"fresh":3} -->',
    '<!-- qwen-review-ledger {"v":1,"round":0,"fresh":3} -->',
  ]) {
    assert.equal(readMarker(bad), null, bad);
    assert.equal(decideAutoStop([bad, ...STOPPING.slice(1)]).stop, false, bad);
  }
  assert.equal(decideAutoStop(null).stop, false);
  assert.equal(decideAutoStop([]).stop, false);
});

test('reads the LAST marker in a body, like the pipeline does', () => {
  // A quoted older marker must not decide the round: an edited or
  // quote-carrying body can hold more than one.
  const quoted = `${body(2, 9)}\n\nreply quoting the above\n\n${body(6, 3).split('\n\n')[1]}`;
  assert.equal(readMarker(quoted).round, 6);
});

test('ignores a marker field it does not need', () => {
  const withExtras = body(6, 3, 'o', { posted: 40, dropped: 5, sha: 'deadbeef' });
  assert.deepEqual(readMarker(withExtras), { round: 6, fresh: 3, floor: 'o' });
});

// ---------------------------------------------------------------------------
// The workflow step itself, replayed.
//
// The unit tests above cover the decision; these cover the wiring around it,
// which is where the first round of this feature was broken in two places at
// once and green everywhere: `gh api --paginate --jq` returns one document
// PER PAGE, so the listing was unparseable — and therefore empty, and
// therefore inert — on every PR past 100 reviews; and the notice was posted
// with a credential that cannot post, so every stop was silent. Both are
// fail-open, both are invisible to a test that stubs the shell out. So this
// section runs the shipped `run:` block verbatim against a stubbed `gh`,
// paginated the way the real one paginates.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, '..', 'workflows', 'qwen-code-pr-review.yml'), 'utf8');

/**
 * The `run:` body of a named step, dedented — no YAML parser, because the
 * profile that runs these tests installs no dependencies.
 */
function stepScript(stepName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: '${stepName}'`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const stepIndent = lines[start].indexOf('- ');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const indent = l.length - l.trimStart().length;
    if (indent <= stepIndent && l.trimStart().startsWith('- ')) { end = i; break; }
    if (indent < stepIndent) { end = i; break; }
  }
  const runAt = lines.slice(start, end).findIndex((l) => /^\s*run: \|-\s*$/.test(l));
  assert.notEqual(runAt, -1, `step has no block run:: ${stepName}`);
  const runLine = lines[start + runAt];
  const bodyIndent = runLine.length - runLine.trimStart().length + 2;
  const body = [];
  for (let i = start + runAt + 1; i < end; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    assert.ok(l.length - l.trimStart().length >= bodyIndent, `dedent failed at line ${i + 1}`);
    body.push(l.slice(bodyIndent));
  }
  return body.join('\n');
}

const RECHECK = stepScript('Re-check PR state');
// A silent extraction failure would make every arm below pass on an empty
// script, so the anchors are asserted, not assumed.
for (const anchor of ['set -euo pipefail', 'should_review', 'upsert-bot-comment.sh', 'decideAutoStop']) {
  assert.ok(RECHECK.includes(anchor), `extracted step is missing ${anchor}`);
}

/** Chronological, oldest first — the order the API returns reviews in. */
const CHRONOLOGICAL = [...STOPPING].reverse();
const review = (b, login = 'qwen-code-ci-bot') => ({ user: { login }, body: b });

/** Replay the step with `gh` stubbed, its pages served exactly as gh serves them. */
function replayRecheck(pages, { window = '', disabled = '', noticeToken = 'pat-token' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auto-stop-step-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  // One JSON document per page, concatenated — `gh api --paginate` without
  // `--jq` emits precisely this, and it is the shape the first version could
  // not read.
  const pagesFile = join(dir, 'pages.json');
  writeFileSync(pagesFile, pages.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const write = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('sleep', '#!/usr/bin/env bash\nexit 0\n');
  write(
    'gh',
    [
      '#!/usr/bin/env bash',
      // Record the credential each call was made with: which token reaches
      // which endpoint is the whole of the second defect.
      'echo "TOKEN=${GH_TOKEN:-} ARGS=$1 $2 $3" >> "$CALLS"',
      'case "$*" in',
      '  "pr view"*) printf \'OPEN\\tfalse\\n\' ;;',
      // Faithful to gh on the one point that matters: `--jq` is applied
      // PER PAGE, and the outputs are concatenated. A stub that ignored the
      // flag would fail the multi-page and single-page arms alike, and prove
      // neither.
      '  *"/pulls/"*"/reviews"*)',
      '    jqexpr=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
      '    if [ -n "$jqexpr" ]; then',
      '      while IFS= read -r page; do printf \'%s\' "$page" | jq -c "$jqexpr"; done < "$PAGES"',
      '    else',
      '      cat "$PAGES"',
      '    fi ;;',
      '  "api user"*) echo qwen-code-ci-bot ;;',
      '  *"/issues/"*"/comments"*) echo "[]" ;;',
      '  *) : ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  const outputs = join(dir, 'outputs');
  const summary = join(dir, 'summary.md');
  writeFileSync(outputs, '');
  writeFileSync(summary, '');
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(runnerTemp);
  const stdout = execFileSync('bash', ['-e', '-c', RECHECK], {
    cwd: join(here, '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: calls,
      PAGES: pagesFile,
      GH_TOKEN: 'job-token',
      NOTICE_TOKEN: noticeToken,
      PR_NUMBER: '42',
      GITHUB_REPOSITORY: 'QwenLM/qwen-code',
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      AUTO_STOP_WINDOW: window,
      AUTO_STOP_DISABLED: disabled,
    },
  });
  return {
    stdout,
    output: readFileSync(outputs, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    calls: readFileSync(calls, 'utf8'),
  };
}

test('a multi-page review listing still reaches the decision', () => {
  // The regression: 100 reviews per page, so a diverging PR is ALWAYS
  // multi-page by the time this rule could matter. A stranger's review rides
  // along to keep the author scope under test at the same time.
  const r = replayRecheck([
    [review(CHRONOLOGICAL[0]), review(CHRONOLOGICAL[1]), review('drive-by', 'someone-else')],
    [review(CHRONOLOGICAL[2]), review(CHRONOLOGICAL[3])],
  ]);
  assert.match(r.output, /should_review=false/);
  assert.match(r.summary, /Automatic review skipped/);
});

test('a single-page listing decides the same way', () => {
  const r = replayRecheck([CHRONOLOGICAL.map((b) => review(b))]);
  assert.match(r.output, /should_review=false/);
});

test('a converging history keeps the trigger, through the same wiring', () => {
  const converging = [...CHRONOLOGICAL.slice(0, 3), body(6, 1)];
  const r = replayRecheck([converging.slice(0, 2).map((b) => review(b)), converging.slice(2).map((b) => review(b))]);
  assert.match(r.output, /should_review=true/);
  assert.match(r.summary, /fell from 3 to 1 at round 6/);
});

test('the notice posts with the credential that can post', () => {
  const r = replayRecheck([
    [review(CHRONOLOGICAL[0]), review(CHRONOLOGICAL[1])],
    [review(CHRONOLOGICAL[2]), review(CHRONOLOGICAL[3])],
  ]);
  assert.match(r.stdout, /Auto-stop notice relayed/);
  const lines = r.calls.trim().split('\n');
  // The reads run on the job token; the POST — and the `gh api user` that
  // scopes it — must not, because neither works under one.
  const post = lines.find((l) => /ARGS=api repos\/\S+\/issues\/\S+\/comments -f$/.test(l));
  assert.ok(post, `no issue-comment POST recorded:\n${r.calls}`);
  assert.match(post, /^TOKEN=pat-token /);
  assert.match(lines.find((l) => /ARGS=api user/.test(l)) ?? '', /^TOKEN=pat-token /);
  assert.match(lines.find((l) => /ARGS=pr view/.test(l)) ?? '', /^TOKEN=job-token /);
});

test('no PAT posts nothing and still stops, rather than retrying a dead credential', () => {
  const r = replayRecheck(
    [[review(CHRONOLOGICAL[0]), review(CHRONOLOGICAL[1])], [review(CHRONOLOGICAL[2]), review(CHRONOLOGICAL[3])]],
    { noticeToken: '' },
  );
  assert.match(r.output, /should_review=false/);
  assert.match(r.stdout, /::warning::Auto-stop notice could not be posted/);
  assert.doesNotMatch(r.calls, /ARGS=api user/);
});

test('the caller\'s two repository variables reach the replayed step', () => {
  // window=2 makes a history too short for the default window decide.
  const short = [body(5, 3), body(4, 2), body(3, 2)].reverse().map((b) => review(b));
  assert.match(replayRecheck([short]).output, /should_review=true/);
  assert.match(replayRecheck([short], { window: '2' }).output, /should_review=false/);
  assert.match(
    replayRecheck([[review(CHRONOLOGICAL[0]), review(CHRONOLOGICAL[1])], [review(CHRONOLOGICAL[2]), review(CHRONOLOGICAL[3])]], { disabled: 'true' }).output,
    /should_review=true/,
  );
});
