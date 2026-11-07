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
import {
  fleetNameFromEnv,
  isManagedRunner,
  planLabels,
} from './review-runner-schedule.mjs';

const FLEET = /^ecs-qwen-hz[1-6]-\d+$/;

// Every fixture runner needs the architecture label the review workflow
// targets — without it `isManagedRunner` returns false and the planner
// skips the runner entirely.
const runner = (id, labels, extra = {}) => {
  const { name, ...rest } = extra;
  return {
    id,
    name: name ?? `ecs-qwen-hz2-${id}`,
    labels: ['X64', ...labels].map((n) => ({ name: n })),
    status: 'online',
    ...rest,
  };
};

const plan = (runners, mode, dayCount = 0) =>
  planLabels(runners, mode, dayCount, FLEET).actions;

describe('review runner schedule', () => {
  describe('fleetNameFromEnv', () => {
    it('falls back to the hz fleet when unset', () => {
      assert.equal(fleetNameFromEnv({}).source, '^ecs-qwen-hz[1-6]-\\d+$');
    });
    it('honours an override and rejects an invalid regex', () => {
      assert.equal(
        fleetNameFromEnv({ QWEN_REVIEW_FLEET_NAME_PATTERN: '^foo-\\d+$' })
          .source,
        '^foo-\\d+$',
      );
      assert.throws(
        () => fleetNameFromEnv({ QWEN_REVIEW_FLEET_NAME_PATTERN: '(' }),
        /not a valid regex/,
      );
    });
  });

  describe('isManagedRunner', () => {
    it('requires the review architecture label', () => {
      // hz1-17..hz1-32 carry ARM64 only — they can never be assigned a
      // review job whose runs-on includes "x64", so they must not count
      // toward the daytime pool.
      assert.equal(
        isManagedRunner(
          runner(1, ['ecs-qwen', 'ARM64'], {
            // strip the default X64 to model the real host
          }),
          FLEET,
        ),
        true,
      );
      const armOnly = {
        id: 17,
        name: 'ecs-qwen-hz1-17',
        labels: ['self-hosted', 'Linux', 'ARM64', 'ecs-qwen'].map((n) => ({
          name: n,
        })),
        status: 'online',
      };
      assert.equal(isManagedRunner(armOnly, FLEET), false);
    });
    it('excludes reserved-label hosts such as ecs-qwen-release-host', () => {
      const releaseHost = {
        id: 17,
        name: 'ecs-qwen-hz1-17',
        labels: ['self-hosted', 'Linux', 'X64', 'ecs-qwen-release-host'].map(
          (n) => ({ name: n }),
        ),
        status: 'online',
      };
      assert.equal(isManagedRunner(releaseHost, FLEET), false);
    });
  });

  it('switches online hz1-hz6 runners, including busy runners', () => {
    const runners = Array.from({ length: 32 }, (_, i) =>
      runner(i + 1, ['ecs-qwen', 'ecs-autofix', 'diagnostic'], {
        name: `ecs-qwen-hz${(i % 6) + 1}-${i + 1}`,
        busy: i % 2 === 0,
        status: i < 2 ? 'offline' : 'online',
      }),
    );
    const actions = plan(runners, 'review');
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
      plan(
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
      plan([runner(1, ['ecs-review', 'diagnostic'])], 'review'),
      [],
    );
    assert.deepEqual(plan([runner(1, ['ecs-qwen'])], 'ci'), []);
    assert.throws(() => plan([], 'invalid'), /mode must be review, day or ci/);
  });

  it('keeps the first N runners on review and returns the rest to CI in day mode', () => {
    assert.deepEqual(
      plan(
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
    const actions = plan(runners, 'day', 2);
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

  it('truncates to the online fleet when dayCount exceeds it, and reports the pick', () => {
    const result = planLabels(
      [runner(1, ['ecs-qwen']), runner(2, ['ecs-qwen'])],
      'day',
      5,
      FLEET,
    );
    // Truncation, not failure: every online managed runner goes on review
    // and the summary flags the gap for the operator.
    assert.equal(result.truncated, true);
    assert.equal(result.requestedDayCount, 5);
    assert.equal(result.effectiveDayCount, 2);
    assert.equal(result.onlineManaged, 2);
    assert.deepEqual(result.keptNames.sort(), [
      'ecs-qwen-hz2-1',
      'ecs-qwen-hz2-2',
    ]);
    assert.equal(result.actions.length, 2);
  });

  it('is idempotent for day mode and validates the count', () => {
    assert.deepEqual(
      plan([runner(1, ['ecs-review'], { name: 'ecs-qwen-hz2-1' })], 'day', 1),
      [],
    );
    assert.throws(
      () => plan([runner(1, ['ecs-qwen'])], 'day', 0),
      /needs a positive integer review-day runner count/,
    );
    assert.throws(
      () => plan([runner(1, ['ecs-qwen'])], 'day', Number.NaN),
      /needs a positive integer review-day runner count/,
    );
  });

  it('skips offline runners when picking the day pool', () => {
    assert.deepEqual(
      plan(
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

  it('excludes ARM64-only and reserved-label hosts from the day pool', () => {
    const arm = (id) => ({
      id,
      name: `ecs-qwen-hz1-${id}`,
      labels: ['self-hosted', 'Linux', 'ARM64', 'ecs-qwen'].map((n) => ({
        name: n,
      })),
      status: 'online',
    });
    const releaseHost = {
      id: 99,
      name: 'ecs-qwen-hz1-99',
      labels: ['self-hosted', 'Linux', 'X64', 'ecs-qwen-release-host'].map(
        (n) => ({ name: n }),
      ),
      status: 'online',
    };
    const x64 = (id) =>
      runner(id, ['ecs-qwen'], { name: `ecs-qwen-hz1-${id}` });
    // Sorted: hz1-1 (arm, skipped), hz1-2 (x64), hz1-3 (x64), hz1-17 (arm,
    // skipped), hz1-99 (release-host, skipped). Day count 2 picks the two
    // usable x64 hosts.
    const result = planLabels(
      [arm(1), x64(2), x64(3), arm(17), releaseHost],
      'day',
      2,
      FLEET,
    );
    assert.deepEqual(result.keptNames.sort(), [
      'ecs-qwen-hz1-2',
      'ecs-qwen-hz1-3',
    ]);
    assert.equal(result.onlineManaged, 2);
    assert.equal(result.truncated, false);
    // Reserved-label and ARM-only hosts must not be touched at all.
    const ids = result.actions.map((a) => a.id).sort();
    assert.deepEqual(ids, [2, 3]);
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
    // exceeds the online fleet truncates with a warning rather than
    // silently shrinking the pool or failing the whole tick.
    assert.ok(schedule.includes("- 'day'"));
    assert.match(
      schedule,
      /REVIEW_DAY_RUNNER_COUNT: .*\$\{\{ vars\.QWEN_REVIEW_DAY_RUNNER_COUNT \|\| '40' \}\}/,
    );
    assert.ok(schedule.includes('"$REVIEW_DAY_RUNNER_COUNT"'));
    // The fleet pattern is configurable so a region change is a var edit,
    // not a code change.
    assert.match(
      schedule,
      /QWEN_REVIEW_FLEET_NAME_PATTERN: .*\$\{\{ vars\.QWEN_REVIEW_FLEET_NAME_PATTERN/,
    );
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

const spawnPlanner = (
  dir,
  runners,
  { fail = false, mode = 'review', dayCount = '' } = {},
) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./review-runner-schedule.mjs', import.meta.url)),
      'example/repo',
      mode,
      ...(mode === 'day' ? [dayCount] : []),
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
  'fails loudly when no managed runner exists instead of switching nothing',
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
          /::error::no runner matches QWEN_REVIEW_FLEET_NAME_PATTERN/,
        );
        assert.equal(readFileSync(log, 'utf8'), '');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it(
  'day mode end-to-end: applies keep-set labels and writes a kept-names summary',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-switch-'));
    try {
      const log = join(dir, 'calls');
      writeFakeGh(dir);
      writeFileSync(log, '');
      const summaryPath = join(dir, 'summary.md');
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./review-runner-schedule.mjs', import.meta.url),
          ),
          'example/repo',
          'day',
          '1',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: dir + delimiter + process.env.PATH,
            RUNNER_ADMIN_TOKEN: 'test-only',
            GITHUB_STEP_SUMMARY: summaryPath,
            PROBE_LOG: log,
            PROBE_FAIL: 'false',
            PROBE_RUNNERS: JSON.stringify([
              runner(1, ['ecs-qwen'], { name: 'ecs-qwen-hz1-1' }),
              runner(2, ['ecs-qwen'], { name: 'ecs-qwen-hz1-2' }),
            ]),
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      // hz1-1 is the pick: POST ecs-review then DELETE ecs-qwen.
      // hz1-2 already carries ecs-qwen and stays on CI: no calls.
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
        'POST',
        'DELETE',
      ]);
      const summary = readFileSync(summaryPath, 'utf8');
      assert.match(summary, /keeping on review \(1\):/);
      assert.match(summary, /ecs-qwen-hz1-1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it(
  'day mode rejects a non-numeric count before touching the API',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-switch-'));
    try {
      const log = join(dir, 'calls');
      writeFakeGh(dir);
      writeFileSync(log, '');
      // `parseInt` would accept each of these as `4` — the strict regex
      // rejects them so a typo cannot silently shrink the daytime pool.
      for (const bad of ['4O', '4.5', '4 0', '1e2', 'abc', '']) {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL('./review-runner-schedule.mjs', import.meta.url),
            ),
            'example/repo',
            'day',
            bad,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: dir + delimiter + process.env.PATH,
              RUNNER_ADMIN_TOKEN: 'test-only',
              GITHUB_STEP_SUMMARY: '',
              PROBE_LOG: log,
              PROBE_FAIL: 'false',
              PROBE_RUNNERS: '[]',
            },
          },
        );
        assert.equal(result.status, 1, `expected ${bad} to fail`);
        assert.match(
          result.stderr,
          /needs a positive integer review-day runner count/,
        );
      }
      assert.equal(readFileSync(log, 'utf8'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
