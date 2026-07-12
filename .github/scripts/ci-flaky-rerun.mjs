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
  return (pr.comments ?? []).some((comment) =>
    String(comment.body ?? '').includes(markerFor(target)),
  );
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

export function selectTarget(prs, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const targets = [];

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.baseRefName !== 'main') continue;
    for (const run of pr.statusCheckRollup ?? []) {
      if (!isStaleFailure(run, now, staleMinutes)) continue;
      const target = toTarget(pr, run);
      if (!target || alreadyHandled(pr, target)) continue;
      targets.push(target);
    }
  }

  return (
    targets.sort((a, b) => timeMs(a.completedAt) - timeMs(b.completedAt))[0] ??
    null
  );
}

export async function actOnDecision(client, target, decision) {
  if (!target) return;
  if (decision?.flaky !== true || decision.confidence !== 'high') return;
  await client.rerunFailedJobs(target.runId);
  await client.comment(
    target.prNumber,
    [
      `Rerunning failed jobs because this failure looks flaky: ${decision.reason}`,
      '',
      markerFor(target),
    ].join('\n'),
  );
}

export async function writeSkillInput(client, target, workdir) {
  writeJson(workdir, 'ci-target.json', target);
  const log = target.jobId === null ? '' : await client.jobLog(target.jobId);
  writeFileSync(resolve(workdir, 'ci-log.txt'), log.slice(0, 20_000));
}

class GhClient {
  constructor(repo) {
    this.repo = repo;
  }

  async gh(args, options = {}) {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      ...options,
    });
    return stdout;
  }

  async prs() {
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
        '--json',
        'number,isDraft,baseRefName,headRefOid,statusCheckRollup,comments',
        '--limit',
        '100',
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
  const target = selectTarget(await client.prs(), {
    staleMinutes: Number(args.get('stale-minutes') ?? DEFAULT_STALE_MINUTES),
  });
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
