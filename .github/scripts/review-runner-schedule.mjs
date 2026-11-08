#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Switch all online hk1/hk2 runners between review and CI, twice a day.
// `day` keeps a named handful on `ecs-review` so reviews start during the
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
const FLEET_NAME = /^ecs-qwen-hk[12]-\d+$/;

const MODES = ['review', 'day', 'ci'];

// `dayKeep` is the runner-name list that stays on `ecs-review` in `day` mode.
// Every other managed runner then serves CI, so the daytime review capacity is
// exactly those runners and never the whole fleet.
export function planLabels(runners, mode, dayKeep = []) {
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  if (mode === 'day') {
    if (!dayKeep.length) {
      throw new Error('mode day needs at least one review-day runner name');
    }
    // Typo defence: a name that matches no registered hk1/hk2 runner would
    // silently shrink the daytime pool every morning. Offline runners stay
    // allowed — they keep their labels and rejoin when they come back.
    const registered = new Set(
      runners.filter((r) => FLEET_NAME.test(r.name)).map((r) => r.name),
    );
    const unknown = dayKeep.filter((name) => !registered.has(name));
    if (unknown.length) {
      throw new Error(
        `review-day runner names match no registered hk1/hk2 runner: ${unknown.join(', ')}`,
      );
    }
  }
  const keep = new Set(mode === 'day' ? dayKeep : []);
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
      'usage: review-runner-schedule.mjs <owner/repo> <review|day|ci> [review-day runner names]',
    );
  }
  const dayKeep = rest.join(' ').split(/\s+/).filter(Boolean);
  // Validate the mode (and the day list shape) before spending an
  // authenticated call on it.
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  if (mode === 'day' && !dayKeep.length) {
    throw new Error('mode day needs at least one review-day runner name');
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
    throw new Error('no ecs-qwen-hk1-<n> or ecs-qwen-hk2-<n> runner found');
  }
  const actions = planLabels(runners, mode, dayKeep);
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
    `### hk1/hk2 runner pool: ${mode}`,
    ...(mode === 'day' ? [`- keeping on review: ${dayKeep.join(', ')}`] : []),
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
