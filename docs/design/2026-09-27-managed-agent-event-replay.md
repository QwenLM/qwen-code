# Managed Agent Event Replay (Stage D3)

[English](2026-09-27-managed-agent-event-replay.md) | [简体中文](2026-09-27-managed-agent-event-replay.zh-CN.md)

Status: implemented in this change
Date: 2026-09-27
Issue: [#12793](https://github.com/QwenLM/qwen-code/issues/12793), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [Managed Agent API Contract (Stage D1)](2026-09-27-managed-agent-api-contract.md) and [Session query (Stage D2)](2026-09-27-managed-agent-session-query.md)

## 1. Problem

After D2 the event routes still differed from the contract:

- A JSON event page returned `has_more: false` and `next_cursor: null` even
  when it was full, and it rejected limits above 100, while the contract
  allows 1000. The WebShell transcript had the same limit.
- There was no replay floor. `replay_floor_sequence` was the constant `0`,
  nothing answered `409 cursor_expired`, and neither stream sent
  `agent.session.resync_required`.
- Public and WebShell events lacked `schema_version`, `projection_version` and
  a top-level `item_id` and `content_part_id`. The event table had no columns
  for them.
- `capabilities` reported `snapshots` and `resync` as `false`.

Two more problems came up while closing these gaps:

- Text deltas carry `data.contentPartId` as `part_<turn>_<type>`, but the Items
  projection names the Part `part_<turn>_<type>_<first sequence>`. Moving the
  data field to the top level would name a Part that the Snapshot does not
  have.
- The specification had no schema for the resync frame, and it declared
  `409` on the WebShell stream, although section 4 of the
  [public API contract][contract] has streams send the resync frame instead.

The issue's exit check for D3 is that the event query and stream, the WebShell
event stream and the WebShell transcript move to `implemented`, with tests for
`Last-Event-ID` resumption, the switch from catch-up to live events, subscriber
overflow and a floor that the test advances: no duplicates, no gaps, and a
correct `cursor_expired` or resync.

## 2. Goals

- Close every D3 line in the known-gap file without adding new ones.
- Move `getSessionEvents`, `webShellStreamEvents` and `webShellTranscript` to
  `implemented`.
- Store the versions and the Item and Part identity with each event, so replay
  returns what the event was accepted with.
- Persist a replay floor per Session and answer expired cursors from it.

## 3. Non-goals

- Pruning events. Nothing raises the floor in production yet; that belongs to
  the retention work.
- The WebShell Session's `replayFloorSequence` and `snapshotThroughSequence`,
  which stay `planned`.
- `listItems`, which stays `partial` until Snapshot versions are paged.
- Durable admission for posted events, submit and cancel.

## 4. Decisions

### 4.1 Contract v1.17

- The three operations above move to `implemented`.
- `next_cursor` is the `after` value for the next page, the last returned
  sequence as a decimal string, and `null` when `has_more` is `false`.
- Two schemas describe the resync frame: `SessionResyncRequired` for the public
  stream and `WebShellResyncRequired` for the WebShell stream. Both carry the
  type, the Session id, the replay floor, the Snapshot's covered sequence and
  the action `reload_snapshot`. Each stream's `text/event-stream` media type
  points to its schema through `x-qwen-resync-frame`. The contract test
  validates resync frames against it, and the reference makes the generator
  emit the WebShell type.
- The WebShell stream no longer declares `409`. The server never returned it;
  an expired `afterSequence` ends the stream with the resync frame, as on the
  public stream.
- `content_part_id` and `contentPartId` allow 128 characters, like
  `PublicContentPart.part_id`. A Part id ends with a sequence, so it exceeds 64
  characters once the sequence has ten digits.
- `replay_floor_sequence` gains a description: events at or below it may be
  pruned, and a cursor below it has expired.
- `SessionResyncRequired` tells a client to resume after the
  `snapshot_through_sequence` that the Items list returns, since the value in
  the frame can be older than the Snapshot the client then reads.
- The WebShell transcript states what it already returned: without a cursor, a
  Session with a Snapshot gets all of its Items, the events up to the Snapshot
  other than `turn.accepted`, `item.output_text.delta`,
  `item.reasoning.delta`, `item.tool_call.updated` and
  `item.tool_result.updated`, which the Items already hold, and every later
  event;
  `limit` bounds the event pages otherwise.
- `PublicEvent` and `WebShellEvent` state that events replay with the versions
  and identity they were accepted with, except after a `stream.reconciled`
  event, which the contract did not mention before (see 4.2). A public client
  reloads the Items until their `snapshot_through_sequence` reaches that
  event, because the Snapshot is rebuilt after it, and then resumes after that
  `snapshot_through_sequence`. Resuming after the `stream.reconciled` event
  instead would apply again the deltas that the Snapshot already holds.

### 4.2 Versions and identity

Flyway V14 adds `schema_version` and `projection_version`, both defaulting to
`1`, and `item_id` and `content_part_id` to `managed_agent_event`, and
`replay_floor_sequence` to `managed_agent_session`. The store writes version 1
of both on every new event and replay reads the stored values, so a later
version does not rewrite older events.

`EventIdentity` states projection version 1's rule for naming the Item and
Part that an event changes:

| Event                                                         | `item_id`                                                                                    | `content_part_id`                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.accepted`                                               | `data.itemId`, else `item_<turn>_input`                                                      | none; the event fills several Parts                                                                                                    |
| `item.output_text.delta` and `item.reasoning.delta` with text | `data.itemId`, else `item_<turn>_assistant`                                                  | the Part of the event right before it, when that event is a delta of the same type and Item; otherwise `part_<turn>_<type>_<sequence>` |
| a text delta with empty text                                  | none                                                                                         | none; the projection skips it                                                                                                          |
| `item.tool_call.updated` and `item.tool_result.updated`       | `data.itemId`, else derived from the tool call id, or from the turn and sequence without one | none                                                                                                                                   |
| any other event                                               | none                                                                                         | none                                                                                                                                   |

This is the rule the materializer already applies when it builds Items, and
the materializer now takes its names from the same helpers. Because a delta's
Part depends only on the event before it, the store assigns the identity when
it appends the event. For a text delta it reads the previous event by primary
key; other events need no read. `data.contentPartId` is left as it was, and
clients should use the top-level field.

Flyway V15 is a Java migration that gives the events written before V14 their
identity with the same rule. It lists the Sessions from their own table in
pages of 1,000 and reads each Session's events in sequence order in pages of
5,000, so its memory grows neither with the number of Sessions nor with a
Session's length. It
reads `data_json` only for the four event types that have an identity, and it
writes
each run of consecutive events with the same identity, such as one text Part,
with a single ranged update. A delta whose text a retraction emptied gets no
identity, which matches the Items that the store rebuilds after a retraction.
`EventIdentity` is projection version 1 for both the store and V15; a
different rule needs a new projection version rather than a change to it.

A retraction (`retractContinuationOutput`, during Harness recovery) empties the
text of the retracted deltas and rebuilds the Items. The store then derives the
identity of every event from the first retracted one on again, so that an
emptied delta names nothing and a kept delta that continued it names the Part
that the rebuilt Items give it. This rewrites identity together with the data
that the retraction already rewrites, and the `stream.reconciled` event that
follows tells clients to reload the Snapshot.

### 4.3 Event pages

- The event query and the WebShell transcript accept a limit from 1 to 1000
  and default to 100. The Session list and the Items list keep 1 to 100.
- The query reads one event more than the limit to set `has_more`.
- Stream catch-up still reads pages of 100 events.

### 4.4 Replay floor

- A cursor has expired when it is below the floor. A cursor equal to the floor
  is valid, because the next event is retained.
- A read checks the floor after it reads the events. The floor only rises and
  the retention work prunes only below it, so a floor that is not above the
  cursor after the read was not above it during the read.
- The JSON query answers an expired cursor with `409 cursor_expired`, and the
  error envelope carries `replay_floor_sequence` and
  `snapshot_through_sequence`, which the contract already defined. An
  `ApiException` can now carry extra envelope fields.
- A stream checks the floor whenever it reads the store: at the start, after
  the in-memory hub overflowed, and after an idle wait. An expired cursor sends
  one `agent.session.resync_required` frame and completes the stream. The frame
  has no `id`, so the client's `Last-Event-ID` does not move past events it
  lacks.
- `ManagedAgentStore.advanceReplayFloor` raises the floor and never lowers it.
  It caps the floor at the Snapshot's covered sequence, so that a client that
  reloads the Snapshot can resume after `snapshot_through_sequence`. Tests call
  it; the retention work will call it before it deletes events.
- `PublicSession.replay_floor_sequence` returns the stored floor.
- A stream reconciliation discards the Snapshot, so its covered sequence is `0`
  until the Items are rebuilt. With a raised floor, a public client told to
  resync during that time would find its cursor expired again, with `409` or
  another resync frame, until the rebuild finishes.
  Nothing raises the floor in production yet; the retention work must close
  this window before it does.
- The WebShell transcript does not check the floor. Once events are pruned,
  its older pages must end at the floor; that also belongs to the retention
  work.

### 4.5 Capabilities

`snapshots` and `resync` become `true`. The Items list returns a Snapshot with
its covered sequence, and both streams send the resync frame. The Items list
reads the current Snapshot for every page, so a client that needs more than one
page can see two Snapshot versions; pinning one version across pages is the
remaining `listItems` work. The WebShell transcript returns one Snapshot in
one response.

### 4.6 WebShell client

The client recognizes the resync frame by its event name and the missing id.
The provider turns it into the existing `stream_gap` event, so the session hook
reloads the transcript and resumes from the transcript head, as it does after
`stream.reconciled`.

The hook's gap recovery merges the fresh transcript into the displayed events
instead of replacing them. The snapshot is authoritative for the range it
covers ([first event, lastSequence]): live events missing from it — for
example, streamed deltas the server has since assembled into an Item — are
dropped rather than duplicated, while live events newer than the snapshot head
survive a lagging read. Below the window, events the user paged in survive
only while the paged region stays contiguous with the window — a hole between
them would otherwise render two unrelated delta runs as one assistant bubble,
so on a hole the pages drop and the window's cursor is adopted to page them
back — and item projections never survive — after a retraction the server
stands behind the raw events. The paging cursor follows the retained content:
cleared when a non-empty snapshot carries the full history, adopted from the
snapshot when the client has none or a hole opens between the paged pages and
the window, and left with the user otherwise. A gap resync that does not
advance the cursor counts as a stall; the third consecutive stall surfaces a
persistent error, and any delivered event or advancing snapshot resets the
count.

The stream client tolerates corrupt frames. A frame whose data payload does
not parse, parses to something without a string `type`, or — mid-stream —
carries no `data:` line at all counts as corrupt. The default is fail closed:
only the delta types whose text the snapshot re-assembles
(`item.output_text.delta`, `item.reasoning.delta`) are skipped, with a
rate-limited warning, and later frames move the consumer's cursor past them.
Every other corrupt frame yields a resync — including one whose `event:` name
is unusable. A resync also fires when more than three corrupt frames arrive
with no decoded event between them (heartbeats do not reset the count — only
a delivered event does), or when a whole connection delivered nothing but
skips. A torn final buffer is a mid-frame disconnect: logged as such and
never charged to the corruption budget. Synthesized resync frames carry
placeholder watermarks (`replayFloorSequence: 0`,
`snapshotThroughSequence: 0`) that no client code reads.

## 5. Tests

- The contract test drops the 14 D3 lines, leaving 3 lifecycle lines. It
  validates every stream frame, including resync frames, which must have no
  id. On a fresh Session whose floor it raises to the Snapshot, the JSON query
  returns `409` with both watermarks below the floor and `200` at it, and both
  streams answer with exactly one resync frame. The parity test checks the new
  capabilities and that every event's `item_id` and `content_part_id` name an
  Item and a Part of the Snapshot.
- `ManagedEventReplayTest` covers:
  - JSON pages that follow `next_cursor` without gaps, including a full last
    page that must report `has_more: false`, and the 1000 limit;
  - `Last-Event-ID` taking precedence over `after` and resuming across the
    100-event catch-up pages before live events;
  - a catch-up that races a writer and hands over to live events without gaps
    or duplicates;
  - a stuck stream that falls behind by 600 events, more than the 512 the hub
    keeps (the test asserts this), reads the dropped ones back from the store
    and sends no resync frame;
  - a floor raised past a lagging stream, which then sends one resync frame
    after the last event it delivered;
  - expired cursors on the JSON query and on both streams, and the floor's cap
    and monotonicity.

  The stuck-stream and lagging-stream cases run on each stream, since each has
  its own delivery loop, and resume from a non-zero cursor. The suite sets both the poll and the heartbeat interval to one minute, so an
  idle stream does not read the store during a test and live events can reach
  it only through the hub.

- `EventIdentityTest` pins the rule. Integration tests compare every event's
  identity with the materialized Snapshot after deltas appended in two batches
  with a reasoning Part that spans both, after single appends, and after
  retractions, including a kept delta that continued a retracted one.
- An upgrade test writes events at V1 on H2 in MySQL mode, migrates, and checks
  the backfilled identity against the rule and against the Snapshot.
  `ManagedAgentMySqlIT` runs the same upgrade on MySQL and checks the replay
  floor there.
- The web-shell tests decode a resync frame and check that the provider yields
  one `stream_gap` and stops, and that the session hook then reloads the
  transcript and resubscribes from its head. The hook's gap-merge tests pin
  the window semantics: paged pages survive while contiguous with the window,
  superseded deltas drop, the cursor tracks the retained content, and
  repeated non-advancing resyncs surface an error. The stream client's tests
  pin the corrupt-frame policy: only re-assemblable deltas skip (at a bounded
  warning rate), every other corrupt frame resyncs — including one with no
  usable event name — more than three corrupt frames with no decoded event
  between them resync (heartbeats do not dilute the count), a mid-frame close
  logs distinctly and spares the budget, and a connection of only skips ends
  with a resync.

## 6. Compatibility

- Events gain fields and Sessions report the stored floor; nothing is removed.
- The WebShell stream's `409` response leaves the contract; the server never
  returned it.
- V14 adds columns with defaults. V15 lists the Sessions in pages, reads each
  Session's events once in pages, all in the migration's
  transaction, and updates each run of events with one statement. On a local MariaDB it migrated 200,000 events in 100 Sessions
  in under three seconds; a table with many short runs takes longer.
- Upgrade all replicas together. A replica that still runs the previous
  version after V14 writes events without an identity, and a text delta that
  a new replica appends after one of them starts a Part that the Items do not
  have.
- A client that ignores the resync frame sees the stream end, reconnects with
  the same cursor and gets the frame again. The web-shell client handles it.
  Until the retention work raises the floor, no production stream sends it.
- The generated `@qwen-code/web-shell` types add `WebShellResyncRequired`, and
  the stream operation no longer lists `409`. The optional event fields were
  already in the WebShell event schema.

## 7. Validation

- The Managed Agent server's full test suite and Checkstyle pass.
- `ManagedAgentMySqlIT` passes against `mariadb:10.11.18`, the image CI uses,
  and against `mysql:8.4`.
- The packaged Spring Boot jar migrates a MariaDB database to V15, which shows
  that Flyway finds the Java migration inside the jar.
- Mutations each fail the matching test: ignoring `Last-Event-ID`, skipping the
  floor check, a hub that hides its overflow, a hub that never delivers,
  returning no `next_cursor`, reporting `has_more` on a full last page,
  starting a new Part for every delta, ignoring the previous event on a single
  append, skipping the identity rederivation after a retraction, skipping the
  V15 backfill, merging V15 ranges across a gap, and losing V15's state at a
  page boundary.
- The web-shell typecheck, the managed component tests and the managed-progress
  and managed-workspace-w0d e2e specs pass against the regenerated types.

## 8. Follow-up

- Retention: prune events, raise the floor before pruning, keep the floor at
  or below the Snapshot while a stream reconciliation rebuilds the Items, and
  end the WebShell transcript's older pages at the floor.
- The WebShell Session's floor and Snapshot watermarks.
- `listItems` with paged Snapshot versions.
- Lifecycle work: the three remaining gap lines.

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
