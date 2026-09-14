#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Sizes the PR review runner pool by time of day. Run every 15 minutes by
// .github/workflows/qwen-review-runner-schedule.yml; each run recomputes the
// target from live runner data, so a late or skipped tick only delays it.
//
// On the hk2 runners: inside [QWEN_REVIEW_NIGHT_START, QWEN_REVIEW_NIGHT_END)
// (Asia/Shanghai) every online runner carries `ecs-review`; outside it only
// QWEN_REVIEW_DAY_RUNNERS do and the rest carry `ecs-qwen` so they run CI
// instead of idling. `ecs-agent` (autofix) never stays on hk2. Removing a
// label does not interrupt a running job, so in-flight reviews finish.

import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const REVIEW_LABEL = 'ecs-review';
export const CI_LABEL = 'ecs-qwen';
export const AGENT_LABEL = 'ecs-agent';
const RUNNER_NAME = /^ecs-qwen-hk2-\d+$/;
const TIME_ZONE = 'Asia/Shanghai';
// Runners added to the review pool per tick, so the night burst does not
// start every review's prebuild on one host in the same minute.
export const RAMP_STEP = 8;

// A repository variable as an integer in [0, max], or null when it is unset
// or malformed. "0" is a real value (QWEN_REVIEW_DAY_RUNNERS=0: none by day),
// so this never tests truthiness.
export function intVar(value, max) {
  const text = String(value ?? '').trim();
  return /^\d{1,3}$/.test(text) && Number(text) <= max ? Number(text) : null;
}

export function hourIn(date, timeZone = TIME_ZONE) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date),
  );
}

// [start, end) on a 24-hour clock; 17..5 covers 17:00 through 04:59.
export function isNight(hour, start, end) {
  // Equal start and end means daytime mode all day.
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

const has = (runner, label) => runner.labels.includes(label);
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });

// Label changes that bring the online runners to `target` review runners.
// Shrinking keeps busy review runners (they finish either way) and releases
// idle ones; growing takes idle runners first, at most RAMP_STEP per tick.
export function planLabels(runners, target) {
  const online = runners.filter((r) => r.status === 'online').sort(byName);
  const current = online.filter((r) => has(r, REVIEW_LABEL));
  let pool;
  if (current.length >= target) {
    pool = [...current]
      .sort((a, b) => b.busy - a.busy || byName(a, b))
      .slice(0, target);
  } else {
    const grow = online
      .filter((r) => !has(r, REVIEW_LABEL))
      .sort((a, b) => a.busy - b.busy || byName(a, b))
      .slice(0, Math.min(target - current.length, RAMP_STEP));
    pool = [...current, ...grow];
  }
  const inPool = new Set(pool.map((r) => r.id));
  return online.flatMap((r) => {
    const want = {
      [REVIEW_LABEL]: inPool.has(r.id),
      [CI_LABEL]: !inPool.has(r.id),
      [AGENT_LABEL]: false,
    };
    const add = Object.keys(want).filter((l) => want[l] && !has(r, l));
    const remove = Object.keys(want).filter((l) => !want[l] && has(r, l));
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
  const repo = process.argv[2];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error('usage: review-runner-schedule.mjs <owner/repo>');
  }
  // The workflow supplies every value (its default, or the repository
  // variable that overrides it); the script has no defaults of its own. A
  // missing or malformed value fails the run by name, as does a missing
  // token: a silent no-op would freeze the labels in whichever phase they
  // are in.
  const schedule = {
    QWEN_REVIEW_NIGHT_START: intVar(process.env.QWEN_REVIEW_NIGHT_START, 23),
    QWEN_REVIEW_NIGHT_END: intVar(process.env.QWEN_REVIEW_NIGHT_END, 23),
    QWEN_REVIEW_DAY_RUNNERS: intVar(process.env.QWEN_REVIEW_DAY_RUNNERS, 999),
  };
  const bad = Object.keys(schedule).filter((k) => schedule[k] === null);
  if (bad.length) {
    throw new Error(
      `unset or out-of-range repository variable: ${bad.join(', ')}`,
    );
  }
  const start = schedule.QWEN_REVIEW_NIGHT_START;
  const end = schedule.QWEN_REVIEW_NIGHT_END;
  const dayRunners = schedule.QWEN_REVIEW_DAY_RUNNERS;
  if (!process.env.RUNNER_ADMIN_TOKEN) {
    throw new Error(
      'RUNNER_ADMIN_TOKEN is empty (needs Administration: write)',
    );
  }

  // --slurp returns an array of pages; gh refuses it together with --jq.
  const pages = JSON.parse(
    await gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/runners?per_page=100`,
    ]),
  );
  const runners = pages
    .flatMap((page) => page.runners)
    .filter((r) => RUNNER_NAME.test(r.name))
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      busy: r.busy,
      labels: r.labels.map((l) => l.name),
    }));
  if (runners.length === 0) throw new Error('no ecs-qwen-hk2-<n> runner found');

  const hour = hourIn(new Date());
  const night = isNight(hour, start, end);
  const online = runners.filter((r) => r.status === 'online').length;
  const target = night ? online : Math.min(dayRunners, online);
  const actions = planLabels(runners, target);

  const failures = [];
  for (const { id, name, add, remove } of actions) {
    for (const label of remove) {
      await gh([
        'api',
        '--method',
        'DELETE',
        `repos/${repo}/actions/runners/${id}/labels/${label}`,
      ]).catch((e) => failures.push(`${name} -${label}: ${e.message}`));
    }
    if (add.length) {
      await gh([
        'api',
        '--method',
        'POST',
        `repos/${repo}/actions/runners/${id}/labels`,
        ...add.flatMap((l) => ['-f', `labels[]=${l}`]),
      ]).catch((e) => failures.push(`${name} +${add}: ${e.message}`));
    }
  }

  const summary = [
    `### Review runners: ${night ? 'night' : 'day'} (${hour}:xx ${TIME_ZONE}, night ${start}:00–${end}:00)`,
    `- target ${target} \`${REVIEW_LABEL}\` of ${online} online hk2 runners`,
    ...actions.map(
      (a) =>
        `- ${a.name}: ${[...a.add.map((l) => `+${l}`), ...a.remove.map((l) => `-${l}`)].join(' ')}`,
    ),
    ...failures.map((f) => `- failed: ${f}`),
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (failures.length)
    throw new Error(`${failures.length} label change(s) failed`);
}

if (process.argv[1]?.endsWith('review-runner-schedule.mjs')) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
