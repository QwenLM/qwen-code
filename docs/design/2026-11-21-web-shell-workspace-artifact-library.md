# Web Shell workspace artifact library for the local daemon

[English](2026-11-21-web-shell-workspace-artifact-library.md) | [简体中文](2026-11-21-web-shell-workspace-artifact-library.zh-CN.md)

Status: proposal (not implemented).

## Problem statement

Web Shell's local daemon mode shows artifacts only inside a session: per-turn
chips, the right-panel artifacts list tab opened from the chat header entry,
and the session-list artifact count. Finding a deliverable produced by an
earlier session means opening that session first; artifacts of archived
sessions are unreachable until an explicit unarchive and load. Managed mode
already has a workspace-wide artifact library dialog
([managed workspace artifact library](managed-workspace-artifact-library.md),
#17728); the local daemon has the backend for the same experience but no Web
Shell surface.

Users look for deliverables ("last week's report"), not sessions. Browsing
across history should not require loading every conversation — loading
allocates agents and changes runtime state merely to browse outputs, the
exact problem the persisted library routes were built to avoid
([session artifact library](session-artifact-library.md)).

## Current state (verified on main `232496db23`)

Session-scoped surfaces (local daemon):

- Per-turn chips (`TurnOutputs`) tied to transcript replay.
- The right-panel artifacts list tab (`ArtifactsListPanel.tsx`), opened by the
  chat header entry. The restore response embeds the artifact list (scope A of
  [early session-artifact entry](2026-11-15-early-session-artifact-entry.md)),
  and the session list carries `artifactCount` / `artifactCountPending`
  (scope B, [session-list artifact summary](2026-11-17-session-list-artifact-summary.md)).
- Browsing the artifacts themselves requires a loaded session;
  `useSessionArtifacts` gates refresh on connection, `catchingUp`, and the
  `session_artifacts` capability. The session-list count is sidebar metadata
  hydrated without loading the session, but it is a count, not a browsable
  list.

Workspace-level backend (built for DAC, unconsumed by Web Shell):

- `GET /workspaces/:workspace/artifact-library` (all sessions),
  `POST /workspaces/:workspace/artifact-library/query` (1–100 sessionIds),
  `POST /workspaces/:workspace/artifact-library/delete` (1–100 pairs);
  capabilities `workspace_artifact_library` and
  `workspace_artifact_library_stream`
  ([workspace artifact library](workspace-artifact-library.md)).
- Envelopes carry a required `session` object (`displayName?`, `createdAt`,
  `archiveState`, `sourceType`, `sourceId?`). Reads cover live, cold, and
  archived sessions without attach/spawn/unarchive; progressive SSE
  (`start` / `session` / `session_error` / `complete` / `error`); bounded
  per-runtime cache; JSON full scans skip nonexistent or foreign sessions.
- No SDK wrapper (the backend design deferred it) and no consumption of
  these daemon routes in `packages/web-shell` — the managed library below
  reads the Java control plane, not the daemon.

Managed precedent:

- `ManagedArtifactLibraryPage.tsx` (#17728): a workspace-wide, newest-first
  cursor page with per-row source-session labels and preview/download through
  existing byte routes; read-only. Parity marks `workspace_artifact_library`
  as `managed` standing; `workspace_artifact_library_stream` remains absent
  (JSON pages, no progressive scan).

Content paths:

- `GET /session/:id/artifacts/:artifactId/content` requires a live session
  (`withOwnerReadSession`).
- Workspace-storage artifacts preview through workspace file reads with
  workspace attribution (`useArtifactWorkspaceTarget.ts`), independent of
  session load.

## Goals

- A workspace-scoped, read-only artifact library page for local daemon mode,
  mirroring the managed library's product shape: newest-first artifacts
  across all live, cold, and archived sessions of the current workspace, each
  row labeled with its source session.
- Browse without loading sessions; progressive results while the scan runs;
  explicit per-session failures.
- Preview workspace-storage artifacts without a session load; reach cold
  managed snapshots and sessions through the existing open/unarchive flows.
- No new backend routes; no change to session-scoped surfaces or to the
  managed library.

## Non-goals / scope boundaries

- No deletion, pinning, or view-preference UI. The daemon batch-delete route
  exists; a later slice (the managed library is also read-only).
- No new content routes or content semantics; cold managed-snapshot preview
  goes through session jump.
- No live subscription: finite snapshot scan plus manual refresh. Live
  updates for the open session stay on the existing session path.
- No cursor pagination: the daemon library is a full/batch scan, not a keyset
  page; progressive SSE is the delivery mechanism.
- No cross-workspace aggregation; the page queries the workspace the shell is
  currently scoped to. Managed workspaces keep their own library dialog.
- No disk index; no changes to per-turn chips, the right-panel tab, the header
  entry, or session-list counts.

## Proposed solution

### SDK: type and wrap the library reads

- `packages/sdk-typescript/src/daemon/types.ts`: the library envelope
  (`DaemonSessionArtifactsEnvelope` plus the required `session` metadata), the
  full-query result `{ v: 1, sessions, errors }`, the member error shape
  `{ sessionId, status, code, message }`, and the SSE event payloads
  (`start` / `session` / `session_error` / `complete` / `error`).
- `WorkspaceDaemonClient` (`DaemonClient.ts`): `artifactLibrary()` — full GET,
  JSON; `artifactLibraryStream()` — the same GET with
  `Accept: text/event-stream`, yielding typed events through the existing SSE
  parsing helpers. Callers preflight `workspace_artifact_library` /
  `workspace_artifact_library_stream` from `capabilities()`. Read-only: no
  delete wrapper in this slice.

### Client: progressive scan hook

- `useWorkspaceArtifactLibrary(workspaceTarget)`: capability gate; SSE-first
  when `workspace_artifact_library_stream` is advertised, JSON fallback
  otherwise; an SSE admission refusal (`503 sse_connection_limit_exceeded`,
  sent as a plain HTTP response before the stream starts) retries the same
  scan as JSON — both capabilities share one persistence toggle, so the
  capability check alone cannot detect this refusal. Accumulate envelopes
  keyed by `sessionId`; the flattened newest-first list (`updatedAt`
  descending, `createdAt` fallback, stable `(sessionId, artifactId)`
  tiebreak) is a derived projection recomputed in batches, not on every
  event. Track scan progress (`total` from `start`; only `complete`
  terminates; sessions silently skipped mid-scan emit no event, so terminal
  progress reconciles with `complete`'s `succeeded` / `failed` / `skipped`
  counters); a disconnect or terminal `error` without `complete` marks the
  result partial and offers retry. No polling.
- Scan-generation ownership: every scan — initial load, manual refresh, or
  workspace switch — aborts the previous scan and bumps a monotonic generation
  bound to the workspace key (`ScanOwner = { workspaceKey, generation }`).
  Every event and terminal-state commit (`start` / `session` / `session_error`
  / `complete` / `error`) is guarded by an ownership check: the signal is not
  aborted, the workspace key matches, and the generation matches the current
  scan. Abort alone is not ownership proof — a transport can deliver a queued
  event after abort; a delayed `complete(A)` must not terminate a newer
  refresh B, and a delayed `session(A)` must not overwrite a newer result from
  B. An A→B→A workspace switch must not revive the old A scan: generation
  identity is required, not the workspace key string alone.
- Envelopes and errors are kept per generation and replaced when a new scan
  begins; progress, partial banners, and terminal states always describe the
  current generation, never a settled-but-superseded one.
- Session metadata comes from the envelope (no client-side summary resolution,
  unlike the managed page); a missing `displayName` falls back to a shortened
  session id.
- Sessions with no artifacts are omitted from the list but still count toward
  scan progress.

### UI: full-page library view

- New `mainView` `'artifacts'` and primary nav item `'artifacts'`, following
  the scheduledTasks / prWatches / goals / workflows feature-page pattern
  (`App.tsx`, `WebShellSidebar.tsx` `DEFAULT_PRIMARY_NAV_ITEMS`, customization
  types). The entry renders only when `workspace_artifact_library` is
  advertised; hidden otherwise — no silent live-only fallback (the library
  design requires an explicit upgrade state rather than a partial view;
  hiding the entry avoids a degraded view entirely).
- Rows: artifact icon and title (`artifactUtils.ts`, `FileTypeIcon`), size and
  updated time, source-session label with an `archiveState` badge; clicking
  the label opens the session. A single client-side text filter over artifact
  title/description and session label. Rendered rows are bounded — incremental
  reveal or windowing over the sorted projection; a large workspace's full
  result set is retained per generation, but the DOM is not mounted all at
  once.
- Row action dispatch reuses the session panel's preview paths:
  workspace-storage artifacts preview/download through the page's own
  workspace file-read actions resolved by `useArtifactWorkspaceTarget` (no
  session load); managed snapshots of live sessions use the existing content
  route; managed snapshots of cold/archived sessions jump to the session
  first (existing open path, including the archived unarchive flow), then
  open the artifact; external URLs use the existing safe-link opener.
  Liveness comes from the shell's existing live-session tracking
  (`workspace-session-live-state`), never from the envelope's `archiveState`
  — that is storage location, not attachment, and a cold-but-active session's
  managed snapshot must jump, not hit the attached-only content route. Where
  the dispatch logic is embedded in `ArtifactPanel`, extract the minimal
  shared helper into `artifactUtils.ts` without changing session-panel
  behavior.
- States: scanning progress (received/total sessions), empty workspace,
  persistence unavailable (`409 artifact_library_unavailable`), runtime
  unavailable (`503 workspace_runtime_unavailable`), request-level error with
  retry, per-session error summary (`session_error` rows), partial-result
  banner when the stream ends without `complete`. Terminal wording distinguishes
  two judgments: `complete` with `session_error` rows reads as "scan finished
  with per-session failures", not "all workspace artifacts verified";
  `complete` without errors reads as "enumeration finished", not "atomic
  snapshot at time T" — the sources are mutable while the scan runs.
- Copy follows the managed library precedent: a dedicated message module
  (EN/ZH/RU) registered in `i18n.tsx`, a transcript stub registered in
  `vite.lib.config.ts` so interaction-only copy stays out of the exported
  transcript budget, and zh-TW catalog entries pinned by i18n tests.

## Key design decisions and rationale

- Mirror the managed library's product shape (newest-first, source-session
  labels, read-only, preview via existing content paths) so both modes present
  one artifact-library experience; adapt only where the daemon backend
  differs (session-grouped envelopes, progressive scan instead of cursor
  pages).
- Reuse the DAC backend unchanged: the slice is SDK plus client only;
  protocol, trust, cache, and failure semantics are already designed and
  tested.
- SSE-first with JSON fallback: full scans are O(sessions) with cold
  transcript replay; progressive rendering keeps the page usable on large
  workspaces. Finite-query semantics are preserved: only `complete` terminates
  a scan; a disconnect is partial, never silently complete.
- Transport completion is not view establishment: a `complete` event only
  terminates the scan that owns the current generation. The generation guard
  on every state commit is a client-only contract — no new daemon semantics —
  and the interleaving tests below pin it, so an older request settling last
  can never establish the current view.
- Hide the entry on old daemons rather than build a degraded view: satisfies
  "must not silently return live-only artifacts" without an upgrade-state
  screen for a feature that does not exist there.
- Jump for cold managed previews instead of a new workspace content route:
  keeps the slice read-only and avoids new content/trust semantics; loading
  one session on demand is the existing user flow, unlike loading every
  session to browse.
- Full page rather than a dialog or panel tab: scheduled tasks, PR watches,
  goals, and workflows establish the local shell's feature-page pattern; the
  environment panel and right panel are session-scoped, and workspace
  browsing must work with no session open. The managed dialog lives inside
  `ManagedSessionsPage`; the local shell has no equivalent shared page.
- Snapshot plus manual refresh: the backend offers finite queries, not
  subscriptions; freshness of the open session is already handled by the
  session-scoped live path.

## Files involved

- `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.ts`
  (`WorkspaceDaemonClient`), and barrel exports as needed.
- `packages/web-shell/client/daemon-react-sdk` workspace surface (expose the
  library reads).
- New hook and page: `hooks/useWorkspaceArtifactLibrary.ts`,
  `components/artifacts/WorkspaceArtifactLibraryPage.tsx` (plus module CSS);
  shared preview-dispatch helper extracted from `ArtifactPanel` as needed.
- `App.tsx` (mainView, routing, open-session wiring), `WebShellSidebar.tsx`
  (nav item), `customization.tsx` (types), `i18n.tsx` plus the message module,
  transcript stub, `i18n-zh-tw.ts`, `vite.lib.config.ts`,
  `build-artifact.test.ts`.
- Collocated tests for every changed behavior.

## Constraints and risks

- Scan cost: cold sessions replay transcripts (four concurrent workers,
  per-runtime cache with a 32 MiB serialized budget; uncached sessions replay
  on every query). First visit to a large workspace can be slow; progress and
  partial rendering mitigate, not eliminate.
- Rows re-sort as scan results arrive (SSE completion order is not display
  order); the list is a scan snapshot, not a stable pagination window.
- A full scan is enumeration-complete, not an atomic as-of workspace snapshot:
  live, cold, and archived sources may change while the four workers run, and
  per-session envelopes are read at different moments. The UI must not present
  the result as a coherent as-of view; the backend is not asked for
  transactional semantics.
- Library projections carry metadata-only workspace restore state; the list
  does not guarantee file freshness. Preview reads the actual file on demand
  and surfaces missing/changed files.
- Snapshots go stale until refresh; artifact identity is
  `(sessionId, artifactId)`, never `artifactId` alone.
- In-flight scans must abort on refresh, unmount, or workspace change; state
  ownership is guaranteed by the generation contract above, and cache keys
  follow the existing per-session guard pattern.
- Old daemons hide the entry; clients must not fabricate a library from
  live-only reads. Managed mode is untouched (its library dialog and parity
  standing stay as they are).

## Validation plan

- Unit: SDK wrapper request shape, Accept header, and error mapping; hook SSE
  accumulation, JSON fallback, SSE-admission-refusal JSON fallback,
  partial-on-disconnect, abort, refresh, sort stability, zero-artifact
  progress counting and terminal reconciliation with `complete`'s counters,
  `displayName` fallback; page rows/filter/states (including the `503`
  runtime-unavailable state)/bounded rendering/action dispatch (workspace
  preview vs live content vs cold jump, with a cold-but-active managed
  snapshot taking the jump); nav gating.
- Interleaving witnesses for scan-generation ownership: (negative)
  same-workspace overlapping refresh — scan A emits an older envelope for
  session S, the user refreshes, scan B returns a newer S and `complete(B)`,
  then a delayed `session(A)` and `complete(A)` arrive from a transport that
  delivers queued events even after abort; final rows, progress, and terminal
  state must reflect only B, regardless of which request settles last.
  (negative) A→B→A workspace switch — the old A request must not be revived
  merely because the workspace key matches again; generation identity is also
  required. (positive) a single completed scan displays all successful
  envelopes, preserves session-error reporting, and keeps the cold/archived
  jump and workspace-file preview paths working; a disconnected current stream
  is partial.
- E2E (headless against a real daemon; plan under `.qwen/e2e-tests/`): a
  workspace with live, cold, and archived sessions carrying artifacts —
  progressive display without session load (no attach/spawn), archived
  artifacts visible, workspace-file preview without load, cold managed jump
  loads then previews, session-label jump including unarchive,
  capability-absent hides the entry, persistence-unavailable and corrupt- or
  oversized-transcript (`413 transcript_too_large`) partial failures,
  disconnect-without-complete partial banner.
- Regression: session panel, chips, header entry, and session-list counts
  unchanged; managed library untouched; build, typecheck, bundle, lint,
  format.

## Acceptance criteria

- The page lists artifacts of live, cold, and archived sessions of the current
  workspace newest-first with source-session labels, without loading sessions;
  progress and per-session errors are visible.
- Workspace-storage artifacts preview without a session load; cold managed
  artifacts reach preview through session jump; session labels open the
  session (archived via the existing unarchive flow).
- Old daemons hide the entry; no live-only fallback. A stream ending without
  `complete` is shown as partial with retry.
- Overlapping refreshes and A→B→A workspace round-trips never let a superseded
  scan establish rows, progress, or terminal state; terminal wording
  distinguishes "enumeration finished" from "scan finished with per-session
  failures", and never claims an atomic as-of snapshot.
- Build, typecheck, and focused unit tests pass; session-scoped surfaces and
  the managed library are unchanged.

## Open questions

- Default-on in the standalone primary nav vs opt-in (proposed default-on,
  following the header-entry precedent); embedded hosts keep their explicit
  items lists.
- Whether multi-workspace shells need a workspace selector on the page or
  follow the overview's current workspace context (proposed: follow the
  current context; selector deferred).
- Follow-up slices: batch delete UI (daemon route exists), session-grouped
  view, pinning/view preferences.
