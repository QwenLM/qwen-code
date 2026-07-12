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

function markerFor(target) {
  return `<!-- ${MARKER} v=1 pr=${target.prNumber} head=${target.headSha} run=${target.runId} -->`;
}

function alreadyHandled(pr, target) {
  return (pr?.comments ?? []).some((comment) =>
    String(comment.body ?? '').includes(markerFor(target)),
  );
}

function actionCountForHead(pr, target) {
  const prefix = `<!-- ${MARKER} v=1 pr=${target.prNumber} head=${target.headSha} `;
  return (pr?.comments ?? []).filter((comment) =>
    String(comment.body ?? '').includes(prefix),
  ).length;
}

function isRecentlyActive(pr, now, activeDays) {
  return timeMs(now) - timeMs(pr.updatedAt) <= activeDays * 24 * 60 * 60_000;
}

function canAct(pr, target, options) {
  return (
    !alreadyHandled(pr, target) &&
    actionCountForHead(pr, target) <
      (options.maxActions ?? MAX_ACTIONS_PER_HEAD)
  );
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

  return targets.sort((a, b) => timeMs(b.completedAt) - timeMs(a.completedAt));
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

  if (decision.action === 'rerun') {
    await client.rerunFailedJobs(target.runId);
    await client.comment(
      target.prNumber,
      [
        `Rerunning failed jobs because this failure looks flaky: ${decision.reason_en}`,
        '',
        markerFor(target),
      ].join('\n'),
    );
    return;
  }

  if (decision.action === 'update_branch') {
    if ((await client.behindBy(target.headSha)) <= 0) return;
    await client.updateBranch(target.prNumber, target.headSha);
    await client.comment(
      target.prNumber,
      [
        'Requesting an update from main because this failure needs current main.',
        '',
        markerFor(target),
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
        markerFor(target),
      ].join('\n'),
    );
  }
}

export async function writeSkillInput(client, target, workdir) {
  writeJson(workdir, 'ci-target.json', target);
  const log = target.jobId === null ? '' : await client.jobLog(target.jobId);
  writeFileSync(resolve(workdir, 'ci-log.txt'), skillLog(log));
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
  let target = null;
  for (const candidate of candidates) {
    const pr = prs.find((item) => item.number === candidate.prNumber);
    const comments = await client.comments(candidate.prNumber);
    if (!canAct({ ...pr, comments }, candidate, {})) continue;
    target = {
      ...candidate,
      behindBy: await client.behindBy(candidate.headSha),
    };
    break;
  }
  if (target) await writeSkillInput(client, target, args.get('workdir'));
  process.stdout.write(`target_found=${target ? 'true' : 'false'}\n`);
}

async function act(args) {
  const workdir = args.get('workdir');
  const target = JSON.parse(readFileSync(resolve(workdir, 'ci-target.json')));
  const decision = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-decision.json')),
  );
  await actOnDecision(new GhClient(args.get('repo')), target, decision);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (command === 'scan') return scan(args);
  if (command === 'act') return act(args);
  throw new Error('command must be scan or act');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
