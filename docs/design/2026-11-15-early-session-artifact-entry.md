# Early session-artifact header entry via load-embedded artifacts

[English](2026-11-15-early-session-artifact-entry.md) | [简体中文](2026-11-15-early-session-artifact-entry.zh-CN.md)

Status: implemented (scopes A and B). Scope B shipped in
[session-list artifact summary](2026-11-17-session-list-artifact-summary.md).
The header entry's _destination_ is superseded: it now opens the right panel's
artifacts list tab instead of the environment panel's artifacts section — see
[artifacts entry opens the right panel](2026-11-18-artifacts-entry-opens-right-panel.md).
The load-embedded artifact list and the session-list summary remain as designed.

## Problem statement

When a cold session is opened in the Web Shell, the session's artifacts are not
surfaced until the replay has been injected and the artifact list has been
fetched. There is no visible, session-level artifact entry point that appears
before the conversation body renders. A user who wants to jump straight to a
published artifact must wait for the whole cold-open path.

The per-turn artifact chips (`TurnOutputs`) cannot appear earlier: they are
joined to transcript turns by `getArtifactsByTurn`, so they require the replay.
A **session-level** entry point, however, only needs the artifact list, not the
replay. If the list arrives early, the entry point can appear early.

## Baseline (measured before implementation)

The measurements and behaviors below describe the pre-change baseline that
motivated this work; scope A has since shipped and changed the response shape
and client timing described here.

Investigation of session `82c7298a-9233-4efc-b57e-cb1f79ccc06b` (workspace
`qwen-code`, daemon `0.27.3`), cold-opened headlessly with network timing as the
load-bearing evidence:

- `POST /session/:id/load` returns in ~436–464 ms with a ~1.15 MB replay
  (`compactedReplay` 404 events, `liveJournal` 0). The response does **not**
  include an artifact list (only `artifactWarnings`).
- The conversation body first paints ~683–722 ms after the session is clicked.
  The ~250 ms between the load response and first paint is client-side replay
  injection, which the body itself must wait for.
- `GET /session/:id/artifacts` is ~1 ms server-side, but the client only fires it
  after the `catchingUp` gate clears
  (`packages/web-shell/client/hooks/useSessionArtifacts.ts`, the
  `!isConnected || connection.catchingUp || !supportsArtifacts` guard in
  `refresh`). It completes ~638–709 ms after click — within ±45 ms of body first
  paint.

Conclusion: the artifact list already arrives at about the same time as the
body. Embedding artifacts to speed up the **per-turn chips** would save ~0 ms.
But a **session-level header entry** that reads an early artifact list can appear
at load-response time (~450 ms), ~250 ms before the body, because it does not
need the replay.

Relevant baseline behavior (before this change):

- The bridge restores artifacts into the in-memory store during `loadSession`
  (`packages/acp-bridge/src/session-control-plane.ts`, `entry.artifacts.restore`
  in the restore path) before the load response is built, but the response only
  carries `artifactWarnings`.
- `SessionArtifactStore.list()`
  (`packages/acp-bridge/src/sessionArtifacts.ts`) runs
  `refreshWorkspaceStatuses()` (workspace stat/hash) and
  `forgetVanishedAutoRecordedArtifacts()` before returning. Calling it on the
  load path would add latency to `/load`.
- `DaemonRestoredSession`
  (`packages/sdk-typescript/src/daemon/types.ts`) has no artifact field.
- Session summaries already carry derived per-session data (`prs`), hydrated
  best-effort from a sidecar in
  `packages/cli/src/serve/routes/session.ts` — a precedent for metadata
  enrichment that scope B later reused
  ([session-list artifact summary](2026-11-17-session-list-artifact-summary.md)).
- Chat header items are declared by `WebShellChatHeaderItem`
  (`packages/web-shell/client/customization.tsx`), defaulted in
  `DEFAULT_CHAT_HEADER_ITEMS` and consumed in `packages/web-shell/client/App.tsx`
  (`chatHeaderItems`), and rendered by `ChatContextHeader`.

## Goals

- Show a visible, session-level artifact entry in the chat header as soon as the
  artifact list is available from the load response (~450 ms on the measured
  session), before the conversation body renders.
- The entry shows the artifact count and opens the environment panel's
  artifacts section.
- Do not slow down `/load`.
- Preserve existing behavior for older daemons and for the per-turn chips.

## Non-goals / scope boundaries

- This design covers scope A only: embed the artifact list in the `/load` (and
  `/resume`) response. Scope B (artifact summary in the session-list metadata
  for click-time display) shipped separately in
  [session-list artifact summary](2026-11-17-session-list-artifact-summary.md).
- The per-turn `TurnOutputs` chips are unchanged; they still wait for the replay.
- No change to the artifact panel's live-update path (`artifactsVersion` events).
- No new artifact storage format or sidecar in scope A; scope B adds the
  derived `.artifacts.json` summary sidecar described in
  [session-list artifact summary](2026-11-17-session-list-artifact-summary.md).

## Proposed solution

### Server: carry the restored artifact list in the restore response

- Add a lightweight read accessor to `SessionArtifactStore` that returns the
  current artifacts mapped through `toPublicArtifact`, sorted by `insertSeq`,
  **without** `refreshWorkspaceStatuses()` or
  `forgetVanishedAutoRecordedArtifacts()`. It reflects the restored snapshot;
  workspace status is refreshed later by the normal gated `/artifacts` fetch.
- In the bridge restore path, after `entry.artifacts.restore(...)`, include the
  accessor's artifact array in the load/resume response as an optional
  `artifacts` field. Omit it when the session has no artifacts or when artifact
  persistence is unavailable, so the payload stays small and older clients are
  unaffected. The already-live attach returns (a page reload / second tab on a
  session the daemon still holds, and a restore that raced another registration)
  carry the same snapshot via the same cheap accessor, so the entry is early on
  the common re-open path too, not only on a cold restore.
- The `packages/cli/src/serve` restore route already forwards the bridge
  response through `redactSdkSurfaceReplay`; ensure the artifact array passes
  through unredacted (it contains no skill bodies).

### SDK: type the field

- Add optional `artifacts?: DaemonSessionArtifact[]` to `DaemonRestoredSession`
  in `packages/sdk-typescript/src/daemon/types.ts`. Optional so older daemons
  that omit it remain valid.

### Client: commit the artifact snapshot ahead of the replay and add the header entry

- The daemon session client retains the restore response's `artifacts` as
  `restoredArtifacts`; the provider exposes them on the connection state.
- To make the entry paint **before** the conversation body, the provider commits
  `sessionId` + `restoredArtifacts` + `restoredArtifactsSessionId` with
  `flushSync` in its own render before the replay injects (only when
  `restoredArtifacts` is present). It touches only those fields; `catchingUp` and
  the rest of the connection state are left to the existing replay/attach logic.
  Without the forced commit, React batches the snapshot with the replay
  injection and the entry would paint with the body.
- `useSessionArtifacts` falls back to `connection.restoredArtifacts` when its
  per-session cache is empty, so `artifacts` is populated without waiting for the
  `catchingUp` gate. The fallback is gated on
  `connection.restoredArtifactsSessionId === sessionId` so an optimistic switch
  (which spreads the previous connection and sets the new `sessionId` before the
  restore lands) cannot show the previous session's snapshot under the new
  session. The snapshot and its key are cleared together on session clear. The
  existing gated `refresh` and the `artifactsVersion`-driven refresh remain the
  source of live updates and overwrite the fallback. When the field is absent
  (older daemon), behavior is exactly as today.
- Add a new chat header item `artifacts` to `WebShellChatHeaderItem` and to the
  standalone default header items. Render a header button labeled with the
  artifact count (e.g. "Artifacts · N") that opens the environment panel, whose
  artifacts section is expanded by default and lists the session's artifacts.
  The tab-based artifact panel is deliberately not the target: opened with no
  tabs it shows a launcher empty state, not the artifact list. Hide the button
  when the count is 0 or the `session_artifacts` capability is absent.
- Add the i18n strings for the button label/aria in both locales.

## Key design decisions and rationale

- **Embed the list, not just a count.** The list is small (a few KB) and already
  restored in memory; carrying it lets the artifact cache be seeded so the panel
  opened from the button is populated immediately. Scope B later reused this
  header entry and added a sidecar-derived count for the window before the load
  response — the scope-A cache is empty at click time by construction, and once
  the list lands the header still prefers it.
- **No workspace status refresh on the load path.** The cheap accessor avoids
  stat/hash work so `/load` is not slowed. Status accuracy is restored by the
  existing gated fetch shortly after.
- **Seed, don't replace, the gated fetch.** The early list is a snapshot; live
  correctness still comes from the existing refresh path. This keeps reconnect
  and live-update semantics intact.
- **Header entry, not a flat strip.** A count button avoids duplicating the
  per-turn chips and is the smallest visible surface.
- **Accessor: `listRestored()`, sharing one snapshot helper.** The cheap read
  accessor is named `listRestored()`; it and `list()` both map through a shared
  synchronous `snapshotPublicArtifacts()` helper so the two paths cannot drift
  in ordering or public shape. The helper stays synchronous — `listRestored()`
  wraps it in a single `enqueue`, and nesting another `enqueue` inside would
  self-deadlock on the store's queue.
- **Header item is on by default.** The `artifacts` header item ships enabled in
  the standalone shell's default header items (not opt-in like `tokenUsage`),
  for visibility; it still hides itself when the count is 0 or the capability
  is absent.

## Files affected

- `packages/acp-bridge/src/sessionArtifacts.ts` (cheap accessor).
- `packages/acp-bridge/src/session-control-plane.ts` (restore response field).
- `packages/acp-bridge/src/bridgeTypes.ts` (`BridgeRestoredSession` typing).
- `packages/sdk-typescript/src/daemon/types.ts` (`DaemonRestoredSession`).
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts` (retains the field
  as `restoredArtifacts` on every load/resume factory).
- `packages/web-shell/client/daemon/session/*` (provider exposes/keys the field).
- `packages/web-shell/client/hooks/useSessionArtifacts.ts` (early seed).
- `packages/web-shell/client/customization.tsx` (header item type).
- `packages/web-shell/client/App.tsx` (default items, header button wiring).
- `packages/web-shell/client/main.tsx` (standalone default header items).
- `ChatContextHeader` component (render the button).
- `packages/web-shell/client/i18n.tsx` (labels).
- Collocated tests for each changed behavior.

## Constraints and risks

- The early snapshot may show stale workspace status until the gated fetch
  refreshes it; acceptable for a count/entry, and the panel refreshes on open.
- The seed must be keyed to the correct session and cleared on session switch,
  matching the existing cache ownership guards, to avoid cross-session leakage.
- Restore-response size grows by the artifact list (bounded by the artifact
  limits); negligible for typical sessions.
- Backward/forward compatibility: optional field; older daemons omit it and the
  client falls back to the gated fetch; older clients ignore it.

## Validation plan

- Unit: cheap accessor returns restored artifacts without status refresh; restore
  response includes/omits the field correctly; `useSessionArtifacts` seeds from
  the early list and still refreshes on `artifactsVersion`; header button shows
  count and opens the panel; absent field falls back to today's behavior.
- E2E (headless against a real daemon, network timing as load-bearing evidence):
  cold-open a session with published artifacts; assert the header artifact entry
  appears at load-response time (before body first paint) with the correct count,
  and that clicking it opens the environment panel's artifacts section. Reuse
  the eviction + cold-open measurement harness.
- Regression: per-turn chips unchanged; `/load` latency not increased; sessions
  without artifacts show no button.

## Acceptance criteria

- On a cold session with artifacts, the header artifact entry is visible before
  the conversation body first paint, with the correct count.
- Clicking the entry opens the artifacts surface populated with the session's
  artifacts. Originally the environment panel's artifacts section; superseded by
  the right panel's artifacts list tab (see
  [artifacts entry opens the right panel](2026-11-18-artifacts-entry-opens-right-panel.md)).
- `/load` server-side duration does not regress.
- Older daemons (no field) behave exactly as today.
- Build, typecheck, and focused unit tests pass.

## Open questions

- None remaining. The scope B follow-up (artifact-summary sidecar for
  click-time display in the session list) is implemented in
  [session-list artifact summary](2026-11-17-session-list-artifact-summary.md).
