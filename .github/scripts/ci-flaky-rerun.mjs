#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

const execFile = promisify(execFileCallback);
const TARGET_WORKFLOW = 'Qwen Code CI';
const MARKER = 'qwen-ci-flaky-rerun';
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_ACTIVE_DAYS = 7;
// How many PR detail reads run at once. Five keeps a 66-PR scan near ten
// seconds without turning the patrol into a burst against the API.
const PR_DETAIL_CONCURRENCY = 5;
const DEFAULT_MAX_CANDIDATES = 5;
const MAX_ACTIONS = 3;
const ACTIONS = new Set(['rerun', 'comment', 'no_action']);
const DEFLAKE_MARKER = 'qwen-deflake';
const DEFLAKE_LABELS = ['status/ready-for-agent', 'autofix/approved'];
const DEFLAKE_MAX_CHARS = 200;

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
      runIdFromUrl(check.detailsUrl) === state.runId &&
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
      /(["']?)([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)(\1\s*[:=]\s*)["']?[^"',\s}]+["']?/gi,
      '$1$2$3[redacted]',
    );
}

export function skillLog(log) {
  // Redact, strip, then redact again. The first pass runs BEFORE the strip so
  // a bare \r still supplies the word boundary the anchored patterns
  // (\bnpm_…, \bsk-…, \beyJ…) need (`x\rnpm_…` redacts). The strip drops the
  // terminal controls (C0/DEL/C1, keeping \n and \t) plus the full Unicode
  // Bidi_Control set — the same class safeReason drops — so a fork-controlled
  // line can neither repaint nor reorder the excerpt. The second pass runs
  // AFTER the strip: a control byte INSIDE a credential (`npm_\rABC…`) defeats
  // every anchor on the first pass, and deleting it welds the fragments into a
  // contiguous token that must still be scrubbed.
  const lines = redactLog(
    redactLog(log).replace(
      // eslint-disable-next-line no-control-regex -- log text must not control the terminal
      /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
      '',
    ),
  ).split('\n');
  const selected = new Set();
  const primary = new Set();
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
  for (const [matchIndex, index] of matches.entries()) {
    const before = lines[index].includes('##[error]') ? 20 : 3;
    for (let context = index - before; context <= index + 3; context += 1) {
      if (context < 0 || context >= lines.length) continue;
      selected.add(context);
      if (matchIndex === 0) primary.add(context);
    }
  }
  for (
    let index = Math.max(0, lines.length - 20);
    index < lines.length;
    index += 1
  ) {
    selected.add(index);
  }
  const remaining = [...selected]
    .filter((index) => !primary.has(index))
    .sort((a, b) => a - b)
    .slice(-(120 - primary.size));
  return [...primary, ...remaining]
    .sort((a, b) => a - b)
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
    decision.failureKey === target.failureKey
  );
}

function wellFormedFlakyTest(ft) {
  return (
    !!ft &&
    typeof ft === 'object' &&
    typeof ft.file === 'string' &&
    ft.file.trim().length > 0 &&
    ft.file.length <= DEFLAKE_MAX_CHARS &&
    typeof ft.name === 'string' &&
    ft.name.trim().length > 0 &&
    ft.name.length <= DEFLAKE_MAX_CHARS
  );
}

// A backtick cannot be escaped INSIDE an inline code span — it closes the span
// and lets the remainder render as live Markdown (mention/markup injection via
// a test path or name). Drop backticks so the value stays inert in its span.
function codeSpanSafe(value) {
  return String(value).replaceAll('`', "'");
}

export function deflakeKey(flakyTest) {
  return createHash('sha256')
    .update(`${flakyTest.file}\u0000${flakyTest.name}`)
    .digest('hex')
    .slice(0, 16);
}

export function deflakeMarker(flakyTest) {
  return `<!-- ${DEFLAKE_MARKER} key=${deflakeKey(flakyTest)} -->`;
}

export function deflakeIssueBody(flakyTest, decision, target, repo) {
  const marker = deflakeMarker(flakyTest);
  const runUrl = `https://github.com/${
    repo ?? target?.repo ?? 'QwenLM/qwen-code'
  }/actions/runs/${target?.runId ?? ''}`;
  const file = codeSpanSafe(flakyTest.file);
  const name = codeSpanSafe(flakyTest.name);
  return [
    `CI Failure Patrol flagged this test as flaky and triggered a rerun on the same commit. If it passes on rerun it is nondeterministic; if it fails again deterministically it is a real bug, not flakiness — in that case do NOT stabilize it.`,
    ``,
    `- **Test file:** \`${file}\``,
    `- **Test name:** \`${name}\``,
    `- **Observed on:** #${target?.prNumber ?? '?'} (${runUrl})`,
    `- **Signature:** ${safeReason(decision?.reason_en ?? 'flaky test')}`,
    ``,
    `Fix it with \`.qwen/skills/deflake/SKILL.md\` — a minimal, assertion-preserving stabilization. Never weaken, skip, or delete the assertion.`,
    ``,
    `<details>`,
    `<summary>中文说明</summary>`,
    ``,
    `CI Failure Patrol 判定此测试疑似 flaky 并在同一 commit 上触发了重跑。重跑通过则为非确定性;若确定性再次失败则是真 bug 而非 flaky —— 那种情况不要稳化它。`,
    ``,
    `- **测试文件:** \`${file}\``,
    `- **用例名:** \`${name}\``,
    `- **出现于:** #${target?.prNumber ?? '?'}(${runUrl})`,
    `- **签名:** ${safeReason(decision?.reason_zh ?? 'flaky 测试')}`,
    ``,
    `请依据 \`.qwen/skills/deflake/SKILL.md\` 做最小、保留断言的稳化修复,绝不弱化、跳过或删除断言。`,
    ``,
    `</details>`,
    ``,
    marker,
  ].join('\n');
}

export async function ensureDeflakeIssue(client, target, decision) {
  if (!wellFormedFlakyTest(decision?.flakyTest)) return;
  const marker = deflakeMarker(decision.flakyTest);
  if (await client.hasOpenIssueWithMarker(marker)) return;
  const title =
    `deflake: ${decision.flakyTest.file} \u203a ${decision.flakyTest.name}`.slice(
      0,
      240,
    );
  await client.createIssue({
    title,
    body: deflakeIssueBody(decision.flakyTest, decision, target, client?.repo),
    labels: DEFLAKE_LABELS,
  });
}

function currentFailure(run, target) {
  return (
    run.status === 'completed' &&
    ['failure', 'timed_out'].includes(run.conclusion) &&
    run.head_sha === target.headSha &&
    run.run_attempt === target.runAttempt
  );
}

export function eligibleAttemptJob(job, target, runAttempt, options = {}) {
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  return (
    Number(job?.id) === target.jobId &&
    Number(job?.run_id) === target.runId &&
    Number(job?.run_attempt) === runAttempt &&
    job?.head_sha === target.headSha &&
    job?.name === target.checkName &&
    isEligibleFailure(
      {
        workflowName: target.workflowName,
        status: String(job?.status ?? '').toUpperCase(),
        conclusion: String(job?.conclusion ?? '').toUpperCase(),
        completedAt: job?.completed_at,
      },
      now,
      staleMinutes,
      activeDays,
    )
  );
}

function safeReason(reason) {
  return (
    reason
      .trim()
      // A newline lets a reason open a block-level Markdown construct: a
      // line-start fence swallows the folded Chinese block and renders the
      // tracking marker as visible code. Keep the reason a single line.
      .replace(/\s*\n\s*/g, ' ')
      // Bidi overrides can visually rewrite a notice maintainers trust when
      // deciding whether to update a branch; the reason is classifier output
      // derived from untrusted logs, so drop them like the markup below.
      // The class is the full Unicode Bidi_Control set.
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('@', '@\u200b')
  );
}

function bilingualComment(en, zh, marker) {
  return `${en}\n\n<details>\n<summary>中文说明</summary>\n\n${zh}\n\n</details>\n\n${marker}`;
}

export async function actOnDecision(client, target, decision) {
  if (!target || !validDecision(target, decision)) return;

  const isCurrentTarget = async () => {
    const pr = await client.currentPr(target.prNumber);
    const current = latestMatchingTarget(pr, target);
    return {
      current:
        pr.state === 'OPEN' &&
        !pr.isDraft &&
        pr.baseRefName === 'main' &&
        pr.headRefOid === target.headSha &&
        current?.runId === target.runId &&
        current?.jobId === target.jobId,
      pr,
    };
  };

  let state = await isCurrentTarget();
  if (!state.current) return;

  const comments = await client.comments(target.prNumber);
  if (
    alreadyHandled(comments, target, client.trustedMarkerLogin) ||
    currentActionCount(state.pr, comments, client.trustedMarkerLogin) >=
      MAX_ACTIONS
  ) {
    return;
  }
  state = await isCurrentTarget();
  if (!state.current) return;
  if (!currentFailure(await client.run(target.runId), target)) return;

  const count =
    currentActionCount(state.pr, comments, client.trustedMarkerLogin) + 1;
  const marker = markerFor(target, decision.action, count);
  if (decision.action === 'rerun') {
    await client.rerunFailedJobs(target.runId);
    // The notice must be visible: a marker-only comment left maintainers
    // unable to tell a patrolled flake from a deterministic failure, so they
    // clicked Update Branch — advancing the head and dismissing approvals.
    await client.comment(
      target.prNumber,
      bilingualComment(
        `CI Failure Patrol: this failure looks transient, not a PR regression: ${safeReason(decision.reason_en)}\n\nFailed jobs were re-run on the same commit. No Update Branch is needed — if the rerun passes, the failure was a flake.`,
        `CI 失败巡逻：此失败疑似瞬时问题，而非 PR 引入的回归：${safeReason(decision.reason_zh)}\n\n已在同一 commit 上重跑失败的 job，无需 Update Branch；重跑通过即为 flake。`,
        marker,
      ),
    );
    // A flaky TEST (not infra) also gets a deflake issue so the autofix loop
    // can stabilize it. Best-effort: the rerun + marker already succeeded, so a
    // transient issue-creation failure must not propagate (it would surface as
    // a misleading "skipping PR" and, with the marker already posted,
    // permanently suppress the deflake). Retried on the next flaky occurrence.
    try {
      await ensureDeflakeIssue(client, target, decision);
    } catch (error) {
      console.error(
        `::warning::deflake issue creation failed for #${target.prNumber}; the rerun stands and it retries on the next flaky occurrence: ${error?.message ?? error}`,
      );
    }
  } else if (decision.action === 'comment') {
    await client.comment(
      target.prNumber,
      bilingualComment(
        `CI is failing because: ${safeReason(decision.reason_en)}`,
        safeReason(decision.reason_zh),
        marker,
      ),
    );
  } else {
    await client.comment(
      target.prNumber,
      bilingualComment(
        `CI Failure Patrol: this failure could not be confidently classified: ${safeReason(decision.reason_en)}\n\nNo automatic action was taken. Inspect the failed job before rerunning or updating the branch.`,
        `CI 失败巡逻：无法确信归类此失败：${safeReason(decision.reason_zh)}\n\n未采取自动动作。请先人工查看失败 job，再决定重跑或更新分支。`,
        marker,
      ),
    );
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
  let matched = 0;
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
      // Schema BEFORE counting. actOnDecision opens with the same check and
      // returns silently, so counting on key resolution alone would let a list
      // that carries all five identity fields but fails validDecision (a
      // 240-char reason, rerun at low confidence, string-typed ids) match every
      // key, act on nothing, and still report success.
      if (!validDecision(target, decision)) {
        process.stderr.write(
          `act: invalid decision for PR ${decision?.prNumber ?? 'unknown'}; it fails the action/confidence/reason schema.\n`,
        );
        continue;
      }
      matched += 1;
      await actOnDecision(client, target, decision);
    } catch (error) {
      process.stderr.write(
        `act: skipping PR ${decision?.prNumber ?? 'unknown'}: ${error.message}${error.stderr ? `\n${String(error.stderr).trim()}` : ''}\n`,
      );
    }
  }
  // A non-empty list that addressed nothing is the hollow-green shape: the
  // round uploads, runs act, prints a per-entry diagnostic and exits 0, while
  // the workflow's verdict step is skipped because has_decisions is true. Fail
  // loudly instead. Per-decision failures stay swallowed above — a candidate
  // superseded between scan and act, one already handled, or one at the action
  // cap is a deliberate decline of a real target and still counts, as does a
  // decision whose action threw after being attempted. `no_action` counts too:
  // it posts the "could not be confidently classified" marker, so it is an act.
  if (decisions.length > 0 && matched === 0) {
    throw new Error(
      `act: ${decisions.length} decision(s) addressed no actionable candidate; this round acted on nothing.`,
    );
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
    // The caller pins an absolute, verified gh. Resolving the bare name here
    // would search PATH inside this child process, which on the shared pool
    // can contain a co-tenant's gh in a uid-writable directory — and this
    // client runs with the bot PAT in its environment.
    const { stdout } = await execFile(process.env.PATROL_GH || 'gh', args, {
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
    const prs = JSON.parse(
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
        'number,isDraft,baseRefName,headRefOid',
        '--limit',
        '1000',
      ]),
    );
    // The rollup is fetched one PR at a time. Asking for it inside the list
    // query makes a single GraphQL call whose cost grows with matched PRs
    // times their check runs, and this repo outgrew it: with the rollup the
    // search returns HTTP 504 above ~30 matches and failed 100 consecutive
    // scheduled scans, while the same search without it answers in a second.
    // A PR whose rollup cannot be read is skipped rather than failing the
    // scan — the next run picks it up.
    // Bounded fan-out: one call per PR is fine, 66 of them in series is not.
    // The patrol job has a ten-minute budget and this cost grows with the
    // open-PR count — the same growth that broke the single bulk query.
    const detailed = new Array(prs.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < prs.length; i = next++) {
        const pr = prs[i];
        try {
          const { statusCheckRollup } = JSON.parse(
            await this.gh([
              'pr',
              'view',
              String(pr.number),
              '--repo',
              this.repo,
              '--json',
              'statusCheckRollup',
            ]),
          );
          detailed[i] = { ...pr, statusCheckRollup };
        } catch (error) {
          process.stderr.write(
            `prList: skipping PR ${pr.number}: ${error.message}\n`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PR_DETAIL_CONCURRENCY, prs.length) }, () =>
        worker(),
      ),
    );
    return detailed.filter(Boolean);
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
        'number,headRefOid,state,isDraft,baseRefName,statusCheckRollup,files',
      ]),
    );
  }

  async run(runId) {
    return JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}`]),
    );
  }

  async job(jobId) {
    return JSON.parse(
      await this.gh(['api', `repos/${this.repo}/actions/jobs/${jobId}`]),
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
    const path = `repos/${this.repo}/actions/jobs/${jobId}/logs`;
    let log;
    try {
      // Current gh refuses to print a response containing terminal escape
      // sequences without this flag, and Actions job logs essentially always
      // contain them; older gh has neither the check nor the flag, so fall
      // back to the bare call only when stderr says `unknown flag`. Strip VT
      // control characters either way so raw ANSI never reaches skillLog's
      // callers. Same three-part shape as autofix-pr/ci-log.ts's jobLog.
      log = await this.gh(['api', '--allow-escape-sequences', path]);
    } catch (error) {
      if (!String(error?.stderr).includes('unknown flag')) throw error;
      log = await this.gh(['api', path]);
    }
    return stripVTControlCharacters(log);
  }

  async hasOpenIssueWithMarker(marker) {
    const output = await this.gh([
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--search',
      `${marker} in:body`,
      '--json',
      'number',
      '--limit',
      '1',
    ]);
    return JSON.parse(output).length > 0;
  }

  async createIssue({ title, body, labels }) {
    await this.gh([
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
    ]);
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
  const staleMinutes = numberArg(args, 'stale-minutes', DEFAULT_STALE_MINUTES);
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
    staleMinutes,
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
      const job = await client.job(target.jobId);
      if (
        !eligibleAttemptJob(job, target, before.run_attempt, {
          activeDays,
          staleMinutes,
        })
      ) {
        continue;
      }
      const log = skillLog(await client.jobLog(target.jobId));
      const candidate = {
        ...target,
        completedAt: job.completed_at,
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
      candidates.push({
        ...candidate,
        actionCount,
        changedFiles: (pr.files ?? []).map((file) => file.path).slice(0, 100),
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
