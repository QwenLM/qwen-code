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
reads is contiguous. Nothing in CI answers what happens when it is not: a
consumer that has processed sequence `N` and next receives `N + k` has lost the
events in between, and the recovery path is the one place where a duplicated
effect is indistinguishable from a replayed one.

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
- **Wake gap.** A wake claims a sequence above work that actually completed.
  `TransportConsumerStore.claimWake` refuses a redelivered or older wake, but a
  wake that jumps forward is a different question, and it is the one that can
  reorder an occurrence against its own settlement.

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
4. **The snapshot fallback is chosen on evidence.** When the gap reaches below
   `replay_floor_sequence`, the recovery must read from `current_snapshot_id`
   and know that the snapshot is stale (`snapshot_stale_since` set) rather than
   treating it as complete.

## Fixture requirements

- A relay that can drop one event from a stream while leaving the sequence
  numbering intact; the existing `HostedLifecycleRelay` drops replies, not
  frames, so this needs a frame-level hook rather than the current one.
- Real MySQL, because every property above is read from `ma_event_stream` and
  `ma_session_record`, not from process memory.
- The assertion set above, plus the existing "one run, one Turn, one execution"
  counts so a replay cannot pass by doing the work twice.

## Open questions

- Which branch decides replay versus snapshot is not yet located. Reading the
  schema says both paths exist; the code that selects between them has not been
  traced, and until it is, a fault arm cannot be aimed at it.
- The client-visible contract for a detected gap — an error frame, a gap marker,
  or a silent resume — is not specified anywhere in the FG11 design set.

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
