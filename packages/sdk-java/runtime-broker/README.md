# Qwen Managed Runtime Broker Core

This Java 21 module defines the state and embeddable orchestration core for a
Managed Agent Runtime Broker. It contains Runtime binding, Runtime Session,
and Tool execution records; repository contracts; thread-safe in-memory
and JDBC implementations; and a framework-neutral service that composes
authoritative scope resolution, Runtime provisioning, and Runtime transport
adapters.

The service acquires operation and dispatch leases, renews them while external
work is in flight, converges idempotent Tool execution, records cancellation
intent, and fails ambiguous dispatch outcomes as `UNKNOWN`. A persisted
`READY` binding is never reused by a new process without explicit adoption or
reconciliation; this core currently fails closed when it has no process-local
attestation for that binding.

The module intentionally does not implement a process or container provider,
expose an HTTP API, wire Spring, call the Hosted Harness, or define public
Agent resources. Those adapters belong to later PRs.

Building and running this module requires JDK 21 or later. Its Maven release
target is 21; services embedding the resulting JAR must also use JDK 21 or later.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

## JDBC persistence

`JdbcRuntimeBrokerSchema.initialize(DataSource)` installs the four private
Broker tables. The JDBC implementations use `javax.sql.DataSource` for
database access and fastjson2 (2.0.60) as the `reference_json`/`result_json`
codec; the embedding service owns the connection pool and schema lifecycle.
Tool execution rows preserve idempotency identity, dispatch ownership and
lease, cancellation intent, `UNKNOWN` recovery state, and the final result.
Tool execution identifiers are globally unique repository keys. The embedding
service must derive them from authenticated tenant, workspace, and session
context because this repository interface does not carry separate scope
arguments.
This module intentionally does not wire a Spring service or dispatch Tool
calls.

Run the optional real-MySQL contract with:

```bash
mvn -Pmysql-integration \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3306/runtime_broker_test' \
  -Dmysql.user=root \
  -Dmysql.password= \
  verify
```

Durable rows alone do not make a stopped local Runtime process recoverable.
The embedding service must reconcile a persisted lease before reuse and own the
process adoption or reprovisioning policy.
