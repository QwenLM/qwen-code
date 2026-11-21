# Workspace skills background refresh

[English](workspace-skills-background-refresh.md) | [简体中文](workspace-skills-background-refresh.zh-CN.md)

## Problem

The previous [workspace skills read model](workspace-skills-read-model.md)
caches a status response for five seconds. Reads
inside that window cannot observe watcher updates; the first read outside it
waits for ACP. When ACP is unavailable, replaying the retained snapshot also
resets its timestamp, hiding how old it is.

## Design

Both the primary and workspace-qualified skills inventory queries return an
existing snapshot immediately. At most once per second, measured from task
start, a query starts background revalidation. Concurrent queries reuse the
current task. Cold queries share and await a foreground observation. If a cold
observation fails within one second of its start, ordinary reads
return an unavailable status for the remainder of that window. A slower failure
leaves no throttle window; clients must apply their own retry backoff.

Warm background revalidation releases its shared slot after five seconds so a
subsequent query can retry. This stops waiting, not observation or child execution.
Cold observations and mutation reads instead await ACP's configured request
timeout (ten seconds by default), then daemon-local enumeration if ACP is
unavailable. There is no facade deadline on that foreground sequence: a slow
but successful ACP or local result must remain usable.

A successful observation may publish after its slot times out, even while a
retry is pending. Publication requires the same invalidation generation, an
open owning workspace runtime, and a read start sequence newer than the last
published observation. Sequence numbers, rather than wall-clock timestamps,
prevent late results from replacing newer observations during clock rollback.
Invalidated observations cannot publish. Only the task occupying the shared
slot may clear it. A superseded successful cold read returns a newer retained
snapshot when one exists; otherwise it returns its own uncached observation
without snapshot metadata.

Only initialized observations without errors atomically replace the snapshot. The
observation timestamp is the task start, conservatively including collection
time. Replaying retained data, failing, or releasing a slot never resets it;
a later successful publication records that observation's start time. When
neither source can enumerate, cold reads return `initialized: false` with an
error and no snapshot. Clients must treat this as unavailable and retryable,
not as an initialized empty inventory.

The optional `snapshot` response object contains `observedAt` (Unix milliseconds),
`ageMs`, `refreshing`, and `stale`. Age is recomputed per response; stale means
the last observation is at least one second old. `refreshing` reports occupancy
of the shared slot, excluding work that continues after slot timeout.
The fields describe the daemon
observation, not the age of files or a guarantee that every session is current.
They are optional in ACP and SDK types: only responses carrying a retained
daemon observation supply this metadata. For example, direct runtime/config
status, session resource inventories, and older daemons omit it.

Explicit invalidation drops known-invalid inventory, clears the throttle, and
supersedes prior work. A successful explicit ACP preheat that completes before
its timeout also invalidates the retained snapshot, even if the child was
already live, allowing the next inventory read to see the child. A preheat that
times out and then finds the channel live reports success but keeps the
retained snapshot, because startup may still be incomplete; the next read
serves that retained data and background revalidation replaces it once the
one-second start throttle allows.
Destructive Skill deletion and Skill-toggle identity resolution bypass both
the retained snapshot and read throttling. They await an independent observation
and try local enumeration if ACP is unavailable, even if a snapshot exists;
only when both fresh sources fail does the retained snapshot answer instead of
degrading identity resolution to the legacy name heuristic.
That foreground fallback invalidates the local enumerator's cache so it observes
out-of-band installations, while preserving the retained facade snapshot.
A refused runtime deletion leaves retained inventory intact; successful
mutations still invalidate it. Querying status does not invoke the
session-affecting Skill refresh control command.

## Scope and constraints

Generation and publication order guard the snapshot; task identity guards slot
cleanup, and a separate runtime guard checks ownership. External
filesystem changes continue to rely on Skill watchers and extension source
revalidation; this change introduces no cross-process filesystem revision.
There is no idle polling, automatic session mutation, or frontend timer. Clients
can display the returned snapshot age. Existing response fields remain intact.

The affected layers are the workspace-service inventory cache and deletion
consumer, ACP/SDK status types, focused facade tests, and protocol documentation.

## Validation and acceptance

Fake-time tests must cover immediate stale responses, the exact one-second
boundary, shared cold observations beyond five seconds, five-second background
timeouts, ACP timeout followed by slow local fallback, retry, late background
success/rejection, changing six-second observations under continuous polling,
out-of-order completion, invalidation, runtime closure, clock rollback, and unchanged
age during idle fallback. Cover concurrent different-name deletions, refused
deletion retention, cold-throttled single/batch enables, and post-preheat reads.
Existing mutation and fallback tests
must continue to pass. Verify the built CLI HTTP endpoint without model calls.
Build, typecheck, format, and lint the affected code.

The five-second budget is an initial value. Measure normal revalidation latency
and timeout rate before changing it; slow operations must not be repeatedly
cancelled every second. A permanently unavailable runtime can retain old data,
whose increasing age remains visible.
