# Web Shell sidebar goal markers

[English](2026-11-17-web-shell-sidebar-goal-markers.md) | [简体中文](2026-11-17-web-shell-sidebar-goal-markers.zh-CN.md)

Status: landed (2026-11-18, merged as c98108ee13 via #17515). The sections below
describe the design as written on 2026-11-17. Two things changed during review
and are recorded here so the status line does not mislead: the
completed-goals-hidden rule now lives in one shared `hasVisibleGoal` predicate
read by the strip, the sidebar and the marker; and the goal sidecar coexists
with main's separate artifact-count sidecar rather than being merged into it.
One bounded candidate from the final review is tracked in #17731 — the
objective is length-bounded only on the `propose_goal` path.

Follow-up to the Goal display enhancement (#17349, merged as 2b4ce375d2), whose
Non-goals section explicitly deferred this feature.

## Problem

The Goals page (#17230, #17291, #17349) shows every loaded session's goal
with lifecycle tones, budget bars, and session jumps — but only once the
user opens it. The sidebar session list, the surface users actually scan to
find a session, gives no hint which sessions carry a Goal. A user running
several goals across projects must open the Goals page (or each session) to
remember where a goal lives, and a paused goal in an unloaded session is
invisible everywhere except the Goals page's live-only listing.

## Current state

Citations name symbols rather than line numbers, which drift as `main`
moves; each is resolvable in the file named.

- The canonical Goal runtime is session-scoped, owned by each `qwen --acp`
  child; the serve process holds no mutable copy
  (`packages/cli/src/serve/routes/goals.ts`). `GET /goals` fans out one
  `sessionGoalGet` IPC probe per LIVE session (concurrency-capped), so it is
  both costly and blind to unloaded sessions.
- Goal state persists as `goal_state` system records in the session
  transcript. The single journal write point is
  `ChatRecordingService.recordGoalState`
  (`packages/core/src/services/chatRecordingService.ts`); recovery
  scans records newest-first (`goals/goal-persistence.ts`). There is no
  standalone goal file today.
- The session catalog (`POST /sessions/catalog` →
  `packages/cli/src/serve/server/session-list.ts`) already reads
  per-session sidecar files from disk and merges them into the summary:
  PR bindings (`<chatsDir>/<sessionId>.pr.json`, read by
  `enrichPrSidecars`), worktree info (`enrichWorktreeSidecars`), and the
  title sidecar. Path helpers live on `SessionService`
  (`packages/core/src/services/sessionService.ts`,
  `getPrSessionPathForState` / `getPrSessionPathForArchiveState` and the
  archive-state variants), and the PR sidecar is moved/deleted at four
  lifecycle sites: `removePrSidecars` (session removal, both archive
  states), `moveArchiveSidecars` (the generic archive/unarchive move), and
  the archive-conflict and unarchive-conflict branches of
  `archiveSessions` / `unarchiveSessions` (each calls
  `moveSessionPrSidecar` for the dropped lineage).
- Live sidecar updates propagate without polling: the child writes the PR
  sidecar itself, fires `SessionService.emitSessionPrBound` (registered via
  `setSessionPrBoundCallback`), the ACP session sends
  `qwen/notify/session/pr-binding` from
  `Session.#registerBackgroundNotificationCallbacks`
  (`packages/cli/src/acp-integration/session/Session.ts`), the bridge
  validates it and marks the catalog clock
  (`packages/acp-bridge/src/bridgeClient.ts`, the `pr-binding`
  ext-notification handler), and version-watching clients refetch the
  catalog.
- The summary wire type carries `prs?: DaemonSessionPrInfo[]`
  (`packages/sdk-typescript/src/daemon/types.ts`, `DaemonSessionSummary`);
  the sidebar renders `SessionPrBadge` beside the session title in both
  layout variants (`WebShellSidebar.tsx`, the archived-row and active-row
  render branches).
- The client already has `goalStatusTone` and the shared execution-status
  palette from #17349 (`GoalStatusStrip.tsx`), plus the `Target` icon as the
  app-wide Goals glyph.

## Goals

- Show at a glance which sidebar sessions carry a Goal, and its lifecycle
  state, using the same colour language as the Goals page.
- Cover unloaded and archived sessions, not just live ones.
- Add no new polling and no per-catalog IPC probes.
- Keep the transcript canonical; the marker is a projection that may lag.

## Non-goals

- No change to the Goals page, goal control semantics, or the transcript
  schema.
- No goal markers on group headers or the navigation rail — session rows
  only (both layout variants).
- No budget figures in the sidebar; the marker is identity + state, the
  Goals page remains the detail surface.
- No marker for completed goals: both Goals listings filter `complete`
  (pre-existing daemon policy); the sidebar follows the same policy.

## Proposed changes

### Core: goal sidecar projection

- New `session-goal-sidecar.ts` beside `session-pr-service.ts`: a small
  JSON projection `{ v: 1, goalId, status, objective, updatedAt }`, atomic
  write, ENOENT-tolerant read ("no goal"), and a move helper for archive
  transitions — mirroring the PR sidecar service's shape.
- `SessionService` gains `getGoalSessionPathForState` /
  `getGoalSessionPathForArchiveState` returning
  `<chatsDir>/<sessionId>.goal.json`, and the goal sidecar is moved/deleted
  at the same four lifecycle sites as the PR sidecar: `removeGoalSidecars`
  (session removal, both archive states), the goal move in
  `moveArchiveSidecars` (the generic archive/unarchive move), and the
  archive-conflict and unarchive-conflict branches of `archiveSessions` /
  `unarchiveSessions`. The two conflict branches always discard the dropped
  lineage's projection (`reconcileGoalSidecarOnConflict` deletes it): an
  absent goal sidecar is a value (the survivor's goal may be cleared), so
  adopting the dropped projection would resurrect a goal the surviving
  transcript no longer records. The survivor's marker is rebuilt from its own
  transcript on the next transition or restore — a missing marker beats a
  wrong one.
- `ChatRecordingService.recordGoalState` writes the projection after the
  strict journal append succeeds: payload snapshot has a goal → upsert the
  sidecar; `snapshot.goal === null` (clear) → delete it. The write is
  best-effort: a sidecar failure logs and never fails the journal — the
  transcript remains the canonical record, and a stale or missing marker
  is the same degraded mode the PR badge already accepts.
- Restore itself writes nothing (the runtime's invariant); instead
  `Config.initializeGoalRuntime` refreshes the projection once
  `goalRuntimeReady` settles, via the recorder's public
  `refreshGoalProjection`. Sessions journaled before this feature gain a
  marker on their next load without waiting for a transition.
- `SessionService` gains `emitSessionGoalChanged` /
  `setSessionGoalChangedCallback`, mirroring the PR-bound callback pair;
  `Config.relocateWorkingDirectory` carries the callback onto the
  replacement service exactly as it carries the PR-bound one.

### ACP session + bridge: catalog-clock notification

- The ACP session wires the callback to a best-effort
  `qwen/notify/session/goal-changed` ext-notification `{ v: 1, sessionId }`
  — same fire-and-forget shape as pr-binding. It carries only the session
  id: nothing renders notification values, so a status field would add a
  validation surface with no consumer.
- The bridge validates `v` and `sessionId`, checks session ownership, and
  marks the catalog clock; it does NOT carry the projection itself. The
  sidecar on disk is the source the catalog reads, exactly as for PR
  bindings — a dropped notification only delays the marker until the next
  catalog refresh.

### Serve: catalog reads the sidecar

- `session-list.ts` reads the goal sidecar per session alongside the PR
  sidecar (same archive-state parameterization, same ENOENT → absent
  semantics) and sets `goal` on the summary. No IPC, no transcript parse.

### SDK: summary field

- `DaemonSessionSummary` gains
  `goal?: { status: GoalStatus; objective: string; updatedAt: string }`
  (`DaemonSessionGoalInfo`), beside `prs`. Optional everywhere; older
  daemons simply omit it and no marker renders.

### Web Shell client: the marker

- The session-catalog store needs no change: it spreads catalog summaries
  wholesale (`...session`), so `goal` passes through exactly as `prs`
  does. The E2E spec pins the passthrough through the real store.
- New `SessionGoalMarker` rendered beside `SessionPrBadge` in both sidebar
  layout variants: the `Target` glyph tinted by `goalStatusTone(status)`
  (running / attention; `complete` is filtered out before render, matching
  the Goals listings), a tooltip with the localized status and the
  objective, and an accessible name carrying both. Clicking the marker
  opens the session — the same action as the row, so the marker is a
  labeled shortcut, not a new navigation destination.
- i18n: tooltip/aria keys in en / zh / ru, reusing the existing
  `goal.status.*` strings for the status word.

## Design decisions

- **Sidecar projection, not probes.** The PR-binding feature already
  proved the pattern: per-session sidecar + catalog read + clock-mark
  notification. It covers unloaded/archived sessions (the Goals listing
  cannot), costs one small file read per session per catalog fetch, and
  adds zero IPC. Reparsing transcripts per catalog call was rejected on
  cost; a live-only serve cache was rejected because a paused goal in an
  unloaded session is exactly the case the marker must surface.
- **Journal hook, not runtime hooks.** `recordGoalState` is the single
  place every transition already passes through (create, edit, pause,
  resume, clear, usage-limited settle, and the per-turn `turn_finished`
  republish). One hook there covers all paths; sprinkling writes across
  the reducer's callers would drift.
- **Transcript stays canonical.** The sidecar is written after the strict
  append and never gates it. Recovery still reads records; the sidecar
  only serves the list. A crash between append and sidecar write leaves a
  stale marker, repaired by the next transition or load — the same
  consistency contract the PR badge ships with.
- **Mutations serialize per path in-process.** The runtime settles bounds
  automatically, so transitions can arrive faster than disk writes; two
  blind overwrites racing could rename the older projection last. A
  per-path promise queue orders writes/deletes (a failed mutation does not
  block later ones). No cross-process lock: only the session child writes
  a given session's sidecar; the daemon's archive move is ownership-fenced
  and a stranded projection is repaired by the next transition/load.
- **Notification carries a clock mark, not data.** Mirroring pr-binding
  keeps one propagation mechanism and one validation surface; the catalog
  read stays the single source of the projected values.
- **Complete is hidden, done tone unused here.** Consistent with both
  Goals listings filtering `complete`; a finished goal stops being a
  navigation aid. The sidecar still records `complete` so the policy lives
  in the UI, not the persistence.
- **Marker click opens the session.** The row already does; making the
  marker a second affordance for the same action keeps it a labeled
  shortcut (with a full accessible name) rather than inventing a new
  destination. The Goals page remains one click away via the existing
  sidebar entry.

## Files affected

- `packages/core/src/services/session-goal-sidecar.ts` (new) + tests,
  exported from the core barrel
- `packages/core/src/services/sessionService.ts` (path helper, lifecycle
  move/delete, callback pair)
- `packages/core/src/services/chatRecordingService.ts` (journal hook +
  public `refreshGoalProjection`)
- `packages/core/src/config/config.ts` (restore-time projection refresh,
  relocation callback carry)
- `packages/cli/src/acp-integration/session/Session.ts` (notification wire
  - teardown)
- `packages/acp-bridge/src/bridgeClient.ts` (notification handler) +
  `bridgeTypes.ts` (`BridgeSessionGoalInfo`, summary field)
- `packages/cli/src/serve/server/session-list.ts` (sidecar read + merge,
  all three listing paths)
- `packages/sdk-typescript/src/daemon/types.ts` + `daemon/index.ts`
  (`DaemonSessionGoalInfo`, summary field, export)
- `packages/web-shell/client/components/SessionGoalMarker.tsx` +
  `.module.css` (new) + tests, `sidebar/WebShellSidebar.tsx` (both
  variants), `i18n.tsx` + `i18n-ru-part3.ts` (en/zh/ru key)
- The session-catalog store is unchanged (spread passthrough, pinned by
  the E2E spec through the real store)
- Tests collocated per package; E2E in
  `packages/web-shell/client/e2e/` (mockDaemon sidecar fixture) and the
  real-daemon rig.

## Constraints and risks

- Cross-package change (core / acp-bridge / cli / sdk-typescript /
  web-shell). Maintainer-authored; the core paths involved are the
  recording/service layer, not the goal reducer or control semantics.
- Legacy sessions journaled before this feature show no marker until
  their next load or transition (restore-time write). Documented gap, no
  bulk backfill job.
- Sidecar writes are not limited to human-scale transitions. While a goal
  is active the runtime republishes its snapshot at every turn finish
  (cause `turn_finished`, refreshing `turnCount` / `activeTimeMs` /
  `tokensUsed`), and each republish passes through `recordGoalState`. So
  an active-goal session rewrites its sidecar and marks the catalog clock
  once per turn — one small fsync'd write plus one catalog refetch per
  turn per active-goal session, on top of the set/pause/resume/clear
  transitions. This is the same per-turn journaling the transcript already
  does; the projection adds a file write and a clock mark, not a new
  journal record. Paused/blocked goals do not turn, so they incur no
  per-turn cost.
- A wedged child cannot stall the catalog: reads are disk-only, and the
  notification is best-effort.

## Validation plan

- Unit: sidecar write/read/move/delete (core), journal-hook upsert/delete
  incl. best-effort failure isolation, restore-time write, session-list
  merge (present/absent/archived), bridge notification validation
  (bad v/sessionId/status rejected, good marks the clock), SDK type
  surface, sidebar marker render (tone per status, tooltip, accessible
  name, click opens session, complete hidden, absent without goal).
- E2E (mockDaemon): catalog fixture with goal sidecars → markers render
  with tones; a goal-changed notification refreshes the marker; clearing
  removes it.
- Real environment: isolated daemon + real session/goal over HTTP; marker
  appears on set, tones flip on pause/resume, disappears on clear,
  survives daemon restart (sidecar on disk), and shows for an unloaded
  session. Screenshots to the assets branch, reconciled.
- Mutation witnesses for the load-bearing pins (journal hook, sidecar
  read, tone mapping, complete filter), byte-level restores.

## Acceptance criteria

- Sidebar session rows show a lifecycle-tinted goal marker exactly when
  the session has a non-complete goal sidecar, in both layout variants.
- Markers appear/update/disappear on goal transitions without new polling.
- Unloaded and archived sessions show markers from disk.
- No marker for completed goals or goal-less sessions; older daemons
  render the sidebar unchanged.
- Transcript schema and Goals page unchanged; catalog reads add no IPC.

## Open questions

- None blocking. Marker placement beside the PR badge is decided; if both
  badges crowd narrow rows, the existing row-overflow behavior applies
  unchanged (no new truncation logic in this feature).
