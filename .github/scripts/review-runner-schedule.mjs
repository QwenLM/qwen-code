#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Switch all online hk1/hk2 runners between review and CI, twice a day.
// Offline runners are skipped; their labels stay unchanged.
// Running jobs finish normally; labels only control which job starts next.

import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MANAGED_LABELS = ['ecs-review', 'ecs-qwen'];

export function planLabels(runners, mode) {
  if (!['review', 'ci'].includes(mode)) {
    throw new Error('mode must be review or ci');
  }
  const target = mode === 'review' ? 'ecs-review' : 'ecs-qwen';
  return runners
    .filter(
      (r) => r.status === 'online' && /^ecs-qwen-hk[12]-\d+$/.test(r.name),
    )
    .flatMap((r) => {
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
  const [repo, mode] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error(
      'usage: review-runner-schedule.mjs <owner/repo> <review|ci>',
    );
  }
  planLabels([], mode);
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
  if (!runners.some((r) => /^ecs-qwen-hk[12]-\d+$/.test(r.name))) {
    throw new Error('no ecs-qwen-hk1-<n> or ecs-qwen-hk2-<n> runner found');
  }
  const actions = planLabels(runners, mode);
  const results = await Promise.all(
    actions.map(async ({ id, name, add, remove }) => {
      try {
        // Add before removing, so a failure can only leave the host in both
        // pools. The reverse order lets a failed POST strand the host with
        // no pool label at all — no job in either pool can match it until
        // the next successful switch, which can be 12 hours away.
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
