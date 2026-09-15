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
    // The in-repo half of the fence on the admin PAT. Losing it is silent:
    // a dispatch from any other branch still runs, now executing that
    // branch's copy of the planner with the token in its environment.
    assert.ok(schedule.includes("github.ref == 'refs/heads/main'"));
  });
});

// The planner's own entry path, driven through a fake `gh` that logs every
// label call and serves PROBE_RUNNERS as the runner listing.
const writeFakeGh = (dir) =>
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
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
        [['ecs-qwen', 'ecs-agent'], false, ['POST', 'DELETE']],
        [['ecs-qwen', 'ecs-agent'], true, ['POST']],
        [['ecs-qwen', 'ecs-review', 'ecs-agent'], false, ['DELETE']],
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
  'fails loudly when no hk1 or hk2 runner exists instead of switching nothing',
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
        [runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hk3-1' })],
        [runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hk1-1-extra' })],
      ]) {
        writeFileSync(log, '');
        const result = spawnPlanner(dir, runners);
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          result.stderr,
          /::error::no ecs-qwen-hk1-<n> or ecs-qwen-hk2-<n> runner found/,
        );
        assert.equal(readFileSync(log, 'utf8'), '');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
