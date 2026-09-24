# Qwen Managed Runtime Broker

This module is the Java control-plane half of the Hosted Harness architecture.
It is embedded in the Java product service rather than deployed as a mandatory
standalone service. Repository contracts define the persistence boundary;
in-memory implementations remain useful for tests and single-process
development, while JDBC implementations coordinate state through a shared
database.

`JdbcRuntimeBrokerSchema.initialize(DataSource)` installs the Broker's private
tables. The JDBC implementations depend only on `javax.sql.DataSource`; the
embedding service owns its connection pool, schema lifecycle, and repository
wiring. Tool execution rows preserve idempotency identity, dispatch ownership,
lease and cancellation state, ambiguous `UNKNOWN` recovery, and settled
results. Their case-sensitive execution and idempotency identifiers are indexed
by deterministic hashes and verified against the complete stored values.

The module provides:

- authenticated Harness Session scope resolution;
- asynchronous Runtime warmup and compatible Runtime reuse;
- Runtime Session acquisition and release;
- in-memory and JDBC execution ledgers with at-most-once dispatch per
  idempotency key;
- evidence-only `UNKNOWN` reconciliation through `reconcileExecution`,
  which settles only on the original Runtime's terminal answer and never
  replays the call;
- a two-phase Tool boundary that reserves a durable execution identity before
  the Harness checkpoint and starts physical execution only after that commit;
- encrypted durable Runtime seeds, versioned resource handles, and an
  owner-generation fence for cross-JVM recovery;
- a static provisioner for externally managed Runtime endpoints;
- a local-process provisioner with file boot, active health, idle reclaim,
  epoch fencing, same-host process adoption, and owned process-tree shutdown;
- a bare-Pod and Secret Kubernetes provisioner with UID-fenced reconciliation;
- the private `/internal/runtime-broker/v1` HTTP contract used by
  `qwen serve --profile hosted-harness`;
- an HTTP transport for the existing Managed Runtime v1/v2 worker protocol.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

Run the optional real-MySQL contract with:

```bash
mvn -Pmysql-integration \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3306/runtime_broker_test' \
  -Dmysql.user=root \
  -Dmysql.password= \
  verify
```

A restored endpoint is never trusted directly. The Broker reconciles the exact
provider resource and completes private Runtime attestation before opening the
local readiness gate. The local-process adapter supports same-host adoption;
the Kubernetes adapter still requires the real-cluster fault matrix described
in the P3 design before production rollout.
