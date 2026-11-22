# Sidebar Session Continuation Badge

[English](sidebar-session-continuation-badge.md) | [简体中文](sidebar-session-continuation-badge.zh-CN.md)

Status: implemented in this change.

## Problem statement

A session whose last turn was cut off mid-flight (daemon crash, daemon
shutdown, agent channel exit, session close/kill while a prompt ran) can be
continued: opening it shows the `SessionRecoveryBanner` with a
"Continue execution" button. But the Web Shell sidebar gives the session row
no marker at all, so the user cannot tell from the session list which
conversations owe a continuation. They must open each suspect session and wait
for the transcript load before the banner appears.

## Current state

- `packages/core/src/core/session-recovery.ts` and
  `packages/core/src/core/turn-interruption.ts` classify an unfinished turn
  from persisted history (`interrupted_prompt`, `interrupted_turn`,
  `degraded_history`). The classification runs when a session is loaded into
  the agent (`Session.getRecoveryStatusForClient()`), and the result rides the
  session context status (`ServeSessionContextStatus.recovery`).
- `SessionRecoveryBanner.tsx` renders the "Continue execution" affordance
  inside the open chat pane only, from `connection.context?.recovery`.
- The sidebar row's volatile state comes from the session catalog
  (`DaemonSessionSummary`) merged with workspace live state
  (`DaemonSessionLiveState`: `hasActivePrompt`, `activeWorkState`,
  `isWaitingForPermission`, `isWaitingForUserQuestion`, `hasTurnError`,
  `backgroundTurn`, `hasRunningBackgroundTasks`). Neither carries a
  continuation signal, and cold sessions — the main interruption case after a
  daemon restart — are not live at all.
- The daemon already persists a per-session **prompt terminal ledger**
  (`packages/acp-bridge/src/prompt-ledger.ts`, design:
  `2026-08-19-prompt-terminal-ledger-design.md`): one `in_flight` record at
  prompt admission, one terminal record (`completed` / `cancelled` / `error`
  / `interrupted`) when the formal terminal publishes, including the
  close/kill/channel-crash/daemon-shutdown flushes. A hard crash leaves the
  `in_flight` record dangling; the cold-load reconciliation
  (`reconcileDanglingPromptTerminals`) appends `interrupted` /
  `daemon_lost` when it can attribute the outcome.

## Goals

- A session whose persisted prompt-ledger evidence says its last turn was cut
  off shows a visible badge in the sidebar session list (desktop and touch
  layouts), so the user can notice it and open the session to continue.
- The badge never shows for a session that is running, doing background work,
  or waiting for approval/input, and it clears once a newer turn terminal is
  observed or the catalog is re-read after the continuation settles.
- No new persisted state, no hot-path writes: the signal is derived from the
  ledger that already exists.

## Scope boundaries

- The badge is a **hint**, not the authoritative recovery verdict. The banner
  inside the open session still computes `canContinue` from the transcript and
  the live turn guards; a badge click-through can legitimately land on a
  session whose banner is suppressed (for example a writer lock or an active
  automatic turn).
- Sessions without a ledger (TUI-only sessions, sessions whose prompts never
  reached daemon admission) get no badge. Covering them would require a
  transcript-tail scan per listed session; that is deferred.
- Ordinary model-error terminals (`terminal: 'error'` without a teardown code)
  do not raise the badge; they are the turn-error/Retry surface, not the
  continuation surface.
- Archived sessions are closed conversations; the archived list is not
  enriched.
- The Session Overview panel and other catalog consumers are not changed in
  this pass; they may read the new field later.

## Proposed solution

### Wire field

Add one optional boolean to the session summary, mirrored in both wire types:

- `DaemonSessionSummary.needsContinuation?: boolean`
  (`packages/sdk-typescript/src/daemon/types.ts`)
- `BridgeSessionSummary.needsContinuation?: boolean`
  (`packages/acp-bridge/src/bridgeTypes.ts`)

`true` means: the persisted prompt ledger's last record shows the session's
latest prompt was cut off mid-flight. Absent means no evidence (the field is
omitted, never `false`, matching the sidecar-enrichment convention). The
OpenAPI `SessionSummary` schema documents the field
(`docs/developers/daemon-rest-api.openapi.json`, `additionalProperties: true`
already allows it).

### Server derivation (cli serve)

`packages/cli/src/serve/server/session-list.ts` gains one enrichment step,
`enrichPromptContinuation`, called beside `enrichWorktreeSidecars` /
`enrichPrSidecars` in both persisted-summary assembly sites (the default
paginated path and `loadAllPersistedSummaries`, which also serves the
organized, metadata-filtered, and standalone conversation lists). For each
active session it reads the ledger tail
(`sessionService.getPromptLedgerPath(sessionId)`,
`readPromptLedgerRecords(path, { tailBytes: 4096 })`) and sets
`needsContinuation: true` when the **last record** is:

1. `in_flight` — a prompt admitted but never terminated (hard crash before any
   flush); or
2. terminal `interrupted` — the cold-load reconciliation attributed a
   `daemon_lost` interruption; or
3. terminal `error` with a teardown code: `daemon_shutdown`, `channel_closed`,
   `session_closed`, `session_killed` — the graceful flushes publish an error
   terminal for every still-pending prompt, so these codes mean "the turn was
   cut off by teardown", not "the model failed".

Any other last record (`completed`, `cancelled`, an ordinary `error`, a
`prompt_deadline_exceeded` error) leaves the field absent. Reading only the
last record keeps the rule cheap and fail-closed: a torn tail line is dropped
by the ledger reader, an unreadable ledger is skipped, and a later settled
prompt always supersedes an earlier interruption. The 4 KiB window holds dozens
of records while only the final one decides; multi-dangling-prompt shapes whose
last record settled are deliberately not flagged (the reconciliation itself
fails closed on them).

`mergeLiveSessionSummary` drops the persisted flag when the live entry shows
work in flight (`hasActivePrompt`, `activeWorkState === 'active'`,
`hasRunningBackgroundTasks`, or a `backgroundTurn`), so a fresh catalog read of
a running session never carries the badge evidence.

### Client freshness (web-shell)

- `session-catalog-store.ts` `applyLiveState`: when a live activity watermark
  advances a row's activity time, the row's `needsContinuation` is cleared.
  The watermark is the newest terminal of a prompt that ran in the current
  bridge; a terminal newer than the persisted evidence means the continuation
  (or a fresh prompt) already settled, so the stale flag must not wait for the
  rate-limited full catalog reconcile (up to ~10 s) to disappear.
- `WebShellSidebar.tsx`: the row renders an amber pill
  (`sidebar.continuationNeededShort`, full label
  `sidebar.continuationNeeded` as `aria-label`) in the existing meta slot when
  `session.needsContinuation === true` and the session is not running, not
  background-running, carries no `backgroundTurn`, and has no approval/input
  attention badge. The pill shares the `sessionAttention` layout rules (hover
  action reveal, touch layout keeps it in flow), so touch devices keep a
  visible status.
- Freshness differs by surface, matching each surface's existing contract:
  the workspace tree rows merge live-state ticks through the catalog store,
  so the badge hides the moment a run starts and clears on the watermark
  rule. The cross-workspace Recent region re-reads raw catalog pages on its
  existing 10 s cadence (it does not consume live state today, for any
  volatile indicator); its badge follows that same contract — the
  server-side live merge drops the flag for running sessions on each re-read,
  and a settled continuation clears it on the next one.
- i18n: English `Continue execution needed` / `Continue`; Chinese
  `需要继续执行` / `待继续`.

## Design decisions and rationale

- **Ledger, not transcript scan.** The ledger already records exactly the
  admission/terminal evidence needed, is tiny, and is already read on the load
  path. A transcript-tail interruption scan per listed session would duplicate
  `detectTurnInterruption` semantics at list cost and still miss the
  notification-trim provenance rules.
- **Last record, not full-ledger analysis.** The continuation question is
  about the session's latest turn. A later admitted prompt supersedes earlier
  interruptions (the send path strips orphaned trailing user entries), so the
  last record is the correct and cheapest witness.
- **Teardown error codes included.** Graceful shutdown/close/kill flushes write
  `error` terminals, not `interrupted`; excluding them would miss the most
  common restart case. The four codes are exactly the `flushPromptTerminals`
  call sites.
- **Hint semantics.** Deriving the authoritative `canContinue` requires the
  loaded transcript and live turn guards; the list path cannot and should not
  reproduce them. The badge points at the banner, which stays authoritative.
- **Watermark clearing on the client.** The catalog reconcile is rate-limited
  (10 s cooldown); without the watermark rule the badge would flicker back for
  up to ~10 s after a continuation completes while the cached catalog still
  carries the flag.

## Constraints

- The ledger read adds one bounded file read per listed active session, the
  same order as the existing PR/worktree sidecar enrichment; the persisted
  list cache (2 s TTL) and the catalog pagination bound the frequency.
- The field is additive and optional; older daemons omit it and older clients
  ignore it. No capability flag is required.
- `BridgeSessionSummary` is a wire mirror of `DaemonSessionSummary`; both must
  gain the field in the same change.

## Risks

- **False positive while another process owns the turn.** A dangling
  `in_flight` can belong to a prompt running in another daemon/process; this
  daemon's live state cannot suppress it. The badge then points at a session
  whose banner is vetoed on load. Accepted: the badge is a hint, and the
  banner's guards remain authoritative.
- **Ledger append failure.** Ledger writes are best-effort; a lost terminal
  leaves a dangling `in_flight` and the badge stays until a later prompt
  settles. Accepted, same posture as the reconciliation.
- **Recorder flush window.** A hard crash between prompt admission and the
  recorder's first flush leaves a dangling ledger admission but no user
  record in the transcript: the badge shows, while the loaded session reads
  `clean` because there is nothing to continue. Observed in the real-daemon
  E2E when the SIGKILL landed inside this window. Accepted under the hint
  semantics — the badge clears on the next prompt — and the E2E waits for the
  user record to land before crashing so it verifies the continuable case.
- **Window edge.** A ledger whose last record sits before the 4 KiB window
  start cannot happen (the window is anchored at EOF); only a torn final line
  is dropped, which falls back to the previous record — fail-closed.

## Validation plan

- Unit (cli): `session-list.test.ts` — each last-record shape (dangling
  `in_flight`, `interrupted`, the four teardown codes, `completed`,
  `cancelled`, ordinary `error`, `prompt_deadline_exceeded`), unreadable
  ledger, archived skip, live-merge suppression, and the organized/standalone
  paths inheriting the enrichment.
- Unit (web-shell): `session-catalog-store.test.ts` — watermark advance clears
  the flag, equal/older watermark keeps it; sidebar tests — badge visible when
  idle with the flag (en + zh-CN labels), hidden while running / active work /
  background tasks / background turn / attention, and the git icon yields to
  the badge. Touch visibility is not separately asserted: the pill shares the
  `sessionAttention` layout rules, which keep it in flow under
  `@media (hover: none)`.
- E2E (mock daemon, Playwright): catalog fixture with `needsContinuation`
  renders the badge; a live-state tick with `hasActivePrompt` hides it.
- E2E (real daemon): run a prompt, SIGKILL the daemon mid-turn, restart, and
  verify the catalog answers `needsContinuation: true`, the sidebar shows the
  badge, and continuing clears it after the turn settles.

## Acceptance criteria

- An interrupted cold session shows a visible, labeled badge in the sidebar on
  desktop and touch layouts; clicking the row opens the session where the
  recovery banner offers "Continue execution".
- Running, background-active, and attention sessions never show the badge in
  the workspace tree; the Recent region converges within its 10 s raw re-read
  cadence, like every other volatile indicator there.
- After a continuation completes, the badge disappears without a page reload:
  immediately in the workspace tree (watermark clearing, then catalog
  reconcile), and within the Recent region's existing 10 s raw re-read
  cadence.
- Sessions with no ledger evidence, archived sessions, and older daemons
  behave exactly as before.

## Open questions

- Whether the Session Overview panel should surface the same signal (deferred;
  the field is already on the wire).
- Whether TUI-only sessions deserve a transcript-tail fallback scan (deferred;
  cost/benefit unclear for the sidebar's hot list path).
