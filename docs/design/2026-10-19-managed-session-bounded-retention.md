# Bounded retention for managed session state

[English](2026-10-19-managed-session-bounded-retention.md) | [简体中文](2026-10-19-managed-session-bounded-retention.zh-CN.md)

## Problem and scope

Issue #13184 tracks growth in managed-agent journals and resident state. This
change is **slice 1**: compact the local activation and inbox journals without
changing the identity, deduplication, lease, fence, ordering, or outcome contract.
It bounds repeated transition and renewal records relative to the current state.
It does **not** bound the number of completed identities or finish #13184.

The remaining native session journal and authority work is described below as
future implementation, including its dependencies. Resource-store limits,
settled-dispatch eviction, and renewal-loop stopping belong to companion PRs
#14656, #14657, and #14658 and are outside this change.

## Current state and corrected boundaries

The activation store and inbox append v1 JSONL events and replay them from
sequence 1. Both retain every identity indefinitely. An activation's lease
renewals and a message's successive processing fences accumulate on disk even
though their earlier transitions are no longer needed to reconstruct its state.
There is no existing identity-expiration or deduplication window.

Three existing fields describe different domains and must remain separate:

| Field                                                             | Owner and meaning                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ma_event_stream.replay_floor_sequence` and `current_snapshot_id` | Java public event projection and immutable item-pagination snapshots. These snapshots cannot restore a Harness authority. |
| `ma_session_head.compacted_through_revision`                      | Native Harness journal compaction. It remains 0; there is no native journal snapshot publish/read endpoint yet.           |
| `LocalManagedSessionAuthority.compactedThroughSequence`           | Coverage of model-history `context.compacted` summaries, not a physical journal replay floor.                             |

The previous proposal treated the public projection snapshot as a native journal
snapshot and the context-summary coverage as a physical floor. Those assumptions
are corrected here. Slice 1 changes none of these fields.

## Goals

1. Replace redundant activation and inbox transitions with one verified
   current-state snapshot plus a contiguous tail.
2. Preserve every accepted identity and its exact replay result across compaction,
   crashes, and reopen, including terminal entries.
3. Keep sequence positions, Session FIFO, activation epochs, processing fences,
   cancellation state, canonical payloads, and outcomes unchanged.
4. Make replacement fail closed without losing an already accepted operation.

## Non-goals

- Expiring completed identities, deleting inbox payloads, or bounding resident maps.
- Compacting the native session authority journal or changing public event floors.
- Changing admission, scheduler renewal, or HTTP behavior.
- Supporting concurrent owners of one local activation/inbox file; these adapters
  retain their existing single-process, single-owner requirement.

## Proposed solution

### Snapshot format and replay

The first JSONL record may be a v2 `activation.snapshot` or `inbox.snapshot`.
Its `state` object is protected by a SHA-256 `digest` over its JSON encoding.
Each store validates the snapshot's state shape and invariants before accepting
any tail records. A snapshot is permitted only as the first record. Unknown
versions, checksum mismatches, duplicate identities, invalid ordering, and
invalid lease/fence relationships fail closed.

The activation snapshot retains `nextSequence`, all current activation snapshots,
and the complete per-Session `nextEpoch` map. It includes released and cancelled
activations, preserves their original queue sequences, and keeps the latest lease
for each assigned activation. The inbox snapshot retains `nextSequence` and all
current messages, including finished ones, their payloads, admission positions,
readiness, cancellation flag, latest fence, outcome, and finish time.

Subsequent events keep the existing v1 format and must continue exactly at
`nextSequence`. Snapshotting consumes no sequence number, epoch, queue position,
or admission position. Readers without v2 support reject the first snapshot
rather than treating the retained tail as complete history. The public methods
and their return values are unchanged.

### Automatic compaction and growth bound

Each store tracks the byte length of the snapshot and the complete journal.
Before a new event append, it compacts if tail bytes have reached
`max(64 KiB, snapshot bytes)`. A legacy file has zero snapshot bytes and becomes
eligible after 64 KiB. A read-only open does not compact a healthy file.

Replacement serializes the state that is already durable, then the requested
append runs normally. Thus a compaction error precedes the requested operation:
it cannot report that an operation failed after committing it. Idempotent calls
that do not append also do not trigger compaction.

After replacement there is one current-state snapshot. Until the next
replacement, the retained tail is bounded by the threshold plus one existing
record's size. Rewrites grow with the snapshot size rather than rewriting an
ever larger identity set after a fixed small number of appends. A live activation
with any number of renewals retains one latest lease plus a bounded tail.
Completed identities and their payloads still contribute to the snapshot size;
this is an explicit remaining scope item, not evidence of a constant disk or
memory bound for the whole service.

### Durable replacement and failure handling

Both stores share a small snapshot codec and atomic replacement helper. The
existing general atomic-write utility has in-place fallback behavior and cannot
provide the required replacement contract.

1. Remove a stale fixed `<journal>.snapshot.pending` file. It is never an
   authority or a recovery candidate.
2. Create that pending file exclusively with mode `0600`, write the full
   snapshot, fsync it, and close it.
3. Atomically rename it over the journal, then fsync the parent directory on
   platforms supporting directory fsync. Windows retains atomic replacement and
   file flushing; Node does not provide the same directory-fsync facility there.
4. Only after success update the in-process byte counters and append the new
   event. No backup chain accumulates; at most one pending snapshot can remain
   after a process crash.

A crash before rename leaves the old journal; a crash after rename leaves the
new snapshot. Both describe the same committed state. Any replacement error
fences that store instance until reopen, including a directory-fsync failure
after rename. A snapshot-bearing reopen syncs the parent directory before
allowing another append, so an interrupted replacement cannot be followed by
writes to an unconfirmed directory entry. An incomplete snapshot line fails
closed rather than being repaired into an empty store. Existing torn-tail repair
continues to apply only after a complete snapshot or legacy event prefix.

## Remaining native-journal and authority design

These are required follow-ups, not implemented by slice 1. Identity storage
and the native snapshot contract can be developed in parallel. HTTP and local
replay can proceed in parallel once the snapshot contract is stable; the
authority window depends on identity storage and both verified replay paths.
See the [PR2 protocol design](2026-10-26-managed-native-journal-snapshots.md)
for its implementation boundary and the lossless first payload format.

PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) is merged into the PR2 branch; [#15569](https://github.com/QwenLM/qwen-code/pull/15569) delivers native snapshot storage and [HTTP recovery](2026-10-26-managed-http-snapshot-recovery.md) together to main. These remain separate design and acceptance slices within that PR. Local lease-aware recovery, complete historical-reader migration, compact state and the authority window remain follow-ups; the combined delivery does not enable journal deletion or memory eviction.

1. **Identity storage:** move terminal bodies and deduplication evidence to a
   durable lookup/archival structure before removing them from resident maps.
   `enqueue` and `admit` must still return the original result for an old key and
   reject conflicting reuse. An expired TTL must never permit duplicate effects.
   Inbox reconciliation must still find the matching activation outcome.
2. **Native snapshot contract:** add a separate native journal snapshot publish
   and read contract under the writer's tenant/Workspace scope, revision CAS,
   lease/generation fencing, digest, and complete resource-reference closure.
   Snapshot state must include command replay and authority indexes as well as
   execution recovery state; a Harness checkpoint alone is insufficient.
3. **Native HTTP replay:** consume that native snapshot and contiguous tail.
   Migrate `WakeRecoveryStore`, original-CSI recovery/qualification, lifecycle
   cleanup, publication proofs, tool details/results, child relays, and recovery
   exports before deleting a native transaction they can still query.
4. **Local native replay:** extend `SessionWriterLease` with an ownership-checked
   replacement operation that repins inode, metadata, rolling hash, and sealed
   commit proof. Renaming a transcript directly from its journal adapter violates
   the current lease's identity proof. Publish the native snapshot durably before
   advancing a new native replay floor, separate from context-summary coverage.
   [PR4's local design](2026-10-26-managed-local-journal-snapshots.md) implements
   a one-time sealed-resume conversion with the complete prefix retained; it
   does not implement rotation, GC, compact state or bounded memory/storage.
5. **Authority window:** add durable historical lookup/read-through and migrate
   synchronous sequence-1 readers before eviction. Bound `transactions`, event
   IDs, receipt/checkpoint/domain/extension indexes, Actions, and extension
   uniqueness evidence as well as `events`. Approval/model/Plan selection,
   wake/cancel recovery, tool results, tasks, hooks, automations, channels,
   transcript projection, and SSE must preserve their historical answers.

The [local terminal-identity lookup slice](2026-10-26-managed-terminal-identity-lookup.md)
adds a derived per-key query used by terminal duplicate admission. It keeps the
journal authoritative and retains resident maps; an independently authoritative
archive and its completeness boundary remain prerequisites for eviction.

## Validation plan

- Reproduce the baseline using the globally installed CLI where supported and
  use a direct store script when the CLI does not expose these adapter methods.
- Compare every activation/message state before and after a snapshot and reopen,
  including released/finished identities, multiple Sessions, FIFO, epoch advance,
  cancelled messages, pending work, exact retries, and conflicting retries.
- Run a single activation through at least 1,024 renewals and a message through
  repeated increasing processing epochs; verify obsolete transition rows are
  replaced and latest state and fences survive reopen.
- Inject pending write/fsync, rename, and directory-fsync failures. The failed
  instance must stop; reopen must see the same accepted state, allow retry,
  preserve sequence continuity, and accept only the latest fence.
- Reject torn/checksum-invalid snapshots, repeated snapshots, duplicate IDs,
  regressed counters, impossible state combinations, and noncontiguous tails.
- Run focused activation/inbox, scheduler, admission, and store growth tests,
  then the required build, typecheck, bundle, self-audit, and code review.

## Acceptance criteria

- Both stores automatically compact redundant transitions before the next append
  once eligible, without adding an unused configuration switch.
- All existing identities, replay outcomes, ordering, and fencing survive.
- A live activation's retained renewal rows stop growing with elapsed lifetime.
- A replacement failure cannot acknowledge a new event or admit later writes
  through that failed instance.
- Terminal-identity memory/disk growth and native journal/authority work remain
  explicitly open under #13184.

## Open questions

There are no unresolved behavior choices for slice 1. The remaining work needs a
native snapshot protocol and durable historical-index storage; neither can be
substituted with the public projection snapshot or an identity TTL.
