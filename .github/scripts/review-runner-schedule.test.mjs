/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  AGENT_LABEL,
  CI_LABEL,
  RAMP_STEP,
  REVIEW_LABEL,
  hourIn,
  intVar,
  isNight,
  planLabels,
} from './review-runner-schedule.mjs';

// node: builtins only, so it runs in ci.yml's HELPER_TESTS_DEP_FREE lane.

let nextId = 1;
const runner = (labels, { busy = false, status = 'online' } = {}) => {
  const id = nextId++;
  return { id, name: `ecs-qwen-hk2-${id}`, status, busy, labels };
};
const find = (actions, r) => actions.find((a) => a.id === r.id);

describe('review runner schedule', () => {
  it('reads the night window across midnight in Asia/Shanghai', () => {
    assert.deepEqual(
      [16, 17, 23, 0, 4, 5, 12].map((h) => isNight(h, 17, 5)),
      [false, true, true, true, true, false, false],
    );
    assert.equal(isNight(10, 10, 10), false);
    // 14:30Z is 22:30 in Shanghai; 16:05Z is 00:05, which must read 0.
    assert.equal(hourIn(new Date('2026-09-14T14:30:00Z')), 22);
    assert.equal(hourIn(new Date('2026-09-14T16:05:00Z')), 0);
  });

  it('accepts 0 and rejects unset or malformed variables', () => {
    // 0 is a real setting (no review runners by day), not "unset".
    assert.equal(intVar('0', 999), 0);
    assert.equal(intVar(' 4 ', 999), 4);
    assert.equal(intVar('17', 23), 17);
    for (const bad of [undefined, '', 'abc', '-1', '1.5', '24']) {
      assert.equal(intVar(bad, 23), null, JSON.stringify(bad));
    }
  });

  it('day: keeps busy review runners, lends the released ones to CI', () => {
    const busy1 = runner([REVIEW_LABEL], { busy: true });
    const idle = runner([REVIEW_LABEL]);
    const busy2 = runner([REVIEW_LABEL], { busy: true });
    const agent = runner([AGENT_LABEL]);
    const actions = planLabels([busy1, idle, busy2, agent], 2);
    assert.equal(find(actions, busy1), undefined);
    assert.equal(find(actions, busy2), undefined);
    assert.deepEqual(find(actions, idle), {
      id: idle.id,
      name: idle.name,
      add: [CI_LABEL],
      remove: [REVIEW_LABEL],
    });
    assert.deepEqual(find(actions, agent).add, [CI_LABEL]);
    assert.deepEqual(find(actions, agent).remove, [AGENT_LABEL]);
  });

  it('night: grows by at most RAMP_STEP per tick, idle runners first', () => {
    const ci = Array.from({ length: 12 }, (_, i) =>
      runner([CI_LABEL], { busy: i < 4 }),
    );
    const actions = planLabels(ci, ci.length);
    assert.equal(actions.length, RAMP_STEP);
    for (const a of actions) {
      assert.deepEqual(a.add, [REVIEW_LABEL]);
      assert.deepEqual(a.remove, [CI_LABEL]);
      assert.equal(ci.find((r) => r.id === a.id).busy, false);
    }
  });

  it('changes nothing once converged, and ignores offline runners', () => {
    const runners = [
      runner([REVIEW_LABEL], { busy: true }),
      runner([REVIEW_LABEL]),
      runner([CI_LABEL]),
      runner([REVIEW_LABEL], { status: 'offline' }),
    ];
    assert.deepEqual(planLabels(runners, 2), []);
  });

  it('is wired to the review job and the three schedule variables', () => {
    const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const schedule = read('../workflows/qwen-review-runner-schedule.yml');
    // The defaults live in the workflow; a repository variable overrides.
    for (const [name, fallback] of [
      ['QWEN_REVIEW_NIGHT_START', '17'],
      ['QWEN_REVIEW_NIGHT_END', '5'],
      ['QWEN_REVIEW_DAY_RUNNERS', '0'],
    ]) {
      assert.ok(
        schedule.includes(`${name}: "\${{ vars.${name} || '${fallback}' }}"`),
        name,
      );
    }
    assert.match(
      schedule,
      /RUNNER_ADMIN_TOKEN: '\$\{\{ secrets\.RUNNER_ADMIN_PAT \}\}'/,
    );
    const review = read('../workflows/qwen-code-pr-review.yml');
    const runsOn = review.match(/^  review-pr:[\s\S]*?^    runs-on: (.*)$/m)[1];
    assert.match(runsOn, /"ecs-review"/);
  });
});
