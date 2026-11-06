# Channel event timeline in the Web Shell

[English](2026-11-02-channel-events-timeline.md) | [简体中文](2026-11-02-channel-events-timeline.zh-CN.md)

Status: implemented. Date: 2026-11-02. Updated 2026-11-04 for private
PR-bound-session delivery (§5) and the `failed_ambiguous` publication outcome.

## Problem

A Channel answers a lot of questions only through stderr. When the GitHub
Channel does not reply to a comment, an operator cannot tell from the Web Shell
whether the notification was filtered by `reasonFilter`, dropped because the
comment did not mention the bot, rejected by a sender gate, deduplicated, or
answered but published as a suppressed comment. The Channel management page
shows configuration and a runtime badge (`stopped` / `starting` / `connected` /
`partial` / `error`); it shows nothing about what the Channel actually did.

Everything that could answer those questions exists in scattered form:
`preflight` rejections and poll failures go to stderr, publication outcomes go
to `github-audit.jsonl`, inbound task state goes to `github-inbound-tasks.json`,
and the notification reason filter only writes a debug payload. None of it is
readable by the daemon, so no page can show it.

## Goals

- Record what a Channel did, per Channel, in one bounded, append-only journal.
- Expose the journal over a workspace-scoped, read-only daemon route.
- Show a cross-Channel timeline as a standalone Web Shell page, with filters
  for Channel and event type.

## Non-goals

- No message bodies in the journal. Operators see routing decisions and
  outcomes, not conversation text.
- No live push (SSE). The page polls; a Channel worker writes the journal in a
  separate process from the daemon.
- No new capability bit. The page is gated by `channel_management`, which is
  what makes the journal exist in the first place.
- No retention beyond one rotated file. The journal is diagnostic, not an
  audit trail with a compliance requirement; `github-audit.jsonl` stays the
  publication record.

## Current state

- `packages/channels/base/src/PollingChannelBase.ts` polls, backs off, and
  writes poll failures to stderr only.
- `packages/channels/base/src/ChannelBase.ts` rejects inbound messages in
  `preflightInbound` (message route, group gate, DM gate, sender gate) and logs
  a one-line reason through `logPreflightRejected`.
- `packages/channels/github/src/GithubAdapter.ts` polls GitHub notifications,
  filters by `reasonFilter`, deduplicates by cursor bookkeeping, tracks inbound
  tasks in `github-inbound-tasks.json`, and records publication outcomes in
  `github-audit.jsonl`.
- `packages/cli/src/serve/routes/workspace-channel-management.ts` exposes
  Channel configuration, lifecycle, and pairing routes; none of them read
  runtime activity.
- `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx` is
  the only Channel surface in the Web Shell.

## Design

### 1. Journal (`packages/channels/base/src/channel-events.ts`)

A Channel appends one JSON line per event. The file lives beside the other
workspace-scoped Channel state files:

```
~/.qwen/channels/<workspaceScopeDir>/<encodedName>-<nameHash16>-channel-events.jsonl
```

`<workspaceScopeDir>` is `getWorkspaceScopeDirName(config.cwd)`, and the file
name reuses the `encodedName` + `nameHash16` scheme already used by the GitHub
state files, so a Channel name cannot escape the directory.

Record:

| Field         | Meaning                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`          | ISO timestamp                                                                                                                                                                                                                                                                             |
| `channel`     | Channel instance name, kept in full (see limits below)                                                                                                                                                                                                                                    |
| `type`        | `inbound` / `outbound` / `task` / `poll`                                                                                                                                                                                                                                                  |
| `outcome`     | `accepted` / `skipped` / `posted` / `suppressed` / `posting` / `failed` / `failed_ambiguous` / `ok` / `degraded` / a task state (§5)                                                                                                                                                      |
| `reason`      | machine reason code on a skip, an inbound failure, a task retire/failure, or a degraded poll (`sender_denied`, `reason_filter`, `github_api_error`, `dead_letter`, `bindings_partial`, ...)                                                                                               |
| `triggerKind` | Channel-specific trigger (`mention`, `assign`, ...)                                                                                                                                                                                                                                       |
| `repository`  | conversation container (for GitHub, `owner/repo`)                                                                                                                                                                                                                                         |
| `thread`      | thread identity (`issue:12`, `pr:34`)                                                                                                                                                                                                                                                     |
| `number`      | issue or PR number                                                                                                                                                                                                                                                                        |
| `actor`       | sender login                                                                                                                                                                                                                                                                              |
| `sessionId`   | session the event was routed to; on the rows written while a delivery is cleared (`cancelled` / `running` / `failed` / `reply_pending` / `retired`) and on a pre-claim `skipped` row, the one it lost (§5). A `running` row with a live delivery carries its live target, not a lost one. |
| `messageId`   | source message identity                                                                                                                                                                                                                                                                   |
| `durationMs`  | poll duration                                                                                                                                                                                                                                                                             |
| `error`       | sanitized single-line error, capped at 200 characters                                                                                                                                                                                                                                     |
| `detail`      | flat primitive map, at most 12 keys                                                                                                                                                                                                                                                       |

Limits: free-text fields and `detail` values are capped at 200 characters. The
Channel identity is the exception: the management API accepts names up to 255
UTF-8 bytes, and code points never exceed bytes, so the identity is kept up to
255 code points — every legal name survives intact and stays matchable by the
`channel` filter. Only the UI shortens it for display.

The file rotates to `<name>.1` when an append would exceed 1 MiB; the previous
`.1` is replaced. Directory mode is `0700`, file mode `0600`. Every write
failure is swallowed into one stderr line: diagnostics must never break message
handling.

### 2. Emit points

| Where                                                              | Event                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelBase.logPreflightRejected`                                 | `inbound` / `skipped` with the rejection reason                                                                                    |
| `ChannelBase.preflightInbound` (message route, `mention_required`) | `inbound` / `skipped` with `message_route` or `group_mention_required`                                                             |
| `ChannelBase.processPreflightedInbound`                            | `inbound` / `accepted`                                                                                                             |
| `PollingChannelBase.runLoop`                                       | `poll` / `ok` with `durationMs` and the adapter's detail, `poll` / `failed` with `consecutiveErrors`                               |
| `GithubAdapter` reason filter                                      | `inbound` / `skipped`, reason `reason_filter`; past 20 in one poll, one row with `detail.filtered` counting the rest               |
| `GithubAdapter` comment lane (`onlyMentioned` miss)                | `inbound` / `skipped`, reason `mention_required`; once per comment while the window is held                                        |
| `GithubAdapter` dedupe hit                                         | `inbound` / `skipped`, reason `duplicate`; once per comment while the window is held                                               |
| `GithubAdapter` thread read failure                                | `inbound` / `failed` (window held) or `skipped`, reason `github_api_error`; throttled while the window is held                     |
| `GithubAdapter.claimInboundTask`                                   | `task` / `accepted`, with `sessionId` when the target is a bound session                                                           |
| `GithubAdapter.transitionInboundTask`                              | `task` / `<state>` with `attempts`, `error` and the bound `sessionId`; §5 overrides the terminal word                              |
| `GithubAdapter.recordPublicationAudit`                             | `outbound` / `<outcome>` (also keep the audit file)                                                                                |
| `GithubAdapter.runInboundTask` (bound verdict)                     | `task` / `delivered`, or `task` / `retired` with a reason (§5)                                                                     |
| `GithubAdapter.retireBoundTask`                                    | `task` / `retired`, reason `dead_letter`; `task` / `failed`, reason `dead_letter_write_failed` (§5)                                |
| `GithubAdapter.drainPendingWatch` (retire before claim)            | `inbound` / `skipped`, reason `watch_no_candidate` (§5)                                                                            |
| `GithubAdapter.watchOnePr` (pending-queue overflow)                | `inbound` / `skipped`, reason `watch_pending_overflow` (§5)                                                                        |
| `GithubAdapter` comment lane (no role matched)                     | `inbound` / `skipped`, reason `no_role_matched` (§5)                                                                               |
| `GithubAdapter` binding scan and watch guard                       | `poll` / `degraded` with a reason, at the existing throttles or on a state edge; binding-scan rows also carry `detail.streak` (§5) |

`PollingChannelBase` gains a `setPollEventDetail` seam so an adapter can attach
its own counters (GitHub reports how many notifications a poll returned)
without the base class knowing about them. The base class clears the field
before the poll and consumes it after that poll settles, so an event never
carries the previous poll's counters against the current timestamp.

### 3. Daemon route

```
GET /workspace/channels/events
GET /workspaces/:workspace/channels/events
```

Query: `limit` (1-500, default 100), `type` (comma separated), `channel`
(repeat the parameter once per instance name), `since` (ISO timestamp).

Response: `{ "events": [...], "truncated": boolean }`, `Cache-Control:
no-store`, the same trust and client checks as the other workspace Channel
routes.

The route never accepts a path from the request. The scope directory is
derived from the resolved runtime's workspace cwd through
`getWorkspaceScopeDirName`; a managed Channel's working directory must
canonicalize to that same workspace, so its journal lives there. A `channel`
filter narrows the candidate files by their name-derived identity **before**
any cap, so an explicitly requested, quieter Channel stays reachable even when
busier peers have newer files.

Reads are asynchronous and chunked, because this route runs on the daemon that
also serves sessions: a synchronous multi-megabyte scan would stall every other
request for its whole duration. The bounds are 256 KiB per journal file
(current and `.1`), 4 MiB per request in total, 32 journal files per request,
and 500 records returned; candidates are ordered freshest-first so the
allowance is spent on the journals an operator is most likely looking at.
Anything a bound clips sets `truncated`: dropped files, an exhausted byte
budget, **and a journal taller than the tail window** — a file grows to 1 MiB
before it rotates, so a 256 KiB window omits that Channel's own older events.
The page's completeness banner therefore cannot claim a timeline is whole when
any of those happened. The budget is reserved per journal — a file is read only
if its whole window fits in what remains — so a small journal is still read when
the remainder is under one window, and the flag always means "whole journals
were left out". A window starting mid-file reads one leading byte to tell a
partial first line from a complete one, so a window that lands exactly on a line
boundary keeps every record it read.

Every line still has to be parsed to filter it, but the accumulator is trimmed
to the newest `limit` once it passes four times that, so a busy workspace's
poll does not retain every record it parsed. The trim cannot change the answer:
a dropped record is older than every kept one, and the sort is stable, so
records sharing an instant keep their write order. Trimming counts as hitting
the record limit, so it sets `truncated` too.

A missing scope directory means "no Channel has written yet" and stays an empty
result. Any other read failure (permissions, I/O) propagates, and the route
answers 5xx instead of an empty list: "this workspace's Channels did nothing"
must not be the answer when the journal could not be read.

### 4. Web Shell

- `useChannelEvents` polls the route while the page is mounted and visible
  (5 s), pauses while the tab is hidden, and reloads when it becomes visible
  again; the page also offers a manual refresh. **Exactly one polling cycle may
  be in flight**: restoring visibility during a pending request must not start a
  second one, because both would schedule on settling while only the last timer
  handle is retained, leaving an orphan that polls forever — ordinary tab
  switches on a slow response would permanently multiply journal reads. A
  restore during a pending request therefore lets that request finish and
  reschedule. Both read paths are time-bounded (the SDK's 30 s fetch default and
  the action timeout), so the guard cannot stall the loop. Every snapshot is
  tagged with the query that produced it (workspace, Channel, types, limit) and
  mismatched data is masked, the way `useDaemonChannels` does: the underlying
  resource keeps its previous data while a request is in flight or after it
  fails, so without the tag the last workspace's rows — and their Channel names
  in the filter — would show under the newly selected workspace.
- `ChannelEventsPage` renders a newest-first timeline with a workspace
  selector, a Channel filter, a type filter, and a row per event: time, Channel,
  type, outcome, target (`owner/repo#12`), actor, reason or trigger kind,
  duration, and error. A bound delivery also shows the session it reached — or
  lost when the delivery was cleared — as a
  chip truncated to 8 characters, with the full identity in `title` — a UUID
  would otherwise push the reason and the counters out of the column. A
  binding-scan `degraded` row shows `detail.streak` (a count of scans, not
  polls) and, on the `bindings_partial` rows only, `detail.sessions`; the
  `bindings_cold_empty` and `bindings_unreachable` rows carry `streak` alone, so
  the presence of `sessions` is not a "this scan was partial" predicate. The
  watch-guard rows carry only their reason, plus `error` on a blocking row when
  the watch state could not be read or reconciliation failed. The workspace selector lists the registered, non-live
  workspaces exactly as the management page does, because the provider's cwd is
  the daemon-wide primary workspace and a Channel started in a secondary
  workspace would otherwise be unreachable. Changing the workspace resets the
  Channel filter.
- Every outcome the adapter can write has an English and a Chinese label.
  `KNOWN_OUTCOMES` is exported so a test can assert both catalogs cover it: the
  translator falls back to English and then to the raw key, so a missing
  Chinese label would otherwise render English silently. An outcome the page
  does not know still renders as its raw token, which is unreadable but safe.
  The watch-guard recovery edge keeps `degraded` on the wire but takes its
  label from the reason — **Recovered** / **已恢复** — so a recovery cannot
  read as an ongoing failure.
- It is a standalone page: `activePanel` value `channel-events`, URL
  `/channel-events`, and a sidebar primary-nav item `channelEvents`.
- It is gated by the `channel_management` capability and a trusted workspace,
  matching the management page.

### 5. Private delivery into PR-bound sessions

PR #16117 added a second delivery lane: with `deliverToBoundSessions`, a GitHub
event on a PR that a daemon session follows is injected into that session
instead of being answered publicly, and `prWatchEvents` adds operator-facing PR
state transitions that are **private-only** — they must never reach the public
reply path. The journal described above could not tell that lane's story:

| Fact                                                       | Before                                         |
| ---------------------------------------------------------- | ---------------------------------------------- |
| The prompt was accepted into a session                     | last row `task` / `running`, then nothing      |
| Which session received it, and that it was private         | no `sessionId` on any task row                 |
| The channel gates rejected it before delivery              | `inbound` / `skipped`, then two `running` rows |
| A watch event was retired privately (three separate exits) | stderr only                                    |
| The event was dead-lettered at the backpressure horizon    | stderr and the dead-letter file only           |
| The binding scan stalled every notification                | stderr only; the poll still reported `ok`      |

The first row is the worst of them: a delivered event and an event still in
flight ended on the same word.

**A verdict, not a boolean.** `deliverToBoundSession` is private and has one
caller. Its `boolean` meant "settled", which conflated an injected prompt, a
private retire and the public fallback — only the first is a delivery. It now
returns `{ kind: 'delivered' }`, `{ kind: 'retired', reason, sessionId? }`,
`{ kind: 'public' }` or `{ kind: 'deferred' }`, and `runInboundTask` derives the
journal's terminal word from it. No routing, fallback, budget or cursor
decision changed: the deferred verdict is the old `false`, and every other
verdict is the old `true`. The public verdict emits nothing because the public
path journals its own acceptance and publication. A retire carries the session
it lost: most retire exits clear the delivery before returning, so the verdict
names the target explicitly. The preflight-rejected exit is the exception — it
consumes the task with its delivery still set, so its terminal row reads the
live target rather than a lost one.

`transitionInboundTask` takes an optional journal override so the bound
acceptance mark can be persisted as `running` (there is no `delivered` task
state — the record is removed immediately after) while the journal's last word
is terminal. Without the override a preflight-rejected event would still end on
`running` — indistinguishable from a delivery in flight — because that exit
consumes the task with its delivery still set. The same method remembers the
target a task held going in, so the rows written while a delivery is cleared
keep their `sessionId` instead of losing the session they are about.

That memory is **persisted**, as `lostSessionId` on the task record, not just
held for one row. The gone-session fallback clears the delivery, and every later
poll re-enters the absence gate and finally the dead-letter with no delivery left
to read; a one-transition memory would leave all of those rows unnamed —
including the terminal one, which is the row an operator reads to learn which
session lost the event. The field is attribution only: the delivery is
deliberately not restored, since that would re-enter bound delivery and change
routing. It is written only on an explicit clear, so a transition that merely
omits the key cannot disturb it, and it is validated as an optional string like
the record's other fields. The gone-fallback horizon attributes the in-memory
task the same way before retiring it, and a dead-letter record whose delivery
is already cleared names the lost session in `lostSessionId`, so operator
recovery keeps the target.

The same rule reaches the retires that happen before any task is claimed:
their `inbound` / `skipped` rows carry the frozen target from the pending entry
when there is one. Only the overflow retire also writes a dead-letter record;
the `watch_no_candidate` and `no_role_matched` retires write none, so the skip
row is the event's only trace — without the frozen target it could not say
whether the retired event ever belonged to a session.

**New outcomes.** `task` / `delivered` and `task` / `retired` are journal-only
terminal words, not persisted task states. `retired` carries a reason:
`preflight_rejected`, `watch_no_target`, `watch_no_candidate`,
`watch_session_gone`, `dead_letter`, and the role-aware exits
`bound_no_candidate` (a comment whose role lost its match on a complete
snapshot — the non-watch sibling of `watch_no_candidate`) and
`siblings_still_follow` (the gone fallback retires because other roles still
follow the PR or the delivery ring already holds the event, so a public reply
would duplicate a sibling's private delivery). Where another comment would fall
back to the public path, a comment that reached the bound path only through its
mention waiver retires with `private_only_no_target` instead, since such a
comment never takes the public path. A failed dead-letter append
journals `task` / `failed` with reason `dead_letter_write_failed`. For six of
the seven `retireBoundTask` call sites the task is kept and stays recoverable,
so the next poll retries the append — it is not a retire. The exception is the
role-aware public-suppression retire: it calls `markPrivatelyRetired` first,
which persists the terminal `cancelled` state, so a failed append there leaves
a non-recoverable record and the `failed` row is the event's last word. Every
terminal row is written after the durable step it describes, so a throwing
removal or save cannot leave a retire claim behind for an event the next poll
re-runs.

Three retires happen before any task is claimed, so they have no task row to
close and journal `inbound` / `skipped` instead: `watch_no_candidate` when a
complete snapshot has no candidate left, `watch_pending_overflow` when the
per-PR pending queue passes its cap and the oldest event is retired undelivered,
and `no_role_matched` when followers exist but no role's template chain matched
the event on a complete fresh snapshot — an operator subscription decision, not
an absence, so the public path must not answer it either.

The overflow retire's commit point is its dead-letter record, not a sidecar
save. The append happens first (a failed append dumps the body to stderr and
keeps the event queued); the head is then sliced **in memory only**, and the
baseline and the full queue commit together in the single end-of-pass save. A
mid-pass save would persist the advanced baseline before the pass's later
events are queued, so a crash would never re-derive them. The skip row is
journalled only after that save lands. If the save throws — or the process dies
before it — the head stays queued on disk while its dead-letter record stands;
the drain recognizes a dead-lettered head (from the never-rotated file, so this
survives a restart) and **completes its retire instead of delivering it**, so no
event is ever both delivered and filed as retired undelivered. The
`watch_no_candidate` drain retire, which writes no dead-letter record, rolls its
slice back if its save throws: the slice mutates the loaded state before the
save, and a failed save does not clear the loaded flag, so without the rollback
the next poll would skip the entry and the end-of-pass save would persist the
truncation — losing the event with no trace at all.

These are the pre-claim retires this PR journals. The role-aware drain has a
fourth, pre-existing targetless retire (a trusted complete snapshot whose enum
matches no role) that writes only a stderr line, journals no row, and slices
then saves without a rollback; it predates this PR and is out of its scope, so
the journaling and rollback invariants above are claims about the three retires
this PR adds, not about every pre-claim exit in the adapter.

**No new event type, no wire change.** `outcome` is a free string in the
journal, the SDK and the route, so the four types, both routes and the response
shape are unchanged; only the page's label catalog grows. The protocol
_reference_ is updated, because it is where integrators read the vocabulary:
it now documents the open outcome string, the new terminals and reasons, and
which rows carry `sessionId` and `detail`. Reusing `outbound` for a private
injection was rejected: that type means "published to GitHub", and a bound
reply is explicitly not published.

**Never the message body.** The dead-letter record carries `text` for operator
recovery, and its write-failure path dumps the whole payload to stderr. Neither
is copied into the journal: the failure row carries only the write error. A
test asserts the body appears in stderr and does not appear in any journal row.

**Degraded dependencies.** The binding scan is a new hard dependency: while it
has never succeeded, the cold-start gate defers the comment lane and _every_
notification stalls, yet the poll itself reports `ok`. The adapter now journals
`poll` / `degraded` beside the stderr lines it already throttles —
`bindings_unreachable` (first failure, then every tenth), `bindings_partial`
(tenth, then every sixtieth, with `detail.sessions`), `bindings_cold_empty`
(first, then every tenth, and once more when the bounded escape opens the lane)
— and `watch_reconcile_blocked` / `watch_pending_unreconciled` on the false→true
edge of the existing `watchReconcileBlocked` flag, re-journaling whenever the
blocking cause changes (a backlog that turns into an unreadable sidecar, or
back) so the row never names a stale remedy. Reusing those throttles means no
new flood: a permanent outage cannot rotate the useful rows out of the journal;
the cause edge adds one small field, not a new throttle.

`detail.streak` counts **binding scans, not polls**: `refreshBoundSessions` also
runs on every gone-session retry, so one poll can advance it more than once.
The label and the stderr wording say scans for that reason. Likewise
`detail.sessions` counts sessions, not the routing map's size — the map is
keyed per PR, so one session following two PRs would otherwise be reported as
two sessions and send the operator chasing an under-read that never happened.
It is the session rows this scan listed **plus the sessions retention keeps
routing** under a partial answer, bounded by `MAX_PARTIAL_RETAINED`. Counting
only the listed rows would report 0 for a draining workspace whose retained
sessions are still receiving deliveries, and hand the operator a page-cap
diagnosis for a state that is not a page cap. It is a count of session rows,
not of the entries that survive the map's own filters (channel-owned sessions
and unparseable binding URLs are skipped when the map is built). The row label
and the stderr line both say "listed"; that word is shorthand for
listed-or-retained, and both surfaces print this same number.

**Recovery is journalled on the clearing edge**, as `watch_reconcile_recovered`.
A `poll` / `ok` row cannot serve as that signal: the base writes one after every
poll that does not throw, including every poll of a sustained outage, so it is
present throughout the degraded window and unchanged at its end. Only the
watch-guard reasons have a recovery row. `bindings_unreachable` recovers
implicitly, because a successful scan stops producing it and the next streak
starts over. **`bindings_cold_empty` does not**: an empty partial is a
_successful_ scan, and the streak is keyed on the routing map and the trust
flag, not on the snapshot alone — the gate is
`snapshot.partial && map.size === 0 && !boundSnapshotTrusted`, and the streak
resets only when a scan yields a non-empty routing map or a complete snapshot
establishes trust. A workspace whose bindings are all channel-owned leaves the
map empty on a non-empty partial, so the streak keeps advancing and the cap can
fire `bindings_cold_empty` for a scan that _did_ list sessions; once any complete
snapshot has been seen, an empty partial clears it. Past the bounded escape the
row goes silent because the throttle maxed out — the gate guards on
`streak < MAX_COLD_EMPTY_PARTIAL_POLLS` and both escapes test `=== MAX` — not
because the state recovered. On the success-path producer the comment lane is
open while the snapshot is still an empty partial; the refresh-failure producer
shares the counter but, while no snapshot has ever succeeded, the cold-start
gate keeps the lane **closed** and every notification — issue events included —
stays stalled, so the silence there is not containment.
**`bindings_partial` is not a
degradation with a recovery edge**: a successful multi-page scan is its
_producer_, and `partialSnapshotStreak` resets only on a complete snapshot, which
a permanently multi-page daemon never returns. It is a standing health hint, so
an operator must not wait for it to go quiet as evidence of recovery.

The watch-guard row also classifies its cause. `hasUnreconciledWatchPending()`
is fail-closed on a read error, so an unreadable sidecar blocks recovery too —
but reporting that as a pending backlog would name a remedy (re-enable
subscriptions) that cannot clear it. With subscriptions off, the state is loaded
first: a read failure journals `watch_reconcile_blocked` with the error, and
`watch_pending_unreconciled` is reserved for a state that really holds a pending
event. The gate itself is unchanged and stays fail-closed.

Attaching the binding-scan health to the existing poll detail instead was
considered and rejected: `setPollEventDetail` is called by the comment lane, and
both cold-start gates return _before_ it — the detail would be missing in
exactly the case it exists to report.

Six recurring stderr sites in the binding-scan and watch lane are deliberately
not journaled: the credential/rate-limit watch-pass abort, the watch pass
failure, the "keeping previous map" refresh failure, the retention-cap drop that
discards the oldest unlisted sessions when a partial snapshot exceeds
`MAX_PARTIAL_RETAINED`, the watch entry-cap eviction of idle entries, and the
watch cap that leaves the oldest bound PRs beyond `MAX_WATCHED_PRS` unwatched.
The abort is the heaviest silent failure of the six: a credential or rate-limit
answer makes `watchOnePr` break out of the pass and return normally, so the
outer pass-failure catch never fires, the poll completes, the base writes
`poll` / `ok`, and every later poll repeats the abort with no journal row while
no transition is detected for any bound PR. Most of these sites run on every
poll while their condition holds, with no throttle and no flag to edge-trigger
on, so covering them would mean new adapter state for diagnostics alone. The
exception is the "keeping previous map" refresh failure: it is written inside
the catch that sets `boundRefreshFailed`, and the flag clears on every successful
snapshot, so its false→true edge already marks the onset of the run and could be
journaled without new state. It is left on stderr here for scope, not because
the edge is unavailable.

They are not equally heavy. The credential/rate-limit abort and the watch cap
are the worst: the abort stalls detection for every bound PR while the timeline
reads `ok`, and an excluded PR is never watched, so its transitions produce no
rows at all and the operator reads silence rather than a late answer. The
retention-cap drop is next — the dropped sessions' events defer and dead-letter
at the horizon, so terminal rows appear hours later with no row saying sessions
were pruned. The entry-cap eviction is the lightest by construction: it evicts
only idle entries that have no pending event, no surviving binding claim and no
in-flight watch task, so no deliverable event is lost. The abort, the stale-map
refresh failure and the two capacity sites are the first candidates if that
state is ever added.

This is a census of the lane's recurring health and capacity sites, not of every
stderr line in the adapter. Two further classes stay on stderr as well and are
named here so nobody has to go looking: one-shot load diagnostics (corrupt,
malformed or unusable watch state, legacy state migration), which fire once per
load rather than per poll; and per-PR request failures such as a CI fetch, which
degrade one PR's detection for one poll. An inbound-task read failure is in
neither class — it propagates and becomes a `poll` / `failed` row.

One volume note: a dead-letter append that keeps failing leaves the task
recoverable, so the retry — and its `dead_letter_write_failed` row — repeats
every poll. That matches the rows the existing backpressure and failure
transitions already write per poll for a stuck task, and rotation bounds it.
Throttling it would mean new per-task state for a disk-full emergency whose
whole point is that the event has no durable surface left.

**Publication vocabulary.** `failed_ambiguous` (an ambiguous post error: the
comment may have landed, so a second public reply would be irreversible) was
already written to the journal but had no label, and rendered as a raw token.
It is now labelled in both languages and coloured as a failure.

## Files affected

- `packages/channels/base/src/channel-events.ts` (new) and its test
- `packages/channels/base/src/ChannelBase.ts`
- `packages/channels/base/src/PollingChannelBase.ts`
- `packages/channels/base/src/index.ts`
- `packages/channels/github/src/GithubAdapter.ts`
- `packages/cli/src/serve/routes/workspace-channel-management.ts`
- `packages/sdk-typescript/src/daemon/types.ts` and its barrel
- `packages/web-shell/client/hooks/useChannelEvents.ts` (new)
- `packages/web-shell/client/components/channels/ChannelEventsPage.tsx` (new)
- `packages/web-shell/client/components/channels/channel-events-messages.ts` (new)
- `packages/web-shell/client/App.tsx`,
  `components/sidebar/WebShellSidebar.tsx`, `utils/navigationUrl.ts`,
  `i18n.tsx`

§5 touches `packages/channels/github/src/GithubAdapter.ts` and its test,
`ChannelEventsPage.tsx` / `.module.css` / `.test.tsx`,
`channel-events-messages.ts`, and `docs/developers/qwen-serve-protocol.md` —
the reference integrators read, which now publishes the outcome vocabulary and
says which rows carry `sessionId` and `detail`. The journal module, the base
classes, the daemon route, the SDK types and the wire shape are unchanged.

## Design decisions

- **File journal, not IPC.** Channels run in a worker process forked by the
  daemon. A file keeps the daemon route read-only and stateless, and survives a
  worker restart, which is exactly when an operator looks for the last events.
- **One generic journal, not a GitHub-only one.** Every Channel type inherits
  the base emit points; the page is cross-Channel, so a GitHub-only store would
  have forced a second implementation later.
- **No message text.** The journal cannot become a second, unredacted copy of
  message history; publication events carry the outcome, while the existing
  audit file keeps `bodySha256` and `bodyChars`.
- **Reuse `channel_management`.** A new capability bit would add three
  registries and a drift test for no user-visible gain: the journal only exists
  where Channel management exists.
- **Keep `github-audit.jsonl`.** It answers a different question (what was
  published, with a body digest) and is already read during recovery.

## Risks

- Ambient skips on a busy group Channel can be frequent. The journal is capped
  by rotation and the page asks for the newest 200 events; nothing is
  unbounded. (100 is the route's own default, used when a caller sends no
  `limit`.) Rotation alone is not enough for the _usefulness_ of the window:
  the GitHub poll cursor does not advance while an inbound task is recoverable
  — `accepted`, `running`, or `failed` with attempts left — so the provider
  returns the same notifications on every poll, and filtered notifications are
  skipped before any dedupe. An in-flight turn does not cause this on its own:
  the poll loop awaits `pollOnce`, so no poll runs while a turn is in progress;
  the reachable cases include a task that failed and is still retryable or that
  an error in its own run left `running`, a task store the channel cannot read
  or write or a publication audit it cannot read, a thread GitHub failed to read
  with a 5xx (held for at most 30 polls), a rate limit or credential failure, and
  a mark-as-read that keeps failing. A held window is read again from the start on
  every poll; a rate limit or credential failure stops that poll at the first
  thread GitHub refuses. A real run with a 2 s poll and a turn that kept failing
  re-journaled one batch of 300 filtered notifications until the journal
  rotated, pushing the accepted/posted rows out of the page's window. The
  adapter therefore journals at most 20 `reason_filter` rows per poll and
  collapses the remainder into one row carrying `detail.filtered`, which the
  page renders as a count. Measured
  against the real adapter: 15 polls served 4,500 notifications and wrote 315
  rows instead of 4,500, and the journal did not rotate. The budget is per
  poll, so a genuinely new batch is still described in full. Rows that would
  repeat on every poll of a held window are written once per window instead:
  the `duplicate` or `mention_required` skip of a comment read again, and a
  thread skipped for an API error, for up to 8,192 distinct keys per window
  (past that, each new key is written on every poll). A failing thread's
  `github_api_error` row is written on its first failing poll in the window and
  on every tenth failing poll, and a rate limit's or credential failure's on its
  first and every tenth poll.
- A synchronous append sits in the message path. The record is small, and a
  failure is swallowed; the alternative (async queue) would lose the last
  events on a crash, which is when they matter.
- The route reads from disk on every request. Reads are awaited in 64 KiB
  chunks under a 4 MiB per-request budget, so a poll yields to the rest of the
  daemon instead of blocking it, and the page polls every 5 s only while its
  tab is visible.

## Validation

- Unit: journal append/read/filter/rotate/limit and swallowed write failure;
  GitHub emits inbound-skip, task, and publication events; the route filters by
  Channel and type, clamps to the resolved workspace, and honours `since`.
- Web Shell: page renders rows, applies both filters, and shows the empty and
  error states.
- Manual: run a GitHub Channel against a test repository, confirm the page
  shows the filter skips before any session exists, and confirm an accepted
  trigger, a task transition, and the publication outcome appear in order.
- §5 unit: a private delivery ends on `delivered` naming the session; a
  preflight rejection ends on `retired` and never on `delivered`; a rebind
  shows both session ids and pins the retarget row's word; every watch retire
  — including the pre-claim skip and the pending-queue overflow — and the
  dead-letter (both outcomes) are journaled; the body reaches the dead-letter
  file and stderr but no journal row; each degraded reason appears once per
  throttle window, re-emits on the later windows and restarts after a reset;
  the cold-start escape is journaled at the horizon on both the success and the
  failure path; a retire is not claimed when the removal or the save throws;
  and the watch guard's clearing edge is journalled, because a `poll` / `ok`
  row is written throughout the outage and cannot mark its end. The review
  round added guards for the overflow dead-letter dedup (a second detection
  with the sidecar still unwritable files exactly one record), the retention
  cap on the reported session count, the public-path invariant on every
  private retire, the gone-horizon attribution in the same run, the per-cause
  watch-guard edge and its subscriptions-off recovery site, the scan-scoped
  streak under gone retries, the role-aware retire reasons, and the recovered
  label. The fourth round added guards for the overflow's single-save baseline
  atomicity (the first sidecar write already carries both derived events), the
  dead-letter file as the restart-durable dedupe, the drain completing a
  dead-lettered head's retire instead of delivering it, and the lost session's
  workspace on the terminal and pre-claim rows. Every one of
  these guards was mutation-verified: 51 mutations, 51 killed. Two of them
  exist only to prove the privacy assertion is load-bearing — one smuggles the
  body into another field of a retire row, the other appends it after the write
  error so the error assertion still passes. Three more initially survived and
  were investigated rather than accepted: a loose `sessionId` count that three
  correctly attributed rows still satisfied with the clearing row unattributed,
  a mutation filter that matched no test after a rename, and a cap-count
  fixture whose first empty partial already capped `lastBindings`, so the
  mutation was unobservable at the emitting scan — the fixture now keeps
  retention above the cap exactly when the row is written. A sweep that
  cannot tell "no test ran" from "the guard held" is not evidence, so the
  harness now reports that case explicitly.
- §5 Web Shell: `failed_ambiguous` renders its label in English and Chinese
  rather than the raw token, the session chip truncates with the full id in
  `title`, the degraded counters render and are asserted **absent** on a row
  that carries no counter, and both catalogs cover every entry of
  `KNOWN_OUTCOMES`.

## Acceptance criteria

- An operator can see, in the Web Shell, why a GitHub notification produced no
  reply (reason filter, missing mention, gate rejection, dedupe) without
  reading stderr.
- Publication outcomes and inbound task failures appear in the same timeline.
- Poll failures and recovery appear as `poll` events with the consecutive error
  count.
- No message body is written to the journal, and no route can read outside the
  resolved workspace's Channel state.
- A privately delivered event ends on a terminal row that names the session it
  reached; an event that was retired without delivery never claims otherwise.
- A binding scan that stalls the comment lane is visible in the timeline
  without reading stderr, and cannot flood the journal while it stays broken.
