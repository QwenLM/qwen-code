# Managed Runtime Broker JDBC Persistence

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

Status: Implemented and verified at the repository boundary

## Problem

The Runtime Broker state foundation defines optimistic repository contracts for
Runtime bindings and logical Runtime Sessions, but its only implementations are
process-local. A Java process restart loses placement generations, Session
bindings, operation ownership, and the evidence needed to decide whether a
request may be retried. Multiple Java instances also cannot coordinate through
those implementations.

Managed tool execution adds another durable boundary. A caller must be able to
look up the original `executionCallId` after a lost response and must not create
a second physical execution for the same idempotency key.

## Current state

Before this change, the full Managed Agent branch provided immutable Runtime
scope, binding, lease, Session, and Tool execution records plus compare-and-set
repository interfaces, but no MySQL persistence. Its Hosted Harness, Java
Managed Agent server, and Runtime Broker still select the in-memory
implementations; this repository slice adds the durable implementations without
changing that production wiring yet.

## Goals

- Add durable JDBC implementations for Runtime bindings and Runtime Sessions.
- Add a durable JDBC implementation for the existing Tool execution ledger.
- Preserve the existing atomic create, generation, compare-and-set, ownership
  lease, tenant isolation, and terminal-state semantics across JVMs.
- Provide an explicit, idempotent schema initializer for the four private
  state tables, including a stable binding-allocation slot.
- Verify the repositories with two independent repository instances against an
  in-memory JDBC database and a real MySQL database.

## Non-goals

- Migrating old data; these tables are new and have no production predecessor.
- Changing the existing Runtime process lifecycle or health checks.
- Wiring the JDBC repositories into the Spring Managed Agent server or changing
  the Hosted Harness, Runtime transport, or public Agent APIs in this change.
- Cross-node SSE notification, Item/Snapshot materialization, or an Outbox.
- Sharing one Runtime between Sessions.

## Design

### Dependency boundary

The module accepts a standard `javax.sql.DataSource`. It does not depend on
Spring, a connection pool, Flyway, or a concrete JDBC driver. The embedding
service owns the DataSource and schema lifecycle. Tests provide H2 in MySQL mode
and the MySQL Connector/J driver.

JSON fields in the private Tool execution ledger use Fastjson2. They are opaque
Broker payloads and are not public Agent Event or Item resources. Reference
detection is disabled while reading so `$ref` and `@type` remain ordinary data,
and finite decimal values are written without exponent notation so persistence
does not narrow or overflow them through a floating-point conversion.

### Tables

| Table                       | Identity                                                                        | Concurrency constraints                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen_runtime_binding_slot` | immutable request hash                                                          | one locked allocation row per request; globally unique non-null Session isolation key; current active binding and last allocated generation |
| `qwen_runtime_binding`      | `binding_id`; immutable request hash plus generation                            | unique monotonically increasing generation; version and operation generation fencing                                                        |
| `qwen_runtime_session`      | globally unique public `runtime_session_id`                                     | atomic create; version compare-and-set; immutable scope, binding generation, and Session identity                                           |
| `qwen_tool_execution`       | hashed plus full `execution_call_id`; unique hashed plus full `idempotency_key` | atomic idempotent create; version compare-and-set; dispatch owner, expiry, and generation fencing                                           |

Request and scope hashes are SHA-256 indexes over length-prefixed immutable
fields. The original fields remain in each row and are reconstructed and
compared after reads, so a hash collision fails closed instead of merging two
identities.

The stable `qwen_runtime_binding_slot` row is locked before allocation or a
terminal transition. It stores the last allocated generation and the current
active binding identifier. Historical terminal bindings remain in
`qwen_runtime_binding`, while the locked slot prevents two active generations
without relying on an unlocked aggregate query.

### Transaction semantics

- Runtime binding `findOrCreate` inserts the stable slot if needed, locks it
  with `SELECT ... FOR UPDATE`, returns its active binding when present, or
  atomically increments the stored generation and assigns a new binding.
- Runtime Session and Tool execution `findOrCreate` use database uniqueness;
  a unique-key race is resolved by rereading and validating the winning row.
- Mutable operations lock the row with `SELECT ... FOR UPDATE`, validate the
  current version and immutable identity, and update the version in the same
  transaction.
- Operation and dispatch claims read the database clock and persist UTC
  microsecond timestamps. An expired claim can be taken over only by
  incrementing its fencing generation, so JVM clock drift cannot elect an
  owner.
- Terminal Runtime bindings and Sessions cannot be reactivated. Settled Tool
  executions cannot be redispatched.
- SQL failures roll back and surface as repository failures; the adapter never
  silently falls back to process memory.

### Tool execution identity

The Tool execution record binds the stable idempotency key to the Runtime
binding generation, Harness Session, Runtime Session, Turn, Tool call, request
digest, and immutable invocation reference. A duplicate idempotency key returns
the original record so the caller can compare the request and reject changed
content. Lost or ambiguous dispatches remain queryable by the original
`executionCallId`. Both execution and idempotency identifiers use SHA-256 keys
for bounded, case-sensitive indexing under any database collation, while every
lookup verifies the complete identifier and fails closed on a collision.

### Schema lifecycle

`JdbcRuntimeBrokerSchema.initialize(DataSource)` creates only the four new
tables and indexes and is safe to call repeatedly. It does not alter existing
tables or import process-local state. Production deployments may execute the
same bundled SQL through their normal schema-management system instead of the
initializer.

## Security and tenancy

Tenant, workspace, workspace generation, canonical working directory,
capability digest, and isolation class remain part of the persisted scope. The
public Session UUID is globally unique and is the Runtime Session primary key;
an attempt to reuse it with another Harness or scope is rejected.
Session-isolated bindings use that same UUID as their unique isolation key;
workspace-isolated bindings keep the key null. The JDBC adapter does not
authenticate those values; the Java control plane must derive them from its
trusted admission context.

Tool execution methods intentionally do not accept a separate tenant or
workspace argument. The embedding service must derive globally unique
execution and idempotency identifiers from authenticated tenant, workspace,
and Session context; an untrusted identifier alone is never authorization.

Runtime endpoint tokens are private control-plane credentials. The schema
stores them because restart recovery requires the original lease, but the
embedding service must use encrypted storage or database-level encryption and
must not expose rows through public APIs or logs.

## Recovery boundary

Persisting Broker state does not prove that a local Runtime process can be
adopted after a Java restart. A persisted `READY` binding may point to a process
that the previous Java instance stopped. Production integration must health
check and reconcile that lease before reuse, and local-process recovery still
needs a durable provision seed, process adoption or reprovisioning, and a
Session rebind policy for dead bindings. Until then, this implementation proves
shared state, fencing, and execution idempotency only.

## Validation

- Run the existing Runtime Broker lifecycle suite and strengthened in-memory
  repository tests.
- Run JDBC contract tests with two repository objects sharing one H2 database
  in MySQL mode.
- Run the same durable create, CAS, lease takeover, tenant isolation, Session
  accounting, execution idempotency, and restart-read scenarios against a real
  MySQL database.
- Run Maven tests, Checkstyle, and package verification on JDK 21 with the
  module's Java 11 release target.

## Acceptance criteria

- Two JVM-equivalent repository instances converge on one active binding and
  one Tool execution for the same keys.
- A newly constructed repository instance can read and mutate records created
  by a prior instance.
- Stale versions, stale operation generations, and stale dispatch generations
  cannot mutate current state.
- Tenant and workspace identity cannot be replaced by identifier collisions.
- A terminal binding or Session cannot be reactivated, and a settled execution
  cannot be redispatched.
- Schema initialization is repeatable and does not modify unrelated tables.
- Default tests and a real-MySQL integration profile pass without adding a
  Spring dependency.

Verified on 2026-09-20 with JDK 21.0.8 and the Java 11 release target: the
in-memory suite and H2 JDBC contract passed; the same JDBC contract passed
through the `mysql-integration` profile against a disposable local MySQL
database; Checkstyle reported zero violations. The contract uses independently
constructed Repository objects and 32-way concurrent binding and execution
creation.

## Follow-up integration

After this change, the Managed Agent server can inject these repositories into
`RuntimeBrokerService` from its Spring DataSource. The next integration slice
must remove the production InMemory wiring, run two Java processes against one
MySQL database, reconcile stale Runtime leases after restart, recover the
original execution, and then add the delayed-Runtime TTFT scenario. That
integration must depend on this durable source of truth rather than add another
state store. The scheduler-neutral endpoint, resource-handle, and recovery
contract for that slice is specified in
[Managed Runtime Endpoint Persistence and Recovery](2026-09-21-managed-runtime-endpoint-recovery.md).
