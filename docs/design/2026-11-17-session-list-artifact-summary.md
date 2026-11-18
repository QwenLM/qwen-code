# Session-list artifact summary for click-time header display

[English](2026-11-17-session-list-artifact-summary.md) | [简体中文](2026-11-17-session-list-artifact-summary.zh-CN.md)

Status: implemented in this change. Follow-up to
[Early session-artifact header entry](2026-11-15-early-session-artifact-entry.md)
(scope B of that design).

## Problem statement

Scope A embedded the restored artifact list in the `/session/:id/load` and
`/resume` responses so the session-level header artifact entry paints at
load-response time (~450 ms on the measured session), before the conversation
body. The count is still unavailable at **click time**: the session list
carries no artifact information, so between the click and the load response
the header shows nothing about the session's artifacts.

The session list already carries derived per-session data (`prs`, `worktree`)
hydrated best-effort from sidecar files. An artifact summary in the same
metadata lets the header entry show the count the instant a session is
clicked, using the list data the sidebar already holds.

## Current state (verified on main at 91690e86e5)

- Artifact persistence is journal-based: the bridge's `SessionArtifactStore`
  records durable changes as `session_artifact_event` records and periodic
  `session_artifact_snapshot` records through the agent's chat recording
  service (`packages/core/src/services/chatRecordingService.ts`,
  `recordSessionArtifactEvent` / `recordSessionArtifactSnapshot`). Snapshots
  are written every 50 durable events (`SNAPSHOT_AFTER_DURABLE_EVENTS`) and
  after rewind; there is no snapshot on close. A typical small session has
  only event records.
- The event payload (`SessionArtifactEventRecordPayload`,
  `packages/core/src/services/session-artifact-persistence.ts`) carries
  changes only, not a total. The snapshot payload carries the full restorable
  artifact array.
- There is no per-session artifact summary on disk. The only small per-session
  sidecars are the title (`.title.json`), PR bindings (`.pr.json`), worktree
  (`.worktree.json`), and prompt ledger (`.ledger.jsonl`), all in the chats
  directory next to the transcript.
- Session summaries (`BridgeSessionSummary` in
  `packages/acp-bridge/src/bridgeTypes.ts`, mirrored by `DaemonSessionSummary`
  in `packages/sdk-typescript/src/daemon/types.ts`) have no artifact field.
  `toSessionSummary` (`packages/acp-bridge/src/session-control-plane.ts`)
  builds the live summary from the in-memory entry.
- The list response (`packages/cli/src/serve/server/session-list.ts`) enriches
  persisted summaries from sidecars at three sites: the default page path,
  `loadAllPersistedSummaries` (full scan shared by the organized and
  metadata-filtered paths, cached with a 2 s TTL), and the search path.
  `mergeLiveSessionSummary` overlays live state; `liveOnlySummary` inserts
  live sessions with no persisted record.
- The artifact library's cold removal
  (`SessionService.removeSessionArtifactsForLibrary`) appends an event record
  directly to the journal, bypassing the recording service.
- `SessionService.loadSession` rebuilds the artifact snapshot from the active
  branch on every load/resume; this is the central restore read path.
- Client: the header entry count comes from `useSessionArtifacts`
  (per-session cache, then the load-embedded snapshot keyed by
  `restoredArtifactsSessionId`). The click flows
  sidebar `onLoadSession` → App `loadSidebarSession` →
  `sessionActions.loadSession` → `startSessionSwitch`
  (`packages/web-shell/client/daemon/session/actions.ts`), which synchronously
  commits the optimistic connection (`sessionId`, `loadingTranscript`). The
  provider's load effect later commits the embedded snapshot with `flushSync`
  before the replay, and the attach commits it unconditionally.

## Goals

- Session summaries carry an artifact count, for live sessions and for
  persisted (cold) sessions, on every workspace list path.
- Clicking a session in the sidebar shows the header artifact entry with that
  count immediately — before the load response — when the count is known.
- Do not slow down `/load` or the list path beyond the existing sidecar-read
  cost model (one small file read per session, cached).
- Preserve existing behavior for older daemons (no field) and for the
  load-embedded snapshot path (scope A).

## Non-goals / scope boundaries

- No artifact list in the session-list metadata — a count only. The list
  stays small; the full list still arrives via scope A's load embedding and
  the gated `/artifacts` fetch.
- No session-row badge. The count surfaces in the chat header at click time
  (the design's "click-time display"); a row badge is a possible later
  enhancement, not part of this change.
- Standalone (Conversations) catalog rows are not enriched: they use a
  separate summary type and catalog path. Live standalone entries still carry
  the live count wherever `BridgeSessionSummary` flows; cold standalone rows
  keep today's behavior. Follow-up if wanted.
- No change to the per-turn chips, the artifact panel's live-update path, or
  the artifact storage format. The journal remains authoritative; the sidecar
  is a derived cache.
- No new capability tag: the field is additive metadata on the existing
  session-list surface, gated client-side by the existing `session_artifacts`
  capability check.

## Proposed solution

### Server: a derived artifact-summary sidecar

- New core module `session-artifact-summary-sidecar.ts`, mirroring
  `session-title-sidecar.ts`: file `<sessionId>.artifacts.json` in the chats
  directory, shape `{ version: 1, artifactCount: number, updatedAt: string }`.
  Atomic best-effort write (returns boolean), validated read (version, safe
  non-negative integer count capped at `MAX_PERSISTED_ARTIFACTS`, string
  timestamp) with sync and async variants sharing one shape check, move and
  remove helpers.
- The event payload gains an optional `artifactCount` field: the store's
  authoritative **restorable** count (the same filter as the snapshot payload:
  non-ephemeral, excluding non-snapshot published file URLs), computed in
  `persistChanges` when the payload is built. `normalizeEventPayload`
  preserves it silently when valid (a malformed derived field never
  invalidates the authoritative journal record). The fork remap strips it: a
  forked session's count is unknown until its own store writes one.
- The recording service writes the sidecar after the journal append succeeds:
  on event, from `payload.artifactCount` when present; on snapshot, from
  `payload.artifacts.length`. These are the only journal write sites for
  store-driven persistence, so every durable mutation refreshes the sidecar.
- `SessionService.loadSession` seeds the sidecar best-effort from the rebuilt
  snapshot. This covers legacy sessions (journal records predating the
  sidecar) and forks on their first open, and re-seeds after any out-of-band
  journal edit. A zero count heals an existing stale sidecar (a failed
  best-effort zero write must not leave a phantom count forever) but never
  creates one for an artifact-free session; an equal count skips the write so
  a warm load adds no disk write; a partial transcript read never seeds. The
  seed runs before the empty-conversation early return, so side-records-only
  sessions (artifacts registered before the first prompt — the same
  transcript shape the library guard accepts) gain a count on their first
  open even though they have no conversation to load. The
  seed also requires an authoritative journal: no history gap (a broken chain
  can orphan artifact events off the active branch and undercount) and no
  record-level damage warnings — the same predicate the library mutation
  guard uses (`hasDisqualifyingArtifactJournalWarning`); per-artifact skips
  stay tolerated. Both gates read the warnings threaded out of the rebuild,
  not the snapshot's: an all-refused journal yields no snapshot but is
  damaged, not artifact-free.
- The library cold removal updates the sidecar from the remaining restorable
  count after its direct journal write.
- `SessionService` gains the archive-state path helper; archive/unarchive
  moves the sidecar with the other sidecars; session delete removes it;
  conflict resolution discards the dropped side's sidecar (the kept
  transcript's artifact set is different, so the dropped count must not
  transfer).
- Working-directory relocation (`Config.getCurrentSessionArtifactMoves`)
  carries the sidecar with the transcript and the other display sidecars, so
  a `/cd` neither strands the count in the old project nor re-exposes a
  stale count beside the transcript on the way back.

### Server: summaries carry the count

- `SessionArtifactStore` gains a synchronous `count()` accessor (the live
  public artifact count, `artifacts.size`; no queue, no status refresh).
- `toSessionSummary` includes `artifactCount` when non-zero. Live entries are
  authoritative for their count, so the merge drops a stale sidecar-derived
  count when the live summary omits it (count zero).
- While an entry's artifact restore is still pending (`pendingRestoreIds`),
  `toSessionSummary` sets `artifactCountPending: true` and omits the count:
  `session/load` registers the entry before it awaits `artifacts.restore()`,
  and the empty store inside that window would otherwise make the merge drop
  the sidecar-enriched count. The row STAYS visible — the accessor's contract
  is "all live sessions", consumed by occupancy gates and live-state — and
  `mergeLiveSessionSummary` keeps the sidecar count for a pending row. The
  marker is a wire field on both mirrors; an absent count with the marker is
  unknown, not zero.
- `BridgeSessionSummary` and `DaemonSessionSummary` gain optional
  `artifactCount?: number` and `artifactCountPending?: boolean` (wire
  mirrors, kept synchronized).
- `session-list.ts` gains `enrichArtifactSummaries`, called beside
  `enrichPrSidecars` at all three enrichment sites. It awaits an async
  sidecar read per session — like the sibling enrichers, so a mid-scan abort
  is observable and a large scan (up to `MAX_ORGANIZED_SESSIONS`) does not
  stall the event loop — and sets the count when non-zero. An unreadable or
  absent sidecar leaves the field unset on a persisted summary (unknown, not
  zero); on a live summary, absence means zero because the in-memory store
  is authoritative.

### Client: click-time hint, retired by authoritative data

- The sidebar passes the clicked session's `artifactCount` through
  `onLoadSession` → `loadSidebarSession` → `loadSession` options
  (`artifactCountHint`). Other open paths (overview, host handoff, standalone,
  retry, capacity-recovery resume) pass no hint and keep scope A timing;
  `resumeSession` does not declare the option at all.
- `startSessionSwitch`'s optimistic connection commit sets
  `artifactCountHint` and `artifactCountHintSessionId` together (both cleared
  when no hint was passed), following the `restoredArtifacts` /
  `restoredArtifactsSessionId` keying pattern. `getConnectionAfterSessionClear`
  deletes both.
- `useSessionArtifacts` exposes `artifactCountHint`: the connection hint only
  when it is keyed to the current session, positive, and no authoritative
  data exists for the session (no cache entry, no keyed restored snapshot).
  A successful gated fetch (even an empty list) or the embedded snapshot
  retires the hint.
- The provider's early snapshot commit and the attach commit clear the hint
  fields: once authoritative data lands, the hint is gone.
- The App header entry uses `artifacts.length` when non-zero, otherwise the
  hint. The single-gate contract (count and opener derived from one
  condition, spread into both header render sites) is unchanged.

## Key design decisions and rationale

- **Count, not list, in the metadata.** A page of up to 100 sessions must not
  carry 100 artifact lists. The count is the summary; the list arrives via
  scope A at load time.
- **Restorable count on disk, live count in memory.** The sidecar stores the
  restorable count — what a cold open restores. The live summary stores the
  live public count (including ephemeral artifacts), matching what the header
  shows while the session is live. Ephemeral artifacts die with the daemon
  lifetime, so the count correctly drops to the restorable count when the
  session goes cold. The seed and the library-removal write count the set a
  cold open actually restores: published `file:` locators without a preview
  snapshot are dropped on restore — whatever their kind or id — and excluded
  from the derived count. The exclusion is one shared predicate
  (`isNonSnapshotPublishedFileUrl` in core) called by both the bridge's
  restorable count and the core seed (`isRestorablePersistedArtifact`), so
  the two definitions cannot drift; it is keyed off the preview snapshot id
  so real published snapshots stay counted.
- **Public via the core barrel.** The sidecar helpers are exported from
  `packages/core/src/index.ts` because the session-list consumer reads them
  through its existing barrel import (a legacy-allowlisted file). They are a
  public API commitment: signature changes must honour downstream consumers.
- **The count rides the existing persist chain.** Adding the total to the
  event payload (additive, optional) keeps the wire surface unchanged — no
  new ext method kind, no new failure domain. The store is the only component
  that always knows the exact count; deriving it in the handler from change
  deltas would need an unknown base for legacy and forked sessions.
- **Sidecar writes live in the recording service.** It is co-located with the
  transcript by construction (including SSH/managed runtimes), and it is the
  single funnel for store-driven journal writes. The load-time seed lives in
  `SessionService.loadSession`, the single funnel for restore reads.
- **Best-effort everywhere.** A sidecar failure never fails a journal write,
  a load, or a list page. The journal is authoritative; the sidecar self-heals
  on the next persist, load, or library mutation.
- **Hint retired by authoritative data.** The hint only bridges the
  click→load window. The embedded snapshot and the gated fetch supersede it,
  so a stale sidecar count cannot outlive the load. Keying by session id
  prevents cross-session leakage on the optimistic switch, matching the
  scope A guard.
- **No artifactsVersion→catalog wiring.** The catalog already refetches on
  turn admission/completion and other invalidations; artifacts are created
  during turns, so the badge refreshes at turn boundaries. A live counter in
  the list is not the goal.

## Files affected

- `packages/core/src/services/session-artifact-summary-sidecar.ts` (new).
- `packages/core/src/index.ts` (barrel export of the sidecar module).
- `packages/core/src/services/session-artifact-persistence.ts` (payload field,
  normalization, fork strip, shared journal-authority warning predicate,
  rebuild warning threading, shared restorable-set predicate).
- `packages/core/src/services/chatRecordingService.ts` (sidecar writes).
- `packages/core/src/services/sessionService.ts` (path helper, load seed and
  library guard sharing the journal-authority gate, library removal update,
  archive move, delete removal, conflict discard).
- `packages/core/src/config/config.ts` (working-directory relocation move
  list).
- `packages/acp-bridge/src/sessionArtifacts.ts` (count in payload, `count()`).
- `packages/acp-bridge/src/session-control-plane.ts` (`toSessionSummary`
  pending-restore marker, rewind restore registration in `pendingRestoreIds`).
- `packages/acp-bridge/src/bridgeTypes.ts` (`BridgeSessionSummary`).
- `packages/sdk-typescript/src/daemon/types.ts` (`DaemonSessionSummary`).
- `packages/cli/src/serve/server/session-list.ts` (enrichment, merge rule).
- `packages/cli/src/serve/acp-http/dispatch.ts` (ACP session/list projection
  of the count and the pending marker).
- `packages/web-shell/client/daemon/session/types.ts` (connection fields,
  action options).
- `packages/web-shell/client/daemon/session/actions.ts` (optimistic hint,
  clear).
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx` (hint
  retirement on early commit and attach).
- `packages/web-shell/client/hooks/useSessionArtifacts.ts` (hint exposure).
- `packages/web-shell/client/App.tsx` (header count fallback, hint threading).
- `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx` (pass the
  clicked session's count).
- Collocated tests for each changed behavior.

## Constraints and risks

- The sidecar can lag the journal between a failed write and the next
  successful persist/load; the count is best-effort metadata and the
  authoritative load corrects it. Acceptable for a count entry. The same
  envelope covers the designed live-only downgrade path: a previously
  journaled artifact stays restorable in the journal while the live map
  holds it ephemeral, so durable events stamp the live restorable set
  (without it) until the next snapshot converges the journal or the load
  seed heals the sidecar; re-journaling the artifact converges the stamp.
- Legacy sessions show no count until their first open after the upgrade
  (the load seed). Sessions never opened keep today's behavior.
- The list path reads one additional small file per session; the organized
  full scan is cached (2 s TTL) and already reads two sidecars per session.
- During the click→load window the panel opened from the entry shows its
  empty/loading state until the load populates it; the count is a hint that
  artifacts exist, not a populated list.
- Backward/forward compatibility: optional fields both ways; older daemons
  omit the count and older clients ignore it.

## Validation plan

- Unit: sidecar read/write validation (sync and async readers, including the
  async throw contract: ENOENT → undefined, other I/O errors rethrown, abort
  → AbortError); event payload count preservation and fork strip;
  recording-service sidecar writes (event with/without count, snapshot,
  write-after-append order on both paths, legacy count-less events preserve
  an existing sidecar); load seed and its authority gate (history gap,
  record-level damage warnings including change-level drops, tolerated
  per-artifact skips, all-refused journals refused by the seed and the
  library guard alike, side-records-only sessions seeded before the
  empty-conversation early return), in both active and archived states, from
  event and snapshot (fork) records, counting the cold-restorable set
  (non-snapshot published file locators excluded via the shared bridge/core
  predicate, real preview snapshots kept); library
  removal update (restorable-survivor arithmetic, single and batch, stale
  ids in the requested batch, non-snapshot published file locators
  excluded);
  archive/delete/conflict handling (including the kept-side-absent shape);
  working-directory relocation; store
  `count()` including the decrement after a removal; `toSessionSummary`
  include/omit and the pending-restore marker (`artifactCountPending` keeps
  the row visible and the merge keeps the sidecar count, a rejecting
  rewind restore clears it, and it is keyed per session on a shared
  channel); the ACP boundary
  carries the stamped count to the recorder and the ACP session/list
  projection carries the count and the marker; enrichment on all list paths,
  including a mid-scan abort (per-iteration checks, interrupted scan not
  cached) and a throwing read contained per session; merge drops stale
  count; optimistic hint keying, clear, and retirement on a failed load;
  hook hint validity (cache/snapshot retirement, cross-session keying);
  header count fallback; sidebar threading.
- Mutation witnesses: revert each load-bearing guard (keying, retirement,
  merge drop, fork strip, seed) and show the paired test reds.
- E2E (real daemon + headless Chromium, network timing as load-bearing
  evidence): cold-open a session with a sidecar; assert the header entry
  appears at click time (before the load response) with the listed count;
  assert the load-embedded snapshot supersedes the hint; legacy session seeds
  on first open; live count reflects ephemeral artifacts; archive moves the
  sidecar; delete removes it; A→B switch never leaks the hint; older-daemon
  fallback keeps scope A timing.
- Regression: `/load` latency unchanged; list latency within the sidecar-read
  cost model; per-turn chips unchanged; sessions without artifacts show no
  entry.

## Acceptance criteria

- Clicking a session whose summary carries a positive artifact count shows
  the header artifact entry with that count before the load response arrives.
- The embedded snapshot and the gated fetch supersede the hint; a stale hint
  cannot outlive the load or leak across sessions.
- Cold sessions carry the restorable count from the sidecar on every
  workspace list path; live sessions carry the live count.
- Legacy sessions gain the count on first open; archive/delete/conflict keep
  the sidecar consistent with the transcript.
- Older daemons (no field) behave exactly as today.
- Build, typecheck, and focused unit tests pass.

## Open questions

- Whether a session-row badge should follow (separate surface, not part of
  this change).
- Whether the standalone catalog should gain the same enrichment (separate
  summary type and path; follow-up).
