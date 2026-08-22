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
