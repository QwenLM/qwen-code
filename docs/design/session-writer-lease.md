# Session writer lease and consistent recovery

## Problem

Session transcripts are append-only JSONL trees. Before this change, write
serialization was process-local: two processes could restore the same physical
tail, then append different children. Both writes succeeded, but the next
restore could reconstruct only one branch. A response already shown to the user
could therefore disappear after restart.

## Invariants

1. At most one process owns write access to a `(runtime base, session id)`.
2. A writer reloads the transcript after acquiring ownership; preloaded session
   data is only a UI preview.
3. Every append verifies both ownership and the expected physical byte length.
4. The runtime base and session id used by a recorder are immutable. Its
   transcript path changes only during an explicit lease-held workspace
   migration.
5. A session transition keeps the old binding recoverable until the new Core
   and UI state are committed.
6. Offline mutations acquire the same lease and fail closed on live sessions.

## Lease

The lock lives at
`<runtimeBase>/tmp/session-writer-locks/<sessionId>.lock`, independent of the
project directory and archive state. It is created atomically with `wx` and
mode `0600`. Its random `owner_id` is the fencing token.

A live local PID with the same process start time and every foreign-host owner
cause a conflict. A dead or reused local PID is moved aside atomically, re-read,
and reclaimed only after the moved record is proved stale. A malformed record
is retried to tolerate an in-progress write; young or otherwise unverifiable
records fail closed. Runtime sidecars apply the same start-time check before a
reused PID can keep a malformed lock alive.
Release removes the lock only when its on-disk `owner_id` still matches.

Each lease tracks the transcript's expected UTF-8 byte length. Appends validate
the current lock and file length, append one buffered JSON line with flush, and
advance the expected length only after success. Ownership loss and unexpected
length changes are integrity failures, distinct from ordinary recording I/O
degradation.

## Lifecycle and recovery

`Config.initialize()` activates recording before model initialization. It
acquires the lease, captures the byte length, reloads the complete JSONL under
the lease, verifies that the length did not change, and rebases the recorder on
that authoritative history. Initialization and target-Core construction run in
the target session's async context. Inputs and owner-bearing runtime sidecars
are enabled only after activation; read-only Configs do not publish sidecars.

Recorders move through inactive, active, paused, closed, or integrity-failed
states. Pausing synchronously refuses new records and cancels auto-title work,
then drains the existing write chain before ownership can be released.
Integrity failure rejects subsequent model turns while leaving recovery
commands available.

Session transitions are prepare/commit/rollback operations. Preparation pauses
the old recorder without releasing it, acquires and loads the target, and
constructs target state. Commit changes Core and UI state together and releases
the old owner afterward. Any pre-commit error restores the exact old recorder,
client, and session state; an uncertain rollback closes both sides. Destructive
cleanup of old background registries happens only after commit, so a UI commit
failure cannot erase state that rollback must preserve. Resume rechecks the
background-work gate after its asynchronous preview load, and branch requires
an idle, healthy source.

## Maintenance operations

Offline rename, remove, archive, unarchive, and fork acquire temporary
maintenance leases. A live source fork uses the paused recorder's stable
snapshot; an offline fork reads its leased source once. Project relocation
keeps the global lease and uses same-filesystem atomic rename only.

Runtime status sidecars include an optional owner token. Live-session cleanup
removes a sidecar only when that token still matches; offline maintenance
cleanup is instead protected by the session writer lease. Read-only or
auxiliary Config instances explicitly disable chat recording. ACP runs the
complete Config load/initialize sequence inside the selected runtime-output
context and pins that resolved root on the live Session. ACP's textual
`/clear` is not advertised because the protocol cannot atomically commit a
changed session id; clients close and create a session explicitly instead.

## Compatibility and rollout

Old binaries do not honor this lock. Deployments and rollbacks must drain all
old daemons and interactive processes before changing binaries. There is no
feature flag and no automatic repair or branch selection for already-diverged
transcripts.
