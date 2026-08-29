#!/usr/bin/env node
// Watch the health of `@qwen-code /resolve` and file one issue when it is
// failing in a row.
//
// Why this exists: between 2026-08-15 and 08-27 every /resolve request failed
// before the agent looked at the conflict — 0 of 81 — and nobody noticed for
// thirteen days, because each failure looked like one more PR the model could
// not handle and the natural response was to ask again. The command's own
// baseline is 84% pushed, so five consecutive failures are a ~0.01% event
// under normal operation and almost always mean the lane itself is broken
// (an unpublished npm version, a missing sandbox image, a workflow that no
// longer parses). This script turns that streak into an issue.
//
// Data source: the bot's `<!-- qwen-resolve-result -->` comments on PRs that
// carry a `/resolve` request in the last WINDOW_DAYS, read through the same
// APIs a maintainer would. Two signals:
//   - the trailing run of failed attempts (skips do not count either way);
//   - requests that never got a result comment and are older than STALE_HOURS
//     (a workflow file that fails to parse produces exactly this).
// One open issue at a time, found by an exact body marker matched client-side
// (GitHub search tokenizes the marker away). Its body is written once; every
// later change is a comment; recovery comments and closes it.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RESULT_MARKER = '<!-- qwen-resolve-result -->';
export const HEALTH_MARKER = '<!-- qwen-resolve-health -->';
const STATE_RE = /<!-- qwen-resolve-health-state (\{[^\n]*?\}) -->/;
export const DEFAULTS = Object.freeze({
  threshold: 5,
  unansweredThreshold: 3,
  staleHours: 3,
  windowDays: 7,
  bot: 'qwen-code-dev-bot',
  label: 'scope/ci-cd',
  recentLimit: 10,
});

// Mirrors the workflow's own trigger shape (exact body, or the command
// followed by a space / newline / CR), so a comment counts as a request here
// exactly when it counted as one there.
export function isRequest(body) {
  const command = '@qwen-code /resolve';
  return (
    body === command ||
    body.startsWith(`${command} `) ||
    body.startsWith(`${command}\n`) ||
    body.startsWith(`${command}\r`)
  );
}

// `unknown` — a result comment whose sentence this script does not know — is
// counted as a FAILURE on purpose: if the workflow's wording drifts, the watch
// should raise a visible (and visibly mislabelled) alarm rather than fall
// silent while the lane is broken. A test pins every producer sentence.
const FAILED = new Set([
  'infra_failed',
  'agent_failed',
  'push_failed',
  'unknown',
]);
const OK = new Set(['pushed', 'resolved_moved', 'noop', 'dry_run']);

// Classifies a result comment by the fixed sentences `Report result` and
// `Report skipped request` emit. Order matters: the infra wording is checked
// before the generic failure wording it replaced for the never-ran case, and
// the one benign "resolved, but" (the head moved — a retry helps) before the
// three that mean the push itself is broken (token scope, fork permission,
// unexplained rejection — a retry repeats them).
export function classifyResult(body) {
  if (!body.includes(RESULT_MARKER)) {
    return null;
  }
  if (body.includes('could not run conflict resolution')) {
    return 'infra_failed';
  }
  if (body.includes('did not complete successfully')) {
    return 'agent_failed';
  }
  if (body.includes('and pushed the branch update')) {
    return 'pushed';
  }
  if (body.includes('in dry-run mode')) {
    return 'dry_run';
  }
  if (body.includes('head branch changed while resolving')) {
    return 'resolved_moved';
  }
  if (body.includes('resolved the merge conflicts, but')) {
    return 'push_failed';
  }
  if (body.includes('did not push changes')) {
    return 'noop';
  }
  if (body.includes('did not run conflict resolution')) {
    return 'skipped';
  }
  return 'unknown';
}

function headline(body) {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<!--'));
  return (line ?? '').slice(0, 160);
}

// prs: [{ number, comments: [{ id, user, created_at, body, html_url }] }]
export function assess(prs, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = opts.now instanceof Date ? opts.now : new Date();
  // Events older than the window are invisible, whatever PR carries them:
  // the search window bounds which PRs are read, not how old their comments
  // are, and a request or failure from weeks ago must neither alarm nor
  // reset a streak forever. Compared as ISO strings, like everything else.
  const windowStart = new Date(
    now.getTime() - opts.windowDays * 86_400_000,
  ).toISOString();
  const results = [];
  const unanswered = [];
  for (const pr of prs) {
    const comments = [...pr.comments]
      .filter((c) => c.created_at >= windowStart)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const prResults = [];
    for (const c of comments) {
      const kind = classifyResult(c.body);
      if (kind) {
        prResults.push({
          pr: pr.number,
          id: c.id,
          url: c.html_url,
          at: c.created_at,
          kind,
          headline: headline(c.body),
        });
      }
    }
    results.push(...prResults);
    const requests = comments.filter(
      (c) => c.user !== opts.bot && isRequest(c.body),
    );
    for (const req of requests) {
      // Any result after the request answers it. Runs on one PR are
      // serialised by the workflow's concurrency group, so a later result
      // implies the earlier run finished — and a retry typed before the
      // first run reported must not leave the first request "unanswered"
      // forever because its result landed after the retry's timestamp.
      const answered = prResults.some((r) => r.at > req.created_at);
      const ageHours = (now.getTime() - Date.parse(req.created_at)) / 3_600_000;
      if (!answered && ageHours >= opts.staleHours) {
        unanswered.push({
          pr: pr.number,
          id: req.id,
          url: req.html_url,
          at: req.created_at,
          user: req.user,
        });
      }
    }
  }
  results.sort((a, b) => a.at.localeCompare(b.at));
  unanswered.sort((a, b) => a.at.localeCompare(b.at));
  const attempts = results.filter((r) => FAILED.has(r.kind) || OK.has(r.kind));
  let streak = 0;
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (!FAILED.has(attempts[i].kind)) {
      break;
    }
    streak += 1;
  }
  const streakItems = attempts.slice(attempts.length - streak);
  const infra = streakItems.filter((r) => r.kind === 'infra_failed').length;
  return {
    windowStart,
    results,
    attempts,
    streak,
    streakItems,
    infraInStreak: infra,
    unanswered,
    latestAttempt: attempts.at(-1) ?? null,
    alarm:
      streak >= opts.threshold || unanswered.length >= opts.unansweredThreshold,
  };
}

function stateOf(assessment) {
  return {
    streak: assessment.streak,
    unanswered: assessment.unanswered.length,
    latest: assessment.latestAttempt?.id ?? null,
  };
}

export function readState(issueBodyAndComments) {
  let state = null;
  for (const text of issueBodyAndComments) {
    const m = text.match(STATE_RE);
    if (m) {
      try {
        state = JSON.parse(m[1]);
      } catch {
        // A hand-edited marker is treated as no state: the next tick rewrites it.
      }
    }
  }
  return state;
}

function stateMarker(assessment) {
  return `<!-- qwen-resolve-health-state ${JSON.stringify(stateOf(assessment))} -->`;
}

function fmt(at) {
  return at.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z');
}

export function renderReport(assessment, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const lines = [];
  const recent = assessment.attempts.slice(-opts.recentLimit).reverse();
  lines.push(
    `**Trailing failures:** ${assessment.streak} in a row` +
      (assessment.streak
        ? ` (${assessment.infraInStreak} never reached the agent's verdict, ${assessment.streak - assessment.infraInStreak} were the agent giving up)`
        : ''),
  );
  lines.push(
    `**Requests without any result comment after ${opts.staleHours}h:** ${assessment.unanswered.length}`,
  );
  lines.push('');
  if (recent.length) {
    lines.push(`Last ${recent.length} attempts, newest first:`);
    lines.push('');
    lines.push('| When (UTC) | PR | Outcome | Comment |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of recent) {
      const mark = FAILED.has(r.kind) ? '❌' : '✅';
      lines.push(
        `| ${fmt(r.at)} | #${r.pr} | ${mark} ${r.kind} | [${r.headline.replace(/\|/g, '\\|')}](${r.url}) |`,
      );
    }
    lines.push('');
  }
  if (assessment.unanswered.length) {
    lines.push('Requests with no result comment:');
    lines.push('');
    for (const u of assessment.unanswered.slice(-opts.recentLimit)) {
      lines.push(`- ${fmt(u.at)} #${u.pr} by @${u.user} — [comment](${u.url})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderIssueBody(assessment, options = {}) {
  return [
    HEALTH_MARKER,
    stateMarker(assessment),
    '`@qwen-code /resolve` is failing in a row. Its baseline is ~84% of agent runs pushing a resolution, so a streak this long almost always means the lane itself is broken — an npm `latest` that does not resolve, a sandbox image that was never published, a workflow file that no longer parses — not the conflicts. Re-running requests will not help until the cause is fixed.',
    '',
    'How to read the outcomes: `infra_failed` means the agent step ended without running (install, model endpoint, timeout, cancellation — open the workflow run linked from the comment); `agent_failed` means the agent ran and gave up or failed verification; `push_failed` means it resolved the conflict but the push was rejected for a reason a retry repeats (token scope, fork permissions); `unknown` means the result comment used wording this watch does not recognise — check for a producer change. A request with no result comment at all usually means the workflow never started (an invalid workflow file produces exactly that, with no run to look at).',
    '',
    renderReport(assessment, options),
    'This issue is maintained by `.github/workflows/qwen-resolve-health.yml`; it comments when the picture changes and closes itself once a `/resolve` succeeds again.',
  ].join('\n');
}

export function renderUpdate(assessment, options = {}) {
  return [
    HEALTH_MARKER,
    stateMarker(assessment),
    'Still failing; the picture has changed since the last report.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

export function renderRecovery(assessment, options = {}) {
  const latest = assessment.latestAttempt;
  return [
    HEALTH_MARKER,
    stateMarker(assessment),
    latest
      ? `Recovered: the latest attempt ([#${latest.pr}](${latest.url}), ${fmt(latest.at)}) is \`${latest.kind}\`. Closing.`
      : 'Recovered: no failing attempt remains in the window. Closing.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// Pure decision: what to write, given the assessment and the open issue (if
// any). `existing` is { number, texts: [body, ...comments] } or null.
export function decide(assessment, existing, options = {}) {
  const actions = [];
  if (assessment.alarm) {
    if (!existing) {
      actions.push({
        type: 'create',
        title: `/resolve is failing: ${assessment.streak} consecutive failures, ${assessment.unanswered.length} unanswered requests`,
        body: renderIssueBody(assessment, options),
      });
    } else {
      const previous = readState(existing.texts);
      const current = stateOf(assessment);
      const changed =
        !previous ||
        previous.streak !== current.streak ||
        previous.unanswered !== current.unanswered ||
        previous.latest !== current.latest;
      if (changed) {
        actions.push({
          type: 'comment',
          number: existing.number,
          body: renderUpdate(assessment, options),
        });
      }
    }
  } else if (existing) {
    // Recovery needs positive evidence: a successful attempt the issue has
    // not seen yet. An alarm that merely stopped being visible — the PRs
    // carrying the unanswered requests fell out of the discovery window, or
    // no attempt happened at all — is not a recovery, and closing on it
    // would hide a lane that is still broken.
    const previous = readState(existing.texts);
    const latest = assessment.latestAttempt;
    const newSuccess =
      latest && OK.has(latest.kind) && latest.id !== previous?.latest;
    if (newSuccess) {
      actions.push({
        type: 'comment',
        number: existing.number,
        body: renderRecovery(assessment, options),
      });
      actions.push({ type: 'close', number: existing.number });
    }
  }
  return actions;
}

function defaultGh(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tsvLines(text) {
  return text
    .split('\n')
    .filter((l) => l.length)
    .map((l) => l.split('\t'));
}

function b64(s) {
  return Buffer.from(s, 'base64').toString('utf8');
}

export function fetchPrs(gh, repo, since) {
  const numbers = tsvLines(
    gh([
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      `q=repo:${repo} is:pr "@qwen-code /resolve" in:comments updated:>=${since}`,
      '-f',
      'per_page=100',
      '--paginate',
      '--jq',
      '.items[] | [.number] | @tsv',
    ]),
  ).map(([n]) => Number(n));
  return numbers.map((number) => ({
    number,
    comments: tsvLines(
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repo}/issues/${number}/comments`,
        '-f',
        'per_page=100',
        '--paginate',
        '--jq',
        '.[] | [.id, .user.login, .created_at, .html_url, (.body // "" | @base64)] | @tsv',
      ]),
    ).map(([id, user, created_at, html_url, body]) => ({
      id: Number(id),
      user,
      created_at,
      html_url,
      body: b64(body),
    })),
  }));
}

export function findOpenIssue(gh, repo, label) {
  const rows = tsvLines(
    gh([
      'api',
      '-X',
      'GET',
      `repos/${repo}/issues`,
      '-f',
      'state=open',
      '-f',
      `labels=${label}`,
      '-f',
      'per_page=100',
      '--paginate',
      '--jq',
      '.[] | select(.pull_request == null) | [.number, (.body // "" | @base64)] | @tsv',
    ]),
  );
  for (const [number, body] of rows) {
    const text = b64(body);
    if (text.includes(HEALTH_MARKER)) {
      const comments = tsvLines(
        gh([
          'api',
          '-X',
          'GET',
          `repos/${repo}/issues/${number}/comments`,
          '-f',
          'per_page=100',
          '--paginate',
          '--jq',
          '.[] | [(.body // "" | @base64)] | @tsv',
        ]),
      ).map(([b]) => b64(b));
      return { number: Number(number), texts: [text, ...comments] };
    }
  }
  return null;
}

export function apply(gh, repo, actions, label) {
  for (const action of actions) {
    if (action.type === 'create') {
      gh(
        ['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'],
        JSON.stringify({
          title: action.title,
          body: action.body,
          labels: [label],
        }),
      );
    } else if (action.type === 'comment') {
      gh(
        [
          'api',
          '-X',
          'POST',
          `repos/${repo}/issues/${action.number}/comments`,
          '--input',
          '-',
        ],
        JSON.stringify({ body: action.body }),
      );
    } else if (action.type === 'close') {
      gh(
        [
          'api',
          '-X',
          'PATCH',
          `repos/${repo}/issues/${action.number}`,
          '--input',
          '-',
        ],
        JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      );
    }
  }
}

export function main({
  gh = defaultGh,
  env = process.env,
  now = new Date(),
} = {}) {
  const repo = env.REPO;
  if (!repo) {
    throw new Error('REPO is required (owner/name).');
  }
  // A dispatch knob is free text; a non-numeric value must fall back to the
  // default, not to NaN — every comparison against NaN is false, which would
  // silently turn the alarm off.
  const knob = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      return fallback;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) {
      return n;
    }
    console.log(
      `resolve-health: ignoring ${name}=${JSON.stringify(raw)} (not a positive integer); using ${fallback}`,
    );
    return fallback;
  };
  const opts = {
    ...DEFAULTS,
    now,
    threshold: knob('RESOLVE_HEALTH_THRESHOLD', DEFAULTS.threshold),
    unansweredThreshold: knob(
      'RESOLVE_HEALTH_UNANSWERED',
      DEFAULTS.unansweredThreshold,
    ),
  };
  const since = new Date(now.getTime() - opts.windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const prs = fetchPrs(gh, repo, since);
  const assessment = assess(prs, opts);
  const existing = findOpenIssue(gh, repo, opts.label);
  const actions = decide(assessment, existing, opts);
  console.log(
    `resolve-health: ${prs.length} PRs since ${since}, ${assessment.attempts.length} attempts, streak=${assessment.streak}, unanswered=${assessment.unanswered.length}, alarm=${assessment.alarm}, issue=${existing?.number ?? 'none'}, actions=${actions.map((a) => a.type).join(',') || 'none'}`,
  );
  apply(gh, repo, actions, opts.label);
  return { assessment, actions };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
