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
  ...extra,
});

describe('review runner schedule', () => {
  it('switches the entire pool, including busy and offline runners', () => {
    const runners = Array.from({ length: 30 }, (_, i) =>
      runner(i + 1, ['ecs-qwen', 'ecs-agent', 'diagnostic'], {
        busy: i % 2 === 0,
        status: i === 0 ? 'offline' : 'online',
      }),
    );
    const actions = planLabels(runners, 'review');
    assert.equal(actions.length, 30);
    for (const [i, action] of actions.entries()) {
      assert.deepEqual(action, {
        id: i + 1,
        name: runners[i].name,
        add: ['ecs-review'],
        remove: ['ecs-qwen', 'ecs-agent'],
      });
    }
  });

  it('returns every review runner to CI and leaves unrelated runners alone', () => {
    assert.deepEqual(
      planLabels(
        [
          runner(1, ['ecs-review', 'diagnostic']),
          runner(2, ['ecs-agent'], { name: 'ecs-qwen-hk1-2' }),
          runner(3, ['ecs-review'], { name: 'ecs-qwen-hk2-3-extra' }),
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
