#!/usr/bin/env node

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
const TARGET_WORKFLOW = 'Qwen Code CI';
const MAX_REASON_LENGTH = 200;
const MARKER = 'qwen-ci-flaky-rerun';
const VALID_ACTIONS = ['rerun', 'update_branch', 'comment', 'no_action'];

function timeMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

function checkTimeMs(run) {
  return Math.max(timeMs(run.completedAt), timeMs(run.startedAt));
}

function isNewerCheck(run, current) {
  const runTime = checkTimeMs(run);
  const currentTime = checkTimeMs(current);
  if (runTime > 0 && currentTime > 0 && runTime !== currentTime) {
    return runTime > currentTime;
  }
  const runId =
    Number(run.databaseId) ||
    jobIdFromUrl(run.detailsUrl) ||
    runIdFromUrl(run.detailsUrl) ||
    0;
  const currentId =
    Number(current.databaseId) ||
    jobIdFromUrl(current.detailsUrl) ||
    runIdFromUrl(current.detailsUrl) ||
    0;
  return runId > currentId;
}

function runIdFromUrl(url) {
  const match = String(url ?? '').match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function jobIdFromUrl(url) {
  const match = String(url ?? '').match(/\/jobs?\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function markerFor(target, action, failureKey, count, state = 'completed') {
  const check = encodeURIComponent(target.checkName ?? target.workflowName);
  return `<!-- ${MARKER} v=3 pr=${target.prNumber} head=${target.headSha} run=${target.runId} attempt=${target.runAttempt ?? 1} action=${action} state=${state} key=${failureKey} check=${check} count=${count} main=${target.mainHeadSha ?? '-'} -->`;
}

function markerComments(pr, options = {}) {
  const logins = options.trustedMarkerLogins;
  return (pr?.comments ?? []).filter(
    (comment) =>
      !logins || logins.includes(String(comment.author?.login ?? '')),
  );
}

export function alreadyHandled(pr, target, options) {
  const pattern = new RegExp(
    `<!-- ${MARKER} v=(?:1|2|3) pr=${target.prNumber} head=${target.headSha} run=${target.runId}${target.runAttempt ? ` attempt=${target.runAttempt}` : ''}(?:\\x20|\\u00a0)`,
  );
  return markerComments(pr, options).some((comment) =>
    pattern.test(String(comment.body ?? '')),
  );
}

function isStaleFailure(run, now, staleMinutes, activeDays) {
  if (run.status !== 'COMPLETED') return false;
  if (!['FAILURE', 'TIMED_OUT'].includes(run.conclusion)) return false;
  if (run.workflowName !== TARGET_WORKFLOW) return false;
  const age = timeMs(now) - timeMs(run.completedAt);
  return age >= staleMinutes * 60_000 && age <= activeDays * 24 * 60 * 60_000;
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
    workflowName: run.workflowName,
    checkName: run.name,
    detailsUrl: run.detailsUrl,
    completedAt: run.completedAt,
  };
}

export function fingerprint(target, log) {
  const normalized = log
    .toLowerCase()
    .replace(/[a-f0-9]{8,}/g, '#')
    .replace(/\d+/g, '#');
  return `check-${createHash('sha256').update(`${target.workflowName}/${target.checkName}\n${normalized}`).digest('hex').slice(0, 16)}`;
}

function stateMarkers(comments, prNumber, trustedMarkerLogin) {
  const marker = new RegExp(
    `<!-- ${MARKER} v=(2|3) pr=${prNumber} head=(\\S+) run=(\\d+) attempt=(\\d+) action=(\\S+)(?: state=(\\S+))? key=([a-z0-9._-]+) check=(\\S+) count=(\\d+)(?: main=(\\S+))? -->`,
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
        headSha: match[2],
        runId: Number(match[3]),
        attempt: Number(match[4]),
        action: match[5],
        state: match[6] ?? 'completed',
        key: match[7],
        check: decodeURIComponent(match[8]),
        count: Number(match[9]),
        mainHeadSha: match[10] === '-' ? null : (match[10] ?? null),
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
    .replace(/(Authorization:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(
      /(?:gh[pousr]_|github_pat_|glpat-|xox[b]-|xox[p]-)[A-Za-z0-9_-]{8,}/g,
      '[redacted]',
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9-]{20,}/g, 'sk-[redacted]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[redacted]')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^/\s]+@)+/gi, '$1[redacted]@')
    .replace(/\bnpm_[A-Za-z0-9]{20,}/g, '[redacted]');
}

export function skillLog(log) {
  const lines = log.split('\n');
  const failure = lines.findLastIndex((line) =>
    /npm error|AssertionError|Test Files.*failed|❌ Errors:|error TS\d+|Code style issues found|(?:^|\s)FAIL(?:\s|$)/.test(
      line,
    ),
  );
  const end =
    failure === -1
      ? lines.findLastIndex((line) => line.includes('##[error]'))
      : failure;
  return (
    end === -1
      ? lines.slice(-120)
      : lines.slice(Math.max(0, end - 80), end + 41)
  )
    .map(redactLogLine)
    .map((line) => line.slice(0, 500))
    .join('\n');
}

export function selectCandidateTargets(prs, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  const targets = [];

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.baseRefName !== 'main') continue;
    const latestByCheck = new Map();
    for (const run of pr.statusCheckRollup ?? []) {
      const key = `${run.workflowName}/${run.name}`;
      const current = latestByCheck.get(key);
      if (!current || isNewerCheck(run, current)) {
        latestByCheck.set(key, run);
      }
    }
    for (const run of latestByCheck.values()) {
      if (!isStaleFailure(run, now, staleMinutes, activeDays)) continue;
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

function validReason(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_REASON_LENGTH
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
  if (decision.failureKey !== target.failureKey) return;
  if (!(await isActionablePr(client, target))) return;
  if (!(await client.isCurrentFailure(target))) return;
  const requestedAction = VALID_ACTIONS.includes(decision.action)
    ? decision.action
    : 'no_action';
  const action =
    requestedAction === 'no_action' ||
    (decision.confidence === 'high' &&
      validReason(decision.reason_en) &&
      validReason(decision.reason_zh))
      ? requestedAction
      : 'no_action';
  const count = await client.failureActionCount(
    target.prNumber,
    target.headSha,
  );
  if (count >= MAX_ACTIONS_PER_HEAD) return;
  const terminalMarker = (terminalAction = action, state = 'completed') =>
    markerFor(target, terminalAction, target.failureKey, count + 1, state);

  if (action === 'no_action') {
    await client.comment(
      target.prNumber,
      terminalMarker('no_action', 'no_action'),
    );
    return;
  }

  if (action === 'rerun') {
    await client.comment(target.prNumber, terminalMarker(action, 'pending'));
    await client.rerunFailedJobs(target.runId);
    await client.comment(
      target.prNumber,
      `Reran failed jobs: ${decision.reason_en}\n\n${terminalMarker()}`,
    );
    return;
  }
  if (action === 'update_branch') {
    if (
      target.behindBy <= 0 ||
      !target.mainHeadSha ||
      !target.mainRunId ||
      !target.mainWorkflowId ||
      decision.mainHeadSha !== target.mainHeadSha
    ) {
      await client.comment(
        target.prNumber,
        terminalMarker('no_action', 'no_action'),
      );
      return;
    }
    const currentMain = await client.mainContext(target.headSha);
    if (
      currentMain.behindBy <= 0 ||
      currentMain.mainHeadSha !== target.mainHeadSha ||
      currentMain.mainRunId !== target.mainRunId ||
      currentMain.mainWorkflowId !== target.mainWorkflowId
    ) {
      await client.comment(
        target.prNumber,
        terminalMarker('no_action', 'no_action'),
      );
      return;
    }
    await client.comment(target.prNumber, terminalMarker(action, 'pending'));
    await client.updateBranch(target.prNumber, target.headSha);
    await client.comment(
      target.prNumber,
      `Updated the branch from main: ${decision.reason_en}\n\n${terminalMarker()}`,
    );
    return;
  }
  if (action === 'comment') {
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
        terminalMarker(),
      ].join('\n'),
    );
    return;
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
    try {
      if (
        !decision ||
        typeof decision !== 'object' ||
        Array.isArray(decision)
      ) {
        throw new Error('decision must be an object');
      }
      const id = `${decision.prNumber}:${decision.headSha}:${decision.runId}`;
      if (processed.has(id)) continue;
      const target = targetsById.get(id);
      if (!target) continue;
      processed.add(id);
      await actOnDecision(client, target, decision);
    } catch (error) {
      process.stderr.write(
        `actOnDecision failed for ${decision?.prNumber ?? 'unknown'}: ${error.message}\n`,
      );
    }
  }
}

export async function recoverPendingActions(client, prs) {
  for (const pr of prs) {
    try {
      const latest = new Map();
      for (const state of stateMarkers(
        await client.comments(pr.number),
        pr.number,
        client.trustedMarkerLogin,
      ))
        latest.set(`${state.headSha}:${state.key}`, state);
      for (const state of latest.values()) {
        if (state.state !== 'pending') continue;
        let completed = false;
        if (state.action === 'rerun') {
          const run = await client.run(state.runId);
          completed = Number(run.run_attempt) > state.attempt;
        } else if (state.action === 'update_branch' && state.mainHeadSha) {
          completed = await client.wasBranchUpdated(
            pr.number,
            state.headSha,
            state.mainHeadSha,
          );
        }
        if (!completed) continue;
        await client.comment(
          pr.number,
          markerFor(
            {
              prNumber: pr.number,
              headSha: state.headSha,
              runId: state.runId,
              runAttempt: state.attempt,
              checkName: state.check,
              mainHeadSha: state.mainHeadSha,
            },
            state.action,
            state.key,
            state.count,
          ),
        );
      }
    } catch (error) {
      process.stderr.write(
        `recoverPendingActions failed for ${pr.number}: ${error.message}\n`,
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
        if (state.headSha === pr.headRefOid) states.set(state.key, state);
      for (const state of states.values()) {
        if (state.count === 0) continue;
        const run = (pr.statusCheckRollup ?? []).find(
          (check) =>
            check.workflowName === TARGET_WORKFLOW &&
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

export class GhClient {
  constructor(repo) {
    this.repo = repo;
  }

  async gh(args, options = {}) {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
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

  async failureActionCount(prNumber, headSha) {
    if (!this.trustedMarkerLogin)
      throw new Error('trusted marker login is required');
    return (
      stateMarkers(
        await this.comments(prNumber),
        prNumber,
        this.trustedMarkerLogin,
      )
        .filter((state) => state.headSha === headSha)
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
    const run = await this.run(target.runId);
    return (
      run.status === 'completed' &&
      ['failure', 'timed_out'].includes(run.conclusion) &&
      run.head_sha === target.headSha &&
      run.run_attempt === target.runAttempt
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

  async mainContext(headSha) {
    const [comparison, mainHeadSha] = await Promise.all([
      this.gh(['api', `repos/${this.repo}/compare/${headSha}...main`]),
      this.gh(['api', `repos/${this.repo}/commits/main`, '--jq', '.sha']),
    ]);
    const response = JSON.parse(comparison);
    const mainSha = mainHeadSha.trim();
    const runs = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.repo}/actions/runs?branch=main&status=completed&per_page=100`,
      ]),
    );
    const latestMainRun = (runs.workflow_runs ?? []).find(
      (run) => run.name === TARGET_WORKFLOW && run.head_sha === mainSha,
    );
    const mainRun =
      latestMainRun?.conclusion === 'success' ? latestMainRun : null;
    return {
      behindBy: Number(response.ahead_by),
      mainHeadSha: mainSha,
      mainRunId: mainRun?.id ?? null,
      mainWorkflowId: mainRun?.workflow_id ?? null,
      mainCommits: response.commits.slice(-20).map((commit) => ({
        sha: commit.sha,
        message: String(commit.commit?.message ?? '').split('\n')[0],
      })),
    };
  }

  async wasBranchUpdated(prNumber, oldHeadSha, mainHeadSha) {
    const current = await this.currentPr(prNumber);
    if (current.headRefOid === oldHeadSha) return false;
    const commit = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.repo}/commits/${current.headRefOid}`,
      ]),
    );
    const parents = new Set((commit.parents ?? []).map((parent) => parent.sha));
    return parents.has(oldHeadSha) && parents.has(mainHeadSha);
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

export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positiveIntegerArg(args, name, fallback) {
  const value = args.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

async function trustedMarkerLogin(args, client) {
  const login =
    args.get('trusted-marker-login') ?? (await client.viewerLogin());
  if (!login) throw new Error('trusted marker login is required');
  client.trustedMarkerLogin = login;
  return login;
}

async function scan(args) {
  const repo = requiredArg(args, 'repo');
  const workdir = requiredArg(args, 'workdir');
  const activeDays = positiveIntegerArg(
    args,
    'active-days',
    DEFAULT_ACTIVE_DAYS,
  );
  const staleMinutes = positiveIntegerArg(
    args,
    'stale-minutes',
    DEFAULT_STALE_MINUTES,
  );
  const maxCandidates = positiveIntegerArg(
    args,
    'max-candidates',
    DEFAULT_MAX_CANDIDATES_PER_RUN,
  );
  const client = new GhClient(repo);
  const trustedLogin = await trustedMarkerLogin(args, client);
  const prs = await client.prs();
  const candidates = selectCandidateTargets(prs, { staleMinutes, activeDays });
  const options = { trustedMarkerLogins: [trustedLogin] };
  const inputs = [];
  const selectedPrs = new Set();
  for (const candidate of candidates) {
    if (inputs.length >= maxCandidates) break;
    if (selectedPrs.has(candidate.prNumber)) continue;
    try {
      const pr = prs.find((item) => item.number === candidate.prNumber);
      const liveAttempt = await client.runAttempt(candidate.runId);
      if (liveAttempt !== candidate.runAttempt) continue;
      const target = { ...candidate, runAttempt: liveAttempt };
      const comments = await client.comments(candidate.prNumber);
      if (alreadyHandled({ ...pr, comments }, target, options)) continue;
      const log =
        target.jobId === null
          ? ''
          : skillLog(await client.jobLog(target.jobId));
      if ((await client.runAttempt(candidate.runId)) !== liveAttempt) continue;
      const failureKey = fingerprint(target, log);
      inputs.push({
        ...target,
        log,
        failureKey,
        ...(await client.mainContext(target.headSha)),
      });
      selectedPrs.add(candidate.prNumber);
    } catch (error) {
      process.stderr.write(
        `scan: skipping PR ${candidate.prNumber}: ${error.message}\n`,
      );
    }
  }
  const inputPath = resolve(workdir, 'ci-flaky-input.json');
  writeJson(workdir, 'ci-flaky-input.json', { candidates: inputs });
  process.stdout.write(
    `target_found=${inputs.length > 0 ? 'true' : 'false'}\n`,
  );
  process.stdout.write(`input_sha=${fileSha256(inputPath)}\n`);
}

async function act(args) {
  const repo = requiredArg(args, 'repo');
  const workdir = requiredArg(args, 'workdir');
  const inputPath = resolve(workdir, 'ci-flaky-input.json');
  if (fileSha256(inputPath) !== requiredArg(args, 'input-sha')) {
    throw new Error('ci-flaky-input.json integrity check failed');
  }
  const { candidates } = JSON.parse(readFileSync(inputPath));
  const { decisions } = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-decisions.json')),
  );
  const client = new GhClient(repo);
  await trustedMarkerLogin(args, client);
  await actOnDecisions(client, candidates, decisions);
}

async function reset(args) {
  const repo = requiredArg(args, 'repo');
  const client = new GhClient(repo);
  await trustedMarkerLogin(args, client);
  const prs = await client.markerPrs();
  await recoverPendingActions(client, prs);
  await resetSuccessfulFailures(client, prs);
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
    console.error(
      error.stderr ? `${error.message}\n${error.stderr}` : error.message,
    );
    process.exit(1);
  });
}
