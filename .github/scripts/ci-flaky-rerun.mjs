#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_ACTIVE_DAYS = 7;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 5;
const MAX_ACTIONS_PER_HEAD = 3;
const MARKER = 'qwen-ci-flaky-rerun';

function timeMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

function runIdFromUrl(url) {
  const match = String(url ?? '').match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function jobIdFromUrl(url) {
  const match = String(url ?? '').match(/\/jobs?\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function markerFor(target, action, failureKey, count) {
  const check = encodeURIComponent(target.workflowName);
  return `<!-- ${MARKER} v=2 pr=${target.prNumber} head=${target.headSha} run=${target.runId} action=${action} key=${failureKey} check=${check} count=${count} -->`;
}

function markerComments(pr, options = {}) {
  const logins = options.trustedMarkerLogins;
  return (pr?.comments ?? []).filter(
    (comment) =>
      !logins || logins.includes(String(comment.author?.login ?? '')),
  );
}

function alreadyHandled(pr, target, options) {
  const pattern = new RegExp(
    `<!-- ${MARKER} v=\\d+ pr=${target.prNumber} head=${target.headSha} run=${target.runId}(?: | )`,
  );
  return markerComments(pr, options).some((comment) =>
    pattern.test(String(comment.body ?? '')),
  );
}

function isRecentlyActive(pr, now, activeDays) {
  return timeMs(now) - timeMs(pr.updatedAt) <= activeDays * 24 * 60 * 60_000;
}

function canAct(pr, target, options) {
  return !alreadyHandled(pr, target, options);
}

function failureKey(decision) {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(decision?.failureKey ?? '')
    ? decision.failureKey
    : 'unknown';
}

function stateMarkers(comments, prNumber) {
  const marker = new RegExp(
    `<!-- ${MARKER} v=2 pr=${prNumber} head=(\\S+) run=(\\d+) action=(\\S+) key=([a-z0-9._-]+) check=(\\S+) count=(\\d+) -->`,
  );
  return comments
    .filter((comment) =>
      ['qwen-code-ci-bot', 'github-actions[bot]'].includes(
        String(comment.author?.login ?? ''),
      ),
    )
    .map((comment) => {
      const match = marker.exec(String(comment.body ?? ''));
      if (!match) return null;
      return {
        headSha: match[1],
        runId: Number(match[2]),
        action: match[3],
        key: match[4],
        check: decodeURIComponent(match[5]),
        count: Number(match[6]),
        createdAt: comment.createdAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
}

function redactLogLine(line) {
  return line
    .replace(/^(?:Set-)?Cookie:\s*.*/i, 'Cookie: [redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(Authorization:\s*)\S+(?:\s+\S+)?/gi, '$1[redacted]')
    .replace(
      /(?:gh[pousr]_|github_pat_|glpat-|xox[b]-|xox[p]-)[A-Za-z0-9_-]{20,}/g,
      '[redacted]',
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9-]{20,}/g, 'sk-[redacted]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[redacted]')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^/\s]+@)+/gi, '$1[redacted]@');
}

function skillLog(log) {
  const lines = log.slice(-20_000).split('\n');
  const selected = new Set();
  for (const [index, line] of lines.entries()) {
    if (
      /(error|failed|failure|exception|timeout|timed out|network|download|assertion|lint|typecheck)/i.test(
        line,
      )
    ) {
      for (let offset = 0; offset < 4; offset += 1)
        selected.add(index + offset);
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter((line) => line !== undefined)
    .slice(-200)
    .map(redactLogLine)
    .join('\n');
}

function isStaleFailure(run, now, staleMinutes) {
  if (run.status !== 'COMPLETED') return false;
  if (run.conclusion !== 'FAILURE') return false;
  return timeMs(now) - timeMs(run.completedAt) >= staleMinutes * 60_000;
}

function toTarget(pr, run) {
  const runId = runIdFromUrl(run.detailsUrl);
  if (runId === null) return null;
  return {
    prNumber: pr.number,
    headSha: pr.headRefOid,
    runId,
    jobId: jobIdFromUrl(run.detailsUrl),
    workflowName: run.name,
    detailsUrl: run.detailsUrl,
    completedAt: run.completedAt,
  };
}

export function selectCandidateTargets(prs, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  const targets = [];

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.baseRefName !== 'main') continue;
    if (!isRecentlyActive(pr, now, activeDays)) continue;
    for (const run of pr.statusCheckRollup ?? []) {
      if (!isStaleFailure(run, now, staleMinutes)) continue;
      const target = toTarget(pr, run);
      if (!target) continue;
      targets.push(target);
    }
  }

  const seenPrs = new Set();
  return targets
    .sort((a, b) => timeMs(b.completedAt) - timeMs(a.completedAt))
    .filter((target) => {
      if (seenPrs.has(target.prNumber)) return false;
      seenPrs.add(target.prNumber);
      return true;
    })
    .sort((a, b) => timeMs(a.completedAt) - timeMs(b.completedAt));
}

export function selectTarget(prs, options = {}) {
  return (
    selectCandidateTargets(prs, options).find((target) => {
      const pr = prs.find((candidate) => candidate.number === target.prNumber);
      return canAct(pr, target, options);
    }) ?? null
  );
}

export async function actOnDecision(client, target, decision) {
  if (!target) return;
  if (decision?.confidence !== 'high') return;
  if (!['rerun', 'update_branch', 'comment'].includes(decision.action)) return;
  if ((await client.currentHeadSha(target.prNumber)) !== target.headSha) return;
  if (!(await client.isCurrentFailure(target))) return;
  const key = failureKey(decision);
  const actionCount = await client.failureActionCount(target.prNumber, key);
  if (actionCount >= MAX_ACTIONS_PER_HEAD) return;
  const nextTarget = { ...target, actionCount };

  if (decision.action === 'rerun') {
    await client.rerunFailedJobs(target.runId);
    await client.comment(
      target.prNumber,
      [
        `Rerunning failed jobs because this failure looks flaky: ${decision.reason_en}`,
        '',
        markerFor(nextTarget, 'rerun', key, actionCount + 1),
      ].join('\n'),
    );
    return;
  }

  if (decision.action === 'update_branch') {
    if ((await client.behindBy(target.headSha)) <= 0) return;
    if (!Number.isSafeInteger(decision.mainRunId)) return;
    if (!(await client.mainRunSucceeded(decision.mainRunId))) return;
    await client.updateBranch(target.prNumber, target.headSha);
    await client.comment(
      target.prNumber,
      [
        'Requesting an update from main because this failure needs current main.',
        '',
        markerFor(nextTarget, 'update_branch', key, actionCount + 1),
      ].join('\n'),
    );
    return;
  }

  if (decision.action === 'comment') {
    await client.comment(
      target.prNumber,
      [
        decision.reason_en,
        '',
        '<details>',
        '<summary>中文说明</summary>',
        '',
        decision.reason_zh,
        '',
        '</details>',
        '',
        markerFor(nextTarget, 'comment', key, actionCount + 1),
      ].join('\n'),
    );
  }
}

export async function actOnDecisions(client, targets, decisions) {
  const targetsById = new Map(
    targets.map((target) => [
      `${target.prNumber}:${target.headSha}:${target.runId}`,
      target,
    ]),
  );
  for (const decision of decisions ?? []) {
    const target = targetsById.get(
      `${decision.prNumber}:${decision.headSha}:${decision.runId}`,
    );
    if (target) await actOnDecision(client, target, decision);
  }
}

export async function resetSuccessfulFailures(client, prs) {
  for (const pr of prs) {
    const states = new Map();
    for (const state of stateMarkers(await client.comments(pr.number), pr.number))
      states.set(state.key, state);
    for (const state of states.values()) {
      if (state.count === 0) continue;
      const run = (pr.statusCheckRollup ?? []).find(
        (check) =>
          check.name === state.check &&
          check.conclusion === 'SUCCESS' &&
          timeMs(check.completedAt) > timeMs(state.createdAt),
      );
      const target = run ? toTarget(pr, run) : null;
      if (target)
        await client.comment(
          pr.number,
          markerFor(target, 'reset', state.key, 0),
        );
    }
  }
}

export async function writeSkillInput(client, target, workdir) {
  writeJson(workdir, 'ci-target.json', target);
  const log = target.jobId === null ? '' : await client.jobLog(target.jobId);
  writeFileSync(resolve(workdir, 'ci-log.txt'), skillLog(log));
}

export async function writeSkillInputs(
  client,
  targets,
  workdir,
  maxCandidates = Infinity,
) {
  const candidates = [];
  for (const target of targets) {
    try {
      candidates.push({
        ...target,
        log:
          target.jobId === null
            ? ''
            : skillLog(await client.jobLog(target.jobId)),
      });
      if (candidates.length >= maxCandidates) break;
    } catch {
      // Expired Actions logs cannot be classified safely; try the next PR.
    }
  }
  writeJson(workdir, 'ci-flaky-input.json', { candidates });
  return candidates;
}

class GhClient {
  constructor(repo) {
    this.repo = repo;
  }

  async gh(args, options = {}) {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return stdout;
  }

  async prs(activeDays) {
    const activeSince = new Date(Date.now() - activeDays * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    return JSON.parse(
      await this.gh([
        'pr',
        'list',
        '--repo',
        this.repo,
        '--base',
        'main',
        '--state',
        'open',
        '--search',
        `updated:>=${activeSince} status:failure`,
        '--json',
        'number,isDraft,baseRefName,headRefOid,updatedAt,statusCheckRollup',
        '--limit',
        '1000',
      ]),
    );
  }

  async comments(prNumber) {
    return JSON.parse(
      await this.gh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        this.repo,
        '--json',
        'comments',
        '--jq',
        '.comments',
      ]),
    );
  }

  async failureActionCount(prNumber, key) {
    return (
      stateMarkers(await this.comments(prNumber), prNumber)
        .filter((state) => state.key === key)
        .at(-1)?.count ?? 0
    );
  }

  async markerPrs() {
    return JSON.parse(
      await this.gh([
        'pr',
        'list',
        '--repo',
        this.repo,
        '--state',
        'open',
        '--search',
        `${MARKER} in:comments`,
        '--json',
        'number,headRefOid,statusCheckRollup',
        '--limit',
        '1000',
      ]),
    );
  }

  async rerunFailedJobs(runId) {
    await this.gh([
      'api',
      '-X',
      'POST',
      `repos/${this.repo}/actions/runs/${runId}/rerun-failed-jobs`,
    ]);
  }

  async currentHeadSha(prNumber) {
    return (
      await this.gh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        this.repo,
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ])
    ).trim();
  }

  async isCurrentFailure(target) {
    const run = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.repo}/actions/runs/${target.runId}`,
      ]),
    );
    return (
      run.status === 'completed' &&
      run.conclusion === 'failure' &&
      run.head_sha === target.headSha
    );
  }

  async mainRunSucceeded(runId) {
    const run = JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}`]),
    );
    return (
      run.head_branch === 'main' &&
      run.status === 'completed' &&
      run.conclusion === 'success'
    );
  }

  async behindBy(headSha) {
    return Number(
      (
        await this.gh([
          'api',
          `repos/${this.repo}/compare/${headSha}...main`,
          '--jq',
          '.behind_by',
        ])
      ).trim(),
    );
  }

  async updateBranch(prNumber, headSha) {
    await this.gh([
      'api',
      '-X',
      'PUT',
      `repos/${this.repo}/pulls/${prNumber}/update-branch`,
      '-f',
      `expected_head_sha=${headSha}`,
    ]);
  }

  async comment(prNumber, body) {
    await this.gh([
      'pr',
      'comment',
      String(prNumber),
      '--repo',
      this.repo,
      '--body',
      body,
    ]);
  }

  async jobLog(jobId) {
    return this.gh(['api', `repos/${this.repo}/actions/jobs/${jobId}/logs`]);
  }
}

function argsMap(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args.set(argv[i].slice(2), argv[i + 1]);
    i += 1;
  }
  return args;
}

function writeJson(workdir, name, value) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(resolve(workdir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function scan(args) {
  const client = new GhClient(args.get('repo'));
  const activeDays = Number(args.get('active-days') ?? DEFAULT_ACTIVE_DAYS);
  const prs = await client.prs(activeDays);
  const candidates = selectCandidateTargets(prs, {
    staleMinutes: Number(args.get('stale-minutes') ?? DEFAULT_STALE_MINUTES),
    activeDays,
  });
  const trustedMarkerLogins = (args.get('trusted-marker-logins') ?? '')
    .split(',')
    .filter(Boolean);
  const options = { trustedMarkerLogins };
  const requestedMax = Number(args.get('max-candidates'));
  const maxCandidates =
    Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? requestedMax
      : DEFAULT_MAX_CANDIDATES_PER_RUN;
  const targets = [];
  for (const candidate of candidates) {
    const pr = prs.find((item) => item.number === candidate.prNumber);
    const comments = await client.comments(candidate.prNumber);
    if (!canAct({ ...pr, comments }, candidate, options)) continue;
    targets.push({
      ...candidate,
      behindBy: await client.behindBy(candidate.headSha),
    });
  }
  const inputs = await writeSkillInputs(
    client,
    targets,
    args.get('workdir'),
    maxCandidates,
  );
  process.stdout.write(`target_found=${inputs.length > 0 ? 'true' : 'false'}\n`);
  process.stdout.write(`target_count=${inputs.length}\n`);
}

async function act(args) {
  const workdir = args.get('workdir');
  const { candidates } = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-input.json')),
  );
  const { decisions } = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-decisions.json')),
  );
  await actOnDecisions(new GhClient(args.get('repo')), candidates, decisions);
}

async function reset(args) {
  const client = new GhClient(args.get('repo'));
  await resetSuccessfulFailures(client, await client.markerPrs());
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (command === 'scan') return scan(args);
  if (command === 'act') return act(args);
  if (command === 'reset') return reset(args);
  throw new Error('command must be scan or act');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
