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
wiring.

The module provides:

- authenticated Harness Session scope resolution;
- asynchronous Runtime warmup and compatible Runtime reuse;
- Runtime Session acquisition and release;
- an in-memory execution ledger with at-most-once dispatch per idempotency key;
- a static provisioner for externally managed Runtime endpoints;
- a local-process provisioner with file boot, active health, idle reclaim,
  epoch fencing, and owned process-tree shutdown;
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

Durable rows alone do not make a stopped local Runtime process recoverable.
The embedding service must reconcile a persisted lease before reuse and own the
process adoption or reprovisioning policy.
