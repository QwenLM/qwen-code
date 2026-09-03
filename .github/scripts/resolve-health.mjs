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
// Outcomes that reset the failure streak. `skipped`, `noop`, and `dry_run`
// push nothing and are deliberately counted on neither side: they are neither
// evidence that the lane is broken nor evidence that a push outage has
// healed. `resolved_moved` resets the streak (a retryable resolution) but is
// not recovery evidence either — decide() demands a real `pushed` for that.
const OK = new Set(['pushed', 'resolved_moved']);

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
  // Classify the first non-marker line only. `Report result` appends
  // agent-authored text after its fixed sentence (address-summary.md, up to
  // 6000 bytes; no-action.md; failure.md), and that text can quote any of
  // the sentences below — an agent describing an earlier failed run, or
  // conflicting-file content an attacker chose. The fixed sentence is always
  // the first line; nothing after it may change the verdict.
  const line = firstLine(body);
  if (line.includes('could not run conflict resolution')) {
    return 'infra_failed';
  }
  if (line.includes('run artifact never reached the publish job')) {
    return 'infra_failed';
  }
  if (line.includes('did not complete successfully')) {
    return 'agent_failed';
  }
  if (line.includes('and pushed the branch update')) {
    return 'pushed';
  }
  if (line.includes('in dry-run mode')) {
    return 'dry_run';
  }
  if (line.includes('head branch changed while resolving')) {
    return 'resolved_moved';
  }
  if (line.includes('resolved the merge conflicts, but')) {
    return 'push_failed';
  }
  if (line.includes('did not push changes')) {
    return 'noop';
  }
  if (line.includes('did not run conflict resolution')) {
    return 'skipped';
  }
  return 'unknown';
}

function firstLine(body) {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<!--'));
  return line ?? '';
}

function headline(body) {
  return firstLine(body).slice(0, 160);
}

// A request the producer would have refused can never be answered, so it must
// not read as an unanswered one. `resolve-pr` needs `authorize` to say yes,
// and that job demands admin/maintain/write and fails closed; on denial the
// whole job is skipped — including its own `Report skipped request` step — so
// a refused request gets no result comment, no reaction, nothing at all.
// Counting it would turn a healthy lane into a dead one: three fork-PR
// authors asking (the exact population /resolve exists for) would file
// "0 consecutive failures, 3 unanswered requests" while every maintainer
// request is being served.
//
// `author_association` rides along on the comment payload this watch already
// reads, and holding write implies one of these three — the repository owner
// comments as OWNER, an organisation member as MEMBER, anyone granted access
// directly as COLLABORATOR. Everything else (CONTRIBUTOR,
// FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE, and a field the API
// did not return) cannot hold write, so dropping it never hides a request the
// lane would have answered. Deliberately WIDER than "has write": a read-only
// collaborator still counts, which leaves a false alarm possible for three of
// those in one window but keeps the watch from silencing a real outage. The
// permission API itself is not an option here — it needs a PAT (see
// qwen-code-pr-review.yml's authorize job), which a scheduled watch has no
// reason to hold.
export const ANSWERABLE_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

// prs: [{ number, state, comments: [{ id, user, author_association, created_at, updated_at, body, html_url }] }]
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
      // Only the bot posts result comments; a marker plus the right sentence
      // from anyone else must neither break a streak nor pose as a recovery.
      if (c.user !== opts.bot) {
        continue;
      }
      // The producer posts a fresh comment per run and never edits one, so
      // an edited result comment is not the producer's word: anyone with
      // triage-or-better can edit it into a forged recovery (or a success
      // into a failure phrase), and the edit must count as no result at all.
      if (c.updated_at !== c.created_at) {
        continue;
      }
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
    // A request on a closed or merged PR can never be answered — the producer
    // only runs on open PRs — so it must not count as unanswered. Results on
    // such PRs keep counting: attempts that finished before the PR closed
    // still feed the streak and the recovery evidence.
    if (pr.state !== 'open') {
      continue;
    }
    const requests = comments.filter(
      (c) =>
        c.user !== opts.bot &&
        // The producer fires on comment creation only; a comment edited into
        // request shape never ran and never gets a result comment.
        c.updated_at === c.created_at &&
        // ...and only from someone the producer would have served: see
        // ANSWERABLE_ASSOCIATIONS.
        ANSWERABLE_ASSOCIATIONS.has(c.author_association) &&
        isRequest(c.body),
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
  // `created_at` is second-granular, so same-second events tie: without a
  // second key the sort keeps the order the input arrived in, which for
  // `fetchPrs` is search ranking. The streak, the latest attempt, and the
  // roster would then move between ticks on unchanged data. Comment ids are
  // unique, so they settle every tie.
  results.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  unanswered.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
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
  const pushFailed = streakItems.filter((r) => r.kind === 'push_failed').length;
  return {
    windowStart,
    results,
    attempts,
    streak,
    streakItems,
    infraInStreak: infra,
    pushFailedInStreak: pushFailed,
    unanswered,
    latestAttempt: attempts.at(-1) ?? null,
    alarm:
      streak >= opts.threshold || unanswered.length >= opts.unansweredThreshold,
  };
}

// The state a tick records on the issue, compared by the next tick to decide
// whether the picture moved. `unanswered` is the MEMBERSHIP (request ids),
// not the count: during a never-ran outage one request gets answered by a
// skip while another ages past the stale window, the count holds and the
// roster the issue shows would otherwise freeze on week one.
// `newestUnanswered` is the newest unanswered-request timestamp seen since
// the issue opened — carried forward, never lowered: a request answered by
// its PR closing or by ageing out of the window leaves no trace in a later
// assessment, yet the recovery gate must keep postdating it (see decide()).
// Kept single-line (STATE_RE) — JSON.stringify of a flat object never emits
// a newline.
function stateOf(assessment, previous = null) {
  const newest = assessment.unanswered.at(-1)?.at ?? null;
  const carried = previous?.newestUnanswered ?? null;
  return {
    streak: assessment.streak,
    unanswered: assessment.unanswered.map((u) => u.id),
    newestUnanswered:
      carried && (!newest || carried > newest) ? carried : newest,
    latest: assessment.latestAttempt?.id ?? null,
  };
}

// `newestUnanswered` is deliberately not compared: the carried maximum can
// legitimately differ from the current roster's without the picture moving.
function sameState(previous, current) {
  return (
    previous !== null &&
    previous.streak === current.streak &&
    previous.latest === current.latest &&
    JSON.stringify(previous.unanswered) === JSON.stringify(current.unanswered)
  );
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

function stateMarker(state) {
  return `<!-- qwen-resolve-health-state ${JSON.stringify(state)} -->`;
}

function fmt(at) {
  return at.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z');
}

export function renderReport(assessment, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const lines = [];
  const recent = assessment.attempts.slice(-opts.recentLimit).reverse();
  // Split by kind, so the headline sends the reader to the right place: an
  // agent that never ran (install/model/infra), a push that was rejected
  // (credentials, fork permissions), or the agent itself giving up.
  const gaveUp =
    assessment.streak -
    assessment.infraInStreak -
    assessment.pushFailedInStreak;
  lines.push(
    `**Trailing failures:** ${assessment.streak} in a row` +
      (assessment.streak
        ? ` (${assessment.infraInStreak} never reached the agent's verdict, ${assessment.pushFailedInStreak} resolved the conflict but the push was rejected, ${gaveUp} were the agent giving up or an unrecognised result)`
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
    stateMarker(stateOf(assessment)),
    '`@qwen-code /resolve` is failing in a row. Its baseline is ~84% of agent runs pushing a resolution, so a streak this long almost always means the lane itself is broken — an npm `latest` that does not resolve, a sandbox image that was never published, a workflow file that no longer parses — not the conflicts. Re-running requests will not help until the cause is fixed.',
    '',
    'How to read the outcomes: `infra_failed` means the agent step ended without running (install, model endpoint, timeout, cancellation — open the workflow run linked from the comment); `agent_failed` means the agent ran and gave up or failed verification; `push_failed` means it resolved the conflict but the push was rejected for a reason a retry repeats (token scope, fork permissions); `unknown` means the result comment used wording this watch does not recognise — check for a producer change. A request with no result comment at all usually means the workflow never started (an invalid workflow file produces exactly that, with no run to look at); only requests from someone the lane would have served are counted, since it refuses anyone without write access in silence.',
    '',
    renderReport(assessment, options),
    'This issue is maintained by `.github/workflows/qwen-resolve-health.yml`; it comments when the picture changes and closes itself once a `/resolve` succeeds again.',
  ].join('\n');
}

export function renderUpdate(assessment, options = {}, previous = null) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment, previous)),
    'Still failing; the picture has changed since the last report.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// The write decide() makes with the alarm quiet: it records state and claims
// nothing else, so it must not reuse the update's "still failing" headline.
function renderStateRefresh(assessment, options = {}, previous = null) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment, previous)),
    'State refresh: recording the picture as the watch now sees it, which the state on this issue does not yet carry. The alarm is not firing.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// decide() only emits this once a `pushed` attempt exists, so the comment
// always names the attempt that recovered the lane.
export function renderRecovery(assessment, options = {}, previous = null) {
  const latest = assessment.latestAttempt;
  return [
    HEALTH_MARKER,
    `<!-- qwen-resolve-health-state ${JSON.stringify({
      ...stateOf(assessment, previous),
      recovered: latest.id,
    })} -->`,
    `Recovered: the latest attempt ([#${latest.pr}](${latest.url}), ${fmt(latest.at)}) is \`${latest.kind}\`. Closing.`,
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// Holds a state's barrier at the issue body's own when the body is not
// trusted as state — see findOpenIssue's `bodyFloor`. Monotone, so a body
// can only hold the barrier up, never lower what a trusted marker recorded.
function withFloor(previous, bodyFloor) {
  const carried = previous?.newestUnanswered ?? null;
  return {
    ...previous,
    newestUnanswered:
      bodyFloor && (!carried || bodyFloor > carried) ? bodyFloor : carried,
  };
}

// Pure decision: what to write, given the assessment and the open issue (if
// any). `existing` is { number, texts: [body, ...comments], bodyFloor } or
// null.
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
      if (!sameState(previous, current)) {
        actions.push({
          type: 'comment',
          number: existing.number,
          body: renderUpdate(
            assessment,
            options,
            withFloor(previous, existing.bodyFloor),
          ),
        });
      }
    }
  } else if (existing) {
    // Recovery needs positive, push-grade evidence: only a `pushed` result
    // proves the lane works again (`resolved_moved`, `noop`, and `dry_run`
    // push nothing). An alarm that merely stopped being visible — the PRs
    // carrying the unanswered requests fell out of the discovery window, or
    // no attempt happened at all — is not a recovery, and closing on it
    // would hide a lane that is still broken.
    const previous = readState(existing.texts);
    const carried = withFloor(previous, existing.bodyFloor);
    const latest = assessment.latestAttempt;
    // ...and the push must postdate every unanswered request the watch has
    // seen since the issue opened: a push that landed before those requests
    // cannot be evidence that anything ran after them. Requests answered by
    // a closed PR or by ageing out of the window leave no trace in the
    // current assessment, so their newest timestamp survives in the state
    // markers written on the issue.
    const barrier = stateOf(assessment, carried).newestUnanswered;
    // No readable state means no barrier ON RECORD, which is not the same as
    // no barrier: the marker carrying it can be edited away, and closing on
    // that would certify a recovery nothing vouches for.
    if (
      previous &&
      latest &&
      latest.kind === 'pushed' &&
      (!barrier || latest.at > barrier)
    ) {
      // Comment-then-close is not atomic: if the close fails after the
      // comment lands, the `recovered` field the comment wrote keeps the
      // next tick from repeating it while it retries the close. A success
      // first seen in an alarm update still closes once the alarm clears —
      // only the recovery comment itself is deduped, never the close.
      if (!previous.recovered) {
        actions.push({
          type: 'comment',
          number: existing.number,
          body: renderRecovery(assessment, options, carried),
        });
      }
      actions.push({ type: 'close', number: existing.number });
    } else if (!previous || barrier > (previous.newestUnanswered ?? '')) {
      // Persist the barrier while the alarm is quiet. A request that goes
      // unanswered below the threshold reaches no marker otherwise, and once
      // its PR closes assess() drops it by design: the gate above would fall
      // back to the older recorded maximum and close on a push that predates
      // it. This write is also what keeps the refusal above from wedging the
      // issue open — the next tick reads the state recorded here.
      actions.push({
        type: 'comment',
        number: existing.number,
        body: renderStateRefresh(assessment, options, carried),
      });
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
  const found = tsvLines(
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
      '.items[] | [.number, .state] | @tsv',
    ]),
  ).map(([number, state]) => ({ number: Number(number), state }));
  return found.map((pr) => ({
    ...pr,
    comments: tsvLines(
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repo}/issues/${pr.number}/comments`,
        '-f',
        'per_page=100',
        '--paginate',
        '--jq',
        '.[] | [.id, .user.login, (.author_association // ""), .created_at, .updated_at, .html_url, (.body // "" | @base64)] | @tsv',
      ]),
    ).map(
      ([
        id,
        user,
        author_association,
        created_at,
        updated_at,
        html_url,
        body,
      ]) => ({
        id: Number(id),
        user,
        // Empty when the API omitted it, which ANSWERABLE_ASSOCIATIONS reads
        // as "not answerable" — the same direction the producer's authorize
        // job takes when it cannot establish permission.
        author_association,
        created_at,
        updated_at,
        html_url,
        body: b64(body),
      }),
    ),
  }));
}

// Logins whose state markers this watch trusts on the tracking issue. The
// workflow posts with the GITHUB_TOKEN, whose comments attribute to
// github-actions[bot]; the bot login covers a future switch to the bot PAT.
// A marker anyone else comments must not override the watch's state.
const STATE_AUTHORS = new Set(['github-actions[bot]', DEFAULTS.bot]);

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
      '.[] | select(.pull_request == null) | [.number, .user.login, .created_at, .updated_at, (.body // "" | @base64)] | @tsv',
    ]),
  );
  for (const [number, author, created_at, updated_at, body] of rows) {
    // The issue's body is a state source, so the issue has to be the watch's
    // own: a planted issue carrying the label and the marker is exactly as
    // forgeable as a comment on one, and applying that label needs triage —
    // the same adversary assess() models for result comments.
    if (!STATE_AUTHORS.has(author)) {
      continue;
    }
    const text = b64(body);
    // Discovery keeps matching an edited body; only the state it feeds is
    // dropped. Gating discovery too would let a triage user delete the marker
    // by editing, and every later tick would file a duplicate.
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
          '.[] | [.user.login, .created_at, .updated_at, (.body // "" | @base64)] | @tsv',
        ]),
      )
        // An edit is a forgery whoever posted it: the watch writes a fresh
        // comment per tick and never edits one.
        .filter(
          ([user, created, updated]) =>
            STATE_AUTHORS.has(user) && updated === created,
        )
        .map(([, , , b]) => b64(b));
      return {
        number: Number(number),
        texts: [updated_at === created_at ? text : '', ...comments],
        // The barrier outlives the blanking above: `updated_at` moves on ANY
        // comment, so a stranger's reply — no permission needed — would
        // otherwise drop the only record of it until the watch's own first
        // comment, and an older push could certify a recovery. Only this one
        // field is carried out of an untrusted body, and only upward: a
        // forged-high floor can delay a close, never certify a false one.
        bodyFloor: readState([text])?.newestUnanswered ?? null,
      };
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
