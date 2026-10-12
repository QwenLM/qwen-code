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

The module ships a local process provider, `LocalProcessRuntimeProvisioner`,
which starts the merged Managed Runtime worker and adopts it only after
attestation; see
[Managed Runtime process adoption](../../../docs/design/2026-09-23-managed-runtime-process-adoption.md).
The embedding service still owns the worker command wiring, recovery-capable
provisioners, and deployment configuration. The experimental Kubernetes provider
below supports disposable scratch only. The module
intentionally does not expose an HTTP API, wire Spring, call the Hosted
Harness, or define public Agent resources. Those adapters belong to later PRs.

Building and running this module requires JDK 21 or later and Maven 3.8.9+
(the SpotBugs gate's plugin declares that floor). Its Maven release target is
21; services embedding the resulting JAR must also use JDK 21 or later.

Build and test with:

```bash
mvn test
mvn checkstyle:check
mvn verify
```

`mvn verify` needs Maven 3.8.9+ and runs the SpotBugs high-confidence gate: a
new warning fails the build, and a false positive goes into
`spotbugs-excludes.xml` with a justification in the PR. To exercise only the
gate, run `mvn verify -DskipTests` — the full suite includes
environment-sensitive timing tests that can fail on a local machine, so CI is
the arbiter.

## JDBC persistence

`JdbcRuntimeBrokerSchema.initialize(DataSource)` installs the four private
Broker tables. The JDBC implementations use `javax.sql.DataSource` for
database access and fastjson2 (2.0.65) as the `reference_json`/`result_json`
codec; the embedding service owns the connection pool and schema lifecycle.
`JdbcRuntimeBindingRepository` additionally requires a `SecretProtector`
(`AesGcmSecretProtector` is included): the provision seed of a durable binding
and the lease token of a legacy binding are stored encrypted, so the key
material must come from the embedding service's own durable secret store and
stay stable across restarts and instances.
Tool execution rows preserve idempotency identity, dispatch ownership and
lease, cancellation intent, `UNKNOWN` recovery state, and the final result.

New dispatch authorization uses `RuntimeBindingRepository.authorizeDispatch`:
the binding must be READY without a drain request and the original Session
must be READY, under the same parent lock and transaction as the execution's
DISPATCHING-to-EXECUTING CAS. Taking a coordinator claim grants no execution
permission. Original authorized calls may still settle after draining.

`ToolExecutionRepository.findByBinding` provides bounded inventory for the exact
binding/generation across Sessions, including every execution state. Its hash
cursor does not skip records when they settle; custom repositories default to
refusal. Inventory is not a snapshot, a normal-stop receipt or permission to
release storage. The durable CSI retirement coordinator remains unimplemented.
Custom binding repositories must implement this atomic operation; the default
refuses dispatch rather than falling back to a separate readiness read.
Tool execution identifiers are globally unique repository keys. The embedding
service must derive them from authenticated tenant, workspace, and session
context because this repository interface does not carry separate scope
arguments.
This module intentionally does not wire a Spring service or dispatch Tool
calls.

Before upgrading an installation that already used the Broker, stop new
admission and check for historical seeded failures:

```sql
SELECT tenant_id, COUNT(*) AS failed_bindings
FROM qwen_runtime_binding
WHERE binding_state = 'FAILED' AND provision_seed_ciphertext IS NOT NULL
GROUP BY tenant_id;
```

The new placement guard blocks affected tenants, including when a later
generation is `READY`. Do not resume their traffic until the original writer
domain is physically stopped and an evidence-preserving operator migration is
available. This module does not ship that migration; deleting old rows or
fabricating stop evidence would lose the safety fence. A nonempty result is a
rollout blocker for this database.

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

## Experimental Kubernetes scratch Runtime

`KubernetesRuntimeProvisioner` implements the K1 slice of the
[Kubernetes Runtime design](../../../docs/design/2026-10-01-managed-kubernetes-runtime.md).
It creates one bare Pod and immutable boot Secret per persisted provision seed,
with Session-exclusive `emptyDir` scratch. It rejects managed-context requests
and mounts no PVC. This is a private SDK adapter for trusted development
embeddings; Spring selection and public Hosted Workspace admission stay closed.

Construct `KubernetesHttpRuntimeClient` with the HTTPS API origin, service-account
token file and cluster CA file. Configure the provisioner with a stable cluster
identifier, existing namespace, SHA-256-pinned worker image and worker command.
The embedding scope resolver must authorize Session isolation and a container
scratch directory such as `/workspace`; the Java-host directory is not copied
into the Pod. Keep the Broker's encrypted seed and resource handle across
restarts. Custom clients must bound API calls and preserve authoritative-404
semantics.

The image must include Node.js 22+, the built CLI and runtime dependencies, and
support UID/GID 1000 with a read-only root filesystem. Broker RBAC needs `get`
and `create` on Pods and Secrets in the namespace. The Broker must reach the
API and the Pod's IPv4 port `43190`. Worker HTTP uses the existing bearer/lease
protocol on a trusted development network; production TLS/workload identity and
network-policy qualification are later gates.

Recovery observes the original Pod/Secret UIDs and re-attests the same worker.
Restarted, missing, replaced or mismatched resources block adoption. `release`
and `close` never delete Kubernetes objects; neither is authorization to stop a
worker another Broker may use. Budget retained Pods and Secrets: K1 provides no
automatic garbage collection, persistent Workspace storage or volume handoff.

A lost K1 scratch Pod leaves its binding LOST and blocks new placement in that
tenant with non-retryable `runtime_placement_recovery_required`. When sharing the
repository, new local-process and other provisioner kinds are also blocked.
Existing healthy bindings and other tenants remain usable. K1 never emits the
stopped-writer proof required by `recoverBinding`, so retries, Pod deletion and Broker restart do
not recover this tenant. Operators must stop new admission for the affected tenant,
retain the original binding/seed/UIDs and execution inventory, and escalate for an
evidence-preserving recovery or placement-policy change. There is no supported
in-place recovery procedure in this increment; do not delete database rows,
relabel the binding RELEASED, or invent stop evidence to restore admission.
This is an outstanding K1 availability gate tracked in #13395.

Each instance reserves at most 1024 retained or pending seeds before Kubernetes
writes. At capacity, new seeds fail with retryable `runtime_kubernetes_capacity`;
existing identities remain recoverable. Broker pre-create capacity refusal leaves
the original binding PROVISIONING with its claim released for retry; an error
after entering ensure keeps the existing fail-closed policy. The supplied durable
handle is never shadowed by an empty local entry. `release` does not evict, UNKNOWN retains
the slot while revoking local endpoint usability, and only that entry's own
validated reconciliation conflict frees it. Lease lookups use a direct identity
index and compare the endpoint. This bounds local state; it does not retire Pods,
Secrets or durable bindings.

After building and bundling the CLI, run the opt-in real-worker test from this
module with Node.js, a reachable non-loopback IPv4 interface and free port `43190`:

```bash
mvn -Dtest=KubernetesRuntimeWorkerTest \
  -Dqwen.kubernetes.worker-test=true \
  -Dqwen.cli.entry=../../../dist/cli.js test
```

The test uses fake Kubernetes observations and a real Broker/worker for private
file tools, deduplication and live-worker adoption. It does not qualify scheduling,
container isolation, NetworkPolicy or CSI. The default suite skips this opt-in
test; provider and API-client tests run without a cluster. Historical cloud smoke
results in the design concern an earlier snapshot, not this PR's requalification.

## Private CSI evidence components

The managed-server private CSI adapter and evidence commands are described in
[the CSI design](../../../docs/design/2026-10-01-managed-kubernetes-k2.md) and
[the durable worker ACK design](../../../docs/design/2026-10-03-csi-durable-worker-ack.md).
They reserve storage before creation, persist API-observed original Pod identity,
seal dispatch and retain original publication/checkpoint/ACK evidence. Public
Hosted CSI selection and physical holder release remain disabled. ACK success
keeps the holder DRAINING and does not prove worker stop or NodeUnpublish.
The K1 scratch adapter above retains its separate no-PVC contract.

The private `KubernetesCsiLogReader` provides bounded native log segments for ACK
qualification. It corroborates the expected plugin Pod/DaemonSet/Node/container/image
API identity before and after a current-segment read and refuses changed log
prefixes, incomplete lines and invalid timestamps. The HTTP client requests
timestamps without `tailLines` or `limitBytes`, uses strict UTF-8 and rejects
responses above one MiB. ConfigMap object reads separately allow one MiB plus
64 KiB for the JSON envelope so the largest admitted base64 worker chunk fits;
other object reads and request bodies keep their existing one-MiB limit. These are qualification inputs only: the durable
pre-create collector, image-specific publication/unpublish parser and physical
retirement coordinator remain gated. Log disappearance, a fresh baseline or a
diagnostic snapshot never releases a Workspace holder.
Kubernetes omits rotated log files and may skip malformed CRI records. Kubelet
chooses the log container from local status asynchronously synchronized to the
API server; these observations cannot bind log bytes to an exact container ID.
That additional source-binding contract remains required. RFC3339 offsets are
accepted without altering the bytes used for prefix and digest verification.

## Trusted local recovery

Durable local provisioning and trusted reboot recovery are separate opt-ins;
see the [adoption design](../../../docs/design/2026-09-27-local-runtime-adoption.md)
and [reboot cleanup design](../../../docs/design/2026-09-28-local-reboot-recovery.md).
`recoverBinding(bindingId, expectedGeneration)` observes and cleans only the
saved generation. It does not resolve current product authorization or create
replacement workers. Managed Workspace embeddings must implement
`RuntimeProvisioner.recoverResources` to clear their original physical holder;
the default refuses managed cleanup. Only then may `finishLostRecovery` retire
the saved binding. Custom binding repository implementations must implement the
new bounded candidate query and cleanup finalization contract. There is no new
public HTTP recovery endpoint or database migration in this slice.

## Fault gates

The Stage F fault gates run the service in real Broker JVMs against the real
bundled worker, with a fault-injecting HTTP proxy between them and a
file-backed H2 database behind a relay that can be cut. They drop, reset,
delay or hold Runtime answers, kill workers and Broker JVMs, freeze a Broker
past its lease, and take the database away, then check that no tool call
runs twice or settles without the Runtime's evidence. The FG5 gates do the
same around W0c context installation on managed-context/1: no tool runs
before the context is installed and activated, and none runs outside the
Session's directory; see
[Runtime Broker Fault Gates](../../../docs/design/2026-09-26-runtime-broker-fault-gates.md).
They need the bundle, Node.js and POSIX signals, and fail when any is
missing. The default `mvn test` excludes them. From the repository root, run
`npm run build && npm run bundle`, then in this module:

```bash
mvn -Pfault-gates test
```

`-Dqwen.cli.entry=/path/to/dist/cli.js` points them at another bundle.

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
