#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Converges the runner labels on the managed ECS hosts to the time-of-day
// target, so the PR review pool is small while the model API is expensive
// (daytime) and full while it is cheap (night). Driven by
// .github/workflows/qwen-review-runner-schedule.yml every 15 minutes; every
// tick recomputes the whole target state from live runner data, so a missed
// or late cron tick costs nothing but delay.
//
// Three labels are managed, and only on runners whose name matches
// `ecs-qwen-<host>-<n>` for a host in QWEN_REVIEW_RUNNER_HOSTS:
//   ecs-review  the PR review job's pool (qwen-code-pr-review.yml review-pr)
//   ecs-qwen    the shared CI pool — lent to the non-review runners by day so
//               the throttled hosts are not idle (QWEN_REVIEW_DAY_LEND_CI)
//   ecs-agent   the autofix agent pool — never on a managed host, so the
//               night review burst does not share a box with autofix rounds
// Every other label (self-hosted, per-host, updater tags) is left alone.
//
// Removing a label never interrupts a running job: a runner that loses
// ecs-review finishes its review and simply takes no new one. That is the
// intended semantics of the day switch — in-flight reviews run to completion,
// new ones queue until the pool grows again. Growth is rate-limited
// (QWEN_REVIEW_RAMP_STEP per tick) so the night burst does not start every
// review's prebuild on one host in the same minute.

import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const REVIEW_LABEL = 'ecs-review';
export const CI_LABEL = 'ecs-qwen';
export const AGENT_LABEL = 'ecs-agent';
export const MODES = new Set(['auto', 'day', 'night', 'off']);
export const REVIEW_WORKFLOW_FILE = 'qwen-code-pr-review.yml';

const DEFAULTS = Object.freeze({
  mode: 'auto',
  timeZone: 'Asia/Shanghai',
  nightStart: 22,
  nightEnd: 3,
  dayRunners: 2,
  nightRunners: 32,
  rampStep: 8,
  hosts: ['hk2'],
  lendCi: true,
});

function intOr(value, fallback, { min, max }) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,4}$/.test(text)) return fallback;
  const n = Number(text);
  if (n < min || n > max) return fallback;
  return n;
}

// Env → config. Every knob is a repository variable so the schedule can be
// retuned without a code change; an unparseable value falls back to its
// default and is reported, never silently applied as 0.
export function readConfig(env = process.env) {
  const notes = [];
  const pick = (name, fallback, bounds) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const value = intOr(raw, fallback, bounds);
    if (String(value) !== String(raw).trim()) {
      notes.push(
        `${name}=${JSON.stringify(raw)} is not a valid integer in [${bounds.min}, ${bounds.max}]; using ${fallback}`,
      );
    }
    return value;
  };
  const modeRaw = String(env.QWEN_REVIEW_SCHEDULE_MODE ?? '')
    .trim()
    .toLowerCase();
  let mode = DEFAULTS.mode;
  if (modeRaw !== '') {
    if (MODES.has(modeRaw)) mode = modeRaw;
    else
      notes.push(
        `QWEN_REVIEW_SCHEDULE_MODE=${JSON.stringify(env.QWEN_REVIEW_SCHEDULE_MODE)} is not one of ${[...MODES].join('|')}; using ${DEFAULTS.mode}`,
      );
  }
  const hostsRaw = String(env.QWEN_REVIEW_RUNNER_HOSTS ?? '').trim();
  const hosts =
    hostsRaw === ''
      ? DEFAULTS.hosts
      : hostsRaw
          .split(',')
          .map((h) => h.trim())
          .filter((h) => /^[a-z0-9]+$/i.test(h));
  if (hostsRaw !== '' && hosts.length === 0) {
    notes.push(
      `QWEN_REVIEW_RUNNER_HOSTS=${JSON.stringify(hostsRaw)} names no valid host; using ${DEFAULTS.hosts.join(',')}`,
    );
  }
  const lendRaw = String(env.QWEN_REVIEW_DAY_LEND_CI ?? '')
    .trim()
    .toLowerCase();
  const lendCi = lendRaw === '' ? DEFAULTS.lendCi : lendRaw !== 'false';
  const timeZone =
    String(env.QWEN_REVIEW_TIMEZONE ?? '').trim() || DEFAULTS.timeZone;
  return {
    mode,
    timeZone,
    nightStart: pick('QWEN_REVIEW_NIGHT_START', DEFAULTS.nightStart, {
      min: 0,
      max: 23,
    }),
    nightEnd: pick('QWEN_REVIEW_NIGHT_END', DEFAULTS.nightEnd, {
      min: 0,
      max: 23,
    }),
    dayRunners: pick('QWEN_REVIEW_DAY_RUNNERS', DEFAULTS.dayRunners, {
      min: 0,
      max: 999,
    }),
    nightRunners: pick('QWEN_REVIEW_NIGHT_RUNNERS', DEFAULTS.nightRunners, {
      min: 0,
      max: 999,
    }),
    rampStep: pick('QWEN_REVIEW_RAMP_STEP', DEFAULTS.rampStep, {
      min: 1,
      max: 999,
    }),
    hosts: hosts.length ? hosts : DEFAULTS.hosts,
    lendCi,
    notes,
  };
}

// Wall-clock hour (0-23) in the schedule's time zone. Intl, not a UTC offset,
// so a zone with DST would still be right; China has none, but the knob is a
// variable and someone may point it elsewhere.
export function currentHour(date = new Date(), timeZone = DEFAULTS.timeZone) {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(date);
  const hour = Number(text);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(
      `could not read the hour in ${timeZone}: ${JSON.stringify(text)}`,
    );
  }
  return hour;
}

// [start, end) on a 24-hour ring: 22..3 means 22,23,0,1,2. start == end is
// an empty window (never night), not a full one — an operator who wants
// always-night sets the mode to `night`.
export function isNight(hour, start, end) {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function resolvePhase({ mode, hour, config }) {
  if (mode === 'off') return { phase: 'off', target: null };
  if (mode === 'day') return { phase: 'day', target: config.dayRunners };
  if (mode === 'night') return { phase: 'night', target: config.nightRunners };
  const night = isNight(hour, config.nightStart, config.nightEnd);
  return night
    ? { phase: 'night', target: config.nightRunners }
    : { phase: 'day', target: config.dayRunners };
}

export function managedRunnerPattern(hosts) {
  const alternatives = hosts
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`^ecs-qwen-(?:${alternatives})-\\d+$`, 'i');
}

export function managedRunners(runners, hosts) {
  const pattern = managedRunnerPattern(hosts);
  return runners.filter((r) => pattern.test(String(r.name ?? '')));
}

const byName = (a, b) =>
  String(a.name).localeCompare(String(b.name), 'en', { numeric: true });
const hasLabel = (runner, label) =>
  (runner.labels ?? []).some(
    (l) => (typeof l === 'string' ? l : l?.name) === label,
  );
const labelNames = (runner) =>
  (runner.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);

// Pure planner: which labels to add/remove on each managed runner to reach
// `target` review runners. Returned actions are idempotent against the input
// state — a runner already in its wanted state yields no action.
//
// Shrinking keeps BUSY review runners and releases idle ones first: a busy
// one is mid-review and finishes either way, so releasing it would only
// let an idle runner start a new review on top — the day pool would
// overshoot until the tail drained. Growing prefers IDLE runners so the new
// capacity is usable this tick, and is capped at `rampStep` per tick.
export function planLabels({ runners, target, rampStep, lendCi }) {
  const online = runners.filter((r) => r.status === 'online').sort(byName);
  const offline = runners.filter((r) => r.status !== 'online').sort(byName);
  const current = online.filter((r) => hasLabel(r, REVIEW_LABEL));
  let keep;
  let add = [];
  if (current.length > target) {
    keep = [...current]
      .sort(
        (a, b) =>
          Number(Boolean(b.busy)) - Number(Boolean(a.busy)) || byName(a, b),
      )
      .slice(0, target);
  } else {
    keep = current;
    const need = target - current.length;
    if (need > 0) {
      add = online
        .filter((r) => !hasLabel(r, REVIEW_LABEL))
        .sort(
          (a, b) =>
            Number(Boolean(a.busy)) - Number(Boolean(b.busy)) || byName(a, b),
        )
        .slice(0, Math.min(need, rampStep));
    }
  }
  const reviewIds = new Set([...keep, ...add].map((r) => r.id));
  const actions = [];
  const want = (runner, wanted) => {
    const have = new Set(labelNames(runner));
    const toAdd = [];
    const toRemove = [];
    for (const [label, on] of Object.entries(wanted)) {
      if (on && !have.has(label)) toAdd.push(label);
      if (!on && have.has(label)) toRemove.push(label);
    }
    if (toAdd.length || toRemove.length) {
      actions.push({
        id: runner.id,
        name: runner.name,
        busy: Boolean(runner.busy),
        add: toAdd,
        remove: toRemove,
      });
    }
  };
  for (const runner of online) {
    const inPool = reviewIds.has(runner.id);
    want(runner, {
      [REVIEW_LABEL]: inPool,
      [CI_LABEL]: !inPool && lendCi,
      [AGENT_LABEL]: false,
    });
  }
  // An offline runner carries no managed label: it comes back neutral and
  // the next tick places it, instead of reappearing as an unplanned review
  // (or agent) slot.
  for (const runner of offline) {
    want(runner, {
      [REVIEW_LABEL]: false,
      [CI_LABEL]: false,
      [AGENT_LABEL]: false,
    });
  }
  return {
    target,
    online: online.length,
    offline: offline.length,
    reviewBefore: current.length,
    reviewAfter: reviewIds.size,
    reviewBusy: online.filter((r) => reviewIds.has(r.id) && r.busy).length,
    pending: Math.max(0, target - reviewIds.size),
    reviewRunners: online.filter((r) => reviewIds.has(r.id)).map((r) => r.name),
    actions,
  };
}

async function gh(args, { token, allowFailure = false } = {}) {
  try {
    const { stdout } = await execFile('gh', args, {
      env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

async function listRunners(repo, token) {
  const out = await gh(
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/runners?per_page=100`,
      '--jq',
      '[.[].runners[]]',
    ],
    { token },
  );
  const runners = JSON.parse(out);
  if (!Array.isArray(runners))
    throw new Error('runner listing did not return an array');
  return runners.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    busy: Boolean(r.busy),
    labels: (r.labels ?? []).map((l) => l.name),
  }));
}

// Best-effort observability: how many automatic review runs are live
// (queued for a runner or executing). Subtracting the busy review runners
// approximates the queue depth — the number the schedule variables should
// be tuned against. Read with the workflow's own token; never fails the tick.
async function liveReviewRuns(repo, token) {
  if (!token) return null;
  let total = 0;
  for (const status of ['queued', 'in_progress']) {
    const out = await gh(
      [
        'api',
        `repos/${repo}/actions/workflows/${REVIEW_WORKFLOW_FILE}/runs?status=${status}&event=pull_request_target&per_page=1`,
        '--jq',
        '.total_count',
      ],
      { token, allowFailure: true },
    );
    if (out === null) return null;
    const n = Number(String(out).trim());
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return total;
}

async function applyActions(repo, token, actions, dryRun) {
  const failures = [];
  for (const action of actions) {
    for (const label of action.remove) {
      if (dryRun) continue;
      try {
        await gh(
          [
            'api',
            '--method',
            'DELETE',
            `repos/${repo}/actions/runners/${action.id}/labels/${encodeURIComponent(label)}`,
          ],
          { token },
        );
      } catch (error) {
        failures.push(`${action.name}: -${label}: ${error.message}`);
      }
    }
    if (action.add.length && !dryRun) {
      try {
        const fields = action.add.flatMap((label) => [
          '-f',
          `labels[]=${label}`,
        ]);
        await gh(
          [
            'api',
            '--method',
            'POST',
            `repos/${repo}/actions/runners/${action.id}/labels`,
            ...fields,
          ],
          { token },
        );
      } catch (error) {
        failures.push(
          `${action.name}: +${action.add.join(',')}: ${error.message}`,
        );
      }
    }
  }
  return failures;
}

function parseArgs(argv) {
  const args = { repo: '', mode: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') args.repo = argv[++i] ?? '';
    else if (arg === '--mode') args.mode = argv[++i] ?? '';
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo))
    throw new Error('--repo owner/name is required');
  return args;
}

function renderSummary({ config, hour, phase, plan, live, dryRun, failures }) {
  const lines = [];
  lines.push(
    `### Review runner schedule — ${phase.phase}${dryRun ? ' (dry run)' : ''}`,
  );
  lines.push('');
  lines.push(
    `- Time: ${String(hour).padStart(2, '0')}:xx ${config.timeZone}; night window ${config.nightStart}:00–${config.nightEnd}:00; mode \`${config.mode}\``,
  );
  if (phase.phase === 'off') {
    lines.push(
      '- Schedule disabled (`QWEN_REVIEW_SCHEDULE_MODE=off`); no labels touched.',
    );
  } else {
    lines.push(
      `- Hosts: ${config.hosts.join(', ')} — ${plan.online} online, ${plan.offline} offline`,
    );
    lines.push(
      `- \`${REVIEW_LABEL}\` runners: ${plan.reviewBefore} → ${plan.reviewAfter} (target ${plan.target}${plan.pending ? `, ${plan.pending} more next ticks` : ''}); ${plan.reviewBusy} busy`,
    );
    if (live !== null && live !== undefined) {
      lines.push(
        `- Live automatic review runs: ${live} (≈ ${Math.max(0, live - plan.reviewBusy)} waiting for a runner)`,
      );
    }
    lines.push(`- Day lends \`${CI_LABEL}\`: ${config.lendCi}`);
    lines.push(`- Label changes: ${plan.actions.length}`);
    for (const action of plan.actions) {
      const parts = [
        ...action.add.map((l) => `+${l}`),
        ...action.remove.map((l) => `-${l}`),
      ];
      lines.push(
        `  - ${action.name}${action.busy ? ' (busy)' : ''}: ${parts.join(' ')}`,
      );
    }
  }
  for (const note of config.notes) lines.push(`- ⚠️ ${note}`);
  for (const failure of failures) lines.push(`- ❌ ${failure}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig(process.env);
  if (args.mode) {
    if (!MODES.has(args.mode))
      throw new Error(`--mode must be one of ${[...MODES].join('|')}`);
    config.mode = args.mode;
  }
  const adminToken = String(process.env.RUNNER_ADMIN_TOKEN ?? '').trim();
  const hour = currentHour(new Date(), config.timeZone);
  const phase = resolvePhase({ mode: config.mode, hour, config });
  let plan = null;
  let live = null;
  let failures = [];
  if (phase.phase !== 'off') {
    // Fail LOUD without the admin token: a silently no-op schedule leaves the
    // labels frozen in whichever phase they were in — an all-day night pool
    // or an all-night day pool — which is the worst state, not a safe one.
    if (!adminToken) {
      throw new Error(
        'RUNNER_ADMIN_TOKEN is empty — the runner-label API needs a PAT with repository Administration: write',
      );
    }
    const all = await listRunners(args.repo, adminToken);
    const runners = managedRunners(all, config.hosts);
    if (runners.length === 0) {
      throw new Error(
        `no registered runner matches ecs-qwen-(${config.hosts.join('|')})-<n>; refusing to run against an empty host list`,
      );
    }
    plan = planLabels({
      runners,
      target: phase.target,
      rampStep: config.rampStep,
      lendCi: config.lendCi,
    });
    live = await liveReviewRuns(
      args.repo,
      String(process.env.GH_TOKEN ?? '').trim(),
    );
    failures = await applyActions(
      args.repo,
      adminToken,
      plan.actions,
      args.dryRun,
    );
  }
  const summary = renderSummary({
    config,
    hour,
    phase,
    plan,
    live,
    dryRun: args.dryRun,
    failures,
  });
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (failures.length) {
    throw new Error(
      `${failures.length} label change(s) failed; see the summary`,
    );
  }
}

const invokedDirectly = (() => {
  try {
    return (
      import.meta.url === new URL(`file://${process.argv[1]}`).href ||
      process.argv[1]?.endsWith('review-runner-schedule.mjs')
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
