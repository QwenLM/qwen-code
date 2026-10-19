# Bounded retention for managed session state

[English](2026-10-19-managed-session-bounded-retention.md) | [简体中文](2026-10-19-managed-session-bounded-retention.zh-CN.md)

## Problem and scope

Issue #13184 audits time-unbounded growth in the managed-agent persistence and
projection layers. This design covers the two remaining Core items:

- **Item 1**: the session authority keeps every event in process memory, and
  every read path replays the whole journal (local JSONL) or pages it from
  revision 0 (HTTP).
- **Item 2**: the activation store and inbox journals never compact, and the
  activation renewal loop appends a durable record for the life of an open
  session.

The audit's item 4 (resource-store hardening and a publish bound) and the
process-map bound for settled dispatch entries are implemented in companion
branches of this series, not yet merged. The renewal stop condition is
implemented there as well. Those changes are referenced here only to keep the
retention model in one place.

## Current state

Verified against `origin/main` at `e584d4d197`:

- `LocalManagedSessionAuthority` pushes every committed event into `events`
  and never removes one. `readEvents`, `eventsInSequenceRange` and
  `lastEventOfKind` read that array synchronously, and one path indexes it as
  `events[sequence - 1]`, which assumes the array still starts at sequence 1.
- `LocalJsonlManagedSessionJournalStore.read` reads the whole transcript file
  with `readFile` on every open.
- `HttpManagedSessionStore.readJournal` pages `/transactions` from
  `afterRevision = 0` at 100 transactions per page, concatenates every chunk,
  then scans the result. `readOnlyManagedSessionSnapshot` rejects a head whose
  `compactedThroughRevision` is not 0 with
  `snapshot recovery or compaction is unsupported.`, and
  `requireHeadMatchesGrant` rejects the same head with
  `restore head is not readable by this writer.`
- The Java server already persists `last_sequence`, `covered_sequence`,
  `replay_floor_sequence` and `current_snapshot_id` per event stream, and has a
  replay-floor advancer. The TypeScript client does not consume any of it.
- `FileManagedActivationStore.open` and `FileManagedSessionInbox.open` replay
  every JSONL line, and both require contiguous sequences starting at 1.
  Released activations and acknowledged messages stay in their in-memory maps.
  A lease renewal appends a record every `leaseDurationMs / 3`.
- The renewal loop on `origin/main` retries on every interval and never
  stops; a stop condition is implemented in this series (not yet merged).

## Goals

1. Bound memory per open session by a configured number of events, independent
   of total session length.
2. Bound each durable journal by a snapshot plus a retained tail, without
   losing any committed state that a reader can still be asked to serve.
3. Make every read that falls below the replay floor fail explicitly instead of
   returning a silently truncated range.
4. Keep the TypeScript and Java stores on the same retention contract.

## Non-goals

- The Web Shell projection work (issue item 5) and the server-side quarantine
  of an undecodable event row (the open half of item 6).
- Reclaiming orphaned resources; that needs the reference-closure ledger.
- Changing the public event or checkpoint formats beyond adding a journal
  snapshot record and a compacted-session read path.

## Proposed design

### 1. One retention boundary: the replay floor

The floor is the highest sequence below which a snapshot covers every event.
It is persisted per stream and is monotonically non-decreasing. Readers below
the floor receive an explicit expired-cursor error carrying the floor, which
the existing event-replay design already defines for cursors.

The existing `compactedThroughSequence` on the authority is the local
counterpart; this design ties its advancement to the floor. Compaction may only
advance it after the snapshot that covers the same range is durable.

### 2. TypeScript HTTP store: consume the snapshot and the floor

1. `requireHeadMatchesGrant` accepts `compactedThroughRevision > 0` when the
   head names a snapshot the client can fetch.
2. Opening a compacted session fetches that snapshot, rebuilds the authority's
   initial state from it, and then pages `/transactions` from
   `compactedThroughRevision + 1` instead of 0.
3. A head that names a snapshot the client cannot fetch remains a hard
   failure; it never falls back to a full replay from 0.
4. `readJournal` returns the floor with the scan so callers can distinguish
   "no more events" from "events were compacted away".

The server endpoint that returns the snapshot body for `current_snapshot_id`
must be confirmed before this slice starts; the existing head fields are the
contract it has to satisfy.

### 3. Local JSONL journal: snapshot plus truncate

1. Write a `journal.snapshot` record at the head of a new file. It carries the
   format version, the covered sequence, the checkpoint reference, the
   activation epoch and the base commit proof.
2. Append the events after the covered sequence, fsync, then atomically rename
   the new file over the old one and fsync the directory.
3. Keep the previous file as `transcript.jsonl.compacted-<sequence>` until the
   rename is durable, so a crash leaves either the old or the new journal.
4. Rebase the takeover commit proof onto the snapshot base and reject a
   takeover whose proof predates it.
5. `open` reads the snapshot first and replays only the tail.

### 4. Authority memory: window plus indexes

1. Retain events after `max(last checkpoint covered sequence, floor)`, plus a
   fixed overlap for predecessor validation.
2. Maintain `latestByKind` and `executionCallId` indexes so
   `lastEventOfKind` and receipt lookups no longer scan the array.
3. Replace `events[sequence - 1]` with a sequence-keyed lookup that tolerates a
   window that does not start at 1.
4. `readEvents` and `eventsInSequenceRange` serve from the window. A request
   below the floor raises the expired-range error; a request inside the window
   but before the retained start is served from the journal through an async
   variant accepted by the caller.
5. The window size is a configured limit, not a time-based one, so a slow
   session and a fast one have the same memory envelope.

### 5. Activation and inbox journals

1. Add the same snapshot record to both JSONL formats, with the next queue
   sequence and the next epoch per session.
2. Drop released activations older than one lease from memory and from the
   snapshot; retain the identity long enough for the existing enqueue
   deduplication window.
3. Drop acknowledged inbox messages from the snapshot after the same window;
   pending messages are never dropped.
4. Keep renewal records out of the snapshot except for the latest lease per
   activation.

### 6. Renewal

Implemented in this series (not yet merged): the loop stops on writes stopped
or three consecutive failures. The snapshot work above replaces the accumulated
renewal records with the latest lease, so a long-lived session no longer grows
its journal by one record per lease third.

## Design decisions

- **Floor, not TTL, for the event log.** A time-based cutoff can discard an
  event a slow reader still needs; the floor is tied to a durable snapshot and
  is therefore safe to enforce at every read.
- **Snapshot plus tail, not row deletion.** Deleting individual rows breaks
  contiguity and the commit-proof chain; a snapshot gives a new base and keeps
  the tail contiguous.
- **Window in events, not bytes.** Event count is the unit every store already
  validates, and it is what the in-memory indexes need.
- **Explicit expiry over silent truncation.** A partial range presented as
  complete is worse than a failure a caller can handle.

## Constraints and risks

- The local journal commit proof is a prefix hash. Truncation must rebase it;
  an implementation that keeps the old proof will reject every takeover.
- Crash consistency needs the old journal to remain readable until the new one
  is durable. The rename ordering above is part of the contract, not an
  optimization.
- The HTTP snapshot format and endpoint are server-owned. The TypeScript client
  must not invent a second snapshot format.
- Reads below the floor are currently synchronous. Converting every caller to
  an async read is a wide change; the design allows a synchronous explicit
  error first, with async read-through added per call site.
- Resource references inside a snapshot still have to resolve after the old
  events are gone; the snapshot must retain the referenced resource ids.

## Validation plan

1. Replay equivalence: for a scripted session, the state rebuilt from
   `snapshot + tail` equals the state rebuilt from the full log, at every
   checkpoint boundary.
2. Crash injection: fail between snapshot write, rename and directory fsync;
   every outcome must open as either the old journal or the new one.
3. Floor behaviour: a cursor below the floor returns the expired error with the
   floor; a cursor at the floor returns the tail.
4. Memory bound: a session with 100k events keeps at most the configured window
   of events resident.
5. Mutation witnesses for each guard: floor off-by-one, snapshot coverage,
   index staleness, and a takeover proof that predates the snapshot.

## Acceptance criteria

- A session with any number of checkpoints retains at most the configured
  event window in memory and at most `window + snapshot` events on disk.
- No read silently returns a truncated range; every below-floor read raises the
  documented error.
- A compacted HTTP session opens without replaying from revision 0.
- The activation and inbox journals stop growing with released or acknowledged
  entries after the retention window.
- TypeScript and Java agree on the floor and snapshot contract.

## Slices

1. TypeScript HTTP store: snapshot-aware open and tail paging (server endpoint
   confirmed first).
2. Local JSONL journal: snapshot record, truncate and proof rebase.
3. Authority: indexes, windowed reads and explicit expiry.
4. Activation and inbox: snapshot record and released/message retention.
5. Java parity checks and cross-language replay equivalence.

## Open questions

- Which server endpoint returns the snapshot body, and is its payload the same
  `current_snapshot_id` body used by recovery?
- Is a synchronous expired-range error sufficient for every current caller, or
  does any caller need read-through below the floor in the same release?
- What window size fits the largest supported session without changing the
  current checkpoint cadence?
