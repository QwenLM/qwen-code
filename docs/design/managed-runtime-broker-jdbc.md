# Managed Runtime Broker JDBC Persistence

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

Status: Implemented and verified at the repository boundary

## Problem

The managed runtime broker foundation defines Runtime Binding, Runtime Session, and Tool Execution state, but its Tool Execution implementation is process-local. A restart loses execution identity, dispatch ownership, cancellation intent, `UNKNOWN` recovery state, and settled results. Multiple broker processes also cannot coordinate an at-most-once dispatch boundary through a shared source of truth.

## Goals

- Persist runtime bindings, runtime sessions, and tool executions through JDBC.
- Preserve atomic binding creation, binding generation fencing, compare-and-set updates, operation leases, tenant and workspace isolation for Binding and Session state, and terminal session semantics.
- Preserve idempotent Tool Execution creation, dispatch owner and generation fencing, database-clock leases, cancellation intent, `UNKNOWN` reconciliation, and settled results.
- Initialize the private broker schema idempotently.
- Verify the same repository contract against H2 and a real MySQL instance.

## Non-goals

- Starting, stopping, or otherwise managing runtime processes.
- Integrating the repositories into the Harness, Spring wiring, transport layer, or public API.
- Dispatching a Tool call or resolving an `UNKNOWN` execution automatically.
- Delivering events through SSE, an outbox, MQ, or Redis.
- Sharing one managed runtime across unrelated workspaces.

## Dependency boundary

The JDBC repositories use `javax.sql.DataSource` for database access and fastjson2 (2.0.60) as the JSON codec for the `reference_json`/`result_json` columns. Opaque Tool payloads disable fastjson2 reference detection so `$ref` and `@type` members remain data, and finite `BigDecimal` values are written without exponent notation so the reader cannot narrow or overflow them as doubles. They do not choose a connection pool, require Spring, manage database migrations through a framework, or bundle a production database driver. The test profile supplies H2 for the default repository contract and MySQL Connector/J for the optional MySQL integration test.

## Schema

The broker owns four private tables:

- `qwen_runtime_binding_slot` serializes creation for one hashed runtime scope.
- `qwen_runtime_binding` stores the current runtime binding, generation, endpoint, operation lease, lifecycle state, and optimistic version.
- `qwen_runtime_session` stores runtime sessions and their terminal state under a binding generation.
- `qwen_tool_execution` stores one durable Tool Execution per globally unique idempotency key, including immutable request identity, dispatch fencing, cancellation intent, `UNKNOWN` state, and the settled result. Execution-call and idempotency identifiers use deterministic hashes for case-sensitive lookup under any database collation, while each lookup verifies the complete identifier.

Scope identity is represented by a deterministic hash and is always checked together with the full tenant-scoped identity. Endpoint tokens remain encrypted or opaque values supplied by the caller; the repository does not log or transform them.

## Transaction and concurrency semantics

Binding creation locks the scope slot, re-reads the binding inside the transaction, and inserts exactly one active record for that scope. Binding updates use the stored version and generation as fences. Operation leases use the database clock so competing JVMs do not depend on synchronized local clocks. The JDBC adapter converts the database clock to precise Unix epoch time in the query, preventing the connection's session time zone from shifting lease instants. Lease decisions use that precise clock, while each persisted lease deadline is rounded up to a whole second so it remains live for at least its configured duration and round-trips consistently through MySQL-compatible drivers that discard fractional seconds.

Session creation relies on the database uniqueness constraint and re-reads the winning record after a concurrent insert. Session compare-and-set updates lock the current row, validate the expected version and binding generation, and reject any attempt to reactivate a terminal session. SQL failures roll back the transaction and propagate to the caller; there is no silent fallback to process-local state.

Tool Execution creation uses a unique SHA-256 key for bounded database indexing while retaining and verifying the full idempotency key. Mutations lock the execution row. Compare-and-set and `UNKNOWN` reconciliation validate the supplied immutable identity and version; cancellation validates the expected version; dispatch claim and renewal validate the applicable owner, generation, and lease fences. Dispatch leases use the same precise database-clock decisions and rounded whole-second persisted deadlines as operation leases. An expired `DISPATCHING` claim can be reissued because physical execution has not started; an expired `EXECUTING` or `CANCEL_REQUESTED` claim becomes `UNKNOWN` and cannot be dispatched again until an explicit reconciliation result settles it.

## Schema lifecycle

Schema initialization executes idempotent `CREATE TABLE IF NOT EXISTS` statements for the four broker-owned tables. This is sufficient for the current private module boundary. A later server integration must define how migrations are versioned and deployed before these repositories become production wiring.

## Recovery boundary

A durable binding or session row proves only that broker state survived. It does not prove that the referenced runtime process is live. Likewise, an `UNKNOWN` Tool Execution records uncertainty rather than proving whether the side effect happened. Process reconciliation and transport health checks remain responsibilities of the later runtime integration. On-demand execution reconciliation asks the original Runtime and settles through `resolveUnknown` only on its terminal evidence; see the UNKNOWN reconciliation section of `managed-runtime-broker-service-core.md`.

## Security and tenancy

Binding and Session lookups and mutations are constrained by the complete Runtime Scope or an identity created from it. Tool Execution methods accept opaque execution, idempotency, and Runtime Session identifiers without a separate tenant or workspace argument. The embedding service must derive globally unique identifiers from authenticated tenant, workspace, and session context before calling this repository and must never accept an untrusted identifier as sufficient authorization. Within this precondition, the unique keys prevent cross-scope aliasing; the Tool Execution repository does not independently enforce tenant or workspace scope. The Binding and Session repositories never search for a compatible binding in another tenant or workspace, and no repository falls back to a primary runtime when state is missing or ambiguous.

## Validation

The repository contract covers:

- concurrent creation of one binding per scope;
- reconstruction through a new repository instance;
- stale version and stale generation rejection;
- operation lease ownership and takeover after expiry;
- tenant and workspace isolation for Binding and Session state;
- concurrent session creation;
- terminal sessions that cannot be reactivated;
- concurrent idempotent Tool Execution creation across repository instances;
- dispatch claim, renewal, cancellation, expired-owner fencing, and `UNKNOWN` reconciliation;
- settled result reconstruction through a new repository instance; and
- repeatable schema initialization.

The default test suite runs the contract on H2 in MySQL compatibility mode. CI also runs the `mysql-integration` Maven profile against MariaDB through MySQL Connector/J so session-time-zone handling and persisted lease round trips are exercised on a real MySQL-compatible protocol. The same profile can be run locally against a caller-supplied MySQL database.

## Acceptance criteria

- Multiple repository instances coordinate through the database and observe one active binding for a scope.
- Binding and session state survives repository reconstruction.
- Stale owners cannot mutate a newer binding generation or version.
- Expired operation leases can be taken over while live leases remain fenced.
- Binding and Session state remains isolated by tenant and workspace.
- Tool Execution identifiers are globally unique and namespace-bound to authenticated tenant, workspace, and session context by the embedding service.
- Terminal sessions cannot return to a non-terminal state.
- Concurrent callers observe one Tool Execution for an idempotency key.
- A live dispatch lease rejects another owner, while an expired executing claim becomes `UNKNOWN` instead of being replayed.
- Cancellation intent and settled Tool results survive repository reconstruction.
- Schema initialization is safe to repeat.
- The H2 contract and the CI real-MySQL-compatible contract pass without process-local fallback.

## Follow-up work

Server wiring, process reconciliation, takeover scans of `UNKNOWN` executions, schema migration deployment, and multi-process end-to-end validation remain follow-up work.
