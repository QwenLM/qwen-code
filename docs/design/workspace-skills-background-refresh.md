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
current task. Cold queries share and await a foreground observation. Following a
failed cold observation, ordinary reads inside the one-second throttle window
return an unavailable status without starting another query.

Warm background revalidation has a five-second deadline. Timeout releases the
slot so a subsequent query can retry. This stops waiting, not child execution.
Cold observations and mutation reads instead await ACP's configured request
timeout (ten seconds by default), then daemon-local enumeration if ACP is
unavailable. There is no facade deadline on that foreground sequence: a slow
but successful ACP or local result must remain usable.

Only the current task may publish; the generation check is deliberately
redundant with task identity. Timed-out background work and superseded work
cannot overwrite or clear a replacement task. Superseded successful cold
observations can still answer their original callers without being cached.
Publication also checks that the owning workspace runtime generation is open.

Successful initialized observations atomically replace the snapshot. The
observation timestamp is the task start, conservatively including collection
time. Replaying retained data, failing, or timing out never resets it. When
neither source can enumerate, cold reads return `initialized: false` with an
error and no snapshot. Clients must treat this as unavailable and retryable,
not as an initialized empty inventory.

The optional `snapshot` response object contains `observedAt` (Unix milliseconds),
`ageMs`, `refreshing`, and `stale`. Age is recomputed per response; stale means
the last observation is at least one second old. The fields describe the daemon
observation, not the age of files or a guarantee that every session is current.
They are optional in ACP and SDK types because direct runtime/config status
responses and older daemons do not supply this metadata.

Explicit invalidation drops known-invalid inventory, clears the throttle, and
supersedes prior work. Successful explicit ACP preheat also invalidates the
pre-child snapshot, allowing the next inventory read to see the child.
Destructive Skill deletion and Skill-toggle identity resolution bypass both
the retained snapshot and read throttling. They await an independent observation
and try local enumeration if ACP is unavailable, even if a snapshot exists.
That foreground fallback invalidates the local enumerator's cache so it observes
out-of-band installations, while preserving the retained facade snapshot.
A refused runtime deletion leaves retained inventory intact; successful
mutations still invalidate it. Querying status does not invoke the
session-affecting Skill refresh control command.

## Scope and constraints

Task identity enforces supersession; a separate runtime guard checks ownership. External
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
success/rejection, invalidation, runtime closure, clock rollback, and unchanged
age during idle fallback. Cover concurrent different-name deletions, refused
deletion retention, cold-throttled single/batch enables, and post-preheat reads.
Existing mutation and fallback tests
must continue to pass. Verify the built CLI HTTP endpoint without model calls.
Build, typecheck, format, and lint the affected code.

The five-second budget is an initial value. Measure normal revalidation latency
and timeout rate before changing it; slow operations must not be repeatedly
cancelled every second. A permanently unavailable runtime can retain old data,
whose increasing age remains visible.
