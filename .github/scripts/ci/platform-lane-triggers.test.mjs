// The macOS and Windows lanes have exactly one live trigger left: the nightly
// schedule. Their pull-request trigger is off until the standing Windows
// path/symlink failures are fixed, and the merge queue is not enabled on this
// repository — no `merge_group` run since 2026-07-02 — so `on.schedule` is the
// only thing between this repository and the state #9220 shipped from: a
// macOS-only failure sitting in `main` with nothing left to report it.
//
// These guards are about that single point of failure. The schedule exists,
// both lanes accept it, and a nightly is those two jobs and nothing else — a
// third job joining them would burn a runner every night and, worse, could
// fail the nightly for reasons that have nothing to do with either platform,
// which is how a real regression gets read as noise.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ciDoc = parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'workflows',
      'ci.yml',
    ),
    'utf8',
  ),
);

const LANES = ['test_macos', 'test_windows'];

// Evaluates a job-level `if` for one event name. Only the `github.event_name`
// atoms are resolved against the event; every other atom — `cancelled()`, a
// `needs` output, a pull_request payload field — collapses to the value that
// most favours the job RUNNING. A job this reports as skipped is therefore
// skipped by its event wiring alone, never by an accident of some upstream
// output, which is the only thing these guards claim to check.
function runsOnEvent(expression, eventName) {
  const js = String(expression)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .replace(/github\.event_name\s*==\s*'([^']*)'/g, (_, n) =>
      String(n === eventName),
    )
    .replace(/github\.event_name\s*!=\s*'([^']*)'/g, (_, n) =>
      String(n !== eventName),
    )
    .replace(/!\s*[a-z_]+\(\)/gi, 'true')
    .replace(/[A-Za-z_][\w.]*\s*[=!]=\s*'[^']*'/g, 'true')
    .replace(/\b(?:github|needs|vars|inputs)\.[\w.]+/g, 'true')
    .replace(/\btrue\s*[=!]=\s*true\b/g, 'true');

  // Anything the substitutions did not reduce to the boolean skeleton is a
  // shape this evaluator was never taught to read: fail loudly rather than
  // quietly report a job as skipped because a new atom parsed as nothing.
  assert.match(
    js,
    /^[\s()!&|truefalse]*$/,
    `unreduced atoms in \`if\`: ${js.trim()}`,
  );
  return Boolean(new Function(`return (${js});`)());
}

describe('ci.yml macOS/Windows lane triggers', () => {
  it('keeps the nightly schedule that is now their only trigger', () => {
    const schedule = ciDoc.on?.schedule;
    assert.ok(
      Array.isArray(schedule) && schedule.length > 0 && schedule[0].cron,
      'ci.yml must keep an `on.schedule` cron: with the pull-request trigger ' +
        'off and no merge queue, deleting it silences macOS and Windows ' +
        'entirely instead of merely reducing their coverage',
    );
  });

  it('runs both lanes on that schedule', () => {
    for (const lane of LANES) {
      assert.ok(
        runsOnEvent(ciDoc.jobs[lane].if, 'schedule'),
        `${lane} must run on the nightly schedule`,
      );
    }
  });

  it('runs the two lanes and nothing else on a nightly', () => {
    const scheduled = Object.entries(ciDoc.jobs)
      .filter(([, job]) => runsOnEvent(job.if, 'schedule'))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(scheduled, [...LANES].sort());
  });
});
