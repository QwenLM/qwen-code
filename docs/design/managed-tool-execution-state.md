# Managed Tool Execution State

[English](managed-tool-execution-state.md) | [简体中文](managed-tool-execution-state.zh-CN.md)

Status: Implemented at the in-memory and JDBC repository boundaries

## Problem

The Runtime Broker state foundation can identify Runtime bindings and logical
Runtime Sessions, but it cannot identify one Tool call across retries. A lost
dispatch response must not cause a second physical execution, and a caller
must be able to query the original execution while its outcome is unknown.

## Goals

- Define the immutable identity and mutable lifecycle of one Tool execution.
- Converge concurrent creation through a stable idempotency key.
- Fence dispatch ownership with an owner, expiry, and monotonically increasing
  generation.
- Protect updates with optimistic compare-and-set versions.
- Preserve cancellation intent, ambiguous outcomes, ordered result progress,
  and the final result.
- Provide a synchronized in-memory repository for tests and single-process
  prototypes.

## Non-goals

- Dispatching a Tool call or communicating with a Runtime.
- Defining public Agent Event, Item, or API schemas.
- Recovering or reprovisioning Runtime processes.
- Sharing one Runtime between Sessions.

## Record identity

`ToolExecutionRecord` binds `executionCallId` and `idempotencyKey` to the
Runtime binding generation, Harness Session, Runtime Session, Turn, Tool call,
request digest, and immutable invocation reference. The reference must repeat
the Session, Prompt, call, and argument-digest identity so malformed records
fail at construction time.

The idempotency key is the convergence key. `findOrCreate` returns the first
record stored for that key, including when a later candidate carries different
request identity. The caller can compare the returned record with the
candidate and reject changed content without creating another execution. A
reused `executionCallId` with a different idempotency key is rejected.

## Lifecycle and fencing

The record exposes `PREPARED`, `DISPATCHING`, `EXECUTING`,
`CANCEL_REQUESTED`, `SETTLED`, and `UNKNOWN` states. Repository mutations
split into three shapes: a fenced dispatch path, an open cancellation path,
and a claim-less recovery path.

The fenced path is `compareAndSet`. The caller presents its own dispatch
owner and generation alongside the `expected` snapshot; the write succeeds
only while the stored record matches that snapshot on immutable identity,
claim and version, the presented owner and generation match the stored claim,
the lease is unexpired, and the record is neither `SETTLED` nor `UNKNOWN`. A
replacement must repeat the claim fields, can never move or drop dispatch
ownership, must not regress the result sequence, and must not clear a
recorded cancellation request. The fence defeats stale-but-honest dispatchers
presenting their own token; it is not a defence against hostile in-process
callers that copy the claim out of a fresh read. Settlement (`withResult`),
dispatcher state transitions, and dispatcher-reported `UNKNOWN` outcomes all
use this path, so on the fenced path a former owner whose claim expired or
was taken over cannot settle or mutate the execution.

The fenced path also enforces transition legality: a write never moves an
execution back to `PREPARED`, and only a record already `DISPATCHING` may be
re-written as `DISPATCHING`. The legal transitions are `PREPARED` →
`DISPATCHING` (claim), `DISPATCHING` → `EXECUTING` (the dispatcher marks the
record before the Runtime may physically start the Tool call — this ordering
is what makes re-dispatching a taken-over `DISPATCHING` record safe),
`EXECUTING` → `CANCEL_REQUESTED`, `DISPATCHING` / `EXECUTING` /
`CANCEL_REQUESTED` → `SETTLED` or `UNKNOWN`, and `UNKNOWN` → `SETTLED`
(recovery). The repository rejects every other move.

Dispatch ownership moves only through `claimDispatch` and `renewDispatch`. A
live claim blocks another owner. After expiry, a new owner increments the
generation, making updates from the former owner stale; this takeover rule
applies only to records whose execution never reached the Runtime. Taking
over an `EXECUTING` or `CANCEL_REQUESTED` record never re-dispatches it: the
physical Tool call may still be running, so the record transitions to
`UNKNOWN`, keeps the expired claim for attestation, and grants no ownership.
`UNKNOWN` records cannot be claimed or renewed. Lease expiry is decided by
the repository's clock; a multi-instance adapter must evaluate it in the
database, not in the application process.

The open path is `requestCancel`, which records cancellation intent with only
the record version because cancellation originates outside dispatch
ownership. A `PREPARED` execution settles as `cancelled` immediately since no
dispatcher exists to observe the intent. A `DISPATCHING` record keeps its
state so the claim holder sees the flag and must not start physical
execution. An `EXECUTING` record transitions to `CANCEL_REQUESTED`. On an
`UNKNOWN` record the intent is recorded (flag set, version advanced) without
settling it, so an in-flight `resolveUnknown` snapshot is invalidated and
must be re-read. Cancellation intent is advisory until the claim holder
settles with the actual result or with physical stop evidence.

The recovery path is `resolveUnknown`, the only exit from `UNKNOWN`. It
requires the complete immutable identity, the current record version and
state `UNKNOWN`, and deliberately no dispatch claim: a takeover-fenced
record's claim is expired by construction, so an adapter must not add a lease
predicate to it. The settled record retains the last claim for attestation.

A settled record requires an allowed execution status, result, and settlement
time and is immutable after settlement. Result sequence numbers cannot move
backwards. Active-execution queries are scoped to a Runtime Session and exclude
settled records.

## Concurrency boundary

`InMemoryToolExecutionRepository` synchronizes every compound operation. It is
a reference implementation for one process, not a multi-JVM coordination
mechanism. A later JDBC adapter must preserve the same identity, idempotency,
version, lease, transition-legality, and fencing semantics through database
constraints and row locking.

## Security and tenancy

The record retains the binding and Session identities supplied by the trusted
Broker layer. It does not authenticate tenant or workspace values on its own.
The invocation reference and result are private Broker payloads and must not be
logged or exposed as public API resources without a separate projection and
redaction contract.

## Validation

- Concurrent creation converges on one execution for one idempotency key.
- A live dispatch claim excludes another owner; an expired claim on a record
  that never reached the Runtime can be taken over only with a higher
  generation.
- Settlement and dispatcher mutations require the caller to present the
  stored owner and generation with an unexpired lease; a stale owner
  presenting its old generation, or a caller that never claimed, is rejected
  even at the current record version.
- State transitions never move backwards toward `PREPARED`, and only a
  `DISPATCHING` record may be re-written as `DISPATCHING`; the dispatcher's
  own `EXECUTING` → `UNKNOWN` report stays legal.
- Taking over an expired `EXECUTING` or `CANCEL_REQUESTED` claim marks the
  execution `UNKNOWN` instead of re-dispatching it; only `resolveUnknown`
  settles it.
- Cancellation intent does not require the dispatch claim, settles a
  never-dispatched execution immediately, survives ownership takeover, and
  cannot be dropped by a later replacement.
- Result sequence numbers cannot regress, at creation or through
  compare-and-set.
- Settlement removes the execution from active Session accounting.
- A duplicate idempotency key returns the original identity for conflict
  detection.
- Maven tests, Checkstyle, and package verification pass with Java 21.

## Acceptance criteria

- The repository never creates two records for one idempotency key.
- Dispatch ownership cannot be renewed or mutated with a stale generation.
- On the fenced path, a caller that does not present the stored dispatch
  owner and generation cannot settle or mutate the execution.
- An expired `EXECUTING` or `CANCEL_REQUESTED` claim transitions to
  `UNKNOWN` instead of a new dispatch.
- Cancellation intent is recordable without the dispatch claim and survives
  ownership takeover.
- Immutable execution identity cannot be replaced through compare-and-set.
- A settled execution cannot be changed or reactivated.
- Result status, sequence, and settlement invariants fail closed.
- The in-memory repository boundary introduces no JDBC, Runtime transport,
  Hosted Harness, Spring, or public API dependency.

## Follow-up work

The JDBC implementation of this contract lives in
`JdbcToolExecutionRepository`; see `managed-runtime-broker-jdbc.md`. Runtime
dispatch integration must query the original `executionCallId` after an
ambiguous response instead of replaying the Tool call.
