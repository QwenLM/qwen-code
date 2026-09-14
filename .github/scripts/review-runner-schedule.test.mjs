/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AGENT_LABEL,
  CI_LABEL,
  REVIEW_LABEL,
  currentHour,
  isNight,
  managedRunners,
  planLabels,
  readConfig,
  resolvePhase,
} from './review-runner-schedule.mjs';

// This suite is the only guard on the runner schedule and its workflow, and
// it must stay dependency-free (node: builtins only) so it runs in the
// github_ci_only fast lane before any install — see HELPER_TESTS_DEP_FREE
// in ci.yml.

function runner(name, { status = 'online', busy = false, labels = [] } = {}) {
  return {
    id: Number(name.replace(/\D/g, '')) || 1,
    name,
    status,
    busy,
    labels: ['self-hosted', 'Linux', 'X64', 'ecs', ...labels],
  };
}

function actionFor(plan, name) {
  return plan.actions.find((a) => a.name === name);
}

describe('review runner schedule: window', () => {
  it('treats a wrapped window as night across midnight only', () => {
    const night = (h) => isNight(h, 22, 3);
    assert.equal(night(22), true);
    assert.equal(night(23), true);
    assert.equal(night(0), true);
    assert.equal(night(2), true);
    assert.equal(night(3), false);
    assert.equal(night(8), false);
    assert.equal(night(21), false);
  });

  it('handles a same-day window and an empty one', () => {
    assert.equal(isNight(10, 9, 17), true);
    assert.equal(isNight(17, 9, 17), false);
    assert.equal(isNight(10, 10, 10), false);
  });

  it('reads the hour in the configured zone', () => {
    // 2026-09-14T14:30Z is 22:30 in Asia/Shanghai (UTC+8, no DST).
    const at = new Date('2026-09-14T14:30:00Z');
    assert.equal(currentHour(at, 'Asia/Shanghai'), 22);
    assert.equal(currentHour(at, 'UTC'), 14);
    // Midnight must read as 0, not 24 (hourCycle h23).
    assert.equal(
      currentHour(new Date('2026-09-14T16:05:00Z'), 'Asia/Shanghai'),
      0,
    );
  });

  it('lets an explicit mode override the clock and off disables everything', () => {
    const config = readConfig({});
    assert.deepEqual(resolvePhase({ mode: 'auto', hour: 23, config }), {
      phase: 'night',
      target: 32,
    });
    assert.deepEqual(resolvePhase({ mode: 'auto', hour: 12, config }), {
      phase: 'day',
      target: 2,
    });
    assert.deepEqual(resolvePhase({ mode: 'day', hour: 23, config }), {
      phase: 'day',
      target: 2,
    });
    assert.deepEqual(resolvePhase({ mode: 'night', hour: 12, config }), {
      phase: 'night',
      target: 32,
    });
    assert.deepEqual(resolvePhase({ mode: 'off', hour: 12, config }), {
      phase: 'off',
      target: null,
    });
  });
});

describe('review runner schedule: config', () => {
  it('applies defaults and rejects bad values loudly instead of as zero', () => {
    const config = readConfig({
      QWEN_REVIEW_NIGHT_START: '21',
      QWEN_REVIEW_NIGHT_END: 'later',
      QWEN_REVIEW_DAY_RUNNERS: '4',
      QWEN_REVIEW_NIGHT_RUNNERS: '-1',
      QWEN_REVIEW_RAMP_STEP: '0',
      QWEN_REVIEW_RUNNER_HOSTS: 'hk2, hk1',
      QWEN_REVIEW_DAY_LEND_CI: 'false',
      QWEN_REVIEW_SCHEDULE_MODE: 'Night',
    });
    assert.equal(config.nightStart, 21);
    assert.equal(config.nightEnd, 3);
    assert.equal(config.dayRunners, 4);
    assert.equal(config.nightRunners, 32);
    assert.equal(config.rampStep, 8);
    assert.deepEqual(config.hosts, ['hk2', 'hk1']);
    assert.equal(config.lendCi, false);
    assert.equal(config.mode, 'night');
    assert.equal(config.notes.length, 3);
    assert.match(config.notes.join('\n'), /QWEN_REVIEW_NIGHT_END/);
    assert.match(config.notes.join('\n'), /QWEN_REVIEW_NIGHT_RUNNERS/);
    assert.match(config.notes.join('\n'), /QWEN_REVIEW_RAMP_STEP/);
  });

  it('manages only runners on the listed hosts', () => {
    const runners = [
      runner('ecs-qwen-hk1-3'),
      runner('ecs-qwen-hk2-1'),
      runner('ecs-qwen-hk2-32'),
      runner('ecs-qwen-hk4-host'),
      runner('dsw-qwen-benchmark-hk-16c-01'),
      runner('ecs-qwen-hk22-1'),
    ];
    assert.deepEqual(
      managedRunners(runners, ['hk2']).map((r) => r.name),
      ['ecs-qwen-hk2-1', 'ecs-qwen-hk2-32'],
    );
  });
});

describe('review runner schedule: planner', () => {
  it('day: keeps busy review runners, releases idle ones, lends the rest to CI', () => {
    const runners = [
      runner('ecs-qwen-hk2-1', { busy: true, labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-2', { busy: false, labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-3', { busy: true, labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-4', { busy: true, labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-5', {
        busy: false,
        labels: [REVIEW_LABEL, AGENT_LABEL],
      }),
    ];
    const plan = planLabels({ runners, target: 2, rampStep: 8, lendCi: true });
    assert.equal(plan.reviewBefore, 5);
    assert.equal(plan.reviewAfter, 2);
    // Busy first, then name order: hk2-1 and hk2-3 stay.
    assert.deepEqual(plan.reviewRunners, ['ecs-qwen-hk2-1', 'ecs-qwen-hk2-3']);
    assert.equal(actionFor(plan, 'ecs-qwen-hk2-1'), undefined);
    assert.deepEqual(actionFor(plan, 'ecs-qwen-hk2-2').remove, [REVIEW_LABEL]);
    assert.deepEqual(actionFor(plan, 'ecs-qwen-hk2-2').add, [CI_LABEL]);
    // A busy runner beyond the target still loses the label — it finishes
    // its review and takes no new one; that is the day switch's semantics.
    assert.deepEqual(actionFor(plan, 'ecs-qwen-hk2-4').remove, [REVIEW_LABEL]);
    // ecs-agent never survives on a managed host.
    assert.deepEqual(
      actionFor(plan, 'ecs-qwen-hk2-5').remove.sort(),
      [AGENT_LABEL, REVIEW_LABEL].sort(),
    );
  });

  it('night: grows by at most the ramp step per tick, idle runners first', () => {
    const runners = [
      runner('ecs-qwen-hk2-1', { labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-2', { labels: [REVIEW_LABEL] }),
      ...Array.from({ length: 10 }, (_, i) =>
        runner(`ecs-qwen-hk2-${i + 3}`, {
          busy: i % 2 === 0,
          labels: [CI_LABEL],
        }),
      ),
    ];
    const plan = planLabels({ runners, target: 12, rampStep: 4, lendCi: true });
    assert.equal(plan.reviewBefore, 2);
    assert.equal(plan.reviewAfter, 6);
    assert.equal(plan.pending, 6);
    const added = plan.actions.filter((a) => a.add.includes(REVIEW_LABEL));
    assert.equal(added.length, 4);
    // Idle CI runners (odd offsets) are converted before busy ones.
    assert.ok(
      added.every((a) => a.busy === false),
      JSON.stringify(added),
    );
    // Conversion swaps the pool label, never leaves a runner in both pools.
    assert.ok(added.every((a) => a.remove.includes(CI_LABEL)));
    // Already-review runners and not-yet-converted CI runners are untouched.
    assert.equal(actionFor(plan, 'ecs-qwen-hk2-1'), undefined);
    assert.equal(
      plan.actions.filter((a) => a.remove.includes(REVIEW_LABEL)).length,
      0,
    );
  });

  it('is idempotent once the target state is reached', () => {
    const runners = [
      runner('ecs-qwen-hk2-1', { labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-2', { labels: [REVIEW_LABEL], busy: true }),
      runner('ecs-qwen-hk2-3', { labels: [CI_LABEL] }),
    ];
    const plan = planLabels({ runners, target: 2, rampStep: 8, lendCi: true });
    assert.deepEqual(plan.actions, []);
  });

  it('without CI lending, day leaves the released runners label-free', () => {
    const runners = [
      runner('ecs-qwen-hk2-1', { labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-2', { labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-3', { labels: [REVIEW_LABEL] }),
    ];
    const plan = planLabels({ runners, target: 1, rampStep: 8, lendCi: false });
    assert.equal(plan.actions.length, 2);
    assert.ok(plan.actions.every((a) => a.add.length === 0));
  });

  it('strips managed labels from offline runners so they return neutral', () => {
    const runners = [
      runner('ecs-qwen-hk2-1', { labels: [REVIEW_LABEL] }),
      runner('ecs-qwen-hk2-2', {
        status: 'offline',
        labels: [REVIEW_LABEL, CI_LABEL],
      }),
      runner('ecs-qwen-hk2-3', { status: 'offline', labels: [] }),
    ];
    const plan = planLabels({ runners, target: 1, rampStep: 8, lendCi: true });
    assert.equal(plan.online, 1);
    assert.equal(plan.offline, 2);
    assert.deepEqual(
      actionFor(plan, 'ecs-qwen-hk2-2').remove.sort(),
      [CI_LABEL, REVIEW_LABEL].sort(),
    );
    assert.equal(actionFor(plan, 'ecs-qwen-hk2-3'), undefined);
    // Offline runners never count toward the target.
    assert.equal(plan.reviewAfter, 1);
  });
});

describe('review runner schedule: workflow wiring', () => {
  const workflowPath = fileURLToPath(
    new URL('../workflows/qwen-review-runner-schedule.yml', import.meta.url),
  );
  const workflow = readFileSync(workflowPath, 'utf8');
  const reviewWorkflow = readFileSync(
    fileURLToPath(
      new URL('../workflows/qwen-code-pr-review.yml', import.meta.url),
    ),
    'utf8',
  );

  it('ticks every 15 minutes, serialized, and never cancels an in-flight tick', () => {
    assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
    assert.match(workflow, /group: 'qwen-review-runner-schedule'/);
    assert.match(workflow, /cancel-in-progress: false/);
  });

  it('passes every schedule knob through as a repository variable', () => {
    for (const name of [
      'QWEN_REVIEW_SCHEDULE_MODE',
      'QWEN_REVIEW_NIGHT_START',
      'QWEN_REVIEW_NIGHT_END',
      'QWEN_REVIEW_DAY_RUNNERS',
      'QWEN_REVIEW_NIGHT_RUNNERS',
      'QWEN_REVIEW_RAMP_STEP',
      'QWEN_REVIEW_RUNNER_HOSTS',
      'QWEN_REVIEW_DAY_LEND_CI',
    ]) {
      assert.match(
        workflow,
        new RegExp(`${name}: ["']\\$\\{\\{ vars\\.${name}`),
        name,
      );
    }
  });

  it('holds the admin PAT in an environment and never checks out PR code', () => {
    assert.match(workflow, /environment: 'qwen-review-runner-schedule'/);
    assert.match(
      workflow,
      /RUNNER_ADMIN_TOKEN: '\$\{\{ secrets\.RUNNER_ADMIN_PAT \}\}'/,
    );
    assert.match(workflow, /ref: '\$\{\{ github\.sha \}\}'/);
    assert.match(workflow, /runs-on: 'ubuntu-latest'/);
    assert.doesNotMatch(workflow, /pull_request/);
  });

  it('the review job asks for the label this schedule manages', () => {
    const runsOn =
      reviewWorkflow.match(/^  review-pr:[\s\S]*?^    runs-on: (.*)$/m)?.[1] ??
      '';
    assert.match(runsOn, new RegExp(`"${REVIEW_LABEL}"`));
    assert.doesNotMatch(runsOn, /ecs-agent|"ecs-qwen"/);
  });
});
