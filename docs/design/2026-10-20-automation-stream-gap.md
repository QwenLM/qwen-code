# FG11e: the stream gap in the managed event journal

[English](2026-10-20-automation-stream-gap.md) | [简体中文](2026-10-20-automation-stream-gap.zh-CN.md)

Status: proposed. No runnable gate yet; this document scopes what such a gate
must pin and what has to be located first.

Issue: #14446, the FG11 tracker. The `e` row records a gap in the event stream
as the second hole the audit named, and neither the lifecycle gate (FG11d) nor
the publication gate (FG11f) exercises it.

## Why

The other FG11 slices fault what an automation _does_ — a lost reply, a store
failure, a crash, a publication. They all assume the event journal a client
reads is contiguous. Three gates already cover that on other streams — FG6e's
`sse-gap` driver, FG8e's abort-and-resume cases, and FG12f's
`HostedMcpStreamGapIT` — so FG11e is the automation-journal slice they do not
cover. What none of them answers is what happens when this journal is not
contiguous: a consumer that has processed sequence `N` and next receives
`N + k` has lost the events in between, and the recovery path is the one place
where a duplicated effect is indistinguishable from a replayed one.

This matters for automations specifically because their work is driven from the
journal. A gap that is silently papered over can drop a `fire_run`, and a gap
that is replayed too eagerly can fire the same occurrence twice — the exact
failure FG11a and FG11b pin from the other direction.

## What a gap is here

Three shapes, only the first of which is visible on the wire:

- **Delivery gap.** The stream the client reads jumps a sequence. This is what a
  proxy, a dropped SSE frame or a killed connection produces.
- **Projection gap.** `covered_sequence` on `ma_event_stream` advances past
  events that were never projected into the readable record. The client sees a
  consistent-looking record that is missing history.
- **Lost activation after a claim.** `wake_covered_sequence` is a dedup
  watermark, not a completion watermark: `TransportWakeActivator.onWake` claims
  the sequence before it submits the load, and a rejected submission keeps the
  claim and leaves the wake to SQL wake recovery. A delayed or reordered wake is
  therefore normal; the fault is narrower — the claim committed and the
  activation never ran (process exit, dropped load). The property is that the
  independent SQL wake recovery still finds the committed, unconsumed input, and
  the claim watermark is never read as progress.

## Scope from the tracker

The tracker's FG11e row names three scenarios; the first two are not covered by
the journal shapes above, so they are scoped here rather than dropped:

- **Task stream resume.** Disconnect the run's task event stream between `fire`
  and `settle`, then resume it, and assert the delivered sequence: the prefix
  received before the disconnect followed by the suffix received after it must
  equal the task's persisted state-event sequence item by item, in order, with
  no duplicate and no gap. `ManagedTaskEventStore.read` resumes strictly from
  the task's own sequence, which is what makes the concatenation checkable.
  Terminal state exactly once is an additional check, not the contract: a replay
  that repeats a `running` transition still delivers one terminal state.
- **List cursor stability.** Page the Session's runs list while a new run is
  inserted, and assert no entry is skipped or duplicated across the boundary.
- **Session SSE resume.** Resume a Session stream with `Last-Event-ID`; this
  first needs a check that automation events are observable on that stream at
  all, and if they are not, the scenario is recorded as deferred with that check
  as its precondition.

## The mechanisms a gate would lean on

- `ma_event_stream` carries `last_sequence`, `replay_floor_sequence`,
  `covered_sequence` and `wake_covered_sequence` per Session, plus
  `current_snapshot_id` and `snapshot_stale_since`.
- `TransportConsumerStore.claimWake(tenant, session, sequence)` is a
  conditional update against the watermark: it returns true exactly once per
  sequence above the last claim. That is the de-duplication the gate can read.
- `TransportConsumerStore.materializedThrough(tenant, session)` reports the
  `covered_sequence` a PUBLIC, unretired Session's projection has reached.
- `ManagedSnapshotStore` owns the snapshot fallback: it writes
  `current_snapshot_id` and marks `snapshot_stale_since` when the covered
  sequence overtakes the snapshot.

## What the gate must pin

1. **The gap is detected, not absorbed.** A consumer positioned below a
   sequence it never received must take the replay path or the snapshot path —
   never silently continue from `last_sequence`.
2. **No duplicate effect.** Whatever the recovery path re-delivers, the
   occurrence fires at most once and the run settles once. This is the property
   FG11a/b already pin from the lost-reply side; the gap gate has to pin it from
   the missing-event side.
3. **No lost occurrence.** An occurrence whose events fall inside the gap still
   ends in a terminal outcome, or is provably still pending. Silence is a
   failure.
4. **The snapshot fallback is chosen on evidence.** A cursor below
   `replay_floor_sequence` triggers the fallback regardless of staleness:
   `ManagedSnapshotStore` sets `snapshot_stale_since` only when
   `covered_sequence` overtakes the snapshot, so a floor-crossing cursor can
   meet a snapshot that is still current. The gate must check the snapshot's own
   coverage and the continuation after it, and cover a fresh snapshot and a
   stale one as separate cases.

## Fixture requirements

- A relay that can drop one event from a stream while leaving the sequence
  numbering intact; the existing `HostedLifecycleRelay` drops replies, not
  frames, so this needs a frame-level hook rather than the current one.
- Real MySQL, because every property above is read from `ma_event_stream` and
  `ma_session_record`, not from process memory.
- The assertion set above, plus the existing "one run, one Turn, one execution"
  counts so a replay cannot pass by doing the work twice.

## Open questions

- The replay-versus-snapshot branch is located:
  `ManagedAgentService.replayableEvents` throws `ReplayCursorExpired` when the
  cursor falls below `replay_floor_sequence`, and `ManagedEventStreamService`
  turns that into one resync frame. What is still open is narrower — which automation event types
  reach the Session stream, and how a projection gap is told apart from a slow
  projection sitting at the same sequence.
- The client-visible contract lives outside the FG11 set, in
  `docs/design/2026-09-27-managed-agent-event-replay.md` (with a `.zh-CN.md`
  sibling): JSON reads answer `409 cursor_expired` with `replay_floor_sequence`
  and `snapshot_through_sequence`, and streams send one
  `agent.session.resync_required` frame carrying `reload_snapshot`, deliberately
  without an `id` so a reconnect cannot skip what the client lacks. What is open
  is whether automation consumers honour `reload_snapshot`.

## Limits

- The arms describe faults in the journal and the projection, not in the
  transport between client and server; a proxy that truncates a response is a
  different gate.
- Nothing here is implemented. This document is the scope a later slice needs,
  and it exists so the next author does not re-derive the three gap shapes from
  the schema.

## Acceptance

- Each arm green on JDK 21 with a real MySQL 8, selected through the hosted
  automation profile.
- Every arm red at the site it names when its fault arm is removed.
- Delivered in both languages with matching structure.
