#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFile = promisify(execFileCallback);
const DEFAULT_STALE_MINUTES = 30;
const TARGET_WORKFLOW = 'Qwen Code CI';
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

function checkId(run) {
  return jobIdFromUrl(run.detailsUrl) || runIdFromUrl(run.detailsUrl) || 0;
}

function isNewerCheck(run, current) {
  const runId = checkId(run);
  const currentId = checkId(current);
  if (runId && currentId && runId !== currentId) return runId > currentId;
  return (
    Math.max(timeMs(run.completedAt), timeMs(run.startedAt)) >
    Math.max(timeMs(current.completedAt), timeMs(current.startedAt))
  );
}

function markerFor(target) {
  const workflow = encodeURIComponent(target.workflowName);
  const check = encodeURIComponent(target.checkName);
  return `<!-- ${MARKER} v=4 pr=${target.prNumber} head=${target.headSha} workflow=${workflow} check=${check} -->`;
}

export function alreadyHandled(comments, target, trustedMarkerLogin) {
  const marker = markerFor(target);
  return comments.some(
    (comment) =>
      comment.author?.login === trustedMarkerLogin &&
      String(comment.body ?? '').includes(marker),
  );
}

function toTarget(pr, run) {
  const runId = runIdFromUrl(run.detailsUrl);
  if (runId === null) return null;
  return {
    prNumber: pr.number,
    headSha: pr.headRefOid,
    runId,
    jobId: jobIdFromUrl(run.detailsUrl),
    workflowName: run.workflowName,
    checkName: run.name,
    completedAt: run.completedAt,
  };
}

function isStaleFailure(run, now, staleMinutes) {
  return (
    run.workflowName === TARGET_WORKFLOW &&
    run.status === 'COMPLETED' &&
    ['FAILURE', 'TIMED_OUT'].includes(run.conclusion) &&
    timeMs(now) - timeMs(run.completedAt) >= staleMinutes * 60_000
  );
}

export function selectCandidateTargets(prs, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const targets = [];

  for (const pr of prs) {
    if (pr.isDraft || pr.baseRefName !== 'main') continue;
    const latestByCheck = new Map();
    for (const run of pr.statusCheckRollup ?? []) {
      const key = `${run.workflowName}/${run.name}`;
      const current = latestByCheck.get(key);
      if (!current || isNewerCheck(run, current)) latestByCheck.set(key, run);
    }
    for (const run of latestByCheck.values()) {
      if (!isStaleFailure(run, now, staleMinutes)) continue;
      const target = toTarget(pr, run);
      if (target) targets.push(target);
    }
  }

  return targets.sort((a, b) => timeMs(a.completedAt) - timeMs(b.completedAt));
}

function redactLogLine(line) {
  return line
    .replace(/((?:Set-)?Cookie:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/(Authorization:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /(?:gh[pousr]_|github_pat_|glpat-|xox[bp]-)[A-Za-z0-9_-]{8,}/g,
      '[redacted]',
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9-]{20,}/g, 'sk-[redacted]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s]+@)+/gi, '$1[redacted]@')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    );
}

export function skillLog(log) {
  return log
    .split('\n')
    .slice(-200)
    .map(redactLogLine)
    .map((line) => line.slice(0, 500))
    .join('\n');
}

function latestMatchingTarget(pr, target) {
  const runs = (pr.statusCheckRollup ?? []).filter(
    (run) =>
      run.workflowName === target.workflowName && run.name === target.checkName,
  );
  const latest = runs.reduce(
    (current, run) => (!current || isNewerCheck(run, current) ? run : current),
    null,
  );
  return latest ? toTarget(pr, latest) : null;
}

export async function actOnDecision(client, target, decision) {
  if (!target) return;
  const pr = await client.currentPr(target.prNumber);
  const current = latestMatchingTarget(pr, target);
  if (
    pr.state !== 'OPEN' ||
    pr.isDraft ||
    pr.baseRefName !== 'main' ||
    pr.headRefOid !== target.headSha ||
    current?.runId !== target.runId ||
    current?.jobId !== target.jobId
  ) {
    return;
  }

  const run = await client.run(target.runId);
  if (
    run.status !== 'completed' ||
    !['failure', 'timed_out'].includes(run.conclusion) ||
    run.head_sha !== target.headSha ||
    run.run_attempt !== target.runAttempt
  ) {
    return;
  }

  const rerun = decision?.flaky === true && decision.confidence === 'high';
  await client.comment(
    target.prNumber,
    rerun
      ? `Rerunning failed jobs after a high-confidence flaky classification.\n\n${markerFor(target)}`
      : markerFor(target),
  );
  if (rerun) await client.rerunFailedJobs(target.runId);
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

class GhClient {
  constructor(repo) {
    this.repo = repo;
  }

  async gh(args) {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
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
        '--search',
        'status:failure',
        '--json',
        'number,isDraft,baseRefName,headRefOid,statusCheckRollup',
        '--limit',
        '1000',
      ]),
    );
  }

  async comments(prNumber) {
    const output = await this.gh([
      'api',
      '--paginate',
      `repos/${this.repo}/issues/${prNumber}/comments`,
      '--jq',
      '.[] | {body, author: {login: .user.login}}',
    ]);
    return output.trim()
      ? output
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  }

  async currentPr(prNumber) {
    return JSON.parse(
      await this.gh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        this.repo,
        '--json',
        'headRefOid,state,isDraft,baseRefName,statusCheckRollup',
      ]),
    );
  }

  async run(runId) {
    return JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}`]),
    );
  }

  async runAttempt(runId) {
    return Number(
      (
        await this.gh([
          'api',
          `repos/${this.repo}/actions/runs/${runId}`,
          '--jq',
          '.run_attempt',
        ])
      ).trim(),
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
  for (let i = 0; i < argv.length; i += 2) {
    args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function writeJson(workdir, name, value) {
  mkdirSync(workdir, { recursive: true });
  const path = resolve(workdir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function scan(args) {
  const workdir = requiredArg(args, 'workdir');
  const client = new GhClient(requiredArg(args, 'repo'));
  const trustedLogin = requiredArg(args, 'trusted-marker-login');
  const candidates = selectCandidateTargets(await client.prs(), {
    staleMinutes: Number(args.get('stale-minutes') ?? DEFAULT_STALE_MINUTES),
  });
  let input = { target: null, log: '' };

  for (const candidate of candidates) {
    try {
      const comments = await client.comments(candidate.prNumber);
      if (alreadyHandled(comments, candidate, trustedLogin)) continue;
      const runAttempt = await client.runAttempt(candidate.runId);
      const log =
        candidate.jobId === null
          ? ''
          : skillLog(await client.jobLog(candidate.jobId));
      if ((await client.runAttempt(candidate.runId)) !== runAttempt) continue;
      input = { target: { ...candidate, runAttempt }, log };
      break;
    } catch (error) {
      const stderr = error.stderr ? `\n${String(error.stderr).trim()}` : '';
      process.stderr.write(
        `scan: skipping PR ${candidate.prNumber}: ${error.message}${stderr}\n`,
      );
    }
  }

  const path = writeJson(workdir, 'ci-flaky-input.json', input);
  process.stdout.write(`target_found=${input.target ? 'true' : 'false'}\n`);
  process.stdout.write(`input_sha=${fileSha256(path)}\n`);
}

async function act(args) {
  const workdir = requiredArg(args, 'workdir');
  const inputPath = resolve(workdir, 'ci-flaky-input.json');
  if (fileSha256(inputPath) !== requiredArg(args, 'input-sha')) {
    throw new Error('ci-flaky-input.json integrity check failed');
  }
  const { target } = JSON.parse(readFileSync(inputPath, 'utf8'));
  const decision = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-decision.json'), 'utf8'),
  );
  await actOnDecision(
    new GhClient(requiredArg(args, 'repo')),
    target,
    decision,
  );
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
    console.error(
      error.stderr ? `${error.message}\n${error.stderr}` : error.message,
    );
    process.exit(1);
  });
}
