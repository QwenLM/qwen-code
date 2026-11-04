# Channel event timeline in the Web Shell

[English](2026-11-02-channel-events-timeline.md) | [简体中文](2026-11-02-channel-events-timeline.zh-CN.md)

Status: implemented. Date: 2026-11-02.

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

| Field         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `at`          | ISO timestamp                                                         |
| `channel`     | Channel instance name, kept in full (see limits below)                |
| `type`        | `inbound` / `outbound` / `task` / `poll`                              |
| `outcome`     | `accepted` / `skipped` / `posted` / `failed` / `ok` / a task state    |
| `reason`      | machine reason code for skips (`sender_denied`, `reason_filter`, ...) |
| `triggerKind` | Channel-specific trigger (`mention`, `assign`, ...)                   |
| `repository`  | conversation container (for GitHub, `owner/repo`)                     |
| `thread`      | thread identity (`issue:12`, `pr:34`)                                 |
| `number`      | issue or PR number                                                    |
| `actor`       | sender login                                                          |
| `sessionId`   | session that handled the message                                      |
| `messageId`   | source message identity                                               |
| `durationMs`  | poll duration                                                         |
| `error`       | sanitized single-line error, capped at 200 characters                 |
| `detail`      | flat primitive map, at most 12 keys                                   |

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

| Where                                                              | Event                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ChannelBase.logPreflightRejected`                                 | `inbound` / `skipped` with the rejection reason                                                                      |
| `ChannelBase.preflightInbound` (message route, `mention_required`) | `inbound` / `skipped` with `message_route` or `group_mention_required`                                               |
| `ChannelBase.processPreflightedInbound`                            | `inbound` / `accepted`                                                                                               |
| `PollingChannelBase.runLoop`                                       | `poll` / `ok` with `durationMs` and the adapter's detail, `poll` / `failed` with `consecutiveErrors`                 |
| `GithubAdapter` reason filter                                      | `inbound` / `skipped`, reason `reason_filter`; past 20 in one poll, one row with `detail.filtered` counting the rest |
| `GithubAdapter` comment lane (`onlyMentioned` miss)                | `inbound` / `skipped`, reason `mention_required`; once per comment while the window is held                          |
| `GithubAdapter` dedupe hit                                         | `inbound` / `skipped`, reason `duplicate`; once per comment while the window is held                                 |
| `GithubAdapter` thread read failure                                | `inbound` / `failed` (window held) or `skipped`, reason `github_api_error`; throttled while the window is held       |
| `GithubAdapter.claimInboundTask`                                   | `task` / `accepted`                                                                                                  |
| `GithubAdapter.transitionInboundTask`                              | `task` / `<state>` with `attempts` and `error`                                                                       |
| `GithubAdapter.recordPublicationAudit`                             | `outbound` / `<outcome>` (also keep the audit file)                                                                  |

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
  duration, and error. The workspace selector lists the registered, non-live
  workspaces exactly as the management page does, because the provider's cwd is
  the daemon-wide primary workspace and a Channel started in a secondary
  workspace would otherwise be unreachable. Changing the workspace resets the
  Channel filter.
- It is a standalone page: `activePanel` value `channel-events`, URL
  `/channel-events`, and a sidebar primary-nav item `channelEvents`.
- It is gated by the `channel_management` capability and a trusted workspace,
  matching the management page.

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
  the reachable cases are a task that failed and is still retryable, a thread
  GitHub failed to read with a 5xx (held for at most 30 polls), and a rate
  limit or credential failure. A held window is read again in full on every
  poll, except threads that failed permanently or were stale. A real run with
  a 2 s poll and a turn that kept failing re-journaled one batch of 300 filtered
  notifications until the journal rotated, pushing the accepted/posted rows out
  of the page's window. The adapter therefore journals at most 20
  `reason_filter` rows per poll and collapses the remainder into one
  row carrying `detail.filtered`, which the page renders as a count. Measured
  against the real adapter: 15 polls served 4,500 notifications and wrote 315
  rows instead of 4,500, and the journal did not rotate. The budget is per
  poll, so a genuinely new batch is still described in full. Rows that would
  repeat on every poll of a held window are written once per window instead:
  the `duplicate` or `mention_required` skip of a comment read again, and a
  thread skipped for an API error. A failing thread's `github_api_error` row is
  written when the failure starts and on every tenth failing poll, and a rate
  limit's on its first and every tenth poll.
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

## Acceptance criteria

- An operator can see, in the Web Shell, why a GitHub notification produced no
  reply (reason filter, missing mention, gate rejection, dedupe) without
  reading stderr.
- Publication outcomes and inbound task failures appear in the same timeline.
- Poll failures and recovery appear as `poll` events with the consecutive error
  count.
- No message body is written to the journal, and no route can read outside the
  resolved workspace's Channel state.
