#!/usr/bin/env node
// Publishes the triage agent's draft actions to GitHub. The agent never holds
// a write credential: it writes data (actions.jsonl + body files), and this
// script validates the whole set before executing any of it, then performs
// the writes with the gh CLI's ambient GH_TOKEN.
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPolicy, matchArea, pickOwner } from './assign-issue-owner.mjs';

const MARKERS = new Set([
  'stage=1',
  'stage=2',
  'stage=3',
  'stage=1-pre',
  'stage=1b',
]);
const MAX_BODY_LENGTH = 65536;
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const COMMIT_ID = /^[0-9a-fA-F]{40}$/;

const ACTION_FIELDS = {
  'upsert-comment': ['marker', 'body'],
  review: ['event', 'commit_id', 'body'],
  'close-pr': [],
  'close-issue': ['reason'],
  labels: ['add', 'remove'],
  defer: ['body'],
};

const defaultExec = (args) =>
  spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

function ghCall(exec, args) {
  const result = exec(args);
  if (result.status !== 0) {
    throw new Error(
      (result.stderr ?? '').trim() || `gh ${args.slice(0, 2).join(' ')} failed`,
    );
  }
  return (result.stdout ?? '').trim();
}

// --paginate emits one JSON document per page; `.[] | @json` flattens every
// page into JSONL so multi-page results parse as reliably as single-page ones.
function ghJsonLines(exec, args) {
  return ghCall(exec, [...args, '--paginate', '--jq', '.[] | @json'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function markerLine(marker) {
  return `<!-- qwen-triage ${marker} -->`;
}

function readBodyFile(draftDir, bodiesDir, rel, where) {
  const resolved = path.resolve(draftDir, rel);
  if (!resolved.startsWith(bodiesDir + path.sep)) {
    throw new Error(`${where}: body path escapes the bodies directory: ${rel}`);
  }
  // lstat, not stat: a symlink (or FIFO, or directory) is rejected even when
  // its target would be a regular file inside the draft directory.
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new Error(`${where}: body file not found: ${rel}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${where}: body is not a regular file: ${rel}`);
  }
  const realBodies = realpathSync(bodiesDir);
  if (!realpathSync(resolved).startsWith(realBodies + path.sep)) {
    throw new Error(`${where}: body path escapes the bodies directory: ${rel}`);
  }
  const text = readFileSync(resolved, 'utf8');
  // Reject, never truncate: cutting the tail could drop the CI-region or
  // approve-on-green markers the finalize workflow consumes.
  if (text.length > MAX_BODY_LENGTH) {
    throw new Error(
      `${where}: body exceeds ${MAX_BODY_LENGTH} characters (${text.length})`,
    );
  }
  return { file: resolved, text };
}

export function validateDrafts({ dir, targetKind }) {
  const draftDir = path.resolve(dir);
  const bodiesDir = path.join(draftDir, 'bodies');
  const raw = readFileSync(path.join(draftDir, 'actions.jsonl'), 'utf8');
  const actions = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const where = `actions.jsonl line ${i + 1}`;
    let action;
    try {
      action = JSON.parse(line);
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }
    if (
      !action ||
      typeof action !== 'object' ||
      Array.isArray(action) ||
      typeof action.action !== 'string' ||
      !Object.hasOwn(ACTION_FIELDS, action.action)
    ) {
      throw new Error(`${where}: unknown action`);
    }
    const allowed = ACTION_FIELDS[action.action];
    for (const key of Object.keys(action)) {
      if (key !== 'action' && !allowed.includes(key)) {
        throw new Error(`${where}: unknown field ${key} on ${action.action}`);
      }
    }
    if (action.action === 'upsert-comment') {
      if (!MARKERS.has(action.marker)) {
        throw new Error(`${where}: marker not in allowlist: ${action.marker}`);
      }
    }
    if (action.action === 'review') {
      if (!['APPROVE', 'REQUEST_CHANGES'].includes(action.event)) {
        throw new Error(`${where}: unsupported review event: ${action.event}`);
      }
      if (action.commit_id !== undefined && !COMMIT_ID.test(action.commit_id)) {
        throw new Error(`${where}: commit_id must be 40 hex characters`);
      }
      if (action.event === 'APPROVE' && action.commit_id === undefined) {
        throw new Error(`${where}: APPROVE requires commit_id`);
      }
    }
    if (action.action === 'close-issue' && action.reason !== 'not planned') {
      throw new Error(`${where}: close-issue reason must be "not planned"`);
    }
    if (action.action === 'labels') {
      for (const key of ['add', 'remove']) {
        if (action[key] !== undefined && !isStringArray(action[key])) {
          throw new Error(
            `${where}: labels ${key} must be an array of strings`,
          );
        }
      }
    }
    if (action.action === 'defer' && targetKind !== 'pr') {
      throw new Error(`${where}: defer is only valid for pull requests`);
    }
    if (['upsert-comment', 'review', 'defer'].includes(action.action)) {
      if (typeof action.body !== 'string') {
        throw new Error(`${where}: ${action.action} requires a body path`);
      }
      const body = readBodyFile(draftDir, bodiesDir, action.body, where);
      if (
        action.action === 'upsert-comment' &&
        body.text.split('\n')[0] !== markerLine(action.marker)
      ) {
        // The publisher owns the marker prefix; the agent is not trusted to
        // have written it, and dedup/finalize match on these exact bytes.
        throw new Error(
          `${where}: body must start with "${markerLine(action.marker)}"`,
        );
      }
      action.bodyFile = body.file;
      action.bodyText = body.text;
    }
    actions.push(action);
  }
  return actions;
}

function canWrite(exec, repo, login) {
  try {
    return WRITE_PERMISSIONS.has(
      ghCall(exec, [
        'api',
        `repos/${repo}/collaborators/${login}/permission`,
        '--jq',
        '.permission',
      ]),
    );
  } catch {
    // A stale map entry (renamed/deleted account, lost access) must drop the
    // candidate, not fail the defer.
    return false;
  }
}

// Same gh invocation as assign-issue-owner.mjs's openIssueCount so the two
// assignment paths cannot drift; re-spelled here because that export binds
// its own spawnSync and cannot take the injected executor.
function openIssueCount(exec, repo, login) {
  return Number(
    ghCall(exec, [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--assignee',
      login,
      '--limit',
      '100',
      '--json',
      'number',
      '--jq',
      'length',
    ]),
  );
}

export function resolveMaintainer({
  repo,
  number,
  exec,
  env = process.env,
  ownersFile = fileURLToPath(new URL('../issue-owners.json', import.meta.url)),
  err = process.stderr,
}) {
  const handle = env.QWEN_MAINTAINER_HANDLE;
  if (handle) return handle;
  try {
    const policy = loadPolicy(readFileSync(ownersFile, 'utf8'));
    const pr = JSON.parse(
      ghCall(exec, [
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'author,labels',
      ]),
    );
    const area = matchArea(policy, pr);
    if (area) {
      // A null author means a deleted account — nobody to exclude.
      const authorLogin = pr.author?.login?.toLowerCase() ?? '';
      const eligible = area.owners.filter(
        (owner) =>
          owner.toLowerCase() !== authorLogin && canWrite(exec, repo, owner),
      );
      if (eligible.length > 0) {
        const load = new Map(
          eligible.map((owner) => [owner, openIssueCount(exec, repo, owner)]),
        );
        return pickOwner(eligible, load, Number(number));
      }
    }
  } catch (error) {
    err.write(`warning: owner-map resolution failed: ${error.message}\n`);
  }
  try {
    const { latestReviews } = JSON.parse(
      ghCall(exec, [
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'latestReviews',
      ]),
    );
    // latestReviews is not recency-sorted; drop deleted accounts and bot
    // suffixes before sorting so a defer never @mentions a bot.
    const humans = (latestReviews ?? [])
      .filter((review) => review.author?.login != null)
      .filter(
        (review) =>
          !review.author.login.endsWith('[bot]') &&
          !review.author.login.endsWith('-bot'),
      )
      .sort((a, b) =>
        String(a.submittedAt).localeCompare(String(b.submittedAt)),
      );
    return humans.at(-1)?.author.login ?? '';
  } catch {
    return '';
  }
}

function upsertComment(action, { repo, number, botLogin, exec }) {
  const prefix = markerLine(action.marker);
  let existing = null;
  // Without a verified bot identity a PATCH could overwrite a human comment
  // that quotes the marker, so identity failure forbids PATCH entirely.
  if (botLogin) {
    const comments = ghJsonLines(exec, [
      'api',
      `repos/${repo}/issues/${number}/comments`,
    ]);
    const matches = comments.filter(
      (comment) =>
        comment.user?.login === botLogin &&
        typeof comment.body === 'string' &&
        comment.body.startsWith(prefix),
    );
    existing = matches.at(-1) ?? null;
  }
  if (existing) {
    ghCall(exec, [
      'api',
      '-X',
      'PATCH',
      `repos/${repo}/issues/comments/${existing.id}`,
      '-F',
      `body=@${action.bodyFile}`,
    ]);
    return { status: 'published', detail: `PATCH comment ${existing.id}` };
  }
  ghCall(exec, [
    'api',
    `repos/${repo}/issues/${number}/comments`,
    '-F',
    `body=@${action.bodyFile}`,
  ]);
  return {
    status: 'published',
    detail: botLogin
      ? 'POST comment'
      : 'POST comment (identity unresolved; PATCH disabled)',
  };
}

function submitReview(action, { repo, number, botLogin, exec }) {
  const reviews = ghJsonLines(exec, [
    'api',
    `repos/${repo}/pulls/${number}/reviews`,
  ]);
  const head = ghCall(exec, [
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]);
  const own = botLogin
    ? reviews.filter((review) => review.user?.login === botLogin)
    : [];
  if (action.event === 'APPROVE') {
    if (
      own.some(
        (review) =>
          review.state === 'APPROVED' && review.commit_id === action.commit_id,
      )
    ) {
      return { status: 'skipped', detail: 'already approved at this commit' };
    }
    // Attesting a commit that is no longer head would approve code nobody
    // reviewed; the finalize workflow applies the same stale check.
    if (head !== action.commit_id) {
      return { status: 'skipped', detail: 'stale' };
    }
  } else if (own.some((review) => review.state === 'CHANGES_REQUESTED')) {
    return { status: 'skipped', detail: 'changes already requested' };
  }
  const args = [
    'api',
    `repos/${repo}/pulls/${number}/reviews`,
    '-f',
    `event=${action.event}`,
  ];
  if (action.commit_id !== undefined) {
    args.push('-f', `commit_id=${action.commit_id}`);
  }
  args.push('-F', `body=@${action.bodyFile}`);
  ghCall(exec, args);
  return { status: 'published', detail: `${action.event} review` };
}

function closeTarget(action, { repo, number, exec }) {
  const state = ghCall(exec, [
    'api',
    `repos/${repo}/issues/${number}`,
    '--jq',
    '.state',
  ]);
  if (state !== 'open') {
    return { status: 'skipped', detail: `already ${state}` };
  }
  if (action.action === 'close-pr') {
    ghCall(exec, ['pr', 'close', String(number), '--repo', repo]);
  } else {
    ghCall(exec, [
      'issue',
      'close',
      String(number),
      '--repo',
      repo,
      '--reason',
      'not planned',
    ]);
  }
  return { status: 'published', detail: 'closed' };
}

function applyLabels(action, { repo, number, exec }) {
  const existing = new Set(
    ghJsonLines(exec, ['api', `repos/${repo}/labels`]).map(
      (label) => label.name,
    ),
  );
  const add = action.add ?? [];
  const remove = action.remove ?? [];
  const missing = [...add, ...remove].filter((label) => !existing.has(label));
  if (missing.length > 0) {
    throw new Error(`labels do not exist: ${missing.join(', ')}`);
  }
  if (add.length + remove.length === 0) {
    return { status: 'skipped', detail: 'no labels to apply' };
  }
  const args = ['issue', 'edit', String(number), '--repo', repo];
  for (const label of add) args.push('--add-label', label);
  for (const label of remove) args.push('--remove-label', label);
  ghCall(exec, args);
  return {
    status: 'published',
    detail: `add [${add.join(', ')}] remove [${remove.join(', ')}]`,
  };
}

function deferToMaintainer(action, context) {
  const { repo, number, exec, env, ownersFile, err } = context;
  const login = resolveMaintainer({ repo, number, exec, env, ownersFile, err });
  const mention = login
    ? `⏸️ Deferring to @${login} — needs a human call on this one.`
    : '⏸️ Deferring to the maintainers — needs a human call on this one.';
  const tempDir = mkdtempSync(path.join(tmpdir(), 'triage-publish-'));
  const bodyFile = path.join(tempDir, 'defer.md');
  try {
    writeFileSync(bodyFile, `${mention}\n\n${action.bodyText}`);
    ghCall(exec, [
      'api',
      `repos/${repo}/issues/${number}/comments`,
      '-F',
      `body=@${bodyFile}`,
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (login) {
    try {
      ghCall(exec, [
        'pr',
        'edit',
        String(number),
        '--repo',
        repo,
        '--add-assignee',
        login,
      ]);
    } catch (error) {
      // The mention is the load-bearing signal; a failed assign must never
      // turn a published defer into a failed action.
      err.write(`warning: could not assign @${login}: ${error.message}\n`);
    }
  }
  return {
    status: 'published',
    detail: login ? `deferred to @${login}` : 'deferred without mention',
  };
}

function runAction(action, context) {
  switch (action.action) {
    case 'upsert-comment':
      return upsertComment(action, context);
    case 'review':
      return submitReview(action, context);
    case 'close-pr':
    case 'close-issue':
      return closeTarget(action, context);
    case 'labels':
      return applyLabels(action, context);
    case 'defer':
      return deferToMaintainer(action, context);
  }
}

export function executeActions({
  actions,
  repo,
  number,
  botLogin,
  exec,
  env = process.env,
  ownersFile,
  err = process.stderr,
}) {
  const context = { repo, number, botLogin, exec, env, ownersFile, err };
  const results = [];
  for (const action of actions) {
    try {
      const result = runAction(action, context);
      results.push({ action: action.action, ...result });
    } catch (error) {
      results.push({
        action: action.action,
        status: 'failed',
        detail: error.message,
      });
    }
  }
  return results;
}

export function run({
  argv,
  env = process.env,
  exec = defaultExec,
  out = process.stdout,
  err = process.stderr,
}) {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: {
        drafts: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    err.write(`${error.message}\n`);
    return 2;
  }
  const dir = options.values.drafts;
  const repo = options.values.repo;
  const number = Number(options.values.number);
  const dryRun = options.values['dry-run'] === true;
  if (
    !dir ||
    !repo ||
    !/^[^/\s]+\/[^/\s]+$/.test(repo) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    err.write(
      'usage: triage-publish.mjs --drafts <dir> --repo <owner/repo> --number <n> [--dry-run]\n',
    );
    return 2;
  }

  let targetKind;
  try {
    const target = JSON.parse(
      ghCall(exec, ['api', `repos/${repo}/issues/${number}`]),
    );
    targetKind = target.pull_request ? 'pr' : 'issue';
  } catch (error) {
    err.write(`preflight: cannot read target: ${error.message}\n`);
    return 2;
  }

  let actions;
  try {
    actions = validateDrafts({ dir, targetKind });
  } catch (error) {
    err.write(`preflight rejected: ${error.message}\n`);
    return 2;
  }

  let botLogin = env.BOT_LOGIN || null;
  if (!botLogin) {
    try {
      botLogin = ghCall(exec, ['api', 'user', '--jq', '.login']) || null;
    } catch {
      botLogin = null;
    }
    if (!botLogin) {
      err.write(
        'warning: bot identity unresolved; comment PATCH disabled (fresh POST only)\n',
      );
    }
  }

  if (dryRun) {
    for (const action of actions) {
      out.write(
        `${JSON.stringify({ action: action.action, status: 'skipped', detail: 'dry-run' })}\n`,
      );
    }
    err.write(
      `dry-run: ${actions.length} action(s) validated, nothing published\n`,
    );
    return 0;
  }

  const results = executeActions({
    actions,
    repo,
    number,
    botLogin,
    exec,
    env,
    err,
  });
  for (const result of results) {
    out.write(`${JSON.stringify(result)}\n`);
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  err.write(
    `${results.length} action(s): ${count('published')} published, ${count('skipped')} skipped, ${count('failed')} failed\n`,
  );
  return count('failed') > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(run({ argv: process.argv.slice(2) }));
}
