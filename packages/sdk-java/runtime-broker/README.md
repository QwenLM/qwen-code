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
`JdbcRuntimeBindingRepository` additionally requires a `SecretProtector`
(`AesGcmSecretProtector` is included): the provision seed of a durable binding
and the lease token of a legacy binding are stored encrypted, so the key
material must come from the embedding service's own durable secret store and
stay stable across restarts and instances.

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
local readiness gate; see
[Runtime binding reconciliation](../../../docs/design/2026-09-24-runtime-binding-reconciliation.md).
The local-process adapter supports same-host adoption; the Kubernetes adapter
still requires the real-cluster fault matrix described in the P3 design before
production rollout.

## Fault gates

The Stage F fault gates run the service in real Broker JVMs against the real
bundled worker, with a fault-injecting HTTP proxy between them and a
file-backed H2 database behind a relay that can be cut. They drop, reset or
hold Runtime answers, kill workers and Broker JVMs, freeze a Broker past its
lease, and take the database away, then check that no tool call runs twice
or settles without the Runtime's evidence; see
[Runtime Broker Fault Gates](../../../docs/design/2026-09-26-runtime-broker-fault-gates.md).
They need the bundle, Node.js and POSIX signals, and fail when any is
missing. The default `mvn test` excludes them. From the repository root, run
`npm run build && npm run bundle`, then in this module:

```bash
mvn -Pfault-gates test
```

`-Dqwen.cli.entry=/path/to/dist/cli.js` points them at another bundle, with
its `managed-runtime-worker.js` next to it.

## Workspace binding

The `com.alibaba.qwen.code.runtimebroker.managedworkspace` package holds the
W0a Workspace binding contract; see
[Managed Workspace Binding Contract](../../../docs/design/2026-09-25-managed-workspace-binding-contract.md).
It defines the Workspace Registry record and an immutable snapshot built from
deployment configuration, actor-scoped access with an explicit-grant policy,
a catalog that lists Workspaces and resolves a Session's Workspace selection
to one resolved Workspace or one typed error, the lexical rule for a
Session's working directory, and `ContextBinding` with its `contextDigest`.
The TypeScript implementation in
`packages/cli/src/serve/managed-workspace-binding.ts` produces the same
normalized directories and digests; both run the shared fixtures in
`packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json`.
The fixtures of the `managed-context/1` envelope,
`packages/cli/src/serve/contracts/managed-context-v1.fixtures.json`, carry
context digests computed with the same encoding, and
`ManagedContextEnvelopeConformanceTest` recomputes them; see
[Managed Context Envelope](../../../docs/design/2026-09-25-managed-context-envelope.md).
Both fixture files carry unpaired surrogates as `\uXXXX` escapes on purpose,
so read them with a parser that keeps such escapes, as Jackson does.
The package uses only the JDK and no other Broker class, and nothing wires
it into the Broker service yet.

## Tool result contract

`ManagedToolResultConformanceTest` consumes the `managed-tool-result/1`
contract in
`packages/core/src/managed-runtime/contracts/managed-tool-result-v1.fixtures.json`:
the result manifest, segment pages, segment publication and the Tool v3
routes that carry the versioned result envelope. It pins the constants,
routes, closed key sets and error table, and recomputes every segment, seal
and prefix digest; see
[Managed Tool Result Contract](../../../docs/design/2026-09-26-managed-tool-result-contract.md).
The fixtures carry unpaired surrogates as `\uXXXX` escapes on purpose too.
No Java transport speaks Tool v3 yet.
