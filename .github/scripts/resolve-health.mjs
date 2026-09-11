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
//   - requests that never got a result comment and are older than
//     STALE_HOURS, counted once the producer acknowledged them — or all of
//     them when the lane showed no sign of life in over a day (a workflow
//     file that fails to parse produces exactly that).
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
  ackHours: 1,
  windowDays: 7,
  // The lane reads as silent once its newest sign of life is older than
  // this. Bounded above by windowDays: a bound at or past the window could
  // never fire — the blindness this constant exists to remove.
  silentHours: 27,
  bot: 'qwen-code-dev-bot',
  label: 'scope/ci-cd',
  recentLimit: 10,
});

// Mirrors the workflow's own trigger shape (exact body, or the command
// followed by a space / newline / CR), so a comment counts as a request here
// exactly when it counted as one there.
//
// Case-insensitively, because the producer's gate is a GitHub Actions
// expression — `github.event.comment.body == '@qwen-code /resolve'` and three
// `startsWith(...)` arms — and Actions expressions ignore case in both. One
// mobile autocapital produces `@Qwen-Code /Resolve`, which runs the lane; a
// case-sensitive reading here would drop it from the roster, the barrier and
// the sighting record at once, so the never-ran outage it belongs to would go
// unalarmed. Folded on the command only: what follows it is never compared.
export function isRequest(body) {
  const command = '@qwen-code /resolve';
  if (body.slice(0, command.length).toLowerCase() !== command) {
    return false;
  }
  const rest = body.slice(command.length);
  return (
    rest === '' ||
    rest.startsWith(' ') ||
    rest.startsWith('\n') ||
    rest.startsWith('\r')
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
// lane would have answered. Deliberately WIDER than "has write" — narrowing
// the set risks silencing a real outage, never anything else. The false
// alarm that width used to buy (a read-only collaborator sits inside it, and
// the producer refuses them the same silence) is what the acknowledgement
// gate in assess() closes, so the set keeps its width for the barrier, the
// sightings record, and the pairing population. The permission API itself is
// not an option here — it needs a PAT (see qwen-code-pr-review.yml's
// authorize job), which a scheduled watch has no reason to hold.
//
// The field is evaluated at READ time, not comment-creation time, so it
// drifts with permission changes inside the window: a requester whose org
// membership lapses would silently leave the roster their request belonged
// on, and a fork author granted write would retroactively enter it. The
// watch therefore judges once — the first tick to see a request records the
// association in the state marker (stateOf's `requests`), and a later tick
// reads the record, never the live field. The judgment reaches a trusted
// comment on the filing tick itself (apply posts the record with the
// create) and on any later tick that sights a new request, so a mid-window
// permission change moves nothing the watch has recorded. The bound: a
// request sighted only while no issue is open has nowhere to be recorded,
// and a triage user deleting the newest state comments rewinds the record
// to the first one — those are still judged live.
export const ANSWERABLE_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

// prs: [{ number, state, comments: [{ id, user, author_association, created_at, updated_at, body, html_url, eyes }] }]
// `eyes` is the reaction count the acknowledgement gate reads (see isOwed
// below).
// options.recorded: [[id, created_at, association], ...] — the first-sight
// judgments carried in the tracking issue's state; a recorded id is judged
// by the record, never by the live field (see ANSWERABLE_ASSOCIATIONS).
// options.recordedResults: [[id, pr, created_at, kind?], ...] — the
// first-sight record of result comments from the same state: a recorded
// result still answers the request it served after its comment is edited
// (see the gateResults build below), and a recorded failure still counts
// toward the streak. kind is absent on markers written before this file
// recorded it; those entries answer and give life but move no streak.
// options.deficit: [id, ...] — the requests the
// last tick recorded as unanswered; a recorded id stays admitted while the
// request is still live, open and result-less (see the deficit arms below).
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
  // The newest request with no result of its own — see the pairing loop
  // below. Deliberately read WITHOUT `staleHours`: the roster needs it so a
  // run still in flight does not raise the alarm, and the recovery gate needs
  // the opposite reading, since a run in flight is precisely a reason not to
  // certify that the lane works again. Read by decide(), never by the alarm.
  let unserved = null;
  // Newest unserved request per PR, whatever the PR's state — read after the
  // loop to qualify the recovery evidence on its own PR.
  const unservedByPr = new Map();
  // The judgments the first tick to see each request recorded in the
  // tracking issue's state, keyed by comment id. A comment with no record
  // yet is judged live, and this tick's sightings record it for the next.
  const recorded = new Map(
    (opts.recorded ?? []).map(([id, , association]) => [id, association]),
  );
  // A result comment an earlier tick saw unedited: the edit exclusion below
  // guards classification, but an edit after the fact must not un-answer
  // the request the result already served. Entries older than the window
  // can answer no live request — the request would have aged out first —
  // so they are dropped on read.
  const recordedResults = (opts.recordedResults ?? []).filter(
    (e) => e[2] >= windowStart,
  );
  const recordedResultsByPr = new Map();
  for (const entry of recordedResults) {
    const list = recordedResultsByPr.get(entry[1]) ?? [];
    list.push(entry);
    recordedResultsByPr.set(entry[1], list);
  }
  // The deficit the last tick recorded (the state's `unanswered` ids). The
  // live rules re-derive the roster from what is visible NOW, which at the
  // heal tick reads the outage's starved requests as refusals — no ack ever
  // landed, their PRs show no result — and drops them, closing the issue
  // over requests never served and erasing the deficit without a trace. A
  // recorded id is the watch's own prior judgment, so it stays admitted
  // while the request is still live, open and result-less, and leaves only
  // when the request does (aged out, deleted, PR closed, or answered at
  // last).
  const deficit = new Set(opts.deficit ?? []);
  const requestSightings = [];
  const resultSightings = [];
  // The recorded deficit ids whose requests are still live, unedited,
  // in-window and result-less, collected per PR below: id → created_at.
  const carriedDeficit = new Map();
  const isRequestShaped = (c) =>
    c.user !== opts.bot &&
    ANSWERABLE_ASSOCIATIONS.has(recorded.get(c.id) ?? c.author_association) &&
    isRequest(c.body);
  // The association set is deliberately wider than "has write", so it
  // cannot by itself separate a request the lane accepted from one it
  // refused in silence — a read-only collaborator sits inside it, and
  // authorize skips the whole job on a refusal. What separates them is the
  // producer's own acceptance signal: `Acknowledge resolve request`,
  // resolve-pr's first step, posts an `eyes` reaction on the request
  // comment and runs only when authorize said yes, so it is present exactly
  // on the requests the lane accepted and absent on every silent refusal. A
  // deficit — the roster below, or the close gate's veto — requires it:
  // three read-only collaborators asking inside one window no longer file
  // "0 consecutive failures, 3 unanswered requests" against a healthy lane,
  // and no single refused request arms the veto for the rest of the window.
  // One grace covers the ordinary landing delay: the reaction lands
  // seconds-to-minutes after the comment (queue, authorize, the job's first
  // steps), so a request younger than ackHours is owed even before it can
  // have landed — a genuinely in-flight request must still veto a recovery
  // close. The grace stays short on purpose. The real delay can be hours:
  // the producer serialises a PR's runs under one concurrency group whose
  // slot an autofix round can hold for its whole 345-minute timeout, and
  // the ack POST's failure is swallowed by design (its step ends with
  // `|| echo ... continuing`), so an accepted request can sit
  // unacknowledged long past any grace. Widening the grace to cover
  // that would re-admit refused requests to the roster past staleHours, so
  // the close gate carries the long-queue case on its own arm below. The
  // count cannot say WHO reacted; a requester reacting to their own refused
  // request re-arms only the failure this gate removes, never more.
  const isOwed = (c) =>
    (c.eyes ?? 0) > 0 ||
    now.getTime() - Date.parse(c.created_at) < opts.ackHours * 3_600_000;
  // The per-request signal goes blind exactly where the watch needs it
  // most: a lane that never ran produces no acknowledgements either, so the
  // owed gate reads the outage this file exists for (the thirteen days in
  // the header) as a lane full of refusals, and the roster goes quiet for
  // as long as the outage lasts. What no per-request signal can say, the
  // window can: requests exist and the lane produced no RECENT classified
  // result comment anywhere. Then the missing reactions are the outage, not
  // refusals, and every stale request counts whatever its reaction. One
  // recent live result switches the per-request reading back on, so a
  // refused request on a demonstrably healthy lane still never alarms.
  //
  // Life is a classified result comment — the only signal whose author the
  // watch can check. The acknowledgement count cannot serve here: it
  // cannot say WHO reacted, so one 👀 from any account — on a closed PR,
  // edited after posting — would switch the never-ran arm off for the whole
  // window, renewable at will. (isOwed keeps reading the count: both its
  // consumers move toward alarming, where the unattributed read is safe.)
  // An edited result is not the producer's word and proves nothing either;
  // a result the RECORD carries was seen unedited by an earlier tick, so an
  // edit after the fact cannot take back the life the lane showed.
  //
  // Life also expires: a result posted days ago says nothing about the
  // requests being judged now, and treating the whole window as alive kept
  // an outage that began yesterday invisible until every pre-outage result
  // aged out. The signal is the AGE of the newest sign of life — live, or
  // carried by the record — and the lane reads as silent once that is older
  // than silentHours.
  let newestLife = null;
  for (const entry of recordedResults) {
    if (!newestLife || entry[2] > newestLife) {
      newestLife = entry[2];
    }
  }
  for (const pr of prs) {
    for (const c of pr.comments) {
      if (
        c.created_at >= windowStart &&
        c.user === opts.bot &&
        c.updated_at === c.created_at &&
        classifyResult(c.body) &&
        (!newestLife || c.created_at > newestLife)
      ) {
        newestLife = c.created_at;
      }
    }
  }
  const laneSilent =
    !newestLife ||
    now.getTime() - Date.parse(newestLife) >= opts.silentHours * 3_600_000;
  const isAnswerableRequest = (c) =>
    isRequestShaped(c) &&
    c.updated_at === c.created_at &&
    (isOwed(c) || laneSilent);
  for (const pr of prs) {
    const comments = [...pr.comments]
      .filter((c) => c.created_at >= windowStart)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const c of comments) {
      // Every request-shaped comment is sighted with its LIVE association,
      // answerable or not: stateOf() records the first sighting, so a later
      // promotion can no more admit the request than a later demotion can
      // drop it.
      if (c.user !== opts.bot && isRequest(c.body)) {
        requestSightings.push({
          id: c.id,
          at: c.created_at,
          association: c.author_association ?? '',
          pr: pr.number,
        });
      }
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
        resultSightings.push([c.id, pr.number, c.created_at, kind]);
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
    // The roster, the pairing and the close gate read the live results plus
    // the ones the record carries for this PR: the edit exclusion above
    // guards CLASSIFICATION — a failure edited into a success must not pose
    // as recovery evidence — but an edit after the fact must not un-answer
    // the request the result already served. Keyed by comment id, so a
    // result still live is never spent twice in the pairing.
    const liveResultIds = new Set(prResults.map((r) => r.id));
    const gateResults = [
      ...prResults,
      ...(recordedResultsByPr.get(pr.number) ?? [])
        .filter((e) => !liveResultIds.has(e[0]))
        .map(([id, , at]) => ({ id, at })),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    // The recorded deficit carries forward while its request is still live,
    // unedited, in-window and result-less — whatever state its PR is in. The
    // roster below skips closed PRs by design, so without the carry one tick
    // that merely sees the starved request's PR closed erases the id, and a
    // later reopening reads it as a request that never owed anything. The id
    // leaves only when the request does (deleted, edited, aged out) or when
    // a result finally answers it.
    for (const c of comments) {
      if (
        deficit.has(c.id) &&
        c.updated_at === c.created_at &&
        !gateResults.some((r) => r.at > c.created_at)
      ) {
        carriedDeficit.set(c.id, c.created_at);
      }
    }
    // The close gate's pairing runs for EVERY PR, open or not. The roster
    // below skips a closed one because the producer only runs on open PRs, so
    // a request there can never be answered and must not alarm; the gate
    // needs the opposite reading of the same fact — a request that can never
    // be served is the strongest reason not to certify that the lane serves
    // people. Barrier and recovery evidence already come from closed PRs
    // (above, and `results.push` here), so skipping only the pairing would
    // read the evidence while dropping the check that qualifies it: merging
    // the PR a lagged retry sits on, the ORDINARY end of a successful
    // `/resolve`, would silently switch the guard off.
    //
    // The roster and the close gate also read different edit predicates, on
    // purpose. The roster stays strict (unedited only): the producer fires
    // on comment creation only, so a comment edited into request shape never
    // ran a lane, and a trusted account must not manufacture an unanswered
    // entry out of an old comment. The gate pairs over the barrier's looser
    // predicate: an edited request it cannot see re-pairs this PR's results
    // onto a later request, or vanishes while the barrier still floors at
    // its created_at — either way certifying a recovery on a push that
    // predates the request. Under the loose predicate an edited request can
    // only REFUSE a close — by claiming a result of its own or holding the
    // gate as unserved — never certify one.
    //
    // The pairing set is the live requests plus the ones the record still
    // holds for this PR that the live arm cannot see: aged out of the comment
    // window, deleted by its author, or edited into something that no longer
    // reads as a request. Each keeps its claim on its own result, so the
    // result is not donated to the next request in line. Excluded by
    // REQUEST-shaped id, not by comment id, or an edited-away request would
    // fall into neither arm. Injected only where a result on this PR could
    // actually be donated: without that an aged-out request on a PR with no
    // results at all would hold the gate for the rest of the window, and the
    // refusal writes nothing, so the prune that would drop it never runs.
    // Excluded by every request-SHAPED live id, answerable or not. Keying it
    // on `isRequestShaped` — which also gates on the association — would let a
    // still-live REFUSED request in through the vanished arm, since its id is
    // absent from a set built that way.
    const liveShapedIds = new Set(
      comments
        .filter((c) => c.user !== opts.bot && isRequest(c.body))
        .map((c) => c.id),
    );
    const vanished = (opts.recorded ?? [])
      .filter(
        (e) =>
          e.length > 3 &&
          e[3] === pr.number &&
          // The lane would never have run this one, so it is owed no result:
          // injecting it hands the gate a permanent veto that one comment from
          // an account without write access can arm. The producer's authorize
          // job refuses such a request in silence, which is the same fact
          // ANSWERABLE_ASSOCIATIONS reads on the live side.
          ANSWERABLE_ASSOCIATIONS.has(e[2]) &&
          !liveShapedIds.has(e[0]) &&
          gateResults.some((r) => r.at > e[1]),
      )
      .map((e) => ({ id: e[0], created_at: e[1] }));
    // The live arm owes a result to a request the producer acknowledged
    // (isOwed): a still-live refused request — inside the association set,
    // refused in silence — otherwise holds this gate's veto for the rest of
    // the window, the same fact the vanished arm's guard reads on the
    // recorded side. The acknowledgement cannot carry the veto alone: the
    // real queue delay dwarfs the grace (see isOwed above), so an accepted
    // request can read exactly like a refused one while its PR's slot is
    // parked. A request therefore also holds the veto while its own PR
    // shows the lane in the window: a result there means the lane accepted
    // this PR's work, so its silence toward this one request cannot be told
    // apart from a parked queue — and when that result postdates the
    // request the pairing below spends it on this request anyway, so the
    // veto only survives while the lane showed up on this PR but not since.
    // A request on a PR with no in-window result at all still reads as
    // refused, or one read-only collaborator re-arms the veto this gate
    // exists to drop. The veto only ever refuses a close, so the
    // conservative side is the safe side. The deficit arm re-admits what
    // the watch itself recorded unanswered: those ids were judged at a tick
    // that saw the outage, and re-judging them by the live rules at the
    // heal tick is exactly the erasure the record exists to prevent.
    const gateRequests = [
      ...comments.filter(
        (c) =>
          deficit.has(c.id) ||
          (isRequestShaped(c) && (isOwed(c) || gateResults.length > 0)),
      ),
      ...vanished,
    ].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    // The close gate's own attribution, which the roster's proxy below cannot
    // give it. Match each request, oldest first, to the earliest result that
    // postdates it and no earlier request has taken. Runs on one PR are
    // serialised by the producer's concurrency group, so results arrive in
    // request order, and a request left with no result of its own is one the
    // lane has not answered — including a retry typed inside the previous
    // run's push→comment lag, whose trailing comment the roster's "any later
    // result" reading would otherwise spend twice: once as proof the lane
    // recovered, and again as proof this request was served.
    // Which request the deficit belongs to is not observable — a result that
    // never arrived names nobody — so the walk decides it. Oldest-first blames
    // whichever request the cursor runs out on, which is always the NEWEST, so
    // a single permanently lost result (a cancelled run, a deleted result
    // comment) reported the newest ask as unanswered and slid that report onto
    // each new one. Walking newest-first lands it on the OLDEST unmatched
    // request instead: the earliest moment the lane demonstrably owed an
    // answer, and a value that stops advancing.
    //
    // This changes what the gate REPORTS, not what it decides: the veto is
    // keyed on a deficit existing at all, so its lifetime is set by the count
    // and still runs until the deficient ask leaves the window. Separating a
    // stale deficit from a live one needs the result comment to name the
    // request that triggered it, which the producer does not write.
    let cursor = gateResults.length - 1;
    let prUnserved = null;
    for (let i = gateRequests.length - 1; i >= 0; i -= 1) {
      const req = gateRequests[i];
      while (cursor >= 0 && gateResults[cursor].at <= req.created_at) {
        cursor -= 1;
      }
      if (cursor >= 0) {
        cursor -= 1;
      } else {
        prUnserved = req.created_at;
      }
    }
    if (prUnserved) {
      unservedByPr.set(pr.number, prUnserved);
      // Only an OPEN PR feeds the global signal. A request on a closed one
      // can never be served now, and holding every recovery for the rest of
      // the window over it would refuse the ordinary end of an incident:
      // requests go unanswered, the PRs carrying them are closed or merged,
      // and the lane later demonstrably works. The one place a closed PR
      // still has to count is the evidence's OWN PR, folded in after the loop.
      // Only an OPEN PR feeds the global signal. A request on a closed one
      // can never be served now, and holding every recovery for the rest of
      // the window over it would refuse the ordinary end of an incident:
      // requests go unanswered, the PRs carrying them are closed or merged,
      // and the lane later demonstrably works. The one place a closed PR
      // still has to count is the evidence's OWN PR, folded in after the loop.
      if (pr.state === 'open' && (!unserved || prUnserved > unserved)) {
        unserved = prUnserved;
      }
    }
    // A request on a closed or merged PR can never be answered — the producer
    // only runs on open PRs — so it must not count as unanswered. Results on
    // such PRs keep counting: attempts that finished before the PR closed
    // still feed the streak and the recovery evidence, and the gate's pairing
    // above has already run.
    if (pr.state !== 'open') {
      continue;
    }
    const requests = comments.filter(
      (c) => isAnswerableRequest(c) || deficit.has(c.id),
    );
    for (const req of requests) {
      // Any result after the request answers it. Runs on one PR are
      // serialised by the workflow's concurrency group, so a later result
      // implies the earlier run finished — and a retry typed before the
      // first run reported must not leave the first request "unanswered"
      // forever because its result landed after the retry's timestamp.
      const answered = gateResults.some((r) => r.at > req.created_at);
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
  // What the record carries as the deficit: the live roster plus the carried
  // ids, in the same (at, id) order the roster keeps. The alarm and the
  // report read the live roster alone, so a closed PR's request still cannot
  // raise the alarm — the carried ids are the close gate's veto only.
  const deficitById = new Map(unanswered.map((u) => [u.id, u.at]));
  for (const [id, at] of carriedDeficit) {
    if (!deficitById.has(id)) {
      deficitById.set(id, at);
    }
  }
  const deficitRecord = [...deficitById.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0])
    .map(([id]) => id);
  const attempts = results.filter((r) => FAILED.has(r.kind) || OK.has(r.kind));
  // The recovery evidence is a result COMMENT, and the producer pushes before
  // it posts one: a request typed inside that lag, on the SAME PR, is one that
  // comment's run cannot have served, and the per-PR pairing proves it took no
  // result of its own. Merging or closing that PR is the ordinary end of a
  // successful `/resolve` and must not switch the check off, so this is the
  // one place a closed PR's unserved request still counts.
  const evidence = attempts.at(-1) ?? null;
  const behindEvidence = evidence ? unservedByPr.get(evidence.pr) : null;
  if (
    behindEvidence &&
    behindEvidence < evidence.at &&
    (!unserved || behindEvidence > unserved)
  ) {
    unserved = behindEvidence;
  }
  // The streak reads the live attempts union the first-sight record's: an
  // edit after the fact must not take back a failure the watch already
  // counted, or one triage annotation per failure comment erases the
  // founding incident's own shape — five requests, five answered failures —
  // below the threshold, permanently (`updated_at` never reverts). A
  // recorded success breaks the streak the same way — it really ran, seen
  // unedited — while latestAttempt and the recovery evidence stay live-only,
  // so an edit still cannot certify a recovery.
  const liveIds = new Set(results.map((r) => r.id));
  const streakBase = [
    ...attempts,
    ...recordedResults
      .filter((e) => e.length > 3 && !liveIds.has(e[0]))
      .map(([id, pr, at, kind]) => ({ id, pr, at, kind }))
      .filter((r) => FAILED.has(r.kind) || OK.has(r.kind)),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  let streak = 0;
  for (let i = streakBase.length - 1; i >= 0; i -= 1) {
    if (!FAILED.has(streakBase[i].kind)) {
      break;
    }
    streak += 1;
  }
  const streakItems = streakBase.slice(streakBase.length - streak);
  const infra = streakItems.filter((r) => r.kind === 'infra_failed').length;
  const pushFailed = streakItems.filter((r) => r.kind === 'push_failed').length;
  return {
    windowStart,
    results,
    attempts,
    deficit: deficitRecord,
    streak,
    streakItems,
    infraInStreak: infra,
    pushFailedInStreak: pushFailed,
    unanswered,
    requestSightings,
    resultSightings,
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
// roster the issue shows would otherwise freeze on week one. `requests` is
// the first-sight association judgments, each [id, created_at, association]
// (see ANSWERABLE_ASSOCIATIONS); `resultsSeen` the first-sight record of
// result comments, each [id, pr, created_at] — the roster, the pairing and
// the life signal read it beside the live set (see assess()).
// Kept single-line (STATE_RE) — JSON.stringify of a flat object never emits
// a newline.
// The record rides in one comment, and GitHub refuses a body over 65,536
// characters. Every request-SHAPED comment is sighted, from anyone, so the
// window prune alone does not bound it: a wave of `/resolve`-shaped comments
// from accounts the lane would never serve grows the record past that limit
// and the watch can then write no state at all — no barrier, no roster, no
// recovery close. Measured at ~42 bytes an entry, so this cap holds the
// record near 17 KB and leaves the report room in the same comment.
//
// What to drop is not symmetric. An ANSWERABLE judgment guards the demotion
// direction, where losing it hides a real outage; a refusal guards the
// promotion direction, which additionally requires its author to actually
// gain write access. So answerable entries are kept first and refusals give
// up the newest room, oldest first. Whatever falls out is judged live again
// — the bound the record already documents for a request sighted while no
// issue was open.
export const JUDGMENT_CAP = 400;

function capJudgments(entries) {
  if (entries.length <= JUDGMENT_CAP) {
    return entries;
  }
  const answerable = entries.filter((e) => ANSWERABLE_ASSOCIATIONS.has(e[2]));
  const refused = entries.filter((e) => !ANSWERABLE_ASSOCIATIONS.has(e[2]));
  const keep = new Set(answerable.slice(-JUDGMENT_CAP));
  // `slice(-0)` is `slice(0)` — the whole array — so the room left has to be
  // checked before slicing, or the cap voids itself at exactly its own
  // boundary: once the answerable judgments alone fill it, every refusal came
  // back and the record grew without limit again.
  const room = JUDGMENT_CAP - keep.size;
  if (room > 0) {
    for (const entry of refused.slice(-room)) {
      keep.add(entry);
    }
  }
  return entries.filter((e) => keep.has(e));
}

// The result sightings share the marker, so they need their own bound. It
// is a plain newest-kept slice — the room check capJudgments needs exists
// for its answerable-first asymmetry, which results do not have — and at
// ~45 bytes an entry the cap holds this list near 18 KB beside the request
// record's 17 KB, still inside GitHub's 65,536-character body limit with
// the report.
export const RESULT_RECORD_CAP = 400;

function capResults(entries) {
  return entries.slice(-RESULT_RECORD_CAP);
}

function stateOf(assessment, previous = null) {
  // The request floor is carried forward, never lowered: a request the watch
  // can read today may be deleted tomorrow, and the recovery gate must not
  // read that deletion as a recovery. Recording it means any tick that SAW
  // the request keeps it. It needs no sibling for the newest UNANSWERED
  // request — the scan that feeds it reads every request the roster reads,
  // plus answered ones and ones on closed PRs, so it is never older.
  const carried = previous?.newestRequest ?? null;
  const seen = assessment.newestRequest ?? null;
  // The merged result record — the state's resultsSeen merged with this
  // tick's sightings, first sight wins — is built BEFORE the request prune:
  // the prune's claimable reads the same population the close gate's pairing
  // spends (a live result, or an in-window recorded one, on the entry's PR),
  // so an edit after the recording cannot evict the request that owns the
  // result and donate it to the next request on the PR.
  const resultsSeen = new Map();
  for (const entry of previous?.resultsSeen ?? []) {
    if (entry[2] >= assessment.windowStart) {
      resultsSeen.set(entry[0], entry);
    }
  }
  for (const s of assessment.resultSightings) {
    if (!resultsSeen.has(s[0])) {
      resultsSeen.set(s[0], s);
    }
  }
  // The association judgments carry the same way, first sight wins: merge
  // the record with this tick's sightings, dropping only entries that aged
  // out of the window — their comments are invisible to assess() now, so the
  // entry could never apply again, and an unbounded record would eventually
  // overflow the comment the state rides in.
  const judgments = new Map();
  // An entry outlives the comment filter when a result on its own PR still
  // postdates it: the close gate pairs requests to results, and a request that
  // has aged out of the live view while its result has not would otherwise
  // hand that result to a LATER request on the same PR — spending one comment
  // twice, as proof the lane recovered and again as proof the later request
  // was served. Once no in-window result can be claimed by it, the entry can
  // never change a decision again and goes.
  // Read over every classified result, not just `attempts`: the pairing spends
  // skips, no-ops and dry runs too, so pruning on the narrower set would drop
  // an entry whose own result is a benign skip and hand that skip to the next
  // request on the PR one tick later.
  const claimable = (entry) =>
    entry.length > 3 &&
    [...resultsSeen.values()].some((e) => e[1] === entry[3] && e[2] > entry[1]);
  for (const entry of previous?.requests ?? []) {
    if (entry[1] >= assessment.windowStart || claimable(entry)) {
      judgments.set(entry[0], entry);
    }
  }
  for (const s of assessment.requestSightings) {
    const held = judgments.get(s.id);
    if (!held) {
      judgments.set(s.id, [s.id, s.at, s.association, s.pr]);
    } else if (held.length < 4) {
      // A marker written before this file recorded the PR. Heal it while the
      // comment is still live — first sight still wins for the judgment, only
      // the PR is filled in — or the entry could never claim its own result
      // and the gate would keep donating it to the next request.
      judgments.set(s.id, [held[0], held[1], held[2], s.pr]);
    }
  }
  const kept = [...judgments.values()].sort(
    (a, b) => a[1].localeCompare(b[1]) || a[0] - b[0],
  );
  // The result sightings carry the same way, first sight wins: the record
  // exists so an edit after the fact cannot un-answer the request a result
  // served. Entries age out with the window — a result older than it can
  // answer no live request, since the request would have left first.
  const keptResults = [...resultsSeen.values()].sort(
    (a, b) => a[2].localeCompare(b[2]) || a[0] - b[0],
  );
  return {
    streak: assessment.streak,
    // The live roster plus the carried-forward ids (see assess()): the
    // deficit leaves only when its requests do, so a quiet tick that sees a
    // starved request's PR closed cannot erase it.
    unanswered: assessment.deficit,
    newestRequest: carried && (!seen || carried > seen) ? carried : seen,
    requests: capJudgments(kept),
    resultsSeen: capResults(keptResults),
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

// The record's own write key, for the change no other key sees: a first
// sighting moves neither the streak, nor the roster membership, nor — for a
// request the lane would refuse — the barrier, so a tick whose only change
// is one writes nothing under those keys and the judgment is thrown away,
// to be re-derived from the live field after it drifts. Keyed on the record
// GAINING an id, never on the record changing: the write carries the id, so
// the next tick gains nothing and stays quiet — one comment per newly
// sighted entry, never one per tick. Reads one list at a time: the request
// judgments and the result sightings gain ids independently.
function recordGained(previousList, carriedList) {
  const known = new Set((previousList ?? []).map(([id]) => id));
  return carriedList.some(([id]) => !known.has(id));
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
  const {
    streak,
    unanswered,
    newestRequest,
    latest,
    recovered,
    requests,
    resultsSeen,
  } = state;
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
  if (
    requests !== undefined &&
    requests !== null &&
    (!Array.isArray(requests) ||
      requests.some(
        (v) =>
          !Array.isArray(v) ||
          // Three elements is the shape this file wrote before it recorded
          // the PR; those markers must keep reading, or every tracking issue
          // open at the upgrade loses its barrier to the creation-time floor.
          (v.length !== 3 && v.length !== 4) ||
          typeof v[0] !== 'number' ||
          typeof v[1] !== 'string' ||
          typeof v[2] !== 'string' ||
          (v.length === 4 && typeof v[3] !== 'number'),
      ))
  ) {
    return null;
  }
  if (
    resultsSeen !== undefined &&
    resultsSeen !== null &&
    (!Array.isArray(resultsSeen) ||
      resultsSeen.some(
        (v) =>
          !Array.isArray(v) ||
          // Three elements is the shape this file wrote before it recorded
          // the classification; those markers must keep reading, or every
          // issue open at the upgrade loses its result record.
          (v.length !== 3 && v.length !== 4) ||
          typeof v[0] !== 'number' ||
          typeof v[1] !== 'number' ||
          typeof v[2] !== 'string' ||
          (v.length === 4 && typeof v[3] !== 'string'),
      ))
  ) {
    return null;
  }
  return state;
}

export function readState(texts) {
  let state = null;
  for (const text of texts) {
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
    'How to read the outcomes: `infra_failed` means the agent step ended without running (install, model endpoint, timeout, cancellation — open the workflow run linked from the comment); `agent_failed` means the agent ran and gave up or failed verification; `push_failed` means it resolved the conflict but the push was rejected for a reason a retry repeats (token scope, fork permissions); `unknown` means the result comment used wording this watch does not recognise — check for a producer change. A request with no result comment at all usually means the workflow never started (an invalid workflow file produces exactly that, with no run to look at); only requests from someone the lane would have served are counted, since it refuses anyone without write access in silence — and on a lane that is demonstrably alive, only requests the producer acknowledged; when the lane showed no recent output anywhere, every stale request counts, because a lane that answers nothing is the outage this issue tracks.',
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

// The picture as the filing tick saw it. apply() posts it with the create,
// so the first-sight judgments reach a comment the watch trusts in the same
// run — the body is what FINDS the issue, never what the watch believes,
// and a later first write would freeze whatever the live field drifted to
// meanwhile. It is also decide()'s write when an open issue carries no
// readable state (`texts` empty, `previous` null, `sameState` with nothing
// to compare): required then too — suppressing it puts the barrier back
// where a deleted comment can take it — but it must not claim a change it
// never saw.
function renderFirstRecord(assessment, options = {}) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment)),
    'Still failing. This issue carried no state the watch reads back, so this is a first record of the picture, not a report of a change.',
    '',
    renderReport(assessment, options),
  ].join('\n');
}

// The write decide() makes when the alarm's picture is unchanged but the
// watch sighted something new — a request, or a result. It must not reuse
// the refresh's headline, which says the alarm is not firing — here it is.
function renderRequestRecord(assessment, options = {}, previous = null) {
  return [
    HEALTH_MARKER,
    stateMarker(stateOf(assessment, previous)),
    'Still failing, with the same picture as the last report. Recording a request or result the watch has now seen, so the record survives that comment being edited or deleted.',
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
        // apply() posts this with the create: the filing tick's record, in
        // a comment the watch trusts. The body's own marker is never read
        // back (findOpenIssue returns only comments as state), so without
        // it the judgments wait for a later write and freeze whatever the
        // live field drifted to.
        record: renderFirstRecord(assessment, options),
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
      } else {
        const carried = stateOf(assessment, previous);
        if (
          (carried.newestRequest ?? '') > (previous.newestRequest ?? '') ||
          recordGained(previous?.requests, carried.requests) ||
          recordGained(previous?.resultsSeen, carried.resultsSeen)
        ) {
          // A request can arrive without moving the picture `sameState`
          // compares: below `staleHours` it is not on the roster yet, and
          // it changes neither the streak nor the latest attempt. The quiet
          // branch's rise-keyed refresh is unreachable while the alarm
          // fires, so without this the request lives only in the live scan
          // and its deletion takes the barrier with it. The record key
          // covers the sighting that moves nothing at all — a request the
          // lane would refuse raises not even the barrier, and a result
          // that is not an attempt (a skip, a noop, a dry run) moves neither
          // the streak nor the roster; losing its first sight lets a later
          // edit un-answer the request it served while the watch reports
          // that request as never served. Keyed on the rise and the gained
          // id, never on every tick, so an unchanged picture still writes
          // nothing.
          actions.push({
            type: 'comment',
            number: existing.number,
            body: renderRequestRecord(assessment, options, previous),
          });
        }
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
      (carried.newestRequest ?? '') > (previous.newestRequest ?? '') ||
      recordGained(previous?.requests, carried.requests) ||
      recordGained(previous?.resultsSeen, carried.resultsSeen)
    ) {
      // Persist the barrier while the alarm is quiet. The live scan only
      // reads requests still in the window whose comments still exist, so a
      // request recorded nowhere is a request the gate above will later
      // lose — falling back to the creation-time floor and closing on a push
      // that predates it. The gained id is the same persistence for the
      // first-sight judgment: a request the lane would refuse raises no
      // barrier, so only the record key writes it down. Keyed on the
      // barrier that RISES or the record that GAINS, never on the
      // creation-time floor, which is constant and would say nothing;
      // either moves only when a new request appears or a new result is
      // sighted, so a quiet lane gets one comment per sighting and never
      // chatters — and the result key is what keeps an edit after the fact
      // from un-answering the request the result served before any writing
      // tick saw it.
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
      // Two quoted TOKENS, never the contiguous phrase: GitHub search
      // measurably fails to match "@qwen-code /resolve" against PRs whose
      // comments contain it byte-exactly, and every PR it drops takes its
      // attempts, requests, and recovery evidence with it — the failure
      // find-marked-issue.sh's client-side marker rule names. The token form
      // is a superset, and the precision it gives up was never needed:
      // assess() re-validates every comment client-side with isRequest().
      `q=repo:${repo} is:pr "@qwen-code" "/resolve" in:comments updated:>=${since}`,
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
        '.[] | [.id, .user.login, (.author_association // ""), .created_at, .updated_at, .html_url, (.body // "" | @base64), (.reactions.eyes // 0)] | @tsv',
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
        eyes,
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
        // resolve-pr's acknowledgement reaction, left exactly on the
        // requests authorize accepted — the signal assess()'s owed gate
        // reads. `// 0` above keeps it numeric when nothing reacted.
        eyes: Number(eyes),
      }),
    ),
  }));
}

// Logins whose state markers this watch trusts on the tracking issue. The
// workflow posts with the GITHUB_TOKEN, whose comments attribute to
// github-actions[bot]; the bot login covers a future switch to the bot PAT.
// A marker anyone else comments must not override the watch's state.
const STATE_AUTHORS = new Set(['github-actions[bot]', DEFAULTS.bot]);

// The newest marker-carrying tracking issue in the given state, authored
// by the watch itself. `open` is decide()'s write target; `closed` is
// only a record source — the recovery comment carries the final record, so
// the newest closed issue lets the first-sight record outlive the incident
// it tracked. The API lists created-desc, so the first match is the newest.
function findMarkerIssue(gh, repo, label, state) {
  const rows = tsvLines(
    gh([
      'api',
      '-X',
      'GET',
      `repos/${repo}/issues`,
      '-f',
      `state=${state}`,
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

export function findOpenIssue(gh, repo, label) {
  return findMarkerIssue(gh, repo, label, 'open');
}

export function apply(gh, repo, actions, label) {
  for (const action of actions) {
    if (action.type === 'create') {
      const created = JSON.parse(
        gh(
          ['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'],
          JSON.stringify({
            title: action.title,
            body: action.body,
            labels: [label],
          }),
        ),
      );
      if (action.record) {
        // The filing tick's judgments must reach a trusted comment in the
        // same run: the body is never read back as state, so the next tick
        // would otherwise re-judge every request by the live field, and the
        // first comment it wrote would freeze whatever the field drifted
        // to. The number comes from the create response — the only way to
        // address the issue that was just filed.
        gh(
          [
            'api',
            '-X',
            'POST',
            `repos/${repo}/issues/${created.number}/comments`,
            '--input',
            '-',
          ],
          JSON.stringify({ body: action.record }),
        );
      }
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
  const existing = findOpenIssue(gh, repo, opts.label);
  // The issue's state carries the first-sight judgments; without them
  // assess() would judge every request by the live, read-time field. With
  // no issue open the record's home is the newest closed tracking issue —
  // its recovery comment carries the final record, so an edit after the
  // close cannot un-answer the request a recorded result served. The write
  // target stays the open issue: decide() addresses it by number, and the
  // closed one is never written.
  const record = existing ?? findMarkerIssue(gh, repo, opts.label, 'closed');
  const previous = record ? readState(record.texts) : null;
  const assessment = assess(prs, {
    ...opts,
    recorded: previous?.requests,
    recordedResults: previous?.resultsSeen,
    deficit: previous?.unanswered,
  });
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
