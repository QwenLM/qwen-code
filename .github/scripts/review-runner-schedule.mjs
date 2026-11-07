#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Switch the managed runner fleet between review and CI, twice a day.
// `day` keeps a configured count on `ecs-review` so reviews start during the
// daytime too, and returns the rest of the fleet to CI.
// Offline runners are skipped; their labels stay unchanged.
// Running jobs finish normally; labels only control which job starts next.

import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MANAGED_LABELS = ['ecs-review', 'ecs-qwen'];
// Labels that mark a runner as dedicated to a non-review workload (release
// hosts, benchmarking, etc). They must never receive an `ecs-review` or
// `ecs-qwen` label, so the planner filters them out by name pattern.
const EXCLUDED_LABELS = new Set(['ecs-qwen-release-host']);
// Architecture the review workflow requires (`runs-on: [..., "x64"]`). A
// runner that lacks this label can never be assigned a review job, so it
// does not count toward daytime review capacity.
const REQUIRED_ARCH_LABEL = 'x64';

const MODES = ['review', 'day', 'ci'];

// Compile the fleet-name regex from configuration, never from a hardcoded
// region. Falling back to a restrictive default keeps a forgotten variable
// from silently widening the managed fleet on the next tick.
export function fleetNameFromEnv(env = process.env) {
  const source =
    env.QWEN_REVIEW_FLEET_NAME_PATTERN || '^ecs-qwen-hz[1-6]-\\d+$';
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(
      `QWEN_REVIEW_FLEET_NAME_PATTERN is not a valid regex: ${error.message}`,
    );
  }
}

// True when a runner is eligible to be managed by this schedule. Filters
// out: runners without the architecture the review workflow targets, and
// runners carrying a reserved label such as `ecs-qwen-release-host`.
export function isManagedRunner(runner, fleetName) {
  if (!fleetName.test(runner.name)) return false;
  const labels = runner.labels.map((l) => l.name.toLowerCase());
  if (!labels.includes(REQUIRED_ARCH_LABEL)) return false;
  return !labels.some((l) => EXCLUDED_LABELS.has(l));
}

// `dayCount` is how many runners stay on `ecs-review` in `day` mode. The
// fleet is sorted by name and the first `dayCount` online managed runners
// keep the label; every other managed runner then serves CI, so the daytime
// review capacity is exactly that count and never the whole fleet. Numeric
// sort (hz1-2 before hz1-10) keeps the pick deterministic across runs and
// across changes in runner count.
export function planLabels(runners, mode, dayCount = 0, fleetName) {
  const fleet = fleetName ?? fleetNameFromEnv();
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  const eligible = runners.filter((r) => isManagedRunner(r, fleet));
  if (mode === 'day') {
    if (!Number.isInteger(dayCount) || dayCount < 1) {
      throw new Error(
        'mode day needs a positive integer review-day runner count',
      );
    }
  }
  const sorted = eligible
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const onlineSorted = sorted.filter((r) => r.status === 'online');
  // Soft cap: an over-large count truncates to whatever is online, with a
  // warning the operator can read in the run summary. Hard-failing here
  // would leave every runner in its previous pool (potentially the whole
  // fleet on review at 05:00) until somebody notices.
  const effectiveDayCount =
    mode === 'day' ? Math.min(dayCount, onlineSorted.length) : 0;
  const truncated = mode === 'day' && dayCount > onlineSorted.length;
  const keep = new Set(
    mode === 'day'
      ? onlineSorted.slice(0, effectiveDayCount).map((r) => r.name)
      : [],
  );
  const actions = eligible
    .filter((r) => r.status === 'online')
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
  return {
    actions,
    keptNames: mode === 'day' ? [...keep] : [],
    truncated,
    requestedDayCount: dayCount,
    effectiveDayCount,
    onlineManaged: onlineSorted.length,
  };
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
  if (!MODES.includes(mode)) {
    throw new Error('mode must be review, day or ci');
  }
  // Strict integer parse: `Number.parseInt` accepts trailing garbage (`4O`,
  // `40.9`, `1e2` all silently coerce), which would silently shrink the
  // daytime pool — the exact property this var is supposed to defend.
  const rawCount = rest.join(' ').trim();
  let dayCount = 0;
  if (mode === 'day') {
    if (!/^\d+$/.test(rawCount)) {
      throw new Error(
        'mode day needs a positive integer review-day runner count',
      );
    }
    dayCount = Number(rawCount);
    if (!Number.isSafeInteger(dayCount) || dayCount < 1) {
      throw new Error(
        'mode day needs a positive integer review-day runner count',
      );
    }
  }
  if (!process.env.RUNNER_ADMIN_TOKEN) {
    throw new Error(
      'RUNNER_ADMIN_TOKEN is empty (needs Administration: write)',
    );
  }
  const fleetName = fleetNameFromEnv();
  const pages = JSON.parse(
    await gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/runners?per_page=100`,
    ]),
  );
  const runners = pages.flatMap((page) => page.runners);
  if (!runners.some((r) => isManagedRunner(r, fleetName))) {
    throw new Error(
      `no runner matches QWEN_REVIEW_FLEET_NAME_PATTERN (${fleetName.source})`,
    );
  }
  const plan = planLabels(runners, mode, dayCount, fleetName);
  const results = await Promise.all(
    plan.actions.map(async ({ id, name, add, remove }) => {
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
    `### runner pool: ${mode}`,
    `- fleet pattern: \`${fleetName.source}\``,
    ...(mode === 'day'
      ? [
          `- keeping on review (${plan.effectiveDayCount}${
            plan.truncated ? ` of requested ${plan.requestedDayCount}` : ''
          }):`,
          ...plan.keptNames.map((name) => `  - ${name}`),
        ]
      : []),
    ...(plan.truncated
      ? [
          `- ::warning::requested ${plan.requestedDayCount} day runners but only ${plan.onlineManaged} are online — pool truncated`,
        ]
      : []),
    `- ${plan.actions.length} runners to switch`,
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
