# Qwen Managed Runtime Broker Core

This Java 21 module defines the state and embeddable orchestration core for a
Managed Agent Runtime Broker. It contains Runtime binding, Runtime Session,
and Tool execution records; repository contracts; thread-safe in-memory
and JDBC implementations; and a framework-neutral service that composes
authoritative scope resolution, Runtime provisioning, and Runtime transport
adapters.

The service acquires operation and dispatch leases, renews them while external
work is in flight, converges idempotent Tool execution, records cancellation
intent, and fails ambiguous dispatch outcomes as `UNKNOWN`.
`reconcileExecution` asks the original Runtime about an `UNKNOWN` execution
and settles it only on that Runtime's terminal answer; it never replays the
call. A persisted `READY` binding is never reused by a new process without
proof: a binding whose request carries a durable provisioner kind is adopted
only after the provisioner observes the physical resource and the Broker
re-attests the Runtime identity through the transport, while a legacy binding
still fails closed with `runtime_reconciliation_required`; see
[Runtime binding reconciliation](../../../docs/design/2026-09-24-runtime-binding-reconciliation.md).

The module ships one local process provider, `LocalProcessRuntimeProvisioner`,
which starts the merged Managed Runtime worker and adopts it only after
attestation; see
[Managed Runtime process adoption](../../../docs/design/2026-09-23-managed-runtime-process-adoption.md).
The embedding service still owns the worker command wiring, recovery-capable
provisioners, and any container or remote provider. The module
intentionally does not expose an HTTP API, wire Spring, call the Hosted
Harness, or define public Agent resources. Those adapters belong to later PRs.

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
`JdbcRuntimeBindingRepository` additionally requires a `SecretProtector`
(`AesGcmSecretProtector` is included): the provision seed of a durable binding
and the lease token of a legacy binding are stored encrypted, so the key
material must come from the embedding service's own durable secret store and
stay stable across restarts and instances.
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
For a binding without durable identity the embedding service must reconcile a
persisted lease before reuse and own the process adoption or reprovisioning
policy; a durable binding is reconciled and adopted by the Broker itself.
