# Managed Runtime Broker JDBC Persistence

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

Status: Implemented and verified at the repository boundary

## Problem

The managed runtime broker foundation currently stores runtime bindings and runtime sessions in process memory. A process restart loses that state, and multiple broker processes cannot coordinate ownership through a shared source of truth.

## Goals

- Persist runtime bindings and runtime sessions through JDBC.
- Preserve atomic binding creation, binding generation fencing, compare-and-set updates, operation leases, tenant isolation, and terminal session semantics.
- Initialize the private broker schema idempotently.
- Verify the same repository contract against H2 and a real MySQL instance.

## Non-goals

- Persisting the tool execution ledger.
- Starting, stopping, or otherwise managing runtime processes.
- Integrating the repositories into the Harness, Spring wiring, transport layer, or public API.
- Delivering events through SSE, an outbox, MQ, or Redis.
- Sharing one managed runtime across unrelated workspaces.

## Dependency boundary

The JDBC repositories depend only on `javax.sql.DataSource`. They do not choose a connection pool, require Spring, manage database migrations through a framework, or bundle a production database driver. The test profile supplies H2 for the default repository contract and MySQL Connector/J for the optional MySQL integration test.

## Schema

The broker owns three private tables:

- `qwen_runtime_binding_slot` serializes creation for one hashed runtime scope.
- `qwen_runtime_binding` stores the current runtime binding, generation, endpoint, operation lease, lifecycle state, and optimistic version.
- `qwen_runtime_session` stores runtime sessions and their terminal state under a binding generation.

Scope identity is represented by a deterministic hash and is always checked together with the full tenant-scoped identity. Endpoint tokens remain encrypted or opaque values supplied by the caller; the repository does not log or transform them.

## Transaction and concurrency semantics

Binding creation locks the scope slot, re-reads the binding inside the transaction, and inserts exactly one active record for that scope. Binding updates use the stored version and generation as fences. Operation leases use the database clock so competing JVMs do not depend on synchronized local clocks.

Session creation relies on the database uniqueness constraint and re-reads the winning record after a concurrent insert. Session compare-and-set updates lock the current row, validate the expected version and binding generation, and reject any attempt to reactivate a terminal session. SQL failures roll back the transaction and propagate to the caller; there is no silent fallback to process-local state.

## Schema lifecycle

Schema initialization executes idempotent `CREATE TABLE IF NOT EXISTS` statements for the three broker-owned tables. This is sufficient for the current private module boundary. A later server integration must define how migrations are versioned and deployed before these repositories become production wiring.

## Recovery boundary

A durable binding or session row proves only that broker state survived. It does not prove that the referenced runtime process is live. Process reconciliation and transport health checks remain responsibilities of the later runtime integration.

## Security and tenancy

Every lookup and mutation is constrained by the complete runtime scope or the binding/session identity that was created from it. The repositories never search for a compatible binding in another tenant or workspace, and they never fall back to a primary runtime when state is missing or ambiguous.

## Validation

The repository contract covers:

- concurrent creation of one binding per scope;
- reconstruction through a new repository instance;
- stale version and stale generation rejection;
- operation lease ownership and takeover after expiry;
- tenant and workspace isolation;
- concurrent session creation;
- terminal sessions that cannot be reactivated; and
- repeatable schema initialization.

The default test suite runs the contract on H2 in MySQL compatibility mode. The optional `mysql-integration` Maven profile runs the same contract against a caller-supplied MySQL database.

## Acceptance criteria

- Multiple repository instances coordinate through the database and observe one active binding for a scope.
- Binding and session state survives repository reconstruction.
- Stale owners cannot mutate a newer binding generation or version.
- Expired operation leases can be taken over while live leases remain fenced.
- Tenant and workspace state remains isolated.
- Terminal sessions cannot return to a non-terminal state.
- Schema initialization is safe to repeat.
- The H2 contract and the optional real-MySQL contract pass without process-local fallback.

## Follow-up work

Tool execution persistence will be proposed separately after its in-memory state contract is reviewed. Server wiring, process reconciliation, and multi-process end-to-end validation also remain follow-up work.
