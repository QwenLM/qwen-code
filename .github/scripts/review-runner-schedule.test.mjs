/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { planLabels } from './review-runner-schedule.mjs';

const runner = (id, labels, extra = {}) => ({
  id,
  name: `ecs-qwen-hk2-${id}`,
  labels: labels.map((name) => ({ name })),
  status: 'online',
  ...extra,
});

describe('review runner schedule', () => {
  it('switches online hk1 and hk2 runners, including busy runners', () => {
    const runners = Array.from({ length: 32 }, (_, i) =>
      runner(i + 1, ['ecs-qwen', 'ecs-agent', 'diagnostic'], {
        name: `ecs-qwen-hk${(i % 2) + 1}-${i + 1}`,
        busy: i % 2 === 0,
        status: i < 2 ? 'offline' : 'online',
      }),
    );
    const actions = planLabels(runners, 'review');
    const onlineRunners = runners.filter(({ status }) => status === 'online');
    assert.equal(actions.length, 30);
    for (const [i, action] of actions.entries()) {
      assert.deepEqual(action, {
        id: onlineRunners[i].id,
        name: onlineRunners[i].name,
        add: ['ecs-review'],
        remove: ['ecs-qwen'],
      });
    }
    assert.deepEqual(
      actions.map(({ id }) => id),
      onlineRunners.map(({ id }) => id),
    );
  });

  it('returns every online review runner to CI and leaves unrelated runners alone', () => {
    assert.deepEqual(
      planLabels(
        [
          runner(1, ['ecs-review', 'diagnostic']),
          runner(2, ['ecs-agent'], { name: 'ecs-qwen-hk1-2' }),
          runner(3, ['ecs-review'], { name: 'ecs-qwen-hk2-3-extra' }),
          runner(4, ['ecs-review'], { status: 'offline' }),
          runner(5, ['ecs-review'], { name: 'ecs-qwen-hk3-5' }),
        ],
        'ci',
      ),
      [
        {
          id: 1,
          name: 'ecs-qwen-hk2-1',
          add: ['ecs-qwen'],
          remove: ['ecs-review'],
        },
        {
          id: 2,
          name: 'ecs-qwen-hk1-2',
          add: ['ecs-qwen'],
          remove: [],
        },
      ],
    );
  });

  it('is idempotent and rejects invalid modes', () => {
    assert.deepEqual(
      planLabels([runner(1, ['ecs-review', 'diagnostic'])], 'review'),
      [],
    );
    assert.deepEqual(planLabels([runner(1, ['ecs-qwen'])], 'ci'), []);
    assert.throws(() => planLabels([], 'invalid'), /mode must be review or ci/);
  });

  it('wires two daily UTC switches and manual pool selection', () => {
    const schedule = readFileSync(
      new URL('../workflows/qwen-review-runner-schedule.yml', import.meta.url),
      'utf8',
    );
    assert.deepEqual(
      [...schedule.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]),
      ['0 9 * * *', '0 21 * * *'],
    );
    assert.ok(
      schedule.includes(
        "github.event_name == 'workflow_dispatch' && inputs.pool",
      ),
    );
    assert.ok(
      schedule.includes(
        "github.event.schedule == '0 9 * * *' && 'review' || 'ci'",
      ),
    );
    assert.ok(schedule.includes('"$GITHUB_REPOSITORY" "$POOL"'));
    assert.ok(schedule.includes('secrets.RUNNER_ADMIN_PAT'));
  });
});
