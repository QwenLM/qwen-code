#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Switch all online hz1-hz6 runners between review and CI, twice a day.
// `day` keeps a configured count on `ecs-review` so reviews start during the
// daytime too, and returns the rest of the fleet to CI.
// Offline runners are skipped; their labels stay unchanged.
// Running jobs finish normally; labels only control which job starts next.

import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MANAGED_LABELS = ['ecs-review', 'ecs-qwen'];
// One literal for both the switch filter and the fleet guard below: the
// guard's whole job is to prove the filter will match something, so two
// copies that can drift would reintroduce the silent no-op it prevents.
const FLEET_NAME = /^ecs-qwen-hz[1-6]-\d+$/;

const MODES = ['review', 'day', 'ci'];

// `dayCount` is how many runners stay on `ecs-review` in `day` mode. The
// fleet is sorted by name and the first `dayCount` online runners keep the
// label; every other managed runner then serves CI, so the daytime review
// capacity is exactly that count and never the whole fleet. Numeric sort
// (hz1-2 before hz1-10) keeps the pick deterministic across runs and across
// changes in runner count.
export function planLabels(runners, mode, dayCount = 0) {
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  if (mode === 'day') {
    if (!Number.isInteger(dayCount) || dayCount < 1) {
      throw new Error(
        'mode day needs a positive integer review-day runner count',
      );
    }
    const online = runners.filter(
      (r) => r.status === 'online' && FLEET_NAME.test(r.name),
    );
    // Loud cap: a count larger than the online fleet would silently shrink
    // the daytime pool every morning. Better to fail the schedule and let
    // the operator lower the var than to drift to whatever happens to be
    // online.
    if (dayCount > online.length) {
      throw new Error(
        `review-day runner count ${dayCount} exceeds online fleet of ${online.length}`,
      );
    }
  }
  const sorted = runners
    .filter((r) => FLEET_NAME.test(r.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const keep = new Set(
    mode === 'day'
      ? sorted
          .filter((r) => r.status === 'online')
          .slice(0, dayCount)
          .map((r) => r.name)
      : [],
  );
  return runners
    .filter((r) => r.status === 'online' && FLEET_NAME.test(r.name))
    .flatMap((r) => {
      const target =
        mode === 'review' || keep.has(r.name) ? 'ecs-review' : 'ecs-qwen';
      const labels = r.labels.map((l) => l.name);
      const remove = labels.filter(
        (l) => MANAGED_LABELS.includes(l) && l !== target,
      );
      const add = labels.includes(target) ? [] : [target];
      return add.length || remove.length
        ? [{ id: r.id, name: r.name, add, remove }]
        : [];
    });
}

async function gh(args) {
  const { stdout } = await execFile('gh', args, {
    env: { ...process.env, GH_TOKEN: process.env.RUNNER_ADMIN_TOKEN },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  const [repo, mode, ...rest] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error(
      'usage: review-runner-schedule.mjs <owner/repo> <review|day|ci> [review-day runner count]',
    );
  }
  const dayCount = rest.length === 0 ? 0 : Number.parseInt(rest.join(' '), 10);
  // Validate the mode (and the day count shape) before spending an
  // authenticated call on it.
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  if (mode === 'day' && (!Number.isInteger(dayCount) || dayCount < 1)) {
    throw new Error(
      'mode day needs a positive integer review-day runner count',
    );
  }
  if (!process.env.RUNNER_ADMIN_TOKEN) {
    throw new Error(
      'RUNNER_ADMIN_TOKEN is empty (needs Administration: write)',
    );
  }
  const pages = JSON.parse(
    await gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/runners?per_page=100`,
    ]),
  );
  const runners = pages.flatMap((page) => page.runners);
  if (!runners.some((r) => FLEET_NAME.test(r.name))) {
    throw new Error('no ecs-qwen-hz[1-6]-<n> runner found');
  }
  const actions = planLabels(runners, mode, dayCount);
  const results = await Promise.all(
    actions.map(async ({ id, name, add, remove }) => {
      try {
        // Add before removing. A failed POST leaves the host in its previous
        // pool only; a failed DELETE leaves it in both. Neither leaves it with
        // no pool label at all — the reverse order does, and the host then
        // matches no runs-on until the next successful switch (up to 12 hours)
        // or a manual dispatch. There is no periodic reconciliation.
        if (add.length) {
          await gh([
            'api',
            '--method',
            'POST',
            `repos/${repo}/actions/runners/${id}/labels`,
            ...add.flatMap((l) => ['-f', `labels[]=${l}`]),
          ]);
        }
        for (const label of remove) {
          await gh([
            'api',
            '--method',
            'DELETE',
            `repos/${repo}/actions/runners/${id}/labels/${label}`,
          ]);
        }
        return {
          message: `- ${name}: ${[...remove.map((l) => `−${l}`), ...add.map((l) => `+${l}`)].join(' ')}`,
        };
      } catch (error) {
        return {
          failed: true,
          message: `- ${name}: failed — ${error.message}`,
        };
      }
    }),
  );
  const summary = [
    `### hz runner pool: ${mode}`,
    ...(mode === 'day'
      ? [`- keeping on review: first ${dayCount} runners`]
      : []),
    `- ${actions.length} runners to switch`,
    ...results.map((r) => r.message),
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  const failures = results.filter((r) => r.failed).length;
  if (failures) throw new Error(`${failures} runner label change(s) failed`);
}

if (process.argv[1]?.endsWith('review-runner-schedule.mjs')) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
