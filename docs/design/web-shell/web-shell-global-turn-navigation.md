# Web Shell Global Turn Navigation

## Status

Accepted; Phase 1 implemented, Phases 2–3 proposed, 2026-09-02.

This design complements
`web-shell-bounded-transcript-and-subagent-details.md`. That document defines
the page-based transcript window and explicit gaps needed to keep long sessions
bounded. This document defines the sparse, session-wide navigation index and
the random-access transcript read needed for a Codex-style turn rail.

## Decision

Web Shell can provide a rail for every durable turn without loading every turn's
transcript into the browser. The implementation must separate two concerns:

1. a lightweight index for every navigable turn in one frozen active-chain
   snapshot; and
2. a bounded transcript window that can be loaded at a selected persisted turn.

Increasing `historyPageSize`, repeatedly calling `loadMore`, or deriving the
rail from the current `messages` array is not the solution. Those approaches
make navigation completeness depend on transcript memory and eventually hit
the existing block and byte budgets.

The durable turn identity is the UUID of the persisted user record that starts
the navigable item. A prompt ID is only a live correlation key. A Web Shell
block ID and an array index are never protocol locators.

## Current state and the actual gap

The compact rail introduced in `MessageList` is already a useful presentation
component, but its data source is local:

- `getSessionTimelineEntries(messages)` starts a timeline entry for each loaded
  `user` or `user_shell` message;
- the entry ID is the current client message/block ID;
- initial Web Shell restore requests 200 transcript records, not 200 complete
  turns;
- older records are only prepended when the user scrolls near the top;
- the provider retains at most 50,000 blocks and also enforces a byte budget;
- the rail therefore represents loaded messages, not the complete persisted
  session.

The daemon transcript API is also sequential. `cursor` walks one frozen
snapshot, and `beforeRecordId` starts a backward walk before a known record.
There is no request that asks for a page containing a selected turn. The core
reader already builds a frozen active-chain index containing record UUIDs,
types, subtypes, byte segments, and turn hints, so the missing server primitive
is small compared with building a second transcript database.

The existing client transcript store is a prependable block array rather than
a true reloadable window. Random access must land with the page-table/live-tail
work from the bounded-transcript design; resetting that single array on every
jump would either discard live state or merge unrelated ranges as if they were
contiguous.

## Goals

1. Show the logical position and count of every durable navigable turn after a
   bounded initial load.
2. Jump to an unloaded turn without downloading all intervening transcript
   records.
3. Keep browser transcript and navigation memory bounded as the session grows.
4. Preserve the live tail while the reader is inspecting old history.
5. Use identities that survive prepend, eviction, reconnect, replay, and
   process restart.
6. Keep active-chain, workspace ownership, trust, archive, and snapshot failure
   semantics identical to the existing transcript routes.
7. Degrade to the current loaded-turn rail when the daemon does not advertise
   the new contract.

## Non-goals

- Loading or retaining every transcript block in the browser.
- Searching arbitrary transcript text. Search can later use the same record
  locator, but is a separate feature.
- Changing the model-facing conversation or transcript persistence format.
- Making abandoned branches appear in the current session rail. The rail
  describes the selected active chain; branch sessions remain separate.
- Persisting daemon `user_shell_command` events in the first delivery. Those
  events are currently injected into model history but are not durable
  transcript records.
- Exposing private thinking, tool arguments, tool output, or raw persisted
  records in index previews.
- Removing the current 256 MiB source-snapshot indexing limit. Sessions beyond
  that pre-existing reader limit fall back to loaded-turn navigation until the
  transcript reader gains a disk-backed or incremental index.

## Terminology and turn classification

The UI rail is a navigation list, not a claim that every item increments the
model's internal turn counter. Version 1 contains these durable item kinds:

| Kind        | Persisted record                                    | Rail behavior |
| ----------- | --------------------------------------------------- | ------------- |
| `prompt`    | ordinary visible user record                        | turn head     |
| `realtime`  | visible user record with subtype `realtime_message` | turn head     |
| `scheduled` | visible user record with subtype `cron`             | clock marker  |

The classifier excludes `goal_runtime`, `notification`, and
`mid_turn_user_message`. They remain content inside their owning turn and do
not create extra rail entries. Empty records with no visible text or attachment
also do not create entries.

`user_shell` remains a live-only overlay item. It is shown and clickable while
its block is retained, but it is not counted in the durable index and is not
promised after reload. If historical shell navigation becomes a requirement,
the daemon must first persist a dedicated display record; inferring it from
model history would not provide a stable record locator.

This dedicated navigation classifier must not reuse
`SessionTurnRecordHint.countsAsUserPrompt` or `isReplayTurnStartType`:

- the runtime turn counter and the UI navigation list have different treatment
  of cron and realtime records; and
- replay page boundaries are chosen for tool-pair correctness, not UI meaning.

## Architecture

```text
persisted JSONL active chain
          |
          v
SessionTranscriptReader cached index
   |                         |
   | sparse turn pages       | bounded records at one turn UUID
   v                         v
turn-index route       transcript route + atRecordId
   |                         |
   v                         v
virtual turn rail      immutable historical page(s)
          \               /
           \             /
            Web Shell live tail  <--- SSE remains connected
```

The turn index and transcript body are intentionally different payloads. The
rail needs count, stable IDs, short labels, and positions. The body needs rich
events only for the current bounded window.

## Identity invariants

### Canonical durable identity

`turnId` is the UUID of the active-chain user record represented by the rail
entry. It is also a valid persisted record locator.

This identity is stable across page boundaries and browser sessions. It is
already propagated to replayed UI events as `sourceRecordIds`, so a materialized
user block can be associated with its canonical turn without changing the
block reducer's allocation order.

### Snapshot-local position

`ordinal` is zero-based within one frozen active-chain snapshot. It is used for
rail order, virtual layout, and accessibility, but never as the mutation or
random-read locator. A rewind or branch may assign different content to the
same ordinal.

### Live provisional identity

Before persistence is visible to the turn index, Web Shell may create
`live:<promptId>` for an admitted prompt or `shell:<eventId>` for a live shell
command. A subsequent tail-index refresh replaces a prompt provisional entry
with its canonical `turnId` by exact `promptId` or `sourceRecordIds` match.
Labels and timestamps are not identity and must not be used for reconciliation.

Released legacy records may lack a prompt ID. They are still fully navigable by
record UUID after they appear in the persisted index.

Web Shell already uses the name `turnId` for several presentation groupings
whose value is a reducer-allocated message ID. Version 1 must not silently
replace all of those downstream IDs. Keep a separate canonical navigation
identity in the provider/locator layer and migrate an individual consumer only
when its contract requires persistence. When a block lists several
`sourceRecordIds`, the locator chooses the ID present in the current navigation
index rather than assuming the first array element is the turn head.

## Core sparse index

Extend the existing `TranscriptIndex` with a compact array built after
`replayUuids` is resolved:

```ts
interface TranscriptNavigationTurn {
  turnId: string;
  replayPosition: number;
  kind: 'prompt' | 'realtime' | 'scheduled';
  promptId?: string;
  finalAssistantRecordId?: string;
}
```

The build already scans every record and resolves the active UUID chain. Add a
small navigation hint to each UUID entry while parsing, then make one linear
pass over `replayUuids` to produce `navigationTurns`. While walking a turn, keep
only the last assistant record that could provide a public response preview.
Associate a valid following `turn_result` record's bounded `promptId` with the
current navigation item; this supplies exact live reconciliation for ordinary
and cron turns without changing user-record persistence. An in-progress or
legacy turn may still have no prompt ID. Include the new array and hints in the
existing cache byte accounting.

Do not retain prompt or answer strings in the global index. Reading a turn-index
page opens only the selected user records and their selected assistant preview
records through the existing aggregated-record reader. That keeps cached index
memory proportional to record/turn identities rather than transcript text.

Preview projection is a core concern because both the live-owner ACP path and
the workspace-qualified direct-reader path need identical output. The
projection must:

- reuse `projectUserTranscriptForDisplay` for user-visible prompt content;
- prefer cron `systemPayload.displayText` for scheduled labels;
- strip generated attachment tokens and control-only context;
- emit a generic label for attachment-only turns;
- select only public assistant text for `detail`;
- never include thought parts, tool calls, tool arguments, tool results, raw
  payloads, or debug metadata; and
- enforce server-side code-point and serialized-response limits.

If the selected final assistant record has no public text, `detail` is omitted.
The client can still show the turn label and kind.

## Turn-index protocol

Advertise one atomic capability, `session_turn_navigation`. Web Shell enables
the global rail only when that capability guarantees both the turn-index route
and anchored transcript reads.

Add matching owner-resolved and workspace-qualified routes:

```text
GET /session/:id/turn-index
GET /workspaces/:workspace/session/:id/turn-index
```

The first request omits `snapshot` and captures the latest readable active-chain
snapshot. It defaults to the newest metadata page. Later requests provide the
returned `snapshot` and an ordinal `start`:

```text
GET /session/:id/turn-index?limit=200
GET /session/:id/turn-index?snapshot=<opaque>&start=0&limit=200
```

`limit` uses the existing transcript range: default 100 and maximum 500.
`start` is rejected without `snapshot`; this prevents ordinal reads from racing
with appends. An empty session returns `totalTurns: 0` rather than a fabricated
entry.

```ts
interface DaemonSessionTurnIndexEntry {
  ordinal: number;
  turnId: string;
  kind: 'prompt' | 'realtime' | 'scheduled';
  promptId?: string;
  timestamp?: string;
  label: string;
  detail?: string;
}

interface DaemonSessionTurnIndexPage {
  v: 1;
  sessionId: string;
  snapshot: string;
  totalTurns: number;
  start: number;
  turns: DaemonSessionTurnIndexEntry[];
  startTime?: string;
  lastUpdated?: string;
}
```

The opaque snapshot is HMAC-signed and workspace-bound using the transcript
cursor signing key. It freezes file identity, snapshot byte length, active
leaf, and timestamp in the same way as a transcript cursor, but has its own
versioned payload kind. It never exposes a file path. A later append does not
invalidate it. Replacement, truncation, or failure to reproduce the frozen leaf
from the frozen byte prefix does. A later rewind/branch event may cause the
client to discard the old snapshot even when its immutable prefix remains
technically readable.

The page always preserves exact ordinal positions. If projection of an already
indexed navigation record cannot produce a preview, that record receives a
generic bounded label rather than being removed after the count is published.
This prevents a page from shifting every following ordinal. Invalid records
that never entered the active-chain index follow the reader's existing gap and
diagnostic semantics.

## Anchored transcript protocol

Extend both transcript routes and the core reader with an inclusive persisted
record anchor:

```text
GET /session/:id/transcript
    ?atRecordId=<turnId>
    &snapshot=<turn-index-snapshot>
    &limit=200
```

`cursor` is a continuation and remains mutually exclusive with every explicit
anchor. `atRecordId` and `beforeRecordId` are mutually exclusive with each
other. The turn-index `snapshot` is required with `atRecordId` and is also
accepted with `beforeRecordId`; a subsequent forward continuation uses the
returned transcript cursor. A backward neighbor page may therefore use
`beforeRecordId=<firstRecordId>&snapshot=<same-snapshot>`.

The new response fields are additive:

```ts
interface DaemonSessionTranscriptPage {
  // existing v1 fields
  targetRecordId?: string;
  hasOlder?: boolean;
}
```

For an anchored request, the reader verifies that `atRecordId` belongs to the
frozen `replayUuids` chain and is a navigation entry in that snapshot. The page
contains the target and returns chronological replay events. It begins at the
nearest safe replay boundary at or before the target when that boundary fits
the existing bounded record and byte expansion rules; otherwise it keeps the
bounded selection, as backward paging already does for very long turns and
tool-result runs. `targetRecordId` tells the client which rendered user block to
focus even when the selected page begins earlier.

The forward cursor continues toward the frozen snapshot tail. The Web Shell's
separate SSE live tail covers events after that snapshot. Duplicate replay/live
content is removed by persisted source record ID and then prompt ID, never by
text.

## Route ownership and trust

These are session-scoped persisted-transcript reads, not process-global routes.
They must copy the resolution behavior of the current transcript endpoints:

- `/session/:id/...` resolves the unambiguous live owner or persisted owner;
- `/workspaces/:workspace/session/:id/...` remains inside the selected runtime
  and its runtime storage;
- active, archived, unknown, draining, removed, ambiguous, and generation
  changes keep their existing declared failures;
- an unresolved secondary workspace never falls back to the primary runtime;
- archive coordination and runtime-generation assertions wrap each read; and
- labels/details use the same trust-aware SDK surface policy as transcript
  replay.

The live-owner path adds an ACP status extension that calls the core reader in
the owning process. The workspace-qualified path may use the reader directly,
as the existing workspace transcript route does. Both return the same SDK
types and error codes.

## SDK and client state

Add turn-index request/response types and methods to the TypeScript SDK and
daemon session client. The React provider owns two independent stores:

```ts
interface SessionTurnIndexState {
  sessionId: string;
  snapshot?: string;
  totalTurns: number;
  pages: ReadonlyMap<number, TurnIndexPageCacheEntry>;
  liveEntries: readonly LiveTurnEntry[];
  status: 'idle' | 'loading' | 'ready' | 'error';
}

interface TurnIndexPageCacheEntry {
  snapshot: string;
  turns: readonly DaemonSessionTurnIndexEntry[];
}

interface MainTranscriptWindow {
  pages: readonly MainTranscriptPage[];
  liveTail: LiveTranscriptPage;
  olderBoundary?: TranscriptBoundary;
  newerBoundary?: TranscriptBoundary;
  viewportAnchor?: ScrollAnchor;
}
```

Turn-index pages are keyed by their returned `start` and retain the snapshot
that produced them. They are small, immutable, and bounded by an LRU page
count/byte budget. Evicting metadata does not change `totalTurns`; the rail
displays a placeholder tick until that page is requested again. An append-only
refresh may retain an older prefix page because its snapshot remains readable
after append; selection uses that page's snapshot, not whichever snapshot is
newest. Overlapping stale tail pages are replaced or evicted after a refresh so
one append does not leave one extra cached range forever.

The main transcript window follows the bounded-transcript design:

- historical pages are immutable;
- the live tail alone accepts streaming updates;
- gaps are explicit;
- the target page, viewport page, active turn, and live tail are pinned; and
- completed off-screen pages are evictable.

The global rail must not be connected directly to the transcript block array.
For a loaded turn, a locator map associates canonical `turnId` with the current
rendered block by intersecting `sourceRecordIds`. The existing locally derived
label/detail may override the sparse server preview while that turn is loaded,
but it cannot add or remove durable ordinals.

## Rail rendering

The rail uses `effectiveTurnCount` as the virtualizer count and reuses the
existing fixed tick stride. Only visible ticks plus overscan are mounted. A
large spacer represents the complete logical height, so 10,000 turns do not
create 10,000 buttons or message objects.

While new activity is not yet represented by the frozen index, the effective
rail count is
`effectiveTurnCount = totalTurns + liveEntries.length`. Live entries occupy
tail positions only. Replacing a provisional prompt with its canonical indexed
entry increments `totalTurns` and removes that provisional in the same provider
commit, so the logical count and selected position do not jump. A live-only
shell item is removed if its corresponding live block is evicted.

When the visible virtual range enters an uncached index page, the provider
fetches that page. The initial tail page is requested alongside session load,
so the newest labels normally exist before the user interacts with the rail.
Metadata failure leaves placeholder ticks and a retry path; it does not block
the transcript.

Accessibility attributes describe the logical collection, not the mounted
subset:

- `aria-setsize=effectiveTurnCount`;
- `aria-posinset=ordinal + 1`;
- Home/End select the first/latest turn;
- arrow and page keys move by ordinal and fetch metadata as needed; and
- placeholder labels announce “Turn N, details loading”.

The current responsive constraints remain: the rail may hide on narrow,
split-pane, or reduced-layout surfaces. Completeness refers to the underlying
index, not a requirement to show the rail in every layout.

## Selection flow

Selecting a rail entry follows one state machine:

1. Capture the request generation. If the selected ordinal is a placeholder,
   fetch its metadata page and then continue only if the generation still
   matches.
2. Resolve the canonical entry. A provisional live entry always uses its local
   loaded-block locator and never issues a persisted anchor request.
3. If its `turnId` is in the loaded locator map, scroll to that block and flash
   it using the existing locate behavior.
4. Otherwise, request a transcript page with `atRecordId=turnId` and the entry's
   index snapshot.
5. Normalize the page in an isolated transcript store, then admit it as an
   immutable historical page only if the full page fits the configured budget.
6. Build the locator from `sourceRecordIds`, make the target page the historical
   viewport, and scroll to `targetRecordId` after virtual row measurement.
7. Keep SSE connected. New events continue into `liveTail`, but the viewport
   does not auto-follow while detached.
8. Show the existing “jump to latest” affordance to return to the live tail.

Only the newest selection request may commit. Session change, snapshot reset,
rewind, branch, or a later click invalidates an in-flight result. A failed jump
leaves the currently visible page unchanged and exposes retry.

If an anchored page alone exceeds the entire client window, return the existing
page-too-large failure instead of partially committing it. The turn remains in
the rail, with an explicit “turn too large to display in this view” error.

## Live append, reconnect, rewind, and branch

### Live append

An admitted live prompt immediately adds one provisional rail entry. When the
prompt reaches a terminal state, the provider requests the newest turn-index
page without a snapshot.

To merge the new snapshot, compare every ordinal present in both the old and
new tail pages:

- if all overlapping `turnId` values match, the change is append-only; retain
  old metadata pages and add the new tail;
- if any overlapping identity differs, or there is no overlap after a large
  reconnect gap, clear snapshot-bound pages and keep only the new tail page.

The conservative no-overlap reset is intentionally simple. It costs metadata
refetches but cannot preserve a page from the wrong active chain.

Canonical entries replace provisional prompt entries by exact prompt ID or
record ID. If the terminal event wins a race with transcript persistence, the
unmatched provisional stays visible and the next coalesced tail refresh or
reconnect retries reconciliation; the client does not delete it or guess by
text. An in-progress shell entry stays live-only.

### Reconnect

The existing load response and SSE watermark remain authoritative for body
replay. The turn index is fetched independently and may observe a slightly
newer persisted snapshot. Stable source record IDs and prompt IDs deduplicate
that overlap. Missing, not-yet-persisted live turns remain in the overlay.

### Rewind and branch

`session.rewound` and any active-chain replacement clear turn-index pages,
historical transcript pages, locators, and provisional aliases before fetching
the new tail snapshot. A branch opens a different session ID and therefore a
different index store. Snapshot-unavailable errors never re-anchor silently to
the primary runtime or to a new active leaf.

## Error contract and degradation

| Condition                                         | Result                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| capability absent                                 | current loaded-turn rail                                                   |
| index request temporarily fails                   | transcript usable; placeholder/loaded-only rail with retry                 |
| invalid or tampered snapshot                      | `invalid_transcript_cursor` family; no state commit                        |
| snapshot replaced, truncated, or frozen leaf lost | `transcript_snapshot_unavailable`; refresh index explicitly                |
| rewind or branch event                            | invalidate client snapshot/pages and fetch the selected session explicitly |
| turn UUID not on frozen active chain              | `invalid_turn_anchor`; refresh index, keep current viewport                |
| selected page exceeds response/client budget      | `transcript_page_too_large`; keep rail entry and current viewport          |
| transcript exceeds current 256 MiB index ceiling  | loaded-turn fallback plus diagnostic                                       |
| daemon offline                                    | cached rail/pages readable; unloaded jump reports temporary unavailability |
| unprojectable indexed item or history gap         | generic metadata label; active-chain gap remains explicit in body window   |

The index endpoint is supplementary. Failure must never fail session load,
prompt streaming, permissions, or access to already retained history.

## Security and data handling

- Treat labels and details as untrusted transcript data, never instructions.
- Sign and workspace-bind snapshot tokens; validate session ID, start, limit,
  and record-ID lengths before reading.
- Cap every preview field and the complete serialized response.
- Do not expose filesystem paths, raw records, tool payloads, environment
  values, private thought, or attachment bytes.
- Apply the existing trusted/untrusted workspace projection consistently on
  both route variants.
- Keep `Cache-Control: no-store` on transcript and turn-index responses.
- Record route latency, index cache state, selected-record count, response
  bytes, jump result, and reset reason without recording label/detail content.

## Performance model and budgets

The intended costs are:

- first snapshot on a cache miss: existing `O(records)` index build;
- index page: `O(page turns)` selected record reads plus bounded projection;
- initial browser state: `O(initial transcript page + index metadata page)`;
- rail DOM: `O(visible ticks + overscan)`;
- random jump: `O(one bounded transcript page)` network and normalization;
- streaming: independent of historical transcript pages.

Use the existing transcript limits initially: 100 default and 500 maximum
records/entries per request, plus existing page response caps. Start Web Shell
with a 200-entry turn-index page to match its 200-record history request, but
measure and tune them independently.

The index cache already has entry, byte, and TTL limits. New navigation hints
and arrays participate in that accounting. Do not add IndexedDB or a persisted
sidecar in version 1. If production measurements show repeated cold scans or
supported sessions approaching the 256 MiB reader ceiling, design a writer-
maintained sparse sidecar as a separate change with crash/rewrite validation.

## Delivery plan

### Phase 1: core and protocol

1. Add and test the navigation classifier, preview projection, sparse turn
   array, and index-page reader.
2. Add snapshot-bound `atRecordId` reading and its bounded selection tests.
3. Add ACP bridge, owner-aware daemon routes, SDK types/methods, validation,
   redaction, response caps, and `session_turn_navigation` capability.

Do not advertise the capability until both index and anchor operations work in
the live-owner and workspace-qualified paths.

### Phase 2: bounded client window

1. Land the immutable historical page table and separate live tail described
   by the bounded-transcript design.
2. Add bidirectional boundaries, deduplication by record ID, page admission,
   eviction, and detached-live behavior.
3. Migrate existing sequential prepend pagination to that window before adding
   random jump.

### Phase 3: global rail

1. Add the turn-index store, tail refresh, provisional reconciliation, and
   canonical locator map.
2. Virtualize `SessionTimeline` by total ordinal count.
3. Add loaded and unloaded selection paths, retry, placeholders, keyboard
   navigation, and jump-to-latest integration.
4. Keep the old `getSessionTimelineEntries(messages)` path as the capability
   fallback.

## Implementation map

| Layer                      | Primary areas                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Core index and anchor read | `packages/core/src/services/session-transcript-reader.ts` plus collocated tests and a small navigation projection helper if needed |
| ACP owner process          | `packages/cli/src/acp-integration/acpAgent.ts`, history page conversion, ACP status method types/tests                             |
| Daemon bridge and routing  | `packages/acp-bridge/src/bridgeTypes.ts`, `bridge.ts`, `packages/cli/src/serve/routes/session.ts`, capabilities, route tests       |
| Public SDK                 | daemon types, `DaemonClient`, `DaemonSessionClient`, exports, and contract tests in `packages/sdk-typescript`                      |
| React session state        | `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx` and provider tests                                            |
| Rail and locators          | `packages/web-shell/client/components/MessageList.tsx`, its styles, translations, and component tests                              |

This is necessarily a cross-package feature. Each added request field and
response field must have an enumerated producer and consumer, and both daemon
route variants must be reviewed against the exact runtime/storage ownership
rules before the capability is advertised.

## Verification plan

### Core reader

- Classify ordinary, realtime, cron, notification, goal-runtime, mid-turn, text,
  attachment-only, and empty user records exactly as declared.
- Preserve stable ordinals across metadata pages in one snapshot.
- Read labels/details only from selected user/assistant records.
- Exclude private thought and tool payloads from previews.
- Accept a frozen snapshot after append and reject replacement, shrink, leaf
  rewrite, wrong session, and HMAC tampering.
- Locate the first, middle, and last turn by UUID.
- Keep a huge single turn and tool-result run within existing record/byte
  expansion bounds.
- Cover legacy records without prompt IDs and fragmented records.

### ACP, daemon, and SDK

- Return identical index/anchor results through the live-owner and direct
  workspace reader paths.
- Fail closed for ambiguous owners, wrong workspace, archived/active conflict,
  draining runtime, generation change, and unavailable snapshot.
- Prove a secondary workspace request never reads primary runtime storage.
- Enforce capability, query limits, snapshot size, record-ID length, trust
  projection, and response byte caps.
- Round-trip every new SDK field without exposing raw metadata.

### Web Shell state

- Render `totalTurns` ticks when only the latest body page is loaded.
- Mount only the virtual visible/overscan tick range for thousands of turns.
- Fetch and evict metadata pages without changing ordinals or current
  selection.
- Scroll immediately for a loaded turn and issue exactly one anchored request
  for an unloaded turn.
- Preserve the live tail and stop auto-follow during historical inspection.
- Deduplicate overlap by source record ID and reconcile provisional entries by
  prompt ID.
- Ignore stale index/jump responses after session change or a later click.
- Reset safely on rewind/divergent tail and retain pages on append-only refresh.
- Preserve the current loaded-only behavior against an older daemon.

### End-to-end scenarios

1. Create a session whose transcript contains far more than the initial 200
   records; load it and verify the rail count before scrolling history.
2. Select the oldest, a middle, and the newest unloaded turn; verify the exact
   user record, body context, and highlighted rail position.
3. Start a prompt, jump to old history while it streams, and verify output
   continues without moving the viewport; jump back to latest afterward.
4. Include scheduled cron entries, realtime input, background notifications,
   and a live shell command; verify only the declared entries affect durable
   count.
5. Reconnect during a turn, then rewind and branch; verify no duplicate ticks or
   wrong-session pages.
6. Exercise index/page capacity, daemon restart, unavailable snapshot, corrupt
   history, and an oversized turn; verify existing readable state is retained.

Performance fixtures should cover at least 1,000, 10,000, and 50,000 navigation
entries and record initial payload bytes, index cache hit/miss latency, browser
heap, mounted rail nodes, jump latency, and streaming commit time.

## Rejected alternatives

### Increase initial history page size

Rejected. Transcript records are not turns, payload and normalization grow with
history, and the browser still eventually reaches its block/byte caps.

### Automatically load all older pages after session load

Rejected. It recreates full-history memory and startup cost through multiple
requests and still cannot guarantee completion under retention limits.

### Build the rail from current messages

Retained only as compatibility fallback. Message/block IDs are local reducer
identities, and unloaded or evicted turns are absent by definition.

### Use prompt ID as `turnId`

Rejected. Prompt IDs are useful live correlation keys but are optional on
legacy and special persisted records. The persisted record UUID is already the
authoritative active-chain locator.

### Use ordinal as the random-read locator

Rejected. Ordinals shift when the active chain is rewritten and are unsafe
across snapshot refreshes. They are layout positions only.

### Reset the single transcript array to the selected page

Rejected. It loses or conflates the live tail, breaks sequential boundaries,
and makes SSE reconciliation dependent on display state. Explicit historical
pages plus a separate live tail are required.

### Return every turn label in the first response

Rejected. It couples initial payload and browser memory to session length. A
total count plus virtual ticks and bounded metadata pages gives complete
navigation without complete metadata residency.

### Add a persisted sidecar immediately

Deferred. The existing core reader already builds and caches the offsets needed
for the supported snapshot range. A sidecar adds writer consistency, crash
recovery, branch rewrite, migration, and cleanup obligations before measurements
show they are necessary.

## Final invariants

1. Rail completeness never depends on how many transcript blocks Web Shell has
   loaded.
2. Transcript memory never grows merely because the rail covers more turns.
3. A selected durable turn is addressed by its persisted record UUID.
4. Historical inspection never stops or overwrites the live SSE tail.
5. Snapshot or runtime ambiguity fails closed and leaves current readable state
   intact.
6. Older daemons and unsupported oversized transcripts retain the current
   loaded-turn experience instead of receiving a partially correct global rail.
