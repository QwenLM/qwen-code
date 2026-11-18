# Daemon restart recovery inbox

[English](2026-11-17-daemon-restart-recovery-inbox.md) | [简体中文](2026-11-17-daemon-restart-recovery-inbox.zh-CN.md)

Status: proposed. The read-only scan, both recovery routes, the daemon SDK
client methods, the Web Shell panel, and the REST reference/protocol entries
are implemented in this change. Line references were verified at commit
`5fc5a98ecc`.

## Problem and scope

After a daemon restart, a conversation that was running is left with an
interrupted last turn. Web Shell can continue it, but only after the user opens
that conversation: the recovery summary is produced by the per-session context
that a cold load builds, and the banner that offers the action lives inside the
chat surface. With several workspaces and several interrupted sessions, the
user has to find each conversation in the sidebar and click Continue one by one.

This design adds a restart recovery inbox: a read-only scan that lists the
sessions whose last prompt was interrupted, and a batch continuation endpoint
that resumes a selected set without opening or switching any conversation. The
scan reuses the existing prompt terminal ledger. The continuation reuses the
existing recovery classifier and `continueSession` admission path. No new
recovery algorithm is introduced.

The scope is workspace sessions. Standalone conversations are out of scope for
this slice and are tracked in Open questions.

## Current state

- The recovery summary is built per session after a cold load. `Session`
  derives it from the last turn (`packages/cli/src/acp-integration/session/Session.ts:6819`),
  and the ACP status type exposes only `kind`, `canContinue`, and an optional
  `cancellationConfirmationId` (`packages/acp-bridge/src/status.ts:681`).
- Web Shell shows the action only inside a loaded conversation.
  `SessionRecoveryBanner` reads `connection.context.recovery` and calls the
  session-bound `continueSession` action
  (`packages/web-shell/client/components/SessionRecoveryBanner.tsx`).
- The session list cannot answer which sessions were interrupted. Live state is
  an in-memory snapshot: the capability comment says so
  (`packages/cli/src/serve/capabilities.ts:577`), and
  `DaemonSessionLiveState` contains only live flags
  (`packages/sdk-typescript/src/daemon/types.ts:2129`). After a restart the
  snapshot is empty.
- Continuation requires a live session entry. The HTTP route
  `POST /session/:id/continue` (`packages/cli/src/serve/routes/session.ts:8839`)
  reaches `continueSession`, which throws `SessionNotFoundError` when
  `byId` has no entry for the session
  (`packages/acp-bridge/src/session-control-plane.ts:14716`). A cold load must
  run first.
- The existing Web Shell continuation design explicitly excludes automatic
  resume and new daemon routes
  (`docs/design/web-shell-interrupted-session-continue.md`).
- Core can already express a safe automatic continuation, but nothing enables
  it: `canAutoContinue` is set only from `allowAutoContinue`, and no caller
  passes `true` (`packages/core/src/core/session-recovery.ts:222`).
- The prompt terminal ledger already persists the evidence needed to find
  interrupted sessions. Each session has an append-only
  `<sessionId>.ledger.jsonl` next to its transcript
  (`packages/core/src/services/sessionService.ts:1169`). Records carry only
  `promptId`, `state`, `at`, and an optional `tailUuid`; prompt content is
  deliberately excluded (`packages/acp-bridge/src/prompt-ledger.ts:24`).
- A normal daemon shutdown flushes a terminal record with
  `code: 'daemon_shutdown'` for a pending prompt
  (`packages/acp-bridge/src/bridge-prompt-ledger.test.ts:147`). A crash leaves
  the `in_flight` record without a terminal; a cold load reconciles it through
  `reconcileDanglingPromptTerminals`
  (`packages/cli/src/serve/prompt-terminal-ledger.ts:101`).

## Goals

1. After a daemon restart, show which workspace sessions were interrupted
   without loading them or opening them.
2. Continue a selected set of sessions with one action and return a result for
   each session.
3. Leave the currently open conversation untouched.
4. Fail closed on missing or ambiguous evidence, and never continue degraded
   history.
5. Keep prompt content out of the recovery list.

## Non-goals

- No automatic continuation on startup. `allowAutoContinue` stays unused in
  this change.
- No new persistent recovery file. The scan reads the existing ledger.
- No change to the core recovery classifier or the synthetic tool-result
  repair.
- No tool replay. An `interrupted_turn` continuation keeps the existing
  behavior of closing dangling calls with synthetic error results.
- No change to daemon shutdown drain or to the single-session banner behavior.
- No standalone conversation coverage in this slice.

## Design

### Scan source

For each selected workspace runtime, enumerate the active chats directory and
read the bounded tail of every `<sessionId>.ledger.jsonl`. Session enumeration
uses the existing project-scoped listing, which reads the first transcript
record to keep other projects' sessions out; the scan never reads transcript
bodies. The ledger is small (roughly two records per prompt) and is already
written at admission and at shutdown, so the scan costs one small read per
session.

Reduce each ledger to the last record of its newest prompt:

- No terminal record for that prompt: `interruption: 'in_flight'`. This is the
  crash case.
- Terminal `interrupted`: `interruption` is the record's `code` when present
  and shaped as a lowercase identifier of at most 64 characters
  (`daemon_shutdown`, `daemon_lost`, `channel_closed`, ...), otherwise
  `interrupted`.
- Terminal `completed`, `cancelled`, or `error`: the session is not listed. A
  completed or cancelled turn is not waiting for recovery, and an errored turn
  already published its outcome.

An unreadable ledger is skipped (fail closed). A torn tail loses only the
partial line: earlier valid records still decide the result, so a crash that
left an `in_flight` record before the torn write is still listed. Skipped
sessions are never replaced with a guess. Skip the archive directory and drop
entries older than the requested window. Keep at most 200 entries per
workspace, newest first, and report `truncated: true` when more were present.

The scan reports what the ledger proves: the newest prompt either never
reached a terminal or reached an `interrupted` one. A record whose timestamp
cannot form an ISO value is treated as unreadable and omitted. It does not
claim that the session can be continued. The recovery kind and the
`canContinue` decision still come from the existing classifier after a load.

### Read-only batch route

Mirror the existing workspace-scoped batch shape used by
`POST /sessions/live-state` (`packages/cli/src/serve/routes/session.ts:10959`):
1–20 workspace selectors, per-member results, and the same
`workspace_not_found` / `untrusted_workspace` / `workspace_runtime_unavailable`
errors. The route is advertised by the `restart_recovery` capability tag, which
also covers the continuation route.

`POST /sessions/recovery`

```json
{
  "workspaces": ["qwen-code-x9", "/home/user/Work/other"],
  "sinceMs": 86400000
}
```

```json
{
  "workspaces": [
    {
      "workspace": "qwen-code-x9",
      "workspaceId": "…",
      "cwd": "/home/user/git/qwen-code-x9",
      "items": [
        {
          "sessionId": "…",
          "lastActivityAt": "2026-11-17T09:12:31.000Z",
          "interruption": "daemon_shutdown"
        }
      ],
      "truncated": false
    }
  ]
}
```

`sinceMs` is optional and defaults to 24 hours. The server clamps it to 30 days.
The response intentionally carries no prompt text, no tool name, and no
`canContinue`; a title is resolved by the client from the session catalog it
already renders.

### Batch continuation route

`POST /sessions/recovery/continue`

```json
{
  "sessions": [{ "workspace": "qwen-code-x9", "sessionId": "…" }],
  "confirmToolTurn": false
}
```

The server processes the list serially, at most 10 sessions per request. For
each entry:

1. Re-read that session's ledger. If the newest prompt now has a `completed`,
   `cancelled`, or `error` terminal, return `not_continuable` with the
   `already_moved` code. This covers a session that another client continued
   to a settled turn after the scan. A new `in_flight` record means a turn is
   active; the `canContinue` check in step 5 rejects it.
2. Resolve the owner runtime from the requested workspace, applying the same
   ownership, trust, and generation guards as `POST /session/:id/continue`,
   with no primary-runtime fallback. Standalone conversations are out of scope
   and fail at the cold load.
3. If the session is not live, run the same cold restore core that
   `POST /session/:id/load` uses. No second loading path is introduced. The
   restore's temporary client attachment is released after the continuation
   settles (or before returning when it is rejected); releasing it first would
   let the idle-close path tear down the just-loaded session.
4. Read the recovery summary through the same bridge status path the banner
   uses.
5. If `canContinue` is false, return `not_continuable` with `kind`. This
   includes `degraded_history` and a session with an active turn.
6. If `cancellationConfirmationId` is present, return `confirmation_required`.
   A batch must never auto-confirm a turn that may have been cancelled on
   purpose.
7. If `kind` is `interrupted_turn` and `confirmToolTurn` is not `true`, return
   `confirmation_required`. The caller can resubmit those sessions with
   `confirmToolTurn: true`.
8. Otherwise call the existing `continueSession` path.

The result is per session:

```json
{
  "results": [
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "accepted",
      "kind": "interrupted_prompt"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "confirmation_required",
      "kind": "interrupted_turn"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "not_continuable",
      "kind": "degraded_history"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "error",
      "code": "load_failed"
    }
  ]
}
```

`status` is one of `accepted`, `not_continuable`, `confirmation_required`,
`rejected`, or `error`. `not_continuable` carries `already_moved`,
`no_evidence`, `virtual_subagent`, or `invalid_session_id` (the id does not
match the persisted session-file shape); `confirmation_required` carries
`cancellation_confirmation` or `tool_turn`; `error` carries
`workspace_not_found`, `untrusted_workspace`, `workspace_runtime_unavailable`,
`session_not_found`, or `continue_failed`.

One failure does not stop the remaining entries. No client remains attached
and no SSE subscription is created; the turn runs under normal prompt
admission and its events are available to any client that opens the session
later.

### Web Shell surface

- After daemon availability changes from unavailable to available, request the
  batch once for the workspaces the sidebar already queries.
- If items exist, show a banner above the session list: “N tasks were
  interrupted by the restart”. Opening it shows a panel.
- Each row shows the workspace label, a shortened session id, the last
  activity time, and an interruption badge. The current conversation is never
  switched.
- A row's Continue submits that session; Continue all submits the rows that do
  not need tool confirmation, in batches of 10. Rows that come back `accepted`
  leave the panel; rows that come back `confirmation_required` stay with a
  confirmation action; failures stay with a reason.
- The confirmation action resubmits only the tool-turn rows with
  `confirmToolTurn: true`, and explains that unfinished tool calls will be
  closed as failed before the model continues.

### Limits and safety

- At most 10 sessions per continuation batch and 20 workspaces per scan.
- Serial loads only. Loading a session consumes a per-workspace session slot
  (default 32) and memory; the cap keeps a restart from loading every old
  session at once.
- Only trusted workspaces are scanned; untrusted and unavailable members
  return the same errors as live state.
- The scan reads no prompt content and the response carries none.
- `degraded_history` is never continued.
- A duplicate batch request cannot enqueue twice: the bridge admission check
  rejects a continuation while the session has an active prompt, and the
  ledger re-read drops a session that already moved on.
- Continue all splits more than 10 eligible rows into sequential batches.

### SDK client

`DaemonClient.getRestartRecoveries` wraps `POST /sessions/recovery`, and
`DaemonClient.continueRestartRecoveries` wraps
`POST /sessions/recovery/continue`. Both use the native REST transport and
accept `{ signal, timeoutMs }`; an older daemon surfaces the route's HTTP error
instead of falling back to another endpoint.

## Design decisions

- **Ledger, not transcript or catalog heuristics.** The ledger already
  distinguishes an interrupted prompt from a clean, cancelled, or errored one,
  and it is small. A transcript tail scan would duplicate the interruption
  classifier; a catalog heuristic could not see the prompt outcome at all.
- **Batch query mirrors live state.** Reusing the workspace-scoped batch shape
  keeps trust, ownership, and error semantics aligned with an existing route
  instead of inventing a global scan.
- **Batch continuation runs on the server.** The Web Shell `loadSession` and
  `resumeSession` actions switch the active conversation
  (`packages/web-shell/client/daemon/session/actions.ts:2673`), so a client-side
  loop would yank the user between sessions. The server-side loop also gives
  other SDK clients the same capability.
- **Tool turns need an explicit batch confirmation.** The single-session
  banner does not ask today; the batch path is unattended and can resume
  several sessions at once, so it asks before closing dangling tool calls and
  letting the model retry them.
- **No automatic continuation.** The restart path is exactly where an
  unattended retry is most expensive and most likely to repeat a side effect.
  A future opt-in can build on `allowAutoContinue`; it is not part of this
  slice.

## Constraints and risks

- Continuing N sessions spends N turns of model tokens. The panel shows the
  count and requires a selection; there is no “continue everything on boot”.
- A long session keeps its context in memory after continuation until the
  existing idle reaper closes it. Operators can lower the batch cap if that
  matters on their host.
- The ledger is best-effort evidence. A missing, torn, or unreadable ledger
  fails closed: the session is not listed rather than guessed.
- A crash during a batch leaves earlier sessions continued and later ones not.
  The per-session result is the authority; a retry re-reads the ledger and
  skips sessions that already moved on.
- The list has no prompt text by design, so the title comes from the catalog.
  A session whose title is unavailable is still listed by id and workspace.
- The default 24-hour window is a product choice, not a correctness rule. An
  older interrupted session remains continuable from its own chat surface.

## Files and boundaries

- `packages/cli/src/serve`: the ledger scanner and both recovery routes in this
  change. Focused tests cover the scan, the query, and the continuation route.
- `packages/sdk-typescript/src/daemon`: request/response types, client methods,
  exports, and tests.
- `packages/web-shell/client`: the recovery panel, availability gating, i18n,
  and tests.
- `docs/developers/daemon-rest-api-reference.md`,
  `docs/developers/qwen-serve-protocol.md`, the SDK client guide, and the
  capability parity/contract tests. OpenAPI covers only the core guide
  operations, so the recovery routes are not added there.
- No core changes. No ACP bridge changes beyond reusing the existing
  `continueSession` and recovery status methods. No new persistent file.

## Validation plan

1. Unit-test the scanner with: dangling `in_flight`; `interrupted` with
   `daemon_shutdown`; `interrupted` with `daemon_lost`; last prompt
   `completed`; last prompt `cancelled`; multiple prompts where an older one is
   interrupted; missing ledger; torn tail; oversized ledger tail; archived
   session; entry outside the window.
2. Route-test the scan batch: 1–20 selectors, unknown workspace, untrusted
   workspace, unavailable runtime, per-member failure, stable ordering, and the
   clamp on `sinceMs`.
3. Route-test the continuation batch: serial order, per-session results,
   `already_moved`, `degraded_history`, active turn, cancellation
   confirmation, `interrupted_turn` without and with `confirmToolTurn`, load
   failure, and the 10-session cap.
4. End-to-end: start a real daemon, start a turn, kill the daemon process,
   restart it, query the recovery batch, continue one session, and assert a new
   turn appears in its transcript. Repeat with the daemon shut down normally
   and assert the `daemon_shutdown` item appears.
5. Web Shell test: banner appears only after availability returns, selection
   and confirmation paths work, successful rows leave the panel, failures stay
   with a reason, and the active conversation does not change.
6. Run the package unit suites, build, typecheck, and the REST contract test.

## Acceptance criteria

1. After a restart, an interrupted workspace session appears in the recovery
   scan without being opened or loaded.
2. Continuing a selected set produces one new turn per accepted session and
   one result entry per requested session.
3. The currently open conversation is unchanged by a batch continuation.
4. `interrupted_turn` is not continued by a batch without
   `confirmToolTurn: true`.
5. `degraded_history`, archived sessions, clean sessions, cancelled sessions,
   and unreadable ledgers are never listed as continuable.
6. An untrusted workspace, an unknown workspace, an unknown session, and an
   over-limit batch are rejected with the documented error codes.
7. The existing single-session `POST /session/:id/continue` behavior is
   unchanged.
8. The response and the logs contain no prompt content.

## Open questions

- Should standalone conversations use the same inbox? Their chats directory and
  ownership rules differ, so this needs a separate ownership decision.
- Should the scan key off “this daemon restart” instead of a time window? That
  would need a durable shutdown/start marker; the ledger alone cannot
  distinguish an old interruption from the latest one.
- Should the daemon return catalog titles with the list, or leave title
  resolution to the client? This design leaves it to the client to avoid a
  catalog read on the scan path.
- Should a batch continuation close the loaded sessions immediately after the
  turn settles, or leave them to the idle reaper? The first release leaves them
  to the reaper so a user can open the result without a cold load.
