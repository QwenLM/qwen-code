# Web Shell History Pagination

## Problem

Web Shell restores an existing session through `POST /session/:id/load`. The
daemon currently converts the complete persisted conversation into replay
updates, bounds the resulting in-memory snapshot by bytes, and returns the
retained snapshot as one `compactedReplay` response. Web Shell normalizes that
entire response before painting the transcript.

The byte bound prevents unbounded daemon memory, but a long session can still
produce a multi-megabyte response and a large synchronous normalization pass.
Older events are also represented only by a truncation marker; the persisted
transcript pager is not connected to Web Shell.

The existing transcript API pages from the oldest record toward the newest.
That order is useful for exports but does not support chat history UX, where the
latest messages must paint first and earlier messages are requested on demand.

## Goals

- Let Web Shell request a bounded latest page during `session/load`.
- Preserve the atomic replay snapshot and SSE watermark produced by load.
- Load older persisted history with an opaque backward cursor.
- Keep pages chronological when rendered and preserve the viewport when older
  content is prepended.
- Bound browser transcript state even when the persisted session is very long.
- Preserve existing load and forward transcript paging behavior for clients
  that do not opt in.

## Non-goals

- Changing the model-facing conversation restored by core. The agent still
  receives the complete resumed conversation required for continuation.
- Automatically loading the complete transcript.
- Paging archived transcripts.
- Replacing SSE replay or reconnect behavior.
- Making the first persisted-transcript index scan sublinear. The existing
  frozen-snapshot index remains linear on a cache miss.

## Design

### Stable history record identity

History replay already tracks the active persisted `ChatRecord` while emitting
ACP updates. The replay collector will stamp that record UUID into private
update metadata. This metadata is present only on replayed persisted history;
live events keep their current shape.

The UUID gives the initial load page an exact exclusive boundary. Older paging
therefore does not rely on timestamps and cannot duplicate the first retained
record when timestamps collide.

### Paged session load

The TypeScript SDK adds an optional `historyPageSize` restore option. The serve
route validates it with the transcript pager's existing range of 1 through 500
and forwards it through the bridge as private ACP load metadata. Servers that
support this contract advertise `session_transcript_pagination` through
`/capabilities.features`; Web Shell sends the option only when that feature is
present, so older servers retain their bulk-load behavior.

When the option is absent, load is unchanged. When present, the ACP agent keeps
the complete resumed conversation in core but converts only the latest record
suffix for the UI replay envelope. The suffix begins at a normal user-turn
boundary. The envelope reports whether older active-chain records exist.

The bridge seeds only that page into the session EventBus. Its response still
contains the replay events and the EventBus `lastEventId` from one load
operation, so events emitted after the snapshot remain available through SSE
without a `resume`/transcript-read race.

### Backward persisted transcript pages

`GET /session/:id/transcript` and its workspace-qualified form accept an
exclusive `beforeRecordId` only on the first backward request. The response
uses the existing `nextCursor` field; the signed cursor records that paging is
backward and freezes file identity, active leaf, byte size, position, and replay
direction.

Backward pages are returned in chronological display order. Each selected page
starts at a normal user-turn boundary. The record limit is therefore a soft page
target: a long turn is returned intact even when it exceeds the requested record
count, so scrolling never reveals only the tail of the previous turn. The
workspace route retains its hard source-byte limit: if a complete turn exceeds
that limit, it returns `transcript_page_too_large` rather than returning a
partial turn. Forward cursors and responses remain byte-for-byte compatible.

### WebUI transcript state

The provider normalizes an older page in an isolated transcript store,
allocates non-conflicting block ordinals, and resets the active store with only
the resulting blocks prepended. Live side-channel state, active streaming
pointers, and the SSE event cursor are preserved.

Older pages are prepended atomically: if a complete page would exceed
`maxBlocks`, the UI keeps the current transcript unchanged, stops paging, and
reports that earlier records remain persisted but cannot be displayed in the
current view. A complete initial page is never truncated mid-turn; when it
exceeds `maxBlocks`, the provider retains that page and prevents older paging.

### Web Shell interaction

Web Shell opts into a 100-record initial history page. The session provider
derives the exclusive boundary from the earliest replay record UUID and exposes
history state through a small hook:

- whether an older page exists;
- whether a page request is in flight;
- an action to load the next page.

When the message list reaches the top, it automatically requests the next page
and shows a loading status above the transcript. It records the scroll container
height before the request and restores the visual anchor after prepending. A
short page that does not fill the viewport automatically advances until the
transcript becomes scrollable or history is exhausted. A failed or partial page
leaves the current transcript intact, stops automatic retries, and surfaces the
existing daemon notice path.

### Live-session retention

The 50,000-block store limit remains a final safety cap. Web Shell also applies
a 500-block reload trigger to sessions that remain open for a long time. Once a
transcript exceeds that trigger, the agent is idle, no SSE event has arrived for
two minutes, and the reader remains at the live tail, Web Shell reloads the same
session with `historyPageSize: 100`. The old SSE subscription is closed by the
normal session-switch cleanup. The load response supplies the bounded replay
and its atomic `lastEventId`; the provider rebuilds the transcript and starts a
new SSE subscription from that watermark.

The existing transcript remains mounted while this background load is in
flight. Once the bounded replay arrives, the provider resets and dispatches it
in one store notification, so the reader never sees an empty or loading state.

Loading an already attached session with a page size refreshes only its UI
replay. It does not restart the agent or reload the model-facing conversation.
The bridge reads a fresh persisted page while the session EventBus watermark is
stable and returns it through the normal load envelope. If events arrive during
that read, the bridge retries and otherwise falls back to its existing replay.

After reload, upward scrolling follows the same `beforeRecordId` and opaque
cursor pagination used by historical sessions. Scrolling upward cancels the
reload timer. Returning to the live tail starts a new two-minute quiet period.
Main and split views own independent providers, SSE subscriptions, timers,
cursors, and retained windows.

## Consistency and failure handling

- Initial history and the SSE watermark remain coupled through `session/load`.
- The first older page excludes the exact earliest persisted record already in
  the load snapshot.
- Continuation cursors freeze the transcript snapshot; later appends do not
  change older pages.
- Session changes invalidate in-flight page results before they can modify the
  new transcript.
- Invalid boundaries and cursors return the existing invalid-transcript-cursor
  error family.
- Snapshot replacement, rewind, archive, or deletion returns
  `transcript_snapshot_unavailable`; the provider stops paging and leaves
  already-rendered content intact.
- A replay conversion failure does not prepend a partial page or advance its
  boundary. The provider stops automatic paging and emits a warning notice.
- Existing clients that omit `historyPageSize` or `beforeRecordId` retain the
  current bulk-load and forward-page contracts.

## Affected areas

| Layer                    | Change                                                     |
| ------------------------ | ---------------------------------------------------------- |
| Core transcript reader   | Backward cursor and exclusive record boundary              |
| ACP replay               | Record UUID metadata and latest-suffix selection           |
| ACP bridge / serve route | Paged-load metadata, validation, and `hasMore` propagation |
| TypeScript SDK           | Restore page-size option and restored history state        |
| WebUI provider           | Isolated prepend, page state, stale-request protection     |
| Web Shell                | Opt-in page size and automatic top-loading behavior        |
