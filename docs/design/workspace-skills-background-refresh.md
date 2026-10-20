# Workspace skills background refresh

[English](workspace-skills-background-refresh.md) | [简体中文](workspace-skills-background-refresh.zh-CN.md)

## Problem

The workspace skills facade caches a status response for five seconds. Reads
inside that window cannot observe watcher updates; the first read outside it
waits for ACP. When ACP is unavailable, replaying the retained snapshot also
resets its timestamp, hiding how old it is.

## Design

Both the primary and workspace-qualified skills inventory queries return an
existing snapshot immediately. At most once per second, measured from task
start, a query starts background revalidation. Concurrent queries reuse the
current task. Cold queries share and await that task.

Each revalidation has a five-second deadline covering ACP and local fallback.
Timeout releases the slot, so a subsequent query can retry. The ACP interface
has no cancellation signal: this deadline stops waiting, not child execution.
Only the current task in the current invalidation generation may publish;
timed-out and superseded work cannot overwrite or clear a replacement task.
Publication also checks that the owning workspace runtime generation is open.

Successful initialized observations atomically replace the snapshot. The
observation timestamp is the task start, conservatively including collection
time. Replaying retained data, failing, or timing out never resets it. A cold
read that times out returns the existing uninitialized envelope.

The optional `snapshot` response object contains `observedAt` (Unix milliseconds),
`ageMs`, `refreshing`, and `stale`. Age is recomputed per response; stale means
the last observation is at least one second old. The fields describe the daemon
observation, not the age of files or a guarantee that every session is current.
They are optional in ACP and SDK types because direct runtime/config status
responses and older daemons do not supply this metadata.

Explicit invalidation drops known-invalid inventory, clears the throttle, and
supersedes prior work. Destructive Skill deletion waits for revalidation rather
than using the immediately returned inventory. Querying status does not invoke
the session-affecting Skill refresh control command.

## Scope and constraints

The generation check covers daemon invalidation and runtime ownership. External
filesystem changes continue to rely on Skill watchers and extension source
revalidation; this change introduces no cross-process filesystem revision.
There is no idle polling, automatic session mutation, or frontend timer. Clients
can display the returned snapshot age. Existing response fields remain intact.

The affected layers are the workspace-service inventory cache and deletion
consumer, ACP/SDK status types, focused facade tests, and protocol documentation.

## Validation and acceptance

Fake-time tests must cover immediate stale responses, the exact one-second
boundary, shared long-running tasks, five-second cold/warm timeouts, retry,
late success/rejection, generation invalidation, runtime closure, clock rollback,
and unchanged age during idle fallback. Existing mutation and fallback tests
must continue to pass. Verify the built CLI HTTP endpoint without model calls.
Build, typecheck, format, and lint the affected code.

The five-second budget is an initial value. Measure normal revalidation latency
and timeout rate before changing it; slow operations must not be repeatedly
cancelled every second. A permanently unavailable runtime can retain old data,
whose increasing age remains visible.
