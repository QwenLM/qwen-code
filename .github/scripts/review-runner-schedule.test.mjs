/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { planLabels } from './review-runner-schedule.mjs';

const runner = (id, labels, extra = {}) => ({
  id,
  name: `ecs-qwen-hz2-${id}`,
  labels: labels.map((name) => ({ name })),
  status: 'online',
  ...extra,
});

describe('review runner schedule', () => {
  it('switches online hz1-hz6 runners, including busy runners', () => {
    const runners = Array.from({ length: 32 }, (_, i) =>
      runner(i + 1, ['ecs-qwen', 'ecs-autofix', 'diagnostic'], {
        name: `ecs-qwen-hz${(i % 6) + 1}-${i + 1}`,
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
          runner(2, ['ecs-autofix'], { name: 'ecs-qwen-hz1-2' }),
          runner(3, ['ecs-review'], { name: 'ecs-qwen-hz2-3-extra' }),
          runner(4, ['ecs-review'], { status: 'offline' }),
          runner(5, ['ecs-review'], { name: 'ecs-qwen-hk1-5' }),
        ],
        'ci',
      ),
      [
        {
          id: 1,
          name: 'ecs-qwen-hz2-1',
          add: ['ecs-qwen'],
          remove: ['ecs-review'],
        },
        {
          id: 2,
          name: 'ecs-qwen-hz1-2',
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
    assert.throws(
      () => planLabels([], 'invalid'),
      /mode must be review, day or ci/,
    );
  });

  it('keeps the first N runners on review and returns the rest to CI in day mode', () => {
    assert.deepEqual(
      planLabels(
        [
          runner(1, ['ecs-qwen', 'ecs-autofix'], { name: 'ecs-qwen-hz2-1' }),
          runner(2, ['ecs-qwen'], { name: 'ecs-qwen-hz2-2' }),
          runner(3, ['ecs-review'], { name: 'ecs-qwen-hz1-7' }),
          runner(4, ['ecs-qwen'], { name: 'ecs-qwen-hz1-8' }),
          runner(5, ['ecs-qwen'], { name: 'ecs-qwen-hk1-9' }),
        ],
        'day',
        3,
      ),
      [
        // Sorted by name (numeric), the day pool is hz1-7, hz1-8, hz2-1 —
        // hz2-2 is the first runner past the cut and returns to CI. hk1-9
        // is outside the fleet and untouched. hz2-2 already carries the CI
        // label, and hz1-7 already carries review, so neither appears in
        // the action list. Actions are emitted in the order runners were
        // passed in, not the sorted pick order.
        {
          id: 1,
          name: 'ecs-qwen-hz2-1',
          add: ['ecs-review'],
          remove: ['ecs-qwen'],
        },
        {
          id: 4,
          name: 'ecs-qwen-hz1-8',
          add: ['ecs-review'],
          remove: ['ecs-qwen'],
        },
      ],
    );
  });

  it('sorts numerically so hz1-2 stays ahead of hz1-10', () => {
    const runners = [
      runner(10, ['ecs-qwen'], { name: 'ecs-qwen-hz1-10' }),
      runner(2, ['ecs-qwen'], { name: 'ecs-qwen-hz1-2' }),
      runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hz1-1' }),
    ];
    const actions = planLabels(runners, 'day', 2);
    // Numeric sort puts hz1-1, hz1-2 in the keep set; hz1-10 falls outside
    // and would go to CI — but it already has the CI label, so no action.
    assert.deepEqual(actions, [
      {
        id: 2,
        name: 'ecs-qwen-hz1-2',
        add: ['ecs-review'],
        remove: ['ecs-qwen'],
      },
      {
        id: 1,
        name: 'ecs-qwen-hz1-1',
        add: ['ecs-review'],
        remove: ['ecs-qwen'],
      },
    ]);
  });

  it('is idempotent for day mode and rejects a count above the online fleet', () => {
    assert.deepEqual(
      planLabels(
        [runner(1, ['ecs-review'], { name: 'ecs-qwen-hz2-1' })],
        'day',
        1,
      ),
      [],
    );
    // A stale var would otherwise silently shrink the daytime pool on every
    // morning tick while the run stays green.
    assert.throws(
      () => planLabels([runner(1, ['ecs-qwen'])], 'day', 5),
      /exceeds online fleet of 1/,
    );
    assert.throws(
      () => planLabels([runner(1, ['ecs-qwen'])], 'day', 0),
      /needs a positive integer review-day runner count/,
    );
    assert.throws(
      () => planLabels([runner(1, ['ecs-qwen'])], 'day', Number.NaN),
      /needs a positive integer review-day runner count/,
    );
  });

  it('skips offline runners when picking the day pool', () => {
    assert.deepEqual(
      planLabels(
        [
          runner(1, ['ecs-review'], {
            name: 'ecs-qwen-hz1-1',
            status: 'offline',
          }),
          runner(2, ['ecs-qwen'], { name: 'ecs-qwen-hz1-2' }),
          runner(3, ['ecs-qwen'], { name: 'ecs-qwen-hz1-3' }),
        ],
        'day',
        1,
      ),
      [
        // hz1-1 is offline so the pick falls through to hz1-2 (the first
        // online runner). hz1-3 was not picked and was not on review, so no
        // label change is needed.
        {
          id: 2,
          name: 'ecs-qwen-hz1-2',
          add: ['ecs-review'],
          remove: ['ecs-qwen'],
        },
      ],
    );
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
        "github.event.schedule == '0 9 * * *' && 'review' || 'day'",
      ),
    );
    assert.ok(schedule.includes('"$GITHUB_REPOSITORY" "$POOL"'));
    assert.ok(schedule.includes('secrets.RUNNER_ADMIN_PAT'));
    // The daytime pool. A configured count of runners stay on review after
    // the 05:00 switch; an unset override falls back to 40, and a count that
    // exceeds the online fleet fails the tick instead of shrinking the pool
    // silently.
    assert.ok(schedule.includes("- 'day'"));
    assert.match(
      schedule,
      /REVIEW_DAY_RUNNER_COUNT: .*\$\{\{ vars\.QWEN_REVIEW_DAY_RUNNER_COUNT \|\| '40' \}\}/,
    );
    assert.ok(schedule.includes('"$REVIEW_DAY_RUNNER_COUNT"'));
    // The in-repo half of the fence on the admin PAT. Losing it is silent:
    // a dispatch from any other branch still runs, now executing that
    // branch's copy of the planner with the token in its environment. The
    // 4-space anchor binds the clause to a JOB-level `if:` — the same
    // substring on a step, or quoted in the header prose, would leave the
    // checkout and the job running on a non-main dispatch.
    assert.match(schedule, /^ {4}if: .*github\.ref == 'refs\/heads\/main'/m);
  });
});

// The planner's own entry path, driven through a fake `gh` that logs every
// label call and serves PROBE_RUNNERS as the runner listing.
const writeFakeGh = (dir) => {
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
if (!args.includes('--method')) {
  console.log(JSON.stringify([{ runners: JSON.parse(process.env.PROBE_RUNNERS) }]));
} else {
  fs.appendFileSync(process.env.PROBE_LOG, method + '\\n');
  if (method === 'POST' && process.env.PROBE_FAIL === 'true') process.exit(1);
}
`,
    { mode: 0o755 },
  );
};

const spawnPlanner = (dir, runners, { fail = false } = {}) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./review-runner-schedule.mjs', import.meta.url)),
      'example/repo',
      'review',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        RUNNER_ADMIN_TOKEN: 'test-only',
        GITHUB_STEP_SUMMARY: '',
        PROBE_LOG: join(dir, 'calls'),
        PROBE_FAIL: String(fail),
        PROBE_RUNNERS: JSON.stringify(runners),
      },
    },
  );

it(
  'adds before deleting and preserves the old pool when adding fails',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-switch-'));
    try {
      const log = join(dir, 'calls');
      writeFakeGh(dir);
      for (const [labels, fail, expected] of [
        [['ecs-qwen', 'ecs-autofix'], false, ['POST', 'DELETE']],
        [['ecs-qwen', 'ecs-autofix'], true, ['POST']],
        [['ecs-qwen', 'ecs-review', 'ecs-autofix'], false, ['DELETE']],
      ]) {
        writeFileSync(log, '');
        const result = spawnPlanner(dir, [runner(1, labels)], { fail });
        assert.equal(result.status, fail ? 1 : 0, result.stderr);
        assert.deepEqual(
          readFileSync(log, 'utf8').trim().split('\n'),
          expected,
        );
        if (fail)
          assert.match(
            result.stderr,
            /::error::1 runner label change\(s\) failed/,
          );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it(
  'fails loudly when no hz runner exists instead of switching nothing',
  { skip: process.platform === 'win32' },
  () => {
    // Without the guard a renamed or empty fleet exits 0 after reporting
    // "0 runners to switch": the pool never opens, review-pr queues into a
    // closed `ecs-review` pool, and GitHub ends each job at 24 hours. There
    // is no periodic reconciliation, so that state holds until someone reads
    // a green run.
    const dir = mkdtempSync(join(tmpdir(), 'runner-switch-'));
    try {
      const log = join(dir, 'calls');
      writeFakeGh(dir);
      for (const runners of [
        [],
        [runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hk1-1' })],
        [runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hz7-1' })],
        [runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hz1-1-extra' })],
      ]) {
        writeFileSync(log, '');
        const result = spawnPlanner(dir, runners);
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          result.stderr,
          /::error::no ecs-qwen-hz\[1-6\]-<n> runner found/,
        );
        assert.equal(readFileSync(log, 'utf8'), '');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
