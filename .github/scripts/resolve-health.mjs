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
    // The producer posts this ONE sentence for every request it did not run,
    // benign or not: the reason follows on the next line. Two of those reasons
    // are the lane breaking, not a lane with nothing to do — `prepare`'s EXIT
    // trap firing when the step dies before writing a decision (an expired
    // CI_BOT_PAT does exactly this), and `git merge-tree` failing so the
    // conflict status is unknown. Left as `skipped` they count on neither
    // side of the streak while their comment marks the request answered, so a
    // lane that crash-skips EVERY request reads as healthy forever — the
    // never-ran incident class this watch exists for.
    return CRASH_SKIP_REASONS.some((r) => skipReason(body).startsWith(r))
      ? 'infra_failed'
      : 'skipped';
  }
  return 'unknown';
}

// Producer-owned prefixes, `finish_without_agent failed` in
// qwen-code-pr-review.yml's `Prepare pull request branch`. A test extracts
// them from the workflow so a reworded reason fails there rather than going
// quiet here. Benign refusals (`skip`/`unsupported`: closed PR, draft-free
// no-conflict, deleted head repo, fork without maintainer edits) are NOT
// listed — they must stay uncounted.
const CRASH_SKIP_REASONS = [
  'Internal error while preparing',
  'Could not determine conflict status',
];

// The line after the fixed sentence: `Report skipped request` writes the
// sentence, a blank line, then `skip_reason` verbatim.
function skipReason(body) {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--'));
  return lines[1] ?? '';
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
  // The newest request in the window, whatever became of it — answered or
  // not, on a PR still open or long since closed. It is NOT a signal that
  // anything is wrong (it never feeds the alarm), only the latest moment the
  // lane was asked to do something: a push from before it cannot show the
  // lane can serve it. decide() floors the recovery barrier here, and carries
  // it forward in the state it writes, so a request survives its PR closing,
  // a marker someone deleted, and — once any tick has seen it — its own
  // deletion. What it does NOT survive is deletion before the first tick that
  // could record it, which no source can reach; that residue is bounded by
  // one tick interval.
  //
  // Read with a looser predicate than the roster below. The producer fires on
  // comment CREATION only (`issue_comment: types: ['created']`), so a comment
  // edited into request shape never ran a lane — which is why the roster must
  // stay strict, or a trusted account could manufacture unanswered entries out
  // of old comments. The barrier is safe under both readings: a comment whose
  // body is still request-shaped either was one at creation (the lane really
  // was asked) or was edited into one (the lane was not, and counting it only
  // REFUSES a close). It floors with `created_at`, which no edit moves, so an
  // old comment edited today cannot outrank a recent push.
  let newestRequest = null;
  // The newest request with no result of its own — see the roster loop below.
  // Deliberately read WITHOUT `staleHours`: the roster needs it so a run still
  // in flight does not raise the alarm, and the recovery gate needs the
  // opposite reading, since a run in flight is precisely a reason not to
  // certify that the lane works again. Read by decide(), never by the alarm.
  let unserved = null;
  const isRequestShaped = (c) =>
    c.user !== opts.bot &&
    ANSWERABLE_ASSOCIATIONS.has(c.author_association) &&
    isRequest(c.body);
  const isAnswerableRequest = (c) =>
    isRequestShaped(c) && c.updated_at === c.created_at;
  for (const pr of prs) {
    const comments = [...pr.comments]
      .filter((c) => c.created_at >= windowStart)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const c of comments) {
      if (
        isRequestShaped(c) &&
        (!newestRequest || c.created_at > newestRequest)
      ) {
        newestRequest = c.created_at;
      }
    }
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
    // Same predicate as the barrier scan above: the producer fires on comment
    // creation only (so a comment edited into request shape never ran), and
    // only for someone it would have served (ANSWERABLE_ASSOCIATIONS).
    const requests = comments.filter(isAnswerableRequest);
    // The close gate's own attribution, which the roster's proxy below cannot
    // give it. Match each request, oldest first, to the earliest result that
    // postdates it and no earlier request has taken. Runs on one PR are
    // serialised by the producer's concurrency group, so results arrive in
    // request order, and a request left with no result of its own is one the
    // lane has not answered — including a retry typed inside the previous
    // run's push→comment lag, whose trailing comment the roster's "any later
    // result" reading would otherwise spend twice: once as proof the lane
    // recovered, and again as proof this request was served.
    let cursor = 0;
    for (const req of requests) {
      while (
        cursor < prResults.length &&
        prResults[cursor].at <= req.created_at
      ) {
        cursor += 1;
      }
      if (cursor < prResults.length) {
        cursor += 1;
      } else if (!unserved || req.created_at > unserved) {
        unserved = req.created_at;
      }
    }
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
    newestRequest,
    unserved,
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
// Kept single-line (STATE_RE) — JSON.stringify of a flat object never emits
// a newline.
function stateOf(assessment, previous = null) {
  // The request floor is carried forward, never lowered: a request the watch
  // can read today may be deleted tomorrow, and the recovery gate must not
  // read that deletion as a recovery. Recording it means any tick that SAW
  // the request keeps it. It needs no sibling for the newest UNANSWERED
  // request — the scan that feeds it reads every request the roster reads,
  // plus answered ones and ones on closed PRs, so it is never older.
  const carried = previous?.newestRequest ?? null;
  const seen = assessment.newestRequest ?? null;
  return {
    streak: assessment.streak,
    unanswered: assessment.unanswered.map((u) => u.id),
    newestRequest: carried && (!seen || carried > seen) ? carried : seen,
    latest: assessment.latestAttempt?.id ?? null,
  };
}

// `newestRequest` is deliberately not compared: the carried floor rises when a
// request appears, which is not by itself a move in the picture, and decide()
// keys that write separately.
function sameState(previous, current) {
  return (
    previous !== null &&
    previous.streak === current.streak &&
    previous.latest === current.latest &&
    JSON.stringify(previous.unanswered) === JSON.stringify(current.unanswered)
  );
}

// The shape the watch writes, and the only shape it will read back. A marker
// is text on a GitHub issue, so a payload of the wrong TYPE is as reachable as
// one of the wrong value — and type confusion defeats the close gate's checks
// all at once: `newestRequest: []` is truthy (so a floor that was never
// recorded reads as one) and compares greater-than against every timestamp (so
// the postdating gate refuses forever). Validate rather than trust: anything
// malformed reads as no state, which the gate already handles. Fields this
// version stopped writing are not checked — an old marker carrying one still
// reads.
function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return null;
  }
  // A field that is absent reads as "not recorded", which every gate already
  // handles; a field that is PRESENT must have the type the watch writes.
  const ok = (v, type) => v === undefined || v === null || typeof v === type;
  const { streak, unanswered, newestRequest, latest, recovered } = state;
  if (!ok(streak, 'number') || !ok(newestRequest, 'string')) {
    return null;
  }
  if (!ok(latest, 'number') || !ok(recovered, 'number')) {
    return null;
  }
  if (
    unanswered !== undefined &&
    unanswered !== null &&
    (!Array.isArray(unanswered) ||
      unanswered.some((v) => typeof v !== 'number'))
  ) {
    return null;
  }
  return state;
}

export function readState(issueBodyAndComments) {
  let state = null;
  for (const text of issueBodyAndComments) {
    const m = text.match(STATE_RE);
    if (m) {
      try {
        state = validState(JSON.parse(m[1]));
      } catch {
        // A hand-edited marker is treated as no state: the next tick rewrites it.
        state = null;
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

// The first alarming tick after the issue is filed: the body is what FINDS
// the issue, never what the watch believes, so `texts` is empty, `previous` is
// null, and `sameState` cannot compare anything. The write is required — it is
// how state first reaches a comment the watch trusts, and suppressing it puts
// the barrier back where a deleted comment can take it — but it must not claim
// a change it never saw.
function renderFirstRecord(assessment, options = {}) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment)),
    'Still failing. This issue carried no state the watch reads back, so this is a first record of the picture, not a report of a change.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// The write decide() makes when the alarm's picture is unchanged but a new
// request has appeared. It must not reuse the refresh's headline, which says
// the alarm is not firing — here it is.
function renderRequestRecord(assessment, options = {}, previous = null) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment, previous)),
    'Still failing, with the same picture as the last report. Recording a newer request the watch has now seen, so the record survives that comment being deleted.',
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

// Pure decision: what to write, given the assessment and the open issue (if
// any). `existing` is { number, texts: [...the watch's own unedited comments] }
// or null.
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
          body: previous
            ? renderUpdate(assessment, options, previous)
            : renderFirstRecord(assessment, options),
        });
      } else if (
        (stateOf(assessment, previous).newestRequest ?? '') >
        (previous.newestRequest ?? '')
      ) {
        // A request can arrive without moving the picture `sameState`
        // compares: below `staleHours` it is not on the roster yet, and it
        // changes neither the streak nor the latest attempt. The quiet
        // branch's rise-keyed refresh is unreachable while the alarm fires,
        // so without this the request lives only in the live scan and its
        // deletion takes the barrier with it. Keyed on the rise, never on
        // every tick, so an unchanged picture still writes nothing.
        actions.push({
          type: 'comment',
          number: existing.number,
          body: renderRequestRecord(assessment, options, previous),
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
    const latest = assessment.latestAttempt;
    // ...and the attempt must postdate every request the watch has seen since
    // the issue opened: a result that landed before those requests cannot be
    // evidence that anything ran after them. Read on the result COMMENT's
    // time, which is the only time the watch can see; the guard below covers
    // what that proxy cannot. The barrier is the latest of two, so losing
    // either one cannot certify a recovery that did not happen:
    //   - the newest request the watch can SEE, or REMEMBERS seeing — this
    //     window, answered or not, open PR or closed — carried into every
    //     marker it writes and never lowered, so it survives the request
    //     comment being deleted and its PR closing. A request deleted before
    //     the FIRST tick that could record it reaches neither reading;
    //     nothing can read a comment that is gone, and that residue is
    //     bounded by one tick interval. The record lives on GitHub, where a
    //     triage user can delete the comments carrying it, which is what the
    //     second source is for;
    //   - and the issue's own creation time — a field GitHub maintains and
    //     nobody can edit, so the worst a forged, junked, wrong-typed or
    //     deleted marker can do is drop the barrier back to this floor. It is
    //     sound on its own terms: the issue exists because the lane was
    //     failing then, so an earlier push cannot show it recovered.
    const carried = stateOf(assessment, previous);
    const barrier = [carried.newestRequest, existing.createdAt]
      .filter((t) => typeof t === 'string' && t)
      .reduce((a, b) => (a > b ? a : b), '');
    // The barrier compares comment times, and the producer pushes BEFORE it
    // composes and posts the report: a result comment at T proves the push
    // happened at or before T, never that it happened after some particular
    // moment. A request typed inside that push→comment lag therefore raises
    // the barrier only to its own timestamp, which the trailing comment
    // clears — certifying a recovery with a push that predates the request.
    // Push time appears in nothing the watch reads, so the gate cannot be
    // fixed by comparing better timestamps. What closes it is the request
    // itself: a request with no result OF ITS OWN is refused as evidence
    // regardless of what the clocks say, and a request typed in that lag is
    // exactly that — on the same PR as well as on another, because the
    // matching in assess() will not spend one comment twice, as proof the
    // lane recovered and again as proof the lagged request was served. The
    // ordinary close resumes as soon as every request has its own result.
    if (
      latest &&
      latest.kind === 'pushed' &&
      latest.at > barrier &&
      !assessment.unserved
    ) {
      // Comment-then-close is not atomic: if the close fails after the
      // comment lands, the `recovered` field the comment wrote keeps the
      // next tick from repeating it while it retries the close. A success
      // first seen in an alarm update still closes once the alarm clears —
      // only the recovery comment itself is deduped, never the close.
      if (!previous?.recovered) {
        actions.push({
          type: 'comment',
          number: existing.number,
          body: renderRecovery(assessment, options, previous),
        });
      }
      actions.push({ type: 'close', number: existing.number });
    } else if (
      !previous ||
      (carried.newestRequest ?? '') > (previous.newestRequest ?? '')
    ) {
      // Persist the barrier while the alarm is quiet. The live scan only
      // reads requests still in the window whose comments still exist, so a
      // request recorded nowhere is a request the gate above will later
      // lose — falling back to the creation-time floor and closing on a push
      // that predates it. Keyed on the barrier that RISES, never on the
      // creation-time floor, which is constant and would say nothing; it
      // rises only when a new request appears, so a quiet lane gets one
      // comment per request and never chatters.
      actions.push({
        type: 'comment',
        number: existing.number,
        body: renderStateRefresh(assessment, options, previous),
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
      '.[] | select(.pull_request == null) | [.number, .user.login, .created_at, (.body // "" | @base64)] | @tsv',
    ]),
  );
  for (const [number, author, created_at, body] of rows) {
    // The issue must still be the watch's own: adopting a planted one would
    // let its comments — which ARE the state source — be chosen wholesale.
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
      // The body is what FINDS the issue, never what the watch believes. It
      // cannot be trusted as state and cannot be cheaply checked either: the
      // Issues API bumps an issue's `updated_at` on ANY comment, so
      // `updated_at !== created_at` marks an untouched body as edited the
      // moment a stranger replies (no permission needed), while a body a
      // triage user really did edit is indistinguishable from that. Carrying
      // one field out of it anyway — the barrier — was worse than dropping
      // it: the quiet-tick refresh wrote that value into a comment the watch
      // DOES trust, laundering an attacker-chosen barrier into trusted state
      // one tick later, and a forged-low, absent, or wrong-typed payload then
      // closed the issue on a push that predates the real barrier.
      //
      // So: state comes only from the watch's own unedited comments (a
      // comment's `updated_at` moves only on an edit, which is checkable).
      // Nothing is lost. `decide()` refuses to close while no state is
      // readable and writes a refresh instead, so the first quiet tick
      // re-derives the barrier from the live assessment and records it in a
      // trusted comment; the requests that opened the issue are still inside
      // the window then (ticks are hours apart, the window is days).
      return { number: Number(number), createdAt: created_at, texts: comments };
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
