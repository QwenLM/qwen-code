#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_STALE_MINUTES = 30;
const AUTOFIX_WORKFLOW_RE = /(^|\b)(qwen[-\s]?autofix|autofix)(\b|$)/i;
const MARKER_RE = /<!--\s*qwen-ci-patrol\s+([^>]+?)\s*-->/;
const SAFE_OTHER_DECISION = {
  classification: 'other',
  confidence: 'low',
  reason_en:
    'The CI failure needs human review because the classifier decision was incomplete or unsafe.',
  reason_zh: '分类结果不完整或不安全，需要人工复核这个 CI 失败。',
  evidence: [],
};

function timeMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
}

function normalize(value) {
  return String(value ?? '').toLowerCase();
}

function completedAt(run) {
  return run.completedAt ?? run.updatedAt ?? run.createdAt;
}

function runTime(run) {
  return timeMs(completedAt(run)) ?? 0;
}

function isTerminalFailure(run) {
  const status = normalize(run.status);
  const conclusion = normalize(run.conclusion);
  if (status && status !== 'completed') return false;
  if (conclusion === 'cancelled' && run.superseded) return false;
  return ['failure', 'timed_out', 'action_required'].includes(conclusion);
}

function isPendingOrSuccessful(run) {
  const status = normalize(run.status);
  const conclusion = normalize(run.conclusion);
  return (
    ['queued', 'requested', 'waiting', 'pending', 'in_progress'].includes(
      status,
    ) || conclusion === 'success'
  );
}

function hasNewerReplacement(runs, failedRun) {
  const failedTime = runTime(failedRun);
  return runs.some((run) => {
    if (run === failedRun) return false;
    if (run.workflowName !== failedRun.workflowName) return false;
    if (runTime(run) < failedTime) return false;
    return isPendingOrSuccessful(run);
  });
}

export function extractActionsRunId(run) {
  for (const value of [
    run.runId,
    run.workflowRunId,
    run.detailsUrl,
    run.details_url,
    run.htmlUrl,
    run.html_url,
    run.targetUrl,
    run.target_url,
  ]) {
    const text = String(value ?? '');
    if (/^\d+$/.test(text)) return Number(text);
    const match = /\/actions\/runs\/(\d+)/.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

export function isStaleFailure(run, now, staleMinutes = DEFAULT_STALE_MINUTES) {
  if (!isTerminalFailure(run)) return false;
  const completed = timeMs(completedAt(run));
  if (completed === null) return false;
  return now.getTime() - completed >= staleMinutes * 60 * 1000;
}

function toPrTarget(pr, run) {
  const runId = extractActionsRunId(run);
  if (runId === null) return null;
  return {
    scope: 'pr',
    prNumber: pr.number,
    runId,
    headSha: pr.headRefOid,
    workflowName: run.workflowName,
    completedAt: completedAt(run),
    htmlUrl: run.htmlUrl ?? run.detailsUrl ?? run.targetUrl,
    baseRefName: pr.baseRefName,
    updateable:
      pr.isCrossRepository !== true || pr.maintainerCanModify === true,
    sameRepository: pr.isCrossRepository !== true,
    behindBase: normalize(pr.mergeStateStatus) === 'behind',
    mainRelevantSuccess: pr.mainRelevantSuccess === true,
  };
}

export function selectPrTarget(prs, options) {
  const now = options.now;
  const targets = [];
  for (const pr of prs) {
    if (normalize(pr.state) !== 'open' || pr.isDraft) continue;
    if (pr.baseRefName && pr.baseRefName !== 'main') continue;
    const runs = pr.statusCheckRollup ?? [];
    for (const run of runs) {
      if (AUTOFIX_WORKFLOW_RE.test(run.workflowName ?? '')) continue;
      if (!isStaleFailure(run, now, options.staleMinutes)) continue;
      if (hasNewerReplacement(runs, run)) continue;
      const target = toPrTarget(pr, run);
      if (target) targets.push(target);
    }
  }

  return (
    targets.sort((a, b) => {
      const byTime = timeMs(a.completedAt) - timeMs(b.completedAt);
      if (byTime !== 0) return byTime;
      return a.runId - b.runId;
    })[0] ?? null
  );
}

function isMainRef(run) {
  return run.ref === 'refs/heads/main' || run.headBranch === 'main';
}

function toMainTarget(run) {
  return {
    scope: 'main',
    runId: run.id,
    workflowId: run.workflowId,
    headSha: run.headSha,
    workflowName: run.workflowName,
    completedAt: completedAt(run),
    htmlUrl: run.htmlUrl,
  };
}

export function selectMainTarget(runs, options) {
  const allowlisted = new Set(options.allowlistedWorkflows ?? []);
  const targets = runs
    .filter((run) => allowlisted.has(run.workflowName))
    .filter(isMainRef)
    .filter((run) => isStaleFailure(run, options.now, options.staleMinutes))
    .map(toMainTarget);

  return (
    targets.sort((a, b) => {
      const byTime = timeMs(a.completedAt) - timeMs(b.completedAt);
      if (byTime !== 0) return byTime;
      return a.runId - b.runId;
    })[0] ?? null
  );
}

function markerPairs(text) {
  const match = MARKER_RE.exec(text ?? '');
  if (!match) return null;
  const pairs = new Map();
  for (const token of match[1].trim().split(/\s+/)) {
    const index = token.indexOf('=');
    if (index <= 0) return null;
    pairs.set(token.slice(0, index), token.slice(index + 1));
  }
  return pairs;
}

export function parsePatrolMarker(text) {
  const pairs = markerPairs(text);
  if (!pairs) return null;
  const attempts = Number(pairs.get('attempts'));
  if (pairs.get('v') !== '1') return null;
  if (!Number.isInteger(attempts) || attempts < 0) return null;
  const scope = pairs.get('scope');
  if (!['pr', 'main'].includes(scope)) return null;
  const target = pairs.get('target');
  const headSha = pairs.get('head');
  const runId = pairs.get('run');
  const action = pairs.get('action');
  const handledAt = pairs.get('handled');
  if (!target || !headSha || !runId || !action || !handledAt) return null;
  return {
    version: 1,
    scope,
    target,
    headSha,
    runId,
    attempts,
    action,
    handledAt,
  };
}

export function formatPatrolMarker(marker) {
  return [
    '<!-- qwen-ci-patrol',
    'v=1',
    `scope=${marker.scope}`,
    `target=${marker.target}`,
    `head=${marker.headSha}`,
    `run=${marker.runId}`,
    `attempts=${marker.attempts}`,
    `action=${marker.action}`,
    `handled=${marker.handledAt}`,
    '-->',
  ].join(' ');
}

function matchingMarkers(comments, options) {
  return comments
    .filter((comment) => comment.author?.login === options.botLogin)
    .map((comment) => parsePatrolMarker(comment.body))
    .filter(Boolean)
    .filter(
      (marker) =>
        marker.scope === options.scope &&
        marker.target === String(options.target) &&
        marker.headSha === options.headSha,
    );
}

export function nextAttempt(comments, options) {
  const attempts = matchingMarkers(comments, options).map(
    (marker) => marker.attempts,
  );
  return Math.max(0, ...attempts) + 1;
}

export function decideAttempt(comments, options) {
  const maxAttempts = options.maxAttempts ?? 3;
  const attempt = nextAttempt(comments, options);
  if (attempt > maxAttempts) {
    return { action: 'human_handoff', attempts: maxAttempts };
  }
  return { action: 'continue', attempts: attempt };
}

export function isPrTargetCurrent(pr, target, options) {
  const current = selectPrTarget([pr], options);
  return current?.headSha === target.headSha && current.runId === target.runId;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateClassifierDecision(decision, context) {
  const allowedKeys = new Set([
    'classification',
    'confidence',
    'reason_en',
    'reason_zh',
    'evidence',
  ]);
  if (
    !decision ||
    Object.keys(decision).some((key) => !allowedKeys.has(key)) ||
    !['flaky', 'base_refresh', 'other'].includes(decision.classification) ||
    !['high', 'medium', 'low'].includes(decision.confidence) ||
    !nonEmptyString(decision.reason_en) ||
    !nonEmptyString(decision.reason_zh) ||
    !Array.isArray(decision.evidence) ||
    !decision.evidence.every(nonEmptyString)
  ) {
    return SAFE_OTHER_DECISION;
  }

  if (decision.classification === 'base_refresh' && context.scope !== 'pr') {
    return { ...decision, classification: 'other' };
  }

  if (
    ['flaky', 'base_refresh'].includes(decision.classification) &&
    decision.confidence !== 'high'
  ) {
    return SAFE_OTHER_DECISION;
  }

  return {
    classification: decision.classification,
    confidence: decision.confidence,
    reason_en: decision.reason_en,
    reason_zh: decision.reason_zh,
    evidence: decision.evidence,
  };
}

async function defaultRunner(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  return stdout;
}

function parseJson(text, fallback) {
  if (!text || text.trim() === '') return fallback;
  return JSON.parse(text);
}

export class GhClient {
  constructor({ repo, runner = defaultRunner }) {
    this.repo = repo;
    this.runner = runner;
  }

  async run(args, options) {
    return this.runner('gh', args, options);
  }

  async listOpenPrs() {
    const stdout = await this.run([
      'pr',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--base',
      'main',
      '--limit',
      '100',
      '--json',
      'number,state,isDraft,baseRefName,headRefOid,headRefName,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeStateStatus,statusCheckRollup,url',
    ]);
    return parseJson(stdout, []);
  }

  async getPr(prNumber) {
    const stdout = await this.run([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      this.repo,
      '--json',
      'number,state,isDraft,baseRefName,headRefOid,headRefName,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeStateStatus,statusCheckRollup,url',
    ]);
    return parseJson(stdout, {});
  }

  async listRunJobs(runId) {
    const stdout = await this.run([
      'api',
      `repos/${this.repo}/actions/runs/${runId}/jobs`,
      '--paginate',
    ]);
    return parseJson(stdout, { jobs: [] }).jobs ?? [];
  }

  async jobLog(jobId) {
    return this.run(['api', `repos/${this.repo}/actions/jobs/${jobId}/logs`]);
  }

  async rerunFailedJobs(runId) {
    await this.run([
      'api',
      '-X',
      'POST',
      `repos/${this.repo}/actions/runs/${runId}/rerun-failed-jobs`,
    ]);
  }

  async updateBranch(prNumber, headSha) {
    await this.run([
      'api',
      '-X',
      'PUT',
      `repos/${this.repo}/pulls/${prNumber}/update-branch`,
      '-f',
      `expected_head_sha=${headSha}`,
    ]);
  }

  async viewerLogin() {
    return (await this.run(['api', 'user', '--jq', '.login'])).trim();
  }

  async listIssueComments(issueNumber) {
    return parseJson(
      await this.run([
        'api',
        `repos/${this.repo}/issues/${issueNumber}/comments`,
        '--paginate',
      ]),
      [],
    );
  }

  async postIssueComment(issueNumber, body) {
    await this.run([
      'api',
      '-X',
      'POST',
      `repos/${this.repo}/issues/${issueNumber}/comments`,
      '-f',
      `body=${body}`,
    ]);
  }

  async searchIssuesByBody(text) {
    return parseJson(
      await this.run([
        'search',
        'issues',
        '--repo',
        this.repo,
        '--state',
        'open',
        '--match',
        'body',
        text,
        '--json',
        'number,author,body,labels,assignees,linkedPullRequests,url',
        '--limit',
        '10',
      ]),
      [],
    );
  }

  async createIssue({ title, body, labels }) {
    return parseJson(
      await this.run([
        'issue',
        'create',
        '--repo',
        this.repo,
        '--title',
        title,
        '--body',
        body,
        '--label',
        labels.join(','),
      ]),
      {},
    );
  }

  async commentIssue(issueNumber, body) {
    await this.run([
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      this.repo,
      '--body',
      body,
    ]);
  }

  async listMainRuns() {
    const stdout = await this.run([
      'api',
      `repos/${this.repo}/actions/runs`,
      '-f',
      'branch=main',
      '-f',
      'per_page=50',
    ]);
    return parseJson(stdout, { workflow_runs: [] }).workflow_runs ?? [];
  }

  async dispatchAutofixIssue(issueNumber) {
    await this.run([
      'workflow',
      'run',
      'qwen-autofix.yml',
      '--repo',
      this.repo,
      '-f',
      'phase=issue',
      '-f',
      `issue_number=${issueNumber}`,
      '-f',
      'dry_run=false',
    ]);
  }
}

function stripControlChars(text) {
  let clean = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      continue;
    }
    clean += char;
  }
  return clean;
}

export function sanitizeLog(log, maxBytes = 12_000) {
  return stripControlChars(String(log ?? ''))
    .replace(/\b(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b(token|password|secret)=\S+/gi, '$1=[REDACTED]')
    .slice(0, maxBytes)
    .trimEnd();
}

export async function fetchFailedRunEvidence(client, runId, options = {}) {
  const maxJobs = options.maxJobs ?? 5;
  const maxLogBytes = options.maxLogBytes ?? 12_000;
  const jobs = await client.listRunJobs(runId);
  const failedJobs = jobs
    .filter((job) =>
      ['failure', 'timed_out', 'action_required'].includes(
        normalize(job.conclusion),
      ),
    )
    .slice(0, maxJobs);

  const evidence = [];
  for (const job of failedJobs) {
    evidence.push({
      jobId: job.id,
      jobName: job.name,
      jobUrl: job.html_url ?? job.htmlUrl,
      log: sanitizeLog(await client.jobLog(job.id), maxLogBytes),
    });
  }
  return evidence;
}

export async function verifyBotIdentity(client, expectedLogin) {
  const actual = await client.viewerLogin();
  if (actual !== expectedLogin) {
    throw new Error(`CI_DEV_BOT_PAT authenticates as ${actual}`);
  }
}

export function renderPrComment({
  target,
  decision,
  attempts,
  action,
  handledAt,
}) {
  const evidence = decision.evidence.map((item) => `- ${item}`).join('\n');
  return [
    decision.reason_en,
    '',
    `Run: ${target.htmlUrl}`,
    evidence ? `\nEvidence:\n${evidence}` : '',
    '',
    '<details><summary>中文</summary>',
    '',
    decision.reason_zh,
    '',
    '</details>',
    '',
    formatPatrolMarker({
      scope: 'pr',
      target: String(target.prNumber),
      headSha: target.headSha,
      runId: String(target.runId),
      attempts,
      action,
      handledAt,
    }),
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function renderPrActionMarker({ target, attempts, action, handledAt }) {
  return formatPatrolMarker({
    scope: 'pr',
    target: String(target.prNumber),
    headSha: target.headSha,
    runId: String(target.runId),
    attempts,
    action,
    handledAt,
  });
}

export function planPrAction({
  target,
  decision,
  comments,
  botLogin,
  maxAttempts = 3,
}) {
  const attempt = decideAttempt(comments, {
    botLogin,
    scope: 'pr',
    target: String(target.prNumber),
    headSha: target.headSha,
    maxAttempts,
  });
  const markers = matchingMarkers(comments, {
    botLogin,
    scope: 'pr',
    target: String(target.prNumber),
    headSha: target.headSha,
  });
  if (
    markers.some((marker) =>
      ['comment', 'human_handoff'].includes(marker.action),
    )
  ) {
    return {
      action: 'no_op',
      attempts: Math.max(...markers.map((m) => m.attempts)),
    };
  }
  if (attempt.action === 'human_handoff') return attempt;

  if (decision.classification === 'flaky' && decision.confidence === 'high') {
    return { action: 'rerun_failed_jobs', attempts: attempt.attempts };
  }
  if (
    decision.classification === 'base_refresh' &&
    decision.confidence === 'high' &&
    target.sameRepository &&
    target.updateable &&
    target.behindBase &&
    target.mainRelevantSuccess
  ) {
    return { action: 'update_branch', attempts: attempt.attempts };
  }
  return { action: 'comment', attempts: attempt.attempts };
}

export function formatMainIssueMarker({ workflowId, headSha }) {
  return `<!-- qwen-ci-patrol-main v=1 workflow=${workflowId} head=${headSha} -->`;
}

export function findMainHandoffIssue(issues, options) {
  const marker = formatMainIssueMarker(options);
  return (
    issues.find(
      (issue) =>
        issue.author?.login === options.botLogin &&
        String(issue.body ?? '').includes(marker),
    ) ?? null
  );
}

export function shouldDispatchAutofixIssue(issue) {
  const labels = new Set((issue.labels ?? []).map((label) => label.name));
  if (
    labels.has('autofix/skip') ||
    labels.has('autofix/in-progress') ||
    labels.has('status/need-information') ||
    labels.has('status/need-retesting')
  ) {
    return false;
  }
  if ((issue.assignees ?? []).length > 0) return false;
  if ((issue.linkedPullRequests ?? []).length > 0) return false;
  return true;
}

function renderMainIssueBody({ target, decision }) {
  const evidence = decision.evidence.map((item) => `- ${item}`).join('\n');
  return [
    'A post-merge testing workflow failed on `main` and was classified as actionable for Autofix.',
    '',
    `Workflow: ${target.workflowName}`,
    `Run: ${target.htmlUrl}`,
    `Head SHA: ${target.headSha}`,
    '',
    `Reason: ${decision.reason_en}`,
    '',
    '<details><summary>中文</summary>',
    '',
    decision.reason_zh,
    '',
    '</details>',
    '',
    evidence ? `Evidence:\n${evidence}` : '',
    '',
    formatMainIssueMarker(target),
  ]
    .filter((part) => part !== '')
    .join('\n');
}

export async function handoffMainFailure(client, options) {
  const marker = formatMainIssueMarker(options.target);
  const issues = await client.searchIssuesByBody(
    marker.replace(/^<!--\s*/, '').replace(/\s*-->$/, ''),
  );
  const existing = findMainHandoffIssue(issues, {
    botLogin: options.botLogin,
    workflowId: options.target.workflowId,
    headSha: options.target.headSha,
  });
  const body = renderMainIssueBody(options);

  let issue = existing;
  let created = false;
  if (issue) {
    await client.commentIssue(issue.number, body);
  } else {
    issue = await client.createIssue({
      title: `Post-merge ${options.target.workflowName} failed on ${options.target.headSha.slice(0, 7)}`,
      body,
      labels: ['type/bug', 'status/ready-for-agent', 'autofix/approved'],
    });
    created = true;
  }

  const canDispatch = options.dispatch && shouldDispatchAutofixIssue(issue);
  if (canDispatch) {
    await client.dispatchAutofixIssue(issue.number);
  }
  return { number: issue.number, created, dispatched: Boolean(canDispatch) };
}

function argsMap(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args.set(key, 'true');
    } else {
      args.set(key, next);
      index += 1;
    }
  }
  return args;
}

function requireArg(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function writeJson(workdir, name, value) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(resolve(workdir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(workdir, name) {
  return JSON.parse(readFileSync(resolve(workdir, name), 'utf8'));
}

function toMainRun(run) {
  return {
    id: run.id,
    workflowId: run.workflow_id,
    workflowName: run.name,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
    htmlUrl: run.html_url,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    ref: run.head_branch === 'main' ? 'refs/heads/main' : undefined,
    event: run.event,
  };
}

async function writeTargetPayload({ client, target, workdir }) {
  const evidence = await fetchFailedRunEvidence(client, target.runId);
  writeJson(workdir, 'target.json', target);
  writeJson(workdir, 'ci-failure.json', { target, evidence });
}

async function commandScanPr(args) {
  const workdir = requireArg(args, 'workdir');
  const client = new GhClient({ repo: requireArg(args, 'repo') });
  const prs = await client.listOpenPrs();
  const target = selectPrTarget(prs, {
    now: new Date(args.get('now') ?? Date.now()),
    staleMinutes: Number(args.get('stale-minutes') ?? DEFAULT_STALE_MINUTES),
  });
  if (target) {
    const mainRuns = (await client.listMainRuns()).map(toMainRun);
    target.mainRelevantSuccess = mainRuns.some(
      (run) =>
        run.workflowName === target.workflowName &&
        run.headBranch === 'main' &&
        normalize(run.conclusion) === 'success',
    );
    await writeTargetPayload({ client, target, workdir });
  }
  process.stdout.write(`target_found=${target ? 'true' : 'false'}\n`);
}

async function commandScanMain(args) {
  const workdir = requireArg(args, 'workdir');
  if (existsSync(resolve(workdir, 'target.json'))) {
    process.stdout.write('target_found=true\n');
    return;
  }
  const client = new GhClient({ repo: requireArg(args, 'repo') });
  const target = selectMainTarget(
    (await client.listMainRuns()).map(toMainRun),
    {
      now: new Date(args.get('now') ?? Date.now()),
      staleMinutes: Number(args.get('stale-minutes') ?? DEFAULT_STALE_MINUTES),
      allowlistedWorkflows: requireArg(args, 'allowlist')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    },
  );
  if (target) await writeTargetPayload({ client, target, workdir });
  process.stdout.write(`target_found=${target ? 'true' : 'false'}\n`);
}

async function commandVerifyBot(args) {
  await verifyBotIdentity(
    new GhClient({ repo: requireArg(args, 'repo') }),
    requireArg(args, 'bot-login'),
  );
}

async function commandAct(args) {
  const workdir = requireArg(args, 'workdir');
  const dryRun = args.get('dry-run') === 'true';
  const botLogin = requireArg(args, 'bot-login');
  const client = new GhClient({ repo: requireArg(args, 'repo') });
  const target = readJson(workdir, 'target.json');
  const decision = validateClassifierDecision(
    readJson(workdir, 'ci-decision.json'),
    target,
  );
  writeJson(workdir, 'validated-decision.json', decision);
  if (dryRun) return;

  if (target.scope === 'main') {
    await handoffMainFailure(client, {
      botLogin,
      target,
      decision,
      dispatch: true,
    });
    return;
  }

  if (
    !isPrTargetCurrent(await client.getPr(target.prNumber), target, {
      now: new Date(),
    })
  ) {
    return;
  }

  const comments = await client.listIssueComments(target.prNumber);
  const action = planPrAction({
    target,
    decision,
    comments,
    botLogin,
    maxAttempts: Number(args.get('max-attempts') ?? 3),
  });
  const handledAt = new Date().toISOString();
  if (action.action === 'rerun_failed_jobs') {
    await client.rerunFailedJobs(target.runId);
    await client.postIssueComment(
      target.prNumber,
      renderPrActionMarker({
        target,
        attempts: action.attempts,
        action: 'rerun',
        handledAt,
      }),
    );
  } else if (action.action === 'update_branch') {
    await client.updateBranch(target.prNumber, target.headSha);
    await client.postIssueComment(
      target.prNumber,
      renderPrActionMarker({
        target,
        attempts: action.attempts,
        action: 'update_branch',
        handledAt,
      }),
    );
  } else if (action.action === 'no_op') {
    return;
  } else {
    await client.postIssueComment(
      target.prNumber,
      renderPrComment({
        target,
        decision,
        attempts: action.attempts,
        action: action.action,
        handledAt,
      }),
    );
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (command === 'scan-pr') return commandScanPr(args);
  if (command === 'scan-main') return commandScanMain(args);
  if (command === 'verify-bot') return commandVerifyBot(args);
  if (command === 'act') return commandAct(args);
  throw new Error(
    'command must be one of: scan-pr, scan-main, verify-bot, act',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
