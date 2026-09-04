# Web Shell Global Turn Navigation — Phase 2: Bounded Client Data Layer

## Status

Proposed, 2026-09-04. Builds on
`web-shell-global-turn-navigation.md` (Phase 1 merged as #10751) and the
page-table model of `web-shell-bounded-transcript-and-subagent-details.md`.

Tracking issue: #10750. This document covers only the Phase 2 checklist there:
the client-side turn-index store, the reloadable historical transcript window,
identity reconciliation, memory bounds, and capability fallback. Rail
virtualization and jump UX are Phase 3.

Facts about current code were verified against `origin/main` (`80497a74d0`),
which includes the merged Phase 1.

## Problem

Phase 1 gave the daemon a session-wide sparse turn index and snapshot-bound
random-access transcript reads. The Web Shell client cannot consume either
today:

- The transcript lives in one flat, append/prepend-only SDK store
  (`createDaemonTranscriptStore`). An anchored mid-history page has nowhere to
  land: prepending or appending it would conflate non-contiguous ranges, and
  resetting the store would destroy the live tail.
- Nothing associates a materialized message with its canonical persisted
  `turnId`. `sourceRecordIds` already flow from the wire onto
  `DaemonTranscriptBlock`s, but `transcriptBlocksToDaemonMessages` drops them,
  so the message layer — where the rail lives — has no persisted identity.
- Eviction is a one-way, oldest-first safety trim inside the SDK reducer
  (`trimTranscriptState`). Evicted ranges leave no gap record and cannot be
  re-fetched in the newer direction; the provider's only recovery is the
  500-block quiet-period full reload.
- The rail (`SessionTimeline`) is derived from the loaded `messages` array, so
  its completeness is coupled to transcript retention.

Phase 2 builds the two stores that remove those couplings and migrates the
existing sequential prepend pagination onto the new window before any random
jump is wired (the parent design's delivery order).

## Consumed contract (Phase 1, shipped)

TypeScript SDK daemon surface (all reachable through the session-scoped
`DaemonSessionClient` the provider already holds in `sessionRef`, so
workspace-qualified routing is encapsulated):

- `getTurnIndexPage({ snapshot?, start?, limit? })`
  → `DaemonSessionTurnIndexPage`
  `{ v: 1, sessionId, snapshot, totalTurns, start, turns: DaemonSessionTurnIndexEntry[] }`,
  entry = `{ ordinal, turnId, kind: 'prompt' | 'realtime' | 'scheduled',
  promptId?, timestamp?, label, detail? }`
  (`sdk-typescript/src/daemon/types.ts:1388-1416`;
  `DaemonSessionClient.ts:988`).
  The first call omits `snapshot` and returns the newest page; `start`
  requires a `snapshot`.
- `getTranscriptPage({ atRecordId, snapshot, limit? })`
  → `DaemonSessionTranscriptPage` with additive `targetRecordId` and
  `hasOlder` (`types.ts:1360-1386`). Existing `beforeRecordId` / `nextCursor`
  backward pagination is unchanged and shares the same snapshot.
- Capability gate: `capabilities.features.includes('session_turn_navigation')`
  (registered at `packages/cli/src/serve/capabilities.ts:144`).

Error mapping the stores must implement (verified at
`packages/cli/src/serve/server/error-response.ts`; all surface as
`DaemonHttpError { status, body.code }`):

| HTTP | `body.code`                       | Client meaning                                         |
| ---- | --------------------------------- | ------------------------------------------------------ |
| 400  | `invalid_transcript_cursor`       | Missing/conflicting/tampered snapshot, bad `start`     |
| 400  | `invalid_turn_anchor`             | `atRecordId` is not a navigation turn in this snapshot |
| 409  | `transcript_snapshot_unavailable` | Frozen transcript replaced/truncated/leaf lost         |
| 413  | `transcript_page_too_large`       | One anchored page exceeds the response budget          |
| 413  | `transcript_too_large`            | Transcript exceeds the 256 MiB indexing ceiling        |

Session-resolution failures (archived, conflict, draining, unavailable owner)
follow the existing transcript-route codes and are already handled by the
provider's session-load error paths.

## Current client state (verified)

- **Store**: transcript state lives in an SDK external store, not a React
  reducer — `createDaemonTranscriptStore`
  (`packages/sdk-typescript/src/daemon/ui/store.ts:24`) over the pure reducer
  `reduceDaemonTranscriptEvents` (`ui/transcript.ts:194`). State:
  `DaemonTranscriptState` (`ui/types.ts:1124-1162`) — flat `blocks[]`,
  block/tool/permission indexes, `maxBlocks`, `retainedBytes`,
  `maxRetainedBytes`. React subscribes via `useSyncExternalStore` contexts in
  `DaemonSessionProvider.tsx` (contexts at lines 643-657; hooks from line
  4690), with a 50 ms render-throttled snapshot wrapper for the heavy
  consumers.
- **Initial load**: `historyPageSize = 200` (`client/constants/sessions.ts:22`
  `WEB_SHELL_HISTORY_PAGE_SIZE`) sent only when
  `session_transcript_pagination` is advertised
  (`DaemonSessionProvider.tsx:1724-1733`). The replay snapshot is materialized
  in a throwaway store and committed with `store.reset(...)` (lines
  2289-2340). The pagination anchor is the first replayed
  `_meta['qwen.session.recordId']` (lines 2107-2116).
- **loadMore**: `loadMoreTranscript` (`DaemonSessionProvider.tsx:4059-4313`)
  requests `getTranscriptPage({ cursor | beforeRecordId, limit })`,
  materializes the page in an isolated store (`materializeTranscriptHistory`,
  line 310) with dedup against displayed `sourceRecordIds`, refuses admission
  when count/byte budgets would be exceeded, and commits via
  `store.reset(applyTranscriptHistory(...))` (line 4192). Stale responses are
  dropped by session identity + `paginationGenerationRef`.
- **Retention**: `DEFAULT_MAX_BLOCKS = 50_000` (provider line 712,
  `WEB_SHELL_MAX_TRANSCRIPT_BLOCKS`), byte budget 128 MiB default from the SDK
  store. `trimTranscriptState` (`transcript.ts:1710-1881`) trims oldest-first
  with record-boundary snapping and tool/permission sentinels; the provider's
  `onTruncation` (lines ~874-1010) re-anchors `beforeRecordId`, drops cursors,
  and bumps the pagination generation. Separately,
  `WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS = 500` + 15 s idle triggers a full
  session reload (`MessageList.tsx:3921-3975`).
- **Live tail**: SSE events flow through a 16 ms batcher into the same store;
  history and live differ only positionally. Detached-viewport behavior
  already exists (scroll-up pauses follow; streaming continues).
- **Identity**: the daemon stamps `_meta.qwenTranscript.sourceRecordIds` /
  `qwen.session.recordId`; the normalizer stamps `sourceRecordIds` on every
  `DaemonUiEvent` (`normalizer.ts:1015-1037`) and the reducer carries them
  onto blocks (`ui/types.ts:912`), with merge rules that never join blocks
  across records. `transcriptBlocksToDaemonMessages`
  (`adapters/transcriptToMessages.ts:378`) does **not** copy them onto
  `Message`, and no block↔record locator map exists.
- **Rail**: `getSessionTimelineEntries(messages)`
  (`MessageList.tsx:1194-1261`) — turn head = `user`/`user_shell` message,
  entry id = the client message id. `SessionTimeline` (lines 2537-2770)
  renders every entry un-virtualized, is hidden below 1160 px container width
  and in wide/split layouts, and has no ordinal keyboard navigation. This is
  the documented capability fallback and stays untouched in Phase 2.
- **Page table / gaps**: do not exist. Confirmed by grep; pages are ephemeral
  inside `loadMoreTranscript` only.
- **Turn-index usage**: none. No web-shell reference to `getTurnIndexPage` or
  `session_turn_navigation` yet.
- **Tests**: `DaemonSessionProvider.test.tsx` (vitest + jsdom, `vi.hoisted()`
  `MockDaemonClient`/`MockDaemonSessionClient`, `renderWithProvider`);
  `MessageList.test.ts` pure-function suite; `MessageList.dom.test.tsx` with a
  mocked virtualizer. The transcript-page mock fixtures do not yet carry
  `targetRecordId`/`hasOlder`.

## Goals

1. A client-side turn-index store that loads the newest metadata page first
   and pages older metadata independently of transcript blocks.
2. A reloadable historical transcript window that can open an anchored page at
   a persisted `turnId` while preserving the connected live tail.
3. Canonical identity: materialized user-turn messages/blocks associated with
   their persisted `turnId` via `sourceRecordIds`; provisional live entries
   reconcile by exact `promptId` or record identity — never by label or
   timestamp.
4. Deduplicate overlapping pages, represent unloaded ranges as explicit gaps,
   and bound retained transcript and index memory.
5. Correct behavior across append refresh, reconnect, rewind, branch, snapshot
   replacement, eviction, and retry — never merging non-contiguous ranges.
6. Fall back to the current loaded-message rail when the daemon does not
   advertise `session_turn_navigation` or the transcript exceeds the indexing
   ceiling.
7. Provider/store unit coverage for all of the above.

## Non-goals (Phase 3 and later)

- Rail virtualization, rail selection UX, keyboard navigation, jump-to-latest
  visual integration, and real-browser E2E.
- Server or SDK protocol changes. (Two known non-blocking Phase 1 follow-ups —
  ACP-path `atRecordId` length parity with the route's 200-char cap, and a
  pinning test for the two-record anchored-expansion case — are tracked
  separately and do not block this phase.)
- Persisted client caches (IndexedDB), full-text search, changes to the
  256 MiB indexing ceiling.
- Renaming existing presentation-layer `turnId` usages (reducer message ids).

## Design

### Key structural decision: keep the SDK store flat; add a provider page ledger

The naive reading of the parent design — "replace the single block list with a
page table whose pages hold their own blocks" — would fork the SDK store's
indexing, batching, throttling, and trim machinery. The current code already
points at a cheaper shape:

- Every page (initial, prepend, anchored) is **already materialized in an
  isolated throwaway store** and admitted atomically.
- The visible store is **already rebuilt by `store.reset`** on each admission,
  and `trimTranscriptState` + `onTruncation` already implement prefix eviction
  with re-anchoring.

Phase 2 therefore keeps `DaemonTranscriptStore` as the single flat render
source and adds a provider-owned **page ledger** alongside it:

```ts
interface TranscriptPageLedgerEntry {
  id: string;
  source: 'load' | 'prepend' | 'anchored' | 'continuation';
  firstBlockId: string;          // inclusive, within the flat store
  lastBlockId: string;           // inclusive
  firstRecordId?: string;        // persisted boundaries, when known
  lastRecordId?: string;
  byteSize: number;
  turnIds: readonly string[];    // canonical turn ids present (from sourceRecordIds)
  snapshot?: string;             // index snapshot that produced an anchored page
}

interface TranscriptGap {
  /** Direction in which the gap can be resolved. */
  older?: { beforeRecordId: string };
  newer?: { afterRecordId: string; snapshot: string };
}
```

Invariants:

- Ledger entries are ordered, non-overlapping, and cover exactly the block
  ranges present in the store. Between two entries, or between the newest
  entry and the live tail, an unloaded range is a `TranscriptGap` — never
  implied contiguity.
- A page's blocks remain contiguous in the flat store. Admission of a
  non-contiguous anchored page appends it at the correct ledger position; the
  store keeps a flat `[pages…, liveTail]` layout, and the **ledger owns gap
  knowledge** so the render path can interleave explicit gap sentinel rows
  (a minimal row in this phase; styled UI in Phase 3).
- Eviction removes whole ledger entries, not arbitrary block runs. Prefix
  eviction reuses today's trim + re-anchor path; interior/newer eviction is a
  provider-directed `store.reset` over the retained pages (rare, bounded, and
  generation-guarded like existing resets).
- The live tail is the tail slice of the same flat store, delimited by the
  ledger: the newest page's `lastBlockId` (or store start when no pages
  exist). Streaming keeps writing through the existing batcher; historical
  admission never touches tail blocks.

This gives the parent design's semantics — immutable pages, explicit gaps,
bounded memory, random access — without a cross-package store rewrite.

### Turn-index store

New provider-side store, exposed through a context following the existing
`DaemonTranscriptHistory` pattern (interface at `DaemonSessionProvider.tsx:162-169`,
context at line 657):

```ts
interface SessionTurnIndexState {
  sessionId: string;
  status: 'disabled' | 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  snapshot?: string;           // snapshot that minted the retained pages
  totalTurns: number;
  pages: ReadonlyMap<number, TurnIndexPageCacheEntry>; // key = page start
  liveEntries: readonly LiveTurnEntry[];               // tail-only provisionals
}

interface TurnIndexPageCacheEntry {
  snapshot: string;
  turns: readonly DaemonSessionTurnIndexEntry[];
}

type LiveTurnEntry =
  | { id: `live:${string}`; kind: 'prompt'; promptId: string; label: string }
  | { id: `shell:${string}`; kind: 'shell'; label: string };
```

Rules:

- Seeding: after session load, if the capability is advertised, request the
  newest page (`limit` 200, matching `WEB_SHELL_HISTORY_PAGE_SIZE`). Adopt the
  returned `snapshot`/`totalTurns`.
- Older metadata pages are fetched with the retained snapshot and explicit
  `start`, keyed by `start`, immutable. A page whose snapshot differs from the
  store snapshot is never admitted.
- Tail refresh on prompt terminal: re-request the newest page without a
  snapshot and merge:
  - **append-only** — every ordinal present in both old and new tail pages has
    the same `turnId`: adopt the new `snapshot`/`totalTurns`, keep old pages,
    replace overlapping tail pages.
  - **divergent or zero overlap**: clear all snapshot-bound pages, keep only
    the new tail page. Deliberately conservative — it cannot retain a page
    from a rewritten active chain.
- Reconciliation: a `live:` prompt provisional is removed exactly when an
  index entry appears with the same `promptId`, or (legacy records without a
  prompt id) when its persisted record UUID is observed in admitted blocks'
  `sourceRecordIds`. Unmatched provisionals persist; the next coalesced
  refresh or reconnect retries. Label/timestamp matching is forbidden.
- `shell:` entries are live-only overlays, removed when their live block is
  evicted; they never affect `totalTurns`.
- Eviction bounds the page map by count and bytes (LRU). Evicting metadata
  never changes `totalTurns`; an evicted range renders as placeholder ticks
  and refetches on demand (Phase 3 wires the fetch trigger to the virtualized
  viewport; in this phase the store exposes `ensurePage(start)`).
- `409 transcript_snapshot_unavailable` or a divergent refresh invalidates the
  snapshot and pages; the store re-seeds from a fresh tail request.
- `413 transcript_too_large` latches `status: 'unsupported'` for the session —
  the rail falls back for the rest of the session.

### Anchored open and bidirectional window

New provider action (Phase 3's rail will call it; this phase lands and tests
it):

```ts
openTranscriptAtTurn(turnId: string): Promise<
  | { ok: true; targetRecordId: string }
  | { ok: false; reason: 'unsupported' | 'invalid_anchor' | 'snapshot_gone'
       | 'page_too_large' | 'unavailable' }
>
```

Flow:

1. Capture the request generation (session id + pagination generation +
   selection counter). Only the newest request may commit.
2. Require the index store `ready` and the entry's snapshot; read the anchor
   page with `getTranscriptPage({ atRecordId: turnId, snapshot, limit })`.
3. Materialize the page in an isolated store (existing
   `materializeTranscriptHistory` machinery) and dedup against retained
   blocks by record id, then prompt id.
4. Admit atomically if the window budget admits it; otherwise evict whole
   pages farthest from the target first, and only then refuse with
   `page_too_large`. A failed admission leaves the window unchanged.
5. Record the ledger entry with its snapshot; create or close gaps on both
   sides from `hasOlder` and the frozen-tail relationship; remember
   `targetRecordId` as the pending focus locator.
6. Continuation older uses `beforeRecordId` on the page's `firstRecordId`;
   continuation newer uses the returned `nextCursor` toward the same frozen
   tail. Live events after the snapshot tail remain the SSE stream's job;
   overlap is deduped by record id, then prompt id, never by text.

### Identity and the locator map

- Extend `transcriptBlocksToDaemonMessages` to carry `sourceRecordIds` (and
  the existing `promptId`) through onto the `Message` objects it produces.
  This is the missing link for both the locator map and the rail's canonical
  identity; the wire→event→block path already exists.
- Add a per-session locator derived from the ledger + blocks:
  `turnId → blockId` for blocks whose `sourceRecordIds` intersect the index
  store's known turn ids. When a block lists several source records, the
  locator chooses the id present in the current index — the first array
  element is not assumed to be the turn head.
- Existing presentation `turnId` usages (reducer message ids, e.g.
  `TurnCollapseHead.turnId`, `getTurnIdByDisplayIndex`) are untouched. The
  canonical identity lives in the provider/locator layer only.

### Session lifecycle handling

| Event | Turn-index store | Transcript window |
| ----- | ---------------- | ----------------- |
| Initial load | seed tail page if capable | initial replay = first ledger page + live tail |
| Prompt admitted | append `live:` provisional | tail grows (existing batcher) |
| Prompt terminal | coalesced tail refresh + reconcile | turn blocks stay in tail; ledger page boundary recorded |
| Append-only refresh | adopt new snapshot, keep pages | unchanged |
| Divergent refresh / no overlap | reset to new tail page | unchanged (record-id-keyed content stays valid) |
| Reconnect | independent refetch; dedupe by record/prompt id | existing SSE watermark paths unchanged |
| `session.rewound` | clear pages + provisionals, refetch tail | drop rewound blocks (existing reducer case), drop ledger entries past the rewind point and any gaps beyond |
| Branch | new session id → fresh store | fresh ledger via the existing session-switch reset |
| Eviction | placeholder ticks remain | gaps recorded; re-fetch uses gap locators |
| Daemon offline | cached pages stay readable | retained pages stay readable; jumps report temporary unavailability |

Rewind/branch never re-anchor silently: snapshot-bound failures
(`invalid_transcript_cursor`, `transcript_snapshot_unavailable`,
`invalid_turn_anchor`) after such events are expected invalidation, not a
retryable error storm.

### Capability gating and fallback

- New constant `SESSION_TURN_NAVIGATION_FEATURE = 'session_turn_navigation'`
  in `client/constants/sessions.ts` (same pattern as
  `SESSION_TRANSCRIPT_PAGINATION_FEATURE`, line 15).
- The provider reads it once per session attach. Absent → index store
  `disabled`, anchored open unavailable, and the rail keeps the current
  `messages`-derived entries. No partial enablement: without the capability
  there is no anchored read, so there is no random access to expose.
- `413 transcript_too_large` from any index request → `unsupported` latch +
  diagnostic (no user-facing error; the loaded-turn rail stays functional).
- Index failures never fail session load, prompt streaming, permissions, or
  access to already retained history.

### Migration of existing prepend pagination

Per the parent design, sequential prepend moves onto the window before random
access:

1. Introduce the ledger in degenerate form: the initial load page and every
   prepend become ledger entries; eviction stays prefix-only (today's trim).
   Rendering is unchanged.
2. Add explicit gap tracking: prefix eviction records an `older` gap from the
   trim's `oldestRetainedRecordId` instead of only re-anchoring
   `beforeRecordId`; the 500-block quiet-period reload stays as a guard until
   eviction + re-fetch is proven by measurement.
3. Surface `sourceRecordIds` on messages; build the locator map.
4. Add the turn-index store (seed/refresh/reconcile/evict).
5. Add anchored admission (`openTranscriptAtTurn`) and newer-direction
   continuation.

Steps 1-3 are pure refactor + identity plumbing (no behavior change); 4-5 add
the new surface. Each step is independently shippable.

## Files affected

| Area | Files |
| ---- | ----- |
| Turn-index store | `packages/web-shell/client/daemon/session/turnIndexStore.ts` (new) + `turnIndexStore.test.ts` |
| Page ledger | `packages/web-shell/client/daemon/session/transcriptPageLedger.ts` (new) + tests |
| Provider wiring | `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx` (seed, refresh, reconcile, `openTranscriptAtTurn`, ledger maintenance on admission/trim/reset), `types.ts` (context/state types), `actions.ts` (expose the new action) |
| Identity surface | `packages/web-shell/client/adapters/transcriptToMessages.ts` (carry `sourceRecordIds`/`promptId` onto `Message`), `adapters/messageTypes.ts` (field) |
| Capability gate | `packages/web-shell/client/constants/sessions.ts` (feature constant), `App.tsx` (pass-through, mirroring `session_transcript_pagination` wiring) |
| Tests | `DaemonSessionProvider.test.tsx` (extend `MockDaemonSessionClient` with `getTurnIndexPage` + `targetRecordId`/`hasOlder` fixtures), new store suites |

The SDK, daemon routes, and core reader are unchanged.

## Error and degradation matrix (client view)

| Condition | Store reaction | User-visible result |
| --------- | -------------- | ------------------- |
| capability absent | `disabled` | current loaded-turn rail |
| index fetch fails transiently | `error` + bounded backoff retry | rail placeholders; transcript unaffected |
| 400 `invalid_transcript_cursor` on index | drop snapshot, re-seed tail | rail briefly placeholders |
| 400 `invalid_turn_anchor` on jump | refresh index; keep viewport | jump aborted, current page intact |
| 409 `transcript_snapshot_unavailable` | invalidate snapshot + pages, re-seed | rail refreshes; current page intact |
| 413 `transcript_page_too_large` | reject admission | "turn too large to display" notice; rail entry stays |
| 413 `transcript_too_large` | `unsupported` latch + diagnostic | loaded-turn fallback |
| rewind/branch | full invalidation + refetch | no stale ticks or cross-session pages |
| daemon offline | keep cached pages | retained content readable; jumps report temporary unavailability |

## Performance model and budgets

- Index metadata is ~239 B/turn on the wire (Phase 1 verification on a
  300-turn session); a 200-entry page is tens of KB and pages independently of
  transcript bytes.
- Transcript window budgets build on the existing `maxBlocks` 50,000 / 128 MiB
  store caps; the ledger adds page-granularity eviction so the effective
  resident set becomes a tunable window (starting point per the
  bounded-transcript design: ~100 completed turns / 16 MiB normalized) rather
  than a one-way trim. Defaults are frozen only after a measurement pass; the
  constants stay internal, not API.
- A random jump costs one bounded transcript page of network + normalization.
  Streaming cost stays independent of retained history size (existing batcher
  + structural snapshot gating).
- No IndexedDB or persisted sidecar in this phase.

## Verification plan (Phase 2 scope)

Provider/store unit tests (vitest + jsdom, extending the existing
`MockDaemonSessionClient`):

- turn-index store: seed newest-first, older-page fetch by `start`, snapshot
  pinning, append-only merge, divergent reset, LRU eviction with stable
  `totalTurns`, `413 transcript_too_large` latch;
- page ledger: initial load, prepend parity, anchored admission containing the
  target, older/newer continuation, dedup by record id then prompt id,
  explicit gaps, whole-page eviction that never splits a turn, live-tail
  preservation under historical admission;
- reconciliation: provisional replacement by `promptId`, legacy no-prompt-id
  path by record identity, shell overlay lifetime, no label/timestamp
  matching;
- lifecycle: reconnect dedup, rewind/branch invalidation, stale-response
  rejection by generation, bounded retry;
- fallback: capability-absent and ceiling-exceeded paths keep the existing
  rail behavior.

Real-browser random-jump E2E remains Phase 3 with the rail UI.

## Open questions

1. Window budgets: exact page-count/byte defaults need a measurement pass
   against today's 50,000-block behavior before freezing.
2. Should `openTranscriptAtTurn` pre-fetch the neighboring index page so the
   rail around the target arrives populated (cheap; decide during
   implementation)?
3. Keep or retire the 500-block quiet-period reload once gap-aware eviction +
   re-fetch lands — decide by measurement, not by preference.
4. Does the locator map stay rail-internal, or is it exposed as a read model
   for branch/rewind pickers in this phase?
5. Interior-page eviction commits via `store.reset` over retained pages —
   measure commit cost at the 200-block page size; if visible, consider a
   range-delete store method in the SDK as a follow-up.
