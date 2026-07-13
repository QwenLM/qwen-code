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
import { createHash } from 'node:crypto';

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
  return `<!-- ${MARKER} v=2 pr=${target.prNumber} head=${target.headSha} run=${target.runId} attempt=${target.runAttempt ?? 1} action=${action} key=${failureKey} check=${check} count=${count} -->`;
}

function markerComments(pr, options = {}) {
  const logins = options.trustedMarkerLogins;
  return (pr?.comments ?? []).filter(
    (comment) =>
      !logins || logins.includes(String(comment.author?.login ?? '')),
  );
}

function alreadyHandled(pr, target, options) {
  const attemptPattern = new RegExp(
    `<!-- ${MARKER} v=2 pr=${target.prNumber} head=${target.headSha} run=${target.runId} attempt=${target.runAttempt ?? 1}(?:\\x20|\\u00a0)`,
  );
  const legacyPattern = new RegExp(
    `<!-- ${MARKER} v=1 pr=${target.prNumber} head=${target.headSha} run=${target.runId}(?:\\x20|\\u00a0)`,
  );
  return markerComments(pr, options).some(
    (comment) =>
      attemptPattern.test(String(comment.body ?? '')) ||
      legacyPattern.test(String(comment.body ?? '')),
  );
}

function isRecentlyActive(pr, now, activeDays) {
  return timeMs(now) - timeMs(pr.updatedAt) <= activeDays * 24 * 60 * 60_000;
}

function canAct(pr, target, options) {
  return !alreadyHandled(pr, target, options);
}

function failureKey(target, decision) {
  if (!target.failureKey) return 'unknown';
  return decision?.failureKey === target.failureKey ? target.failureKey : null;
}

function fingerprint(target, log) {
  const normalized = log
    .toLowerCase()
    .replace(/[a-f0-9]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .slice(0, 1000);
  return `check-${createHash('sha256').update(`${target.workflowName}\n${normalized}`).digest('hex').slice(0, 16)}`;
}

function stateMarkers(comments, prNumber, trustedMarkerLogin) {
  const marker = new RegExp(
    `<!-- ${MARKER} v=2 pr=${prNumber} head=(\\S+) run=(\\d+) attempt=(\\d+) action=(\\S+) key=([a-z0-9._-]+) check=(\\S+) count=(\\d+) -->`,
    'g',
  );
  return comments
    .filter(
      (comment) => String(comment.author?.login ?? '') === trustedMarkerLogin,
    )
    .map((comment) => {
      const matches = [...String(comment.body ?? '').matchAll(marker)];
      const match = matches.at(-1);
      if (!match) return null;
      return {
        headSha: match[1],
        runId: Number(match[2]),
        runAttempt: Number(match[3]),
        action: match[4],
        key: match[5],
        check: decodeURIComponent(match[6]),
        count: Number(match[7]),
        createdAt: comment.createdAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
}

function redactLogLine(line) {
  return line
    .replace(/((?:Set-)?Cookie:\s*)[^\r\n]*/gi, '$1[redacted]')
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
  const lines = log.split('\n');
  const selected = new Set();
  for (const [index, line] of lines.entries()) {
    if (
      /(\bfail\b|×|error|failed|failure|exception|timeout|timed out|network|download|assertion|lint|typecheck)/i.test(
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
    runAttempt: run.runAttempt ?? 1,
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

  const newestFailureByPr = new Map();
  for (const target of targets) {
    const current = newestFailureByPr.get(target.prNumber);
    if (!current || timeMs(target.completedAt) > timeMs(current.completedAt)) {
      newestFailureByPr.set(target.prNumber, target);
    }
  }

  return targets.sort((a, b) => {
    const newestA = newestFailureByPr.get(a.prNumber);
    const newestB = newestFailureByPr.get(b.prNumber);
    const prOrder = timeMs(newestA.completedAt) - timeMs(newestB.completedAt);
    if (prOrder !== 0) return prOrder;
    return timeMs(b.completedAt) - timeMs(a.completedAt);
  });
}

export function selectTarget(prs, options = {}) {
  return (
    selectCandidateTargets(prs, options).find((target) => {
      const pr = prs.find((candidate) => candidate.number === target.prNumber);
      return canAct(pr, target, options);
    }) ?? null
  );
}

async function isActionablePr(client, target) {
  const pr = await client.currentPr(target.prNumber);
  return (
    pr.state === 'OPEN' &&
    pr.isDraft === false &&
    pr.baseRefName === 'main' &&
    pr.headRefOid === target.headSha
  );
}

export async function actOnDecision(client, target, decision) {
  if (!target) return;
  if (decision?.action === 'no_action') {
    if (!(await isActionablePr(client, target))) return;
    if (!(await client.isCurrentFailure(target))) return;
    const key = failureKey(target, decision);
    if (!key) return;
    const actionCount = await client.failureActionCount(
      target.prNumber,
      target.headSha,
      key,
    );
    if (actionCount >= MAX_ACTIONS_PER_HEAD) return;
    await client.comment(
      target.prNumber,
      markerFor(target, 'no_action', key, actionCount + 1),
    );
    return;
  }
  if (decision?.confidence !== 'high') return;
  if (!['rerun', 'update_branch', 'comment'].includes(decision.action)) return;
  if (!(await isActionablePr(client, target))) return;
  if (!(await client.isCurrentFailure(target))) return;
  const key = failureKey(target, decision);
  if (!key) return;
  const actionCount = await client.failureActionCount(
    target.prNumber,
    target.headSha,
    key,
  );
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
    if (!target.mainHeadSha) return;
    if (
      decision.mainRunId !== target.mainRunId ||
      (await client.mainHeadSha()) !== target.mainHeadSha
    )
      return;
    if (
      !(await client.mainRunSucceeded(decision.mainRunId, target.mainWorkflow))
    )
      return;
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
    if (!decision.reason_en || !decision.reason_zh) return;
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
  const processed = new Set();
  for (const decision of decisions ?? []) {
    const id = `${decision.prNumber}:${decision.headSha}:${decision.runId}`;
    if (processed.has(id)) continue;
    const target = targetsById.get(id);
    if (!target) continue;
    processed.add(id);
    try {
      await actOnDecision(client, target, decision);
    } catch (error) {
      process.stderr.write(
        `actOnDecision failed for ${decision.prNumber}: ${error.message}\n`,
      );
    }
  }
}

export async function resetSuccessfulFailures(client, prs) {
  for (const pr of prs) {
    try {
      const states = new Map();
      for (const state of stateMarkers(
        await client.comments(pr.number),
        pr.number,
        client.trustedMarkerLogin,
      ))
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
    } catch (error) {
      process.stderr.write(
        `resetSuccessfulFailures failed for ${pr.number}: ${error.message}\n`,
      );
    }
  }
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
      candidates.at(-1).failureKey = fingerprint(target, candidates.at(-1).log);
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
      timeout: 60_000,
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
    const output = await this.gh([
      'api',
      '--paginate',
      `repos/${this.repo}/issues/${prNumber}/comments`,
      '--jq',
      '.[] | {body, createdAt: .created_at, author: {login: .user.login}}',
    ]);
    return output.trim()
      ? output
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  }

  async viewerLogin() {
    return (await this.gh(['api', 'user', '--jq', '.login'])).trim();
  }

  async failureActionCount(prNumber, headSha, key) {
    return (
      stateMarkers(
        await this.comments(prNumber),
        prNumber,
        this.trustedMarkerLogin,
      )
        .filter((state) => state.headSha === headSha && state.key === key)
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

  async currentPr(prNumber) {
    return JSON.parse(
      await this.gh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        this.repo,
        '--json',
        'headRefOid,state,isDraft,baseRefName',
      ]),
    );
  }

  async isCurrentFailure(target) {
    const run = JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${target.runId}`]),
    );
    return (
      run.status === 'completed' &&
      run.conclusion === 'failure' &&
      run.head_sha === target.headSha &&
      run.run_attempt === target.runAttempt
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

  async mainRunSucceeded(runId, workflow) {
    const run = JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}`]),
    );
    return (
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.path === `.github/workflows/${workflow}` &&
      run.status === 'completed' &&
      run.conclusion === 'success'
    );
  }

  async mainHeadSha() {
    return (
      await this.gh(['api', `repos/${this.repo}/commits/main`, '--jq', '.sha'])
    ).trim();
  }

  async mainEvidence() {
    const headSha = await this.mainHeadSha();
    const response = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=30`,
      ]),
    );
    const run = response.workflow_runs.find(
      (candidate) =>
        candidate.head_sha === headSha &&
        candidate.event === 'push' &&
        candidate.conclusion === 'success',
    );
    return run
      ? {
          mainHeadSha: headSha,
          mainRunId: run.id,
          mainWorkflow: 'ci.yml',
        }
      : {};
  }

  async behindBy(headSha) {
    return Number(
      (
        await this.gh([
          'api',
          `repos/${this.repo}/compare/${headSha}...main`,
          '--jq',
          '.ahead_by',
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
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${argv[i]}`);
    }
    args.set(argv[i].slice(2), value);
    i += 1;
  }
  return args;
}

function writeJson(workdir, name, value) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(resolve(workdir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function trustedMarkerLogin(args, client) {
  const login =
    args.get('trusted-marker-login') ?? (await client.viewerLogin());
  if (!login) throw new Error('trusted marker login is required');
  client.trustedMarkerLogin = login;
  return login;
}

async function skillCandidate(client, target) {
  const log =
    target.jobId === null ? '' : skillLog(await client.jobLog(target.jobId));
  return {
    ...target,
    log,
    failureKey: fingerprint(target, log),
  };
}

async function scan(args) {
  const client = new GhClient(args.get('repo'));
  const trustedLogin = await trustedMarkerLogin(args, client);
  const parsedActiveDays = Number(args.get('active-days'));
  const activeDays =
    Number.isFinite(parsedActiveDays) && parsedActiveDays > 0
      ? parsedActiveDays
      : DEFAULT_ACTIVE_DAYS;
  const parsedStaleMinutes = Number(args.get('stale-minutes'));
  const staleMinutes =
    Number.isFinite(parsedStaleMinutes) && parsedStaleMinutes > 0
      ? parsedStaleMinutes
      : DEFAULT_STALE_MINUTES;
  const prs = await client.prs(activeDays);
  const candidates = selectCandidateTargets(prs, {
    staleMinutes,
    activeDays,
  });
  const options = { trustedMarkerLogins: [trustedLogin] };
  const requestedMax = Number(args.get('max-candidates'));
  const maxCandidates =
    Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? requestedMax
      : DEFAULT_MAX_CANDIDATES_PER_RUN;
  const inputs = [];
  const selectedPrs = new Set();
  let mainEvidence;
  for (const candidate of candidates) {
    if (inputs.length >= maxCandidates) break;
    if (selectedPrs.has(candidate.prNumber)) continue;
    try {
      const pr = prs.find((item) => item.number === candidate.prNumber);
      const liveAttempt = await client.runAttempt(candidate.runId);
      if (liveAttempt !== candidate.runAttempt) continue;
      const target = {
        ...candidate,
      };
      const comments = await client.comments(candidate.prNumber);
      if (!canAct({ ...pr, comments }, target, options)) continue;
      const input = await skillCandidate(client, target);
      mainEvidence ??= await client.mainEvidence();
      inputs.push({
        ...input,
        behindBy: await client.behindBy(input.headSha),
        ...mainEvidence,
      });
      selectedPrs.add(candidate.prNumber);
    } catch (error) {
      process.stderr.write(
        `scan: skipping PR ${candidate.prNumber}: ${error.message}\n`,
      );
    }
  }
  writeJson(args.get('workdir'), 'ci-flaky-input.json', { candidates: inputs });
  process.stdout.write(
    `target_found=${inputs.length > 0 ? 'true' : 'false'}\n`,
  );
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
  const client = new GhClient(args.get('repo'));
  await trustedMarkerLogin(args, client);
  await actOnDecisions(client, candidates, decisions);
}

async function reset(args) {
  const client = new GhClient(args.get('repo'));
  await trustedMarkerLogin(args, client);
  await resetSuccessfulFailures(client, await client.markerPrs());
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (command === 'scan') return scan(args);
  if (command === 'act') return act(args);
  if (command === 'reset') return reset(args);
  throw new Error('command must be scan, act, or reset');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stderr || error.message);
    process.exit(1);
  });
}
