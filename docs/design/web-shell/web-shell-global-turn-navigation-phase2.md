# Web Shell Global Turn Navigation — Phase 2: Bounded Client Data Layer

## Status

Phase 2A implemented in [#11054](https://github.com/QwenLM/qwen-code/pull/11054)
(under review); Phase 2B pending. Original proposal: 2026-09-04. Builds on
`web-shell-global-turn-navigation.md` (Phase 1 merged as #10751) and the
page-table model of `web-shell-bounded-transcript-and-subagent-details.md`.

Tracking issue: #10750. This document covers only the Phase 2 checklist there:
the client-side turn-index store, the reloadable historical transcript window,
identity reconciliation, memory bounds, and capability fallback. Rail
virtualization and jump UX are Phase 3.

**Phase-boundary note.** The parent design's original delivery plan placed the
turn-index store, tail refresh, provisional reconciliation, and the canonical
locator map in its Phase 3. This document follows the #10750 checklist, which
assigns the complete data layer — including those four — to Phase 2 and leaves
Phase 3 as the rail UI. The parent design's delivery plan is updated in the
same PR so the two documents stop contradicting each other.

The [implementation plan](../../plans/2026-09-04-web-shell-global-turn-navigation-phase2.md)
supersedes the proposed API names and migration sequence below. Phase 2A adds
the headless index, isolated historical page table, reconciliation, and hooks;
Phase 2B migrates legacy sequential pagination. The problem analysis below
describes `origin/main` at `80497a74d0`, before Phase 2A.

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

Phase 2A builds the two stores and headless random-read API without changing
the visible transcript. Phase 2B migrates existing sequential pagination;
Phase 3 wires the visible random-jump UI.

## Consumed contract (Phase 1, shipped)

TypeScript SDK daemon surface (all reachable through the session-scoped
`DaemonSessionClient` the provider already holds in `sessionRef`, so
workspace-qualified routing is encapsulated):

- `getTurnIndexPage({ snapshot?, start?, limit? })`
  → `DaemonSessionTurnIndexPage`
  `{ v: 1, sessionId, snapshot, totalTurns, start, turns: DaemonSessionTurnIndexEntry[] }`,
  entry = `{ ordinal, turnId, kind: 'prompt' | 'realtime' | 'scheduled', promptId?, timestamp?, label, detail? }`
  (`sdk-typescript/src/daemon/types.ts:1388-1416`;
  `DaemonSessionClient.ts:988`).
  The first call omits `snapshot` and returns the newest page; `start`
  requires a `snapshot`.
- `getTranscriptPage({ atRecordId, snapshot, limit? })`
  → `DaemonSessionTranscriptPage` with additive `targetRecordId` and
  `hasOlder` (`types.ts:1360-1386`). Anchor combinations are enforced
  server-side (`routes/session.ts:4801-4813`): `beforeRecordId` may be sent
  together with a turn-index `snapshot` (a `snapshot` must accompany an
  explicit record anchor and is rejected on its own), while a `nextCursor`
  continuation must be sent **alone** — the signed cursor already encodes the
  frozen file identity, byte size, leaf, and position
  (`session-transcript-reader.ts:654-672`), and pairing `cursor` with
  `snapshot`, `atRecordId`, or `beforeRecordId` is a 400
  `invalid_transcript_cursor`. An anchored read sends no `direction`, so its
  `hasMore`/`nextCursor` continue **forward** toward the frozen tail
  (`session-transcript-reader.ts:3477-3495`); older continuation uses
  `beforeRecordId` plus the same `snapshot`.
- Capability gate: `capabilities.features.includes('session_turn_navigation')`
  (registered at `packages/cli/src/serve/capabilities.ts:144`).

Error mapping the stores must implement (verified at
`packages/cli/src/serve/server/error-response.ts`; all surface as
`DaemonHttpError { status, body.code }`):

| HTTP | `body.code`                       | Client meaning                                                                                                                           |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_transcript_cursor`       | Missing/conflicting/tampered snapshot, bad `start`                                                                                       |
| 400  | `invalid_turn_anchor`             | `atRecordId` is not a navigation turn in this snapshot                                                                                   |
| 409  | `transcript_snapshot_unavailable` | Frozen transcript replaced/truncated/leaf lost                                                                                           |
| 413  | `transcript_page_too_large`       | Serialized response exceeds the 32 MiB whole-response cap — thrown by **both** the transcript and turn-index routes, not anchor-specific |
| 413  | `transcript_too_large`            | Transcript exceeds the 256 MiB indexing ceiling                                                                                          |

Session-resolution failures (archived, conflict, draining, unavailable owner)
follow the existing transcript-route codes and are already handled by the
provider's session-load error paths.

Footnote on `transcript_page_too_large`: both route families structurally
share the same serialization guard, but an index page can never actually reach
the cap — entries are capped at 500 per page (`SESSION_TRANSCRIPT_MAX_LIMIT`,
`session-transcript-reader.ts:86`) with hard-truncated previews (label ≤ 160 /
detail ≤ 240 code points, `compactPreviewText` at `:1130` / `:1153`), bounding
a page near ~250 KB, two orders of magnitude below 32 MiB. The index store
therefore has no 413 branch of its own; a 413 from an index fetch is treated
as a generic transient index failure.

## Current client state (verified)

- **Store**: transcript state lives in an SDK external store, not a React
  reducer — `createDaemonTranscriptStore`
  (`packages/sdk-typescript/src/daemon/ui/store.ts:24`) over the pure reducer
  `reduceDaemonTranscriptEvents` (`ui/transcript.ts:194`). State:
  `DaemonTranscriptState` (`ui/types.ts:1124-1162`) — flat `blocks[]`,
  block/tool/permission indexes, `maxBlocks`, `retainedBytes`,
  `maxRetainedBytes`. React subscribes via `useSyncExternalStore` contexts in
  `DaemonSessionProvider.tsx` (contexts from line 646; exported hooks from
  line 4686), with a 50 ms render-throttled snapshot wrapper for the heavy
  consumers.
- **Initial load**: `historyPageSize = 200` (`client/constants/sessions.ts:22`
  `WEB_SHELL_HISTORY_PAGE_SIZE`) sent only when
  `session_transcript_pagination` is advertised (send point
  `DaemonSessionProvider.tsx:1751-1756`; capability gate at `:2118-2126`). The
  replay snapshot is materialized in a throwaway store and committed with
  `store.reset(...)` (lines 2289-2340). The pagination anchor follows a
  three-level fallback — the first replayed `session_update` carrying
  `_meta['qwen.session.recordId']`, else `history_truncated.data.recordId`,
  else `activeSession.historyAnchorRecordId` (lines 2105-2116).
- **loadMore**: `loadMoreTranscript` (`DaemonSessionProvider.tsx:4057-4313`)
  requests `getTranscriptPage({ cursor | beforeRecordId, limit })`,
  materializes the page in an isolated store (`materializeTranscriptHistory`,
  line 310) with dedup against displayed `sourceRecordIds`, refuses admission
  when count/byte budgets would be exceeded, and commits via
  `store.reset(applyTranscriptHistory(...))` (line 4230). Stale responses are
  dropped by session identity + `paginationGenerationRef`.
- **Retention**: `DEFAULT_MAX_BLOCKS = 50_000` (provider line 710,
  `WEB_SHELL_MAX_TRANSCRIPT_BLOCKS`), byte budget 128 MiB default from the SDK
  store. `trimTranscriptState` (`transcript.ts:1708-1881`) trims oldest-first
  with record-boundary snapping and tool/permission sentinels; the provider's
  `onTruncation` (lines ~874-1010) re-anchors `beforeRecordId`, drops cursors,
  and bumps the pagination generation. Separately,
  `WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS = 500` + 15 s idle triggers a full
  session reload (`MessageList.tsx:3921-3975`).
- **Live tail**: SSE events flow through a 16 ms batcher into the same store;
  history and live differ only positionally. Detached-viewport behavior
  already exists (scroll-up pauses follow; streaming continues).
- **Identity**: the daemon stamps `_meta.qwenTranscript.sourceRecordIds` /
  `qwen.session.recordId`; the normalizer stamps `sourceRecordIds`
  conditionally in `createBase` (`normalizer.ts:653-658`, via
  `extractSourceRecordIds` at `:1015-1037`) and the reducer carries them onto
  blocks (`ui/types.ts:912`), with merge rules that never join blocks across
  records. `transcriptBlocksToDaemonMessages`
  (`adapters/transcriptToMessages.ts:378`) does **not** copy them onto
  `Message` — and `promptId` is missing from the message layer too (the
  adapters directory has no `promptId` reference at all; both fields exist
  only at block level, `ui/types.ts:912-914`). No block↔record locator map
  exists.
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

- Every fetched page (initial load, prepend) is **already materialized in an
  isolated throwaway store** and admitted atomically.
- The visible store is **already rebuilt by `store.reset`** on each admission,
  and `trimTranscriptState` + `onTruncation` already implement prefix eviction
  with re-anchoring.

The reuse boundary is honest, though: the existing admission machinery is
**prepend-only**. `applyTranscriptHistory` hardcodes
`blocks: [...history.blocks, ...current.blocks]`
(`DaemonSessionProvider.tsx:502`), and `materializeTranscriptHistory`'s dedup
is built around the oldest retained block (`:332-360`) — both assume the new
page is older than everything retained. Anchored opens and newer-direction
continuations land _between_ retained pages or between the newest page and the
live tail, which neither function can express. So the reused machinery is
exactly: isolated-page materialization, atomic budget admission, and prefix
trim + re-anchor. What this phase adds is a new **insert-at-ledger-position
admission variant** for pages that are neither older-than-window nor live.
(Block-id uniqueness is not a concern for mid-window insertion: `nextOrdinal`
is a monotone id counter, not a position, and the throwaway store is seeded
with the current value — `transcript.ts:2075-2076`.)

Phase 2 therefore keeps `DaemonTranscriptStore` as the single flat render
source and adds a provider-owned **page ledger** alongside it:

```ts
interface TranscriptPageLedgerEntry {
  id: string;
  source: 'load' | 'prepend' | 'anchored' | 'continuation';
  firstBlockId: string; // inclusive, within the flat store
  lastBlockId: string; // inclusive
  firstRecordId?: string; // persisted boundaries, when known
  lastRecordId?: string;
  nextCursor?: string; // forward continuation minted by this page's fetch;
  // present only on forward reads with hasMore (load / anchored /
  // forward continuation — never on backward prepends)
  byteSize: number;
  turnIds: readonly string[]; // canonical turn ids present (from sourceRecordIds)
  snapshot?: string; // index snapshot that produced an anchored page
}

interface TranscriptGap {
  /** Direction in which the gap can be resolved. */
  older?: { beforeRecordId: string; snapshot?: string };
  newer?: { cursor: string }; // self-bound, sent alone — see Consumed contract
}
```

The protocol has no "page after record X" operation (`afterRecordId` does not
exist), so a gap's newer side is resolvable three ways:

1. the `nextCursor` stored on the **older** neighboring ledger entry, when
   that entry came from a forward read;
2. re-anchoring — pick a navigation turn inside the gap from the turn-index
   store and issue `atRecordId` with that entry's page snapshot; or
3. when the gap contains **no** navigation turn at all — it lies entirely
   inside one long turn (a prompt followed by more than a page of
   tool/assistant records has no index entries between its endpoints) —
   backfill from the **newer** neighbor instead:
   `beforeRecordId = <that page's firstRecordId>`, sent with that page's
   `snapshot` (a legal combination), walking newest-to-oldest into the gap.

Resolver 2 covers gaps whose older neighbor was evicted (its cursor is
evicted with it) and gaps left by backward-only paging, whose pages never
mint a forward cursor; resolver 3 covers the long-single-turn hole that
resolver 2 cannot address.

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
context at `:655-657`):

```ts
interface SessionTurnIndexState {
  sessionId: string;
  status: 'disabled' | 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  snapshot?: string; // newest snapshot, authority for seed/older fetches
  totalTurns: number;
  pages: ReadonlyMap<number, TurnIndexPageCacheEntry>; // key = page start
  liveEntries: readonly LiveTurnEntry[]; // tail-only provisionals
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
- Older metadata pages are fetched with the store's current snapshot and an
  explicit `start`, keyed by `start`, immutable. **Each page's own `snapshot`
  is the read authority** for re-fetching its ordinals and for anchored
  transcript reads at its entries — an append-only refresh legitimately leaves
  the map holding pages minted by different snapshots, which the protocol
  allows because every read binds to the snapshot that produced its page. The
  store-level `snapshot` is only the newest one, used for seeding and
  older-page requests. The only admission-time snapshot rule constrains the
  current fetch itself: a page returned for a store-snapshot request must
  carry that same snapshot; a refresh's tail page mints the new store
  snapshot, and retained pages keep theirs.
- **Pages never overlap.** The seed page's `start` is server-chosen
  (`max(0, totalTurns - min(limit, totalTurns))`,
  `session-transcript-reader.ts:2565`) — note the inner `min`: any session
  with at most `limit` durable turns is seeded at ordinal 0 immediately — so
  the seed is aligned to no client grid. Older-page requests are issued **only
  when `boundary > 0`**, where `boundary` = the smallest ordinal already
  covered: `boundary == 0` means the oldest turn is retained and no older page
  exists (the clamped `limit = boundary - start` would compute 0, a 400
  `invalid_transcript_limit`), so no request is sent. Otherwise request
  `start = max(0, boundary - limit)` and shrink `limit` to `boundary - start`
  so the returned page butts exactly against the retained pages.
  `ensurePage(ordinal)` is a no-op when the ordinal is already covered;
  otherwise it computes the uncovered interval containing the ordinal and
  requests the largest non-overlapping slice inside it. Ordinals are frozen
  within a snapshot, so the grid is stable until a refresh — and a refresh
  re-validates retained pages by identity before keeping anything.
- Tail refresh on prompt terminal is a **two-step merge**, because a refresh
  deliberately omits `snapshot` and therefore cannot choose its `start` — the
  response always covers the server-computed newest window
  `max(0, totalTurns - limit)`, which partially overlaps the retained tail
  page whenever the appended count is not a multiple of the page size:
  1. **Validate**: fetch the newest page without a snapshot and compare every
     ordinal present in both the response and the retained pages by `turnId`.
     All matching → append-only; any mismatch, or zero overlap after a large
     gap → divergent.
  2. **Land on the grid** (append-only only): compare the largest covered
     ordinal against `totalTurns - 1`:
     - **equal** — the append produced no new navigation turn (only excluded
       record kinds arrived, or two refreshes coalesced): skip this step and
       adopt the new `snapshot`/`totalTurns` without issuing a fill request;
     - **greater** — the store still holds ordinals the chain no longer has
       (a rewind/truncation this client has not processed yet, e.g. another
       client rewound the session): this is divergent by definition, so fall
       through to the divergent branch below. This exit matters because a
       validate request omits the snapshot by design — a truncated tail does
       not fail the request, and without the exit it would be misread as
       append-only, compute a negative `limit` (400
       `invalid_transcript_limit`), and adopt a `totalTurns` smaller than the
       retained coverage;
     - **smaller** — issue a clamped fill request against the new snapshot:
       `start` = one past the largest covered ordinal,
       `limit = totalTurns - start` (never 0: `limit < 1` is rejected with
       400 `invalid_transcript_limit`), iterating in page-sized chunks when
       the uncovered tail exceeds one page — and admit the fill page(s). The
       validation response itself is never admitted, since it overlaps
       retained coverage by construction.
  - **append-only**: adopt the new `snapshot`/`totalTurns`, keep old pages,
    add the fill page(s).
  - **divergent, zero overlap, or shrunk** (retained coverage extends past
    the new `totalTurns`): clear all snapshot-bound pages and admit the
    validation response as the new tail page. Deliberately conservative —
    it cannot retain a page from a rewritten active chain.

  "Pages never overlap" is the stable-state invariant after a merge
  completes; the transient overlap inside a refresh response is forced by the
  protocol and resolved before anything is admitted.

- Reconciliation: a `live:` prompt provisional is removed exactly when an
  index entry appears with the same `promptId`, or (legacy records without a
  prompt id) when its persisted record UUID is observed in admitted blocks'
  `sourceRecordIds`. Unmatched provisionals persist; the next coalesced
  refresh or reconnect retries. Label/timestamp matching is forbidden.
- `shell:` entries are live-only overlays, removed when their live block is
  evicted; they never affect `totalTurns`.
- Eviction bounds the page map by count and bytes (LRU), with the **newest
  page pinned** — it is never evicted, so every tail refresh has overlap to
  validate `turnId`s against, and a zero-overlap refresh then occurs only on
  a genuine large rewrite (or after a snapshot-invalidating event, which has
  its own path below), never merely because a cache hole made the refresh
  unverifiable. Evicting metadata never changes `totalTurns`; an evicted
  range renders as placeholder ticks and refetches on demand (Phase 3 wires
  the fetch trigger to the virtualized viewport; in this phase the store
  exposes `ensurePage(ordinal)`).
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
       | 'page_too_large' | 'window_full' | 'window_impossible'
       | 'unavailable' }
>
```

The three size-related failures are deliberately distinct, mirroring the
existing admission contract:

- `page_too_large` — the **server** refused: 413 `transcript_page_too_large`.
  This code is the daemon's whole-response serialization cap (32 MiB = 2 × the
  16 MiB expanded-page budget, `session.ts:274-277`), shared by both route
  families; on the index path it is unreachable in practice (see the contract
  footnote), so this reason only arises from anchored transcript reads.
- `window_full` — the **client** window rejected the page but eviction can
  plausibly free enough: retryable. Carries over the existing
  `capacityReached` + `rejectedPage` latch semantics
  (`DaemonSessionProvider.tsx:4193-4224`): the rejected page's footprint is
  remembered and the same page is re-offered only once enough capacity exists,
  instead of every trim re-offering a doomed page.
- `window_impossible` — the page alone exceeds the entire window budget
  (the existing `admission.impossible` branch, provider `:410-411`):
  terminal for that turn, surfaced as "turn too large to display". This is the
  branch anchored random jumps are most likely to hit — a single aggregate
  record can exceed any window — so it must stay an explicit, tested outcome.

Flow:

1. Capture the request generation (session id + pagination generation +
   selection counter). Only the newest request may commit.
2. Require the index store `ready` and the entry's snapshot; read the anchor
   page with `getTranscriptPage({ atRecordId: turnId, snapshot, limit })`.
3. Materialize the page in an isolated store (existing
   `materializeTranscriptHistory` machinery) and dedup against retained
   blocks by record id, then prompt id.
4. Admit atomically when the window budget admits the page, evicting whole
   pages farthest from the target first; if eviction can free enough capacity,
   the rejection is the retryable `window_full`; if the page alone exceeds the
   whole window, the terminal `window_impossible`. A failed admission leaves
   the window unchanged.
5. Record the ledger entry with its snapshot; create or close gaps on both
   sides from `hasOlder` and the frozen-tail relationship; remember
   `targetRecordId` as the pending focus locator.
6. Continuation older uses `beforeRecordId` on the page's `firstRecordId`
   (sent with the same `snapshot`); continuation newer uses the returned
   `nextCursor` — sent alone, since the signed cursor already carries its
   frozen binding — toward the same frozen tail. Live events after the
   snapshot tail remain the SSE stream's job; overlap is deduped by record id,
   then prompt id, never by text.

The one deliberate exception to "never by text" already exists in the prepend
path: `materializeTranscriptHistory`'s boundary-echo comparison
(`userBlockBoundaryKey`, provider `:332-360`) covers a locally echoed prompt
whose persisted copy arrives without a shared record id
(`suppressOwnUserEcho`). With this phase's identity plumbing, the local echo
and the persisted copy share the admission-time `promptId`, so prompt-id
matching subsumes that case whenever both sides carry identity; the text
comparison stays only for the capability-off path and legacy records where
either side lacks identity. It is not extended to the new anchored or
continuation paths.

### Identity and the locator map

- Extend `transcriptBlocksToDaemonMessages` to carry **both**
  `sourceRecordIds` and `promptId` onto the `Message` objects it produces —
  neither field reaches the message layer today. This is the missing link for
  both the locator map and the rail's canonical identity; the
  wire→event→block path already exists.
- Add a per-session locator derived from the ledger + blocks:
  `turnId → blockId` for blocks whose `sourceRecordIds` intersect the index
  store's known turn ids. When a block lists several source records, the
  locator chooses the id present in the current index — the first array
  element is not assumed to be the turn head.
- Existing presentation `turnId` usages (reducer message ids, e.g.
  `TurnCollapseHead.turnId`, `getTurnIdByDisplayIndex`) are untouched. The
  canonical identity lives in the provider/locator layer only.

### Session lifecycle handling

| Event                          | Turn-index store                                | Transcript window                                                                                          |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Initial load                   | seed tail page if capable                       | initial replay = first ledger page + live tail                                                             |
| Prompt admitted                | append `live:` provisional                      | tail grows (existing batcher)                                                                              |
| Prompt terminal                | coalesced tail refresh + reconcile              | turn blocks stay in tail; ledger page boundary recorded                                                    |
| Append-only refresh            | adopt new snapshot, keep pages                  | unchanged                                                                                                  |
| Divergent refresh / no overlap | reset to new tail page                          | unchanged (record-id-keyed content stays valid)                                                            |
| Reconnect                      | independent refetch; dedupe by record/prompt id | existing SSE watermark paths unchanged                                                                     |
| `session.rewound`              | clear pages + provisionals, refetch tail        | drop rewound blocks (existing reducer case), drop ledger entries past the rewind point and any gaps beyond |
| Branch                         | new session id → fresh store                    | fresh ledger via the existing session-switch reset                                                         |
| Eviction                       | placeholder ticks remain                        | gaps recorded; re-fetch uses gap locators                                                                  |
| Daemon offline                 | cached pages stay readable                      | retained pages stay readable; jumps report temporary unavailability                                        |

Rewind/branch never re-anchor silently: snapshot-bound failures
(`invalid_transcript_cursor`, `transcript_snapshot_unavailable`,
`invalid_turn_anchor`) after such events are expected invalidation, not a
retryable error storm.

### Capability gating and fallback

- New constant `SESSION_TURN_NAVIGATION_FEATURE = 'session_turn_navigation'`,
  declared in **two** places following the existing split for
  `SESSION_TRANSCRIPT_PAGINATION_FEATURE`: a provider-local constant alongside
  the others at `DaemonSessionProvider.tsx:203-205` (the provider deliberately
  does not import `client/constants/sessions.ts`), and
  `client/constants/sessions.ts` for the App-level wiring (its existing
  consumer pattern, `App.tsx:74`).
- The provider reads it once per session attach. Absent → index store
  `disabled`, anchored open unavailable, and the rail keeps the current
  `messages`-derived entries. No partial enablement: without the capability
  there is no anchored read, so there is no random access to expose.
- `413 transcript_too_large` from any index request → `unsupported` latch +
  diagnostic (no user-facing error; the loaded-turn rail stays functional).
- Index failures never fail session load, prompt streaming, permissions, or
  access to already retained history.

### Migration of existing prepend pagination

The original proposal below put sequential migration before the headless
random-access API. It is retained as design history, not the delivery order:
the parent design and implementation plan now place headless reads in Phase
2A, sequential compatibility in Phase 2B, and visible random access in Phase 3.

1. Introduce the ledger in degenerate form: the initial load page and every
   prepend become ledger entries; eviction stays prefix-only (today's trim).
   Rendering is unchanged.
2. Add explicit gap tracking: prefix eviction records an `older` gap from the
   trim's `oldestRetainedRecordId` instead of only re-anchoring
   `beforeRecordId`; the 500-block quiet-period reload stays as a guard until
   eviction + re-fetch is proven by measurement.
3. Surface `sourceRecordIds` and `promptId` on messages; build the locator
   map.
4. Add the turn-index store (seed/refresh/reconcile/evict).
5. Add anchored admission (`openTranscriptAtTurn`) and newer-direction
   continuation.

Steps 1-3 are pure refactor + identity plumbing (no behavior change); 4-5 add
the new surface. Each step is independently shippable.

## Files affected

| Area             | Files                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn-index store | `packages/web-shell/client/daemon/session/turnIndexStore.ts` (new) + `turnIndexStore.test.ts`                                                                                                                                               |
| Page ledger      | `packages/web-shell/client/daemon/session/transcriptPageLedger.ts` (new) + tests                                                                                                                                                            |
| Provider wiring  | `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx` (seed, refresh, reconcile, `openTranscriptAtTurn`, ledger maintenance on admission/trim/reset), `types.ts` (context/state types), `actions.ts` (expose the new action) |
| Identity surface | `packages/web-shell/client/adapters/transcriptToMessages.ts` (carry `sourceRecordIds` and `promptId` onto `Message`), `adapters/messageTypes.ts` (both fields)                                                                              |
| Capability gate  | `DaemonSessionProvider.tsx` (provider-local constant), `packages/web-shell/client/constants/sessions.ts` (App-facing constant), `App.tsx` (pass-through, mirroring `session_transcript_pagination` wiring)                                  |
| Tests            | `DaemonSessionProvider.test.tsx` (extend `MockDaemonSessionClient` with `getTurnIndexPage` + `targetRecordId`/`hasOlder` fixtures), new store suites                                                                                        |

The SDK, daemon routes, and core reader are unchanged.

## Error and degradation matrix (client view)

| Condition                                                           | Store reaction                                                    | User-visible result                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| capability absent                                                   | `disabled`                                                        | current loaded-turn rail                                         |
| index fetch fails transiently                                       | `error` + bounded backoff retry                                   | rail placeholders; transcript unaffected                         |
| 400 `invalid_transcript_cursor` on index                            | drop snapshot, re-seed tail                                       | rail briefly placeholders                                        |
| 400 `invalid_turn_anchor` on jump                                   | refresh index; keep viewport                                      | jump aborted, current page intact                                |
| 409 `transcript_snapshot_unavailable`                               | invalidate snapshot + pages, re-seed                              | rail refreshes; current page intact                              |
| 413 `transcript_page_too_large` on an **anchored transcript** fetch | reject the jump with `page_too_large`                             | "turn too large to display" notice; rail entry stays             |
| client window rejects after eviction                                | `window_full` (retryable latch) or `window_impossible` (terminal) | retry when capacity frees / explicit notice                      |
| 413 `transcript_too_large`                                          | `unsupported` latch + diagnostic                                  | loaded-turn fallback                                             |
| rewind/branch                                                       | full invalidation + refetch                                       | no stale ticks or cross-session pages                            |
| daemon offline                                                      | keep cached pages                                                 | retained content readable; jumps report temporary unavailability |

## Performance model and budgets

- Index metadata is ~239 B/turn on the wire — measured in the Phase 1
  maintainer verification on #10751 (300 real turns, a `limit=500` page
  serialized to ~72 KB; treat as an order-of-magnitude figure, not a
  guarantee). A 200-entry page is tens of KB and pages independently of
  transcript bytes.
- Transcript window budgets build on the existing `maxBlocks` 50,000 / 128 MiB
  store caps; the ledger adds page-granularity eviction so the effective
  resident set becomes a tunable window (starting point per the
  bounded-transcript design: ~100 completed turns / 16 MiB normalized) rather
  than a one-way trim. Defaults are frozen only after a measurement pass; the
  constants stay internal, not API.
- A random jump costs one bounded transcript page of network + normalization.
  Streaming cost stays independent of retained history size (the existing
  batcher and the structural snapshot gating).
- No IndexedDB or persisted sidecar in this phase.

## Verification plan (Phase 2 scope)

Provider/store unit tests (vitest + jsdom, extending the existing
`MockDaemonSessionClient`):

- turn-index store: seed newest-first; older-page fetch by `start` with the
  non-overlap clamp (shrunk `limit` butting exactly against covered ordinals)
  and the `boundary == 0` no-request guard;
  `ensurePage(ordinal)` computing the largest non-overlapping slice of an
  uncovered interval and no-op'ing when the ordinal is covered; snapshot
  pinning; the two-step tail merge — validation
  response never admitted, clamped fill lands on the grid, the
  `largest covered == totalTurns - 1` skip path, the `>` path routing to
  divergent, chunked fill when the uncovered tail exceeds one page;
  divergent/zero-overlap reset; LRU eviction with stable `totalTurns` plus
  the newest-page pin (a refresh after deep-history eviction still has
  overlap to validate against); `413 transcript_too_large` latch;
- page ledger: initial load, prepend parity, anchored admission containing
  the target, older continuation (`beforeRecordId` + `snapshot`) and newer
  continuation (`nextCursor` alone), the three gap resolvers — older
  neighbor's stored `nextCursor`, `atRecordId` re-anchor after the cursor was
  lost to eviction, and newer-neighbor `beforeRecordId` backfill for a gap
  lying entirely inside one long turn — dedup by record id then prompt id,
  explicit gaps, whole-page eviction that never splits a turn, live-tail
  preservation under historical admission;
- admission sizing: `page_too_large` (server 413), retryable `window_full`
  (rejected-page footprint remembered, re-offered only once capacity
  suffices), terminal `window_impossible`;
- reconciliation: provisional replacement by `promptId`, legacy no-prompt-id
  path by record identity, shell overlay lifetime, no label/timestamp
  matching;
- identity plumbing: the message adapter surfaces both `sourceRecordIds` and
  `promptId` onto messages (neither exists there today);
- lifecycle: reconnect dedup, rewind/branch invalidation,
  `transcript_snapshot_unavailable` (409) invalidation followed by explicit
  re-seed (the stale-snapshot recovery the #10750 checklist calls out),
  stale-response rejection by generation, bounded retry;
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
