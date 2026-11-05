# Bounded Available Commands Replay Memory

[English](2026-11-05-available-commands-replay-memory.md) | [简体中文](2026-11-05-available-commands-replay-memory.zh-CN.md)

## Context

An idle hosted daemon repeatedly received approximately 2.55 MB
`available_commands_update` frames containing installed skills' full bodies.
The reconnect ring retained every original object. Its 32,000-event operator
limit did not bound bytes, while browser egress redaction happened too late to
release those objects. In one observed run, 491 frames represented approximately
1.17 GiB of serialized input. Heap growth closely followed notification volume.
This is evidence of retained snapshots, not a heap-snapshot attribution of every
allocated byte.

## Scope

Change qwen-code's notification production and retention, without modifying
Opencode's periodic extension checks or the public ACP event schema. Preserve
live ACP/Desktop skill details, SDK/browser redaction, event IDs, epoch checks,
and existing reconnect recovery.

## Source deduplication

Each ACP `Session` serializes command snapshot construction and publication.
Hash the complete wire `SessionUpdate` using SHA-256 and retain only the last
successfully sent digest. The first snapshot sends; a byte-identical snapshot
is suppressed. A changed command, array order, skill metadata, enablement, or
body sends again. Commit the digest after successful delivery, so failure does
not poison a later retry. Check held/disposed state within queued work and after
asynchronous discovery. Workflow-mode refresh and skill-consumer notification
still run even when a redundant command frame is suppressed.

## Latest full snapshot

The shared immutable projection removes only
`update._meta.availableSkillDetails`, supporting wrapped and flat events. The
live fanout and `publish()` result remain complete. Ring entries and both
compaction journals receive the projection with the original ID and metadata.
A single EventBus-owned slot retains the latest complete command event; replacing
it releases the prior body independently of journal eviction.

Reconnect replay, `snapshotReplay()`, and `liveJournalSnapshot()` restore that
complete event only at its original matching ID. Earlier command events retain
commands and names, but not old skill bodies. This is state replay, not a
historical archive of skill source. If eviction or replay truncation removed the
matching event, do not synthesize an out-of-order replacement. Existing resync,
load, and history-truncation behavior remains authoritative.

Seeded replay uses the same projection and keeps only the last complete command
event. Reset and close clear the ring and latest slot. A subsequent command event
without details clears the prior complete slot, preventing stale skill bodies
from resurfacing. No new protocol field, capability, cursor, or id-less snapshot
notification is introduced. Browser/REST egress reuses the same projection;
ACP egress continues to deliver the one complete latest snapshot.

## Ring byte budget

`EventBusOptions.maxRingBytes` is threaded through `eventRingMaxBytes` and
`--event-ring-max-bytes`. The default is 8 MiB; values must be positive safe
integers no larger than 256 MiB, with no unlimited sentinel. This budget is
independent of `ringSize`, subscriber queues, `replayBudgetBytes`, compacted
replay, and adaptive journal growth.

Store the serialized retained size beside each ring entry. Conservatively count
the latest complete slot as well as projected ring bytes. Evict oldest entries
until both count and byte caps hold, preserving at least the newest ring event.
An individually oversized event or full command snapshot is the documented
exception: the latest complete state and at most one ring event remain, rather
than silently discarding all resumable state. This byte budget measures
serialized payload, not an exact V8 heap limit.

Replay budgeting measures the event actually restored for delivery. Ring eviction
continues to use `ring_evicted`; oversized replay still uses
`replay_budget_exceeded`. IDs are never renumbered or removed from the middle of
the retained suffix. Seed/reset/close reset current byte accounting; cumulative
eviction counters remain lifetime diagnostics.

## Diagnostics

Expose `limits.eventRingMaxBytes` and per-session `eventRingCount`,
`eventRingBytes`, optional `eventRingEarliestEventId`, `eventRingEvictedEvents`,
`eventRingEvictedBytes`, and `availableCommandsSnapshotBytes`.
`eventRingBytes` conservatively includes the latest complete snapshot slot.
These additive status fields distinguish current retention from configured
limits and from bytes evicted over the run.

## Validation

- First, unchanged, changed, failed, concurrent, held, and disposed Session sends.
- Immutable full live delivery and lightweight ring/compaction retention.
- Latest-only body recovery at original IDs, including seeded replay and
  completed-turn snapshots.
- ACP/Desktop initial load and reconnect keep complete latest skill details;
  SDK/browser responses never expose bodies.
- Count and byte limits, UTF-8 sizing, exact boundaries, oversized exceptions,
  reset/close, and eviction counters.
- Epoch mismatch, stale cursor, contiguous in-window replay, and independent
  replay-burst budgeting.
- Default and custom CLI/fast-path/bridge/status wiring across all workspace
  runtime construction paths.
- A controlled daemon behavioral run repeatedly refreshes large command data:
  unchanged producer snapshots stop sending, changed snapshots remain live, and
  EventBus-owned retained bytes plateau rather than scale with refresh count.

Run package-specific focused tests, build, typecheck, and touched-file formatting
and lint checks. See the existing [bounded replay window](2026-07-07-bounded-replay-snapshot-window.md)
and [large-frame measurement](2026-07-05-large-frame-handling-measurement.md)
for the independent retention and delivery contracts.
