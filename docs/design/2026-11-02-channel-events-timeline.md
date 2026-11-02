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
| `channel`     | Channel instance name                                                 |
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

Limits: every string is capped at 200 characters, `detail` values are capped at
200 characters, and a record is rejected when it exceeds those limits rather
than truncated silently.

The file rotates to `<name>.1` when an append would exceed 1 MiB; the previous
`.1` is replaced. Directory mode is `0700`, file mode `0600`. Every write
failure is swallowed into one stderr line: diagnostics must never break message
handling.

### 2. Emit points

| Where                                                              | Event                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ChannelBase.logPreflightRejected`                                 | `inbound` / `skipped` with the rejection reason                                                      |
| `ChannelBase.preflightInbound` (message route, `mention_required`) | `inbound` / `skipped` with `message_route` or `group_mention_required`                               |
| `ChannelBase.processPreflightedInbound`                            | `inbound` / `accepted`                                                                               |
| `PollingChannelBase.runLoop`                                       | `poll` / `ok` with `durationMs` and the adapter's detail, `poll` / `failed` with `consecutiveErrors` |
| `GithubAdapter` reason filter                                      | `inbound` / `skipped`, reason `reason_filter`                                                        |
| `GithubAdapter` comment lane (`onlyMentioned` miss)                | `inbound` / `skipped`, reason `mention_required`                                                     |
| `GithubAdapter` dedupe hit                                         | `inbound` / `skipped`, reason `duplicate`                                                            |
| `GithubAdapter.claimInboundTask`                                   | `task` / `accepted`                                                                                  |
| `GithubAdapter.transitionInboundTask`                              | `task` / `<state>` with `attempts` and `error`                                                       |
| `GithubAdapter.recordPublicationAudit`                             | `outbound` / `<outcome>` (also keep the audit file)                                                  |

`PollingChannelBase` gains a `setPollEventDetail` seam so an adapter can attach
its own counters (GitHub reports how many notifications a poll returned)
without the base class knowing about them.

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

The route never accepts a path from the request. Candidate scope directories
come from the resolved runtime's workspace cwd plus the resolved `cwd` of every
Channel instance the workspace's management service lists, and each candidate
is re-derived through `getWorkspaceScopeDirName`, clamped to the workspace.
Reads are bounded: at most the last 2 MiB of each journal file (current and
`.1`), at most 32 journal files per request, at most 500 records returned.

### 4. Web Shell

- `useChannelEvents` polls the route while the page is mounted (5 s), and the
  page also offers a manual refresh.
- `ChannelEventsPage` renders a newest-first timeline with a Channel filter, a
  type filter, and a row per event: time, Channel, type, outcome, target
  (`owner/repo#12`), actor, reason or trigger kind, duration, and error.
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
  by rotation and the page shows the newest 100 by default; nothing is
  unbounded.
- A synchronous append sits in the message path. The record is small, and a
  failure is swallowed; the alternative (async queue) would lose the last
  events on a crash, which is when they matter.
- The route reads from disk on every request. Only tail windows are read and
  the page polls every 5 s while visible.

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
