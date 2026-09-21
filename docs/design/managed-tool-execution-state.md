# Managed Tool Execution State

[English](managed-tool-execution-state.md) | [简体中文](managed-tool-execution-state.zh-CN.md)

Status: Implemented at the in-memory repository boundary

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

- JDBC or MySQL persistence.
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
`CANCEL_REQUESTED`, `SETTLED`, and `UNKNOWN` states. Repository mutations use
the complete immutable identity plus a record version for compare-and-set.

A dispatch claim has an owner, an expiry, and a generation. A live claim blocks
another owner. After expiry, a new owner increments the generation, making
updates from the former owner stale. Renewal preserves the generation and
increments the record version. `UNKNOWN` records cannot be claimed until a
caller resolves the ambiguous outcome through the original execution identity.

A settled record requires an allowed execution status, result, and settlement
time and is immutable after settlement. Result sequence numbers cannot move
backwards. Active-execution queries are scoped to a Runtime Session and exclude
settled records.

## Concurrency boundary

`InMemoryToolExecutionRepository` synchronizes every compound operation. It is
a reference implementation for one process, not a multi-JVM coordination
mechanism. A later JDBC adapter must preserve the same identity, idempotency,
version, lease, and fencing semantics through database constraints and row
locking.

## Security and tenancy

The record retains the binding and Session identities supplied by the trusted
Broker layer. It does not authenticate tenant or workspace values on its own.
The invocation reference and result are private Broker payloads and must not be
logged or exposed as public API resources without a separate projection and
redaction contract.

## Validation

- Concurrent creation converges on one execution for one idempotency key.
- A live dispatch claim excludes another owner; an expired claim can be taken
  over only with a higher generation.
- Stale versions cannot settle the current execution.
- Settlement removes the execution from active Session accounting.
- A duplicate idempotency key returns the original identity for conflict
  detection.
- Maven tests, Checkstyle, and package verification pass with Java 21.

## Acceptance criteria

- The repository never creates two records for one idempotency key.
- Dispatch ownership cannot be renewed or mutated with a stale generation.
- Immutable execution identity cannot be replaced through compare-and-set.
- A settled execution cannot be changed or reactivated.
- Result status, sequence, and settlement invariants fail closed.
- No JDBC, Runtime transport, Hosted Harness, Spring, or public API dependency
  is introduced.

## Follow-up work

Add a separate JDBC implementation that persists the same contract and proves
cross-instance convergence against MySQL. Runtime dispatch integration must
query the original `executionCallId` after an ambiguous response instead of
replaying the Tool call.
