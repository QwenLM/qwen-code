#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const TARGET_WORKFLOW = 'Qwen Code CI';
const MARKER = 'qwen-ci-flaky-rerun';
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_ACTIVE_DAYS = 7;
const DEFAULT_MAX_CANDIDATES = 5;
const MAX_ACTIONS = 3;
const ACTIONS = new Set(['rerun', 'update_branch', 'comment', 'no_action']);

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

function checkId(check) {
  return (
    Number(check.databaseId) ||
    jobIdFromUrl(check.detailsUrl) ||
    runIdFromUrl(check.detailsUrl) ||
    0
  );
}

function isNewerCheck(check, current) {
  const id = checkId(check);
  const currentId = checkId(current);
  if (id && currentId && id !== currentId) return id > currentId;
  return (
    Math.max(timeMs(check.completedAt), timeMs(check.startedAt)) >
    Math.max(timeMs(current.completedAt), timeMs(current.startedAt))
  );
}

function latestChecks(pr) {
  const checks = new Map();
  for (const check of pr.statusCheckRollup ?? []) {
    const key = `${check.workflowName}/${check.name}`;
    const current = checks.get(key);
    if (!current || isNewerCheck(check, current)) checks.set(key, check);
  }
  return [...checks.values()];
}

function toTarget(pr, check) {
  const runId = runIdFromUrl(check.detailsUrl);
  if (runId === null) return null;
  return {
    prNumber: pr.number,
    headSha: pr.headRefOid,
    runId,
    jobId: jobIdFromUrl(check.detailsUrl),
    workflowName: check.workflowName,
    checkName: check.name,
    completedAt: check.completedAt,
  };
}

function isEligibleFailure(check, now, staleMinutes, activeDays) {
  const age = timeMs(now) - timeMs(check.completedAt);
  return (
    check.workflowName === TARGET_WORKFLOW &&
    check.status === 'COMPLETED' &&
    ['FAILURE', 'TIMED_OUT'].includes(check.conclusion) &&
    age >= staleMinutes * 60_000 &&
    age <= activeDays * 86_400_000
  );
}

export function selectCandidateTargets(prs, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  const targets = [];

  for (const pr of prs) {
    if (pr.isDraft || pr.baseRefName !== 'main') continue;
    for (const check of latestChecks(pr)) {
      if (!isEligibleFailure(check, now, staleMinutes, activeDays)) continue;
      const target = toTarget(pr, check);
      if (target) targets.push(target);
    }
  }

  return targets.sort((a, b) => timeMs(b.completedAt) - timeMs(a.completedAt));
}

function markerFor(target, action, count) {
  return `<!-- ${MARKER} v=5 pr=${target.prNumber} head=${target.headSha} run=${target.runId} attempt=${target.runAttempt} workflow=${encodeURIComponent(target.workflowName)} check=${encodeURIComponent(target.checkName)} action=${action} key=${target.failureKey} count=${count} -->`;
}

function parseMarker(comment) {
  try {
    const match = String(comment.body ?? '').match(
      /<!--\s*qwen-ci-flaky-rerun\s+v=5\s+([^]*?)\s*-->/,
    );
    if (!match) return null;
    const tokens = match[1].split(/\s+/);
    if (tokens.some((field) => field.indexOf('=') <= 0)) return null;
    const fields = Object.fromEntries(
      tokens.map((field) => {
        const separator = field.indexOf('=');
        return [field.slice(0, separator), field.slice(separator + 1)];
      }),
    );
    const state = {
      prNumber: Number(fields.pr),
      headSha: fields.head,
      runId: Number(fields.run),
      runAttempt: Number(fields.attempt),
      workflowName: decodeURIComponent(fields.workflow ?? ''),
      checkName: decodeURIComponent(fields.check ?? ''),
      action: fields.action,
      failureKey: fields.key,
      count: Number(fields.count),
      createdAt: comment.createdAt,
    };
    return Number.isInteger(state.prNumber) &&
      Number.isInteger(state.runId) &&
      Number.isInteger(state.runAttempt) &&
      Number.isInteger(state.count) &&
      state.count >= 0 &&
      state.headSha &&
      state.workflowName &&
      state.checkName &&
      state.failureKey
      ? state
      : null;
  } catch {
    return null;
  }
}

function trustedStates(comments, trustedMarkerLogin) {
  return comments
    .filter((comment) => comment.author?.login === trustedMarkerLogin)
    .map(parseMarker)
    .filter(Boolean)
    .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
}

export function alreadyHandled(comments, target, trustedMarkerLogin) {
  return trustedStates(comments, trustedMarkerLogin).some(
    (state) =>
      state.prNumber === target.prNumber &&
      state.headSha === target.headSha &&
      state.runId === target.runId &&
      state.runAttempt === target.runAttempt &&
      state.workflowName === target.workflowName &&
      state.checkName === target.checkName &&
      state.failureKey === target.failureKey,
  );
}

function succeededAfter(pr, state) {
  return (pr.statusCheckRollup ?? []).some(
    (check) =>
      check.workflowName === state.workflowName &&
      check.name === state.checkName &&
      check.status === 'COMPLETED' &&
      check.conclusion === 'SUCCESS' &&
      timeMs(check.completedAt) > timeMs(state.createdAt),
  );
}

export function currentActionCount(pr, comments, trustedMarkerLogin) {
  const states = trustedStates(comments, trustedMarkerLogin).filter(
    (state) => state.prNumber === pr.number && state.headSha === pr.headRefOid,
  );
  const latest = states.at(-1);
  if (!latest || latest.count === 0 || succeededAfter(pr, latest)) return 0;
  return latest.count;
}

function redactLog(log) {
  return log
    .replace(
      /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g,
      '[redacted private key]',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted jwt]',
    )
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
  const lines = redactLog(log).split('\n');
  const selected = new Set();
  const summary =
    /##\[error\]|failed tests|\sFAIL\s|AssertionError|error TS\d{4}|❌|npm error|lifecycle script .* failed/i;
  let matches = lines.flatMap((line, index) =>
    summary.test(line) ? [index] : [],
  );
  if (matches.length === 0) {
    const fallback = /(?:Type|Reference|Syntax)?Error:|fatal|timed? ?out/i;
    matches = lines.flatMap((line, index) =>
      fallback.test(line) ? [index] : [],
    );
  }
  for (const index of matches) {
    const before = lines[index].includes('##[error]') ? 20 : 3;
    for (let context = index - before; context <= index + 3; context += 1) {
      if (context >= 0 && context < lines.length) selected.add(context);
    }
  }
  for (
    let index = Math.max(0, lines.length - 20);
    index < lines.length;
    index += 1
  ) {
    selected.add(index);
  }
  return [...selected]
    .sort((a, b) => a - b)
    .slice(-120)
    .map((index) => lines[index].slice(0, 300))
    .join('\n');
}

export function fingerprint(target, log) {
  const normalized = log
    .toLowerCase()
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\b(?:0x)?[a-f0-9]{7,40}\b/g, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
  return `check-${createHash('sha256')
    .update(`${target.workflowName}\n${target.checkName}\n${normalized}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function latestMatchingTarget(pr, target) {
  const latest = latestChecks(pr).find(
    (check) =>
      check.workflowName === target.workflowName &&
      check.name === target.checkName,
  );
  return latest ? toTarget(pr, latest) : null;
}

function validDecision(target, decision) {
  if (!decision || typeof decision !== 'object') return false;
  if (!ACTIONS.has(decision.action)) return false;
  if (!['high', 'low'].includes(decision.confidence)) return false;
  if (decision.action !== 'no_action' && decision.confidence !== 'high') {
    return false;
  }
  if (
    typeof decision.reason_en !== 'string' ||
    !decision.reason_en.trim() ||
    decision.reason_en.length > 200 ||
    typeof decision.reason_zh !== 'string' ||
    !decision.reason_zh.trim() ||
    decision.reason_zh.length > 200
  ) {
    return false;
  }
  return (
    decision.prNumber === target.prNumber &&
    decision.headSha === target.headSha &&
    decision.runId === target.runId &&
    decision.runAttempt === target.runAttempt &&
    decision.failureKey === target.failureKey &&
    (decision.action !== 'update_branch' ||
      decision.mainHeadSha === target.mainHeadSha)
  );
}

function currentFailure(run, target) {
  return (
    run.status === 'completed' &&
    ['failure', 'timed_out'].includes(run.conclusion) &&
    run.head_sha === target.headSha &&
    run.run_attempt === target.runAttempt
  );
}

function safeReason(reason) {
  return reason
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b');
}

export async function actOnDecision(client, target, decision) {
  if (!target || !validDecision(target, decision)) return;

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

  const comments = await client.comments(target.prNumber);
  if (
    alreadyHandled(comments, target, client.trustedMarkerLogin) ||
    currentActionCount(pr, comments, client.trustedMarkerLogin) >= MAX_ACTIONS
  ) {
    return;
  }
  if (!currentFailure(await client.run(target.runId), target)) return;

  const count = currentActionCount(pr, comments, client.trustedMarkerLogin) + 1;
  const marker = markerFor(target, decision.action, count);
  if (decision.action === 'rerun') {
    await client.rerunFailedJobs(target.runId);
    await client.comment(target.prNumber, marker);
  } else if (decision.action === 'update_branch') {
    const main = await client.mainContext(target.headSha);
    if (
      target.behindBy <= 0 ||
      main.behindBy <= 0 ||
      main.mainHeadSha !== target.mainHeadSha ||
      main.mainHeadSha !== decision.mainHeadSha
    ) {
      return;
    }
    await client.updateBranch(target.prNumber, target.headSha);
    await client.comment(target.prNumber, marker);
  } else if (decision.action === 'comment') {
    await client.comment(
      target.prNumber,
      `CI is failing because: ${safeReason(decision.reason_en)}\n\n<details>\n<summary>中文说明</summary>\n\n${safeReason(decision.reason_zh)}\n\n</details>\n\n${marker}`,
    );
  } else {
    await client.comment(target.prNumber, marker);
  }
}

function decisionKey(value) {
  return [
    value?.prNumber,
    value?.headSha,
    value?.runId,
    value?.runAttempt,
    value?.failureKey,
  ].join(':');
}

export async function actOnDecisions(client, targets, decisions) {
  if (!Array.isArray(targets) || !Array.isArray(decisions)) return;
  const byKey = new Map(targets.map((target) => [decisionKey(target), target]));
  const handled = new Set();
  for (const decision of decisions) {
    const key = decisionKey(decision);
    if (handled.has(key)) continue;
    handled.add(key);
    try {
      const target = byKey.get(key);
      if (!target) {
        process.stderr.write(
          `act: no candidate for decision on PR ${decision?.prNumber ?? 'unknown'}\n`,
        );
        continue;
      }
      await actOnDecision(client, target, decision);
    } catch (error) {
      process.stderr.write(
        `act: skipping PR ${decision?.prNumber ?? 'unknown'}: ${error.message}${error.stderr ? `\n${String(error.stderr).trim()}` : ''}\n`,
      );
    }
  }
}

export async function resetSuccessfulFailures(client, prs) {
  for (const pr of prs) {
    try {
      const comments = await client.comments(pr.number);
      const state = trustedStates(comments, client.trustedMarkerLogin)
        .filter(
          (item) =>
            item.prNumber === pr.number && item.headSha === pr.headRefOid,
        )
        .at(-1);
      if (!state || state.count === 0 || !succeededAfter(pr, state)) continue;
      await client.comment(pr.number, markerFor(state, 'reset', 0));
    } catch (error) {
      process.stderr.write(
        `reset: skipping PR ${pr.number}: ${error.message}\n`,
      );
    }
  }
}

export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export class GhClient {
  constructor(repo, trustedMarkerLogin) {
    this.repo = repo;
    this.trustedMarkerLogin = trustedMarkerLogin;
  }

  async gh(args) {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  }

  async currentLogin() {
    return (await this.gh(['api', 'user', '--jq', '.login'])).trim();
  }

  async prs(activeDays = DEFAULT_ACTIVE_DAYS) {
    const since = new Date(Date.now() - activeDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return this.prList(`status:failure updated:>=${since}`);
  }

  async prsWithMarkers() {
    return this.prList(`in:comments ${MARKER}`);
  }

  async prList(search) {
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
        search,
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
          .filter((line) => line.length > 0)
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
        'headRefOid,state,isDraft,baseRefName,statusCheckRollup,files',
      ]),
    );
  }

  async run(runId) {
    return JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}`]),
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

  async mainContext(headSha) {
    const main = JSON.parse(
      await this.gh(['api', `repos/${this.repo}/commits/main`]),
    );
    const comparison = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.repo}/compare/${headSha}...${main.sha}`,
      ]),
    );
    return {
      // For head...main, ahead_by is how far main is ahead of the branch.
      behindBy: comparison.ahead_by,
      mainHeadSha: main.sha,
      mainCommits: comparison.commits.slice(-20).map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message.split('\n')[0],
      })),
    };
  }
}

export function argsMap(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--')) {
      throw new Error(`unexpected argument: ${argv[index] ?? ''}`);
    }
    if (argv[index + 1] === undefined) {
      throw new Error(`missing value for ${argv[index]}`);
    }
    args.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function numberArg(args, name, fallback) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return value;
}

function writeJson(workdir, name, value) {
  mkdirSync(workdir, { recursive: true });
  const path = resolve(workdir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function runStillCurrent(run, target, runAttempt) {
  return (
    run.status === 'completed' &&
    ['failure', 'timed_out'].includes(run.conclusion) &&
    run.head_sha === target.headSha &&
    run.run_attempt === runAttempt
  );
}

async function scan(args) {
  const workdir = requiredArg(args, 'workdir');
  const repo = requiredArg(args, 'repo');
  const activeDays = numberArg(args, 'active-days', DEFAULT_ACTIVE_DAYS);
  const maxCandidates = numberArg(
    args,
    'max-candidates',
    DEFAULT_MAX_CANDIDATES,
  );
  const client = new GhClient(repo);
  const trustedLogin =
    args.get('trusted-marker-login') ?? (await client.currentLogin());
  client.trustedMarkerLogin = trustedLogin;
  const targets = selectCandidateTargets(await client.prs(activeDays), {
    activeDays,
    staleMinutes: numberArg(args, 'stale-minutes', DEFAULT_STALE_MINUTES),
  });
  const candidates = [];
  const selectedPrs = new Set();

  for (const target of targets) {
    if (candidates.length >= maxCandidates) break;
    if (selectedPrs.has(target.prNumber)) continue;
    try {
      if (target.jobId === null) continue;
      const before = await client.run(target.runId);
      if (!runStillCurrent(before, target, before.run_attempt)) continue;
      const log = skillLog(await client.jobLog(target.jobId));
      const candidate = {
        ...target,
        runAttempt: before.run_attempt,
        failureKey: fingerprint(target, log),
      };
      const comments = await client.comments(target.prNumber);
      const pr = await client.currentPr(target.prNumber);
      const current = latestMatchingTarget(pr, target);
      const after = await client.run(target.runId);
      if (
        pr.state !== 'OPEN' ||
        pr.isDraft ||
        pr.baseRefName !== 'main' ||
        pr.headRefOid !== target.headSha ||
        current?.runId !== target.runId ||
        current?.jobId !== target.jobId ||
        !runStillCurrent(after, target, before.run_attempt) ||
        alreadyHandled(comments, candidate, trustedLogin)
      ) {
        continue;
      }
      const actionCount = currentActionCount(pr, comments, trustedLogin);
      if (actionCount >= MAX_ACTIONS) continue;
      let main = { behindBy: 0, mainHeadSha: null, mainCommits: [] };
      try {
        main = await client.mainContext(target.headSha);
      } catch (error) {
        process.stderr.write(
          `scan: main context unavailable for PR ${target.prNumber}: ${error.message}\n`,
        );
      }
      candidates.push({
        ...candidate,
        actionCount,
        changedFiles: (pr.files ?? []).map((file) => file.path).slice(0, 100),
        ...main,
        log,
      });
      selectedPrs.add(target.prNumber);
    } catch (error) {
      const stderr = error.stderr ? `\n${String(error.stderr).trim()}` : '';
      process.stderr.write(
        `scan: skipping PR ${target.prNumber}: ${error.message}${stderr}\n`,
      );
    }
  }

  const path = writeJson(workdir, 'ci-flaky-input.json', { candidates });
  process.stdout.write(`target_found=${candidates.length > 0}\n`);
  process.stdout.write(`input_sha=${fileSha256(path)}\n`);
}

async function act(args) {
  const workdir = requiredArg(args, 'workdir');
  const inputPath = resolve(workdir, 'ci-flaky-input.json');
  if (fileSha256(inputPath) !== requiredArg(args, 'input-sha')) {
    throw new Error('ci-flaky-input.json integrity check failed');
  }
  const repo = requiredArg(args, 'repo');
  const client = new GhClient(
    repo,
    args.get('trusted-marker-login') ?? undefined,
  );
  if (!client.trustedMarkerLogin) {
    client.trustedMarkerLogin = await client.currentLogin();
  }
  const { candidates } = JSON.parse(readFileSync(inputPath, 'utf8'));
  const { decisions } = JSON.parse(
    readFileSync(resolve(workdir, 'ci-flaky-decisions.json'), 'utf8'),
  );
  await actOnDecisions(client, candidates, decisions);
}

async function reset(args) {
  const repo = requiredArg(args, 'repo');
  const client = new GhClient(
    repo,
    args.get('trusted-marker-login') ?? undefined,
  );
  if (!client.trustedMarkerLogin) {
    client.trustedMarkerLogin = await client.currentLogin();
  }
  await resetSuccessfulFailures(client, await client.prsWithMarkers());
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (command === 'scan') return scan(args);
  if (command === 'act') return act(args);
  if (command === 'reset') return reset(args);
  throw new Error('command must be scan, act, or reset');
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error.stderr ? `${error.message}\n${error.stderr}` : error.message,
    );
    process.exit(1);
  });
}
