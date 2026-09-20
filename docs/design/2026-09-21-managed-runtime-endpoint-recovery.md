# Managed Runtime Endpoint Persistence and Recovery

[English](2026-09-21-managed-runtime-endpoint-recovery.md) | [简体中文](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)

Status: Implemented in the reference stack; real-cluster validation pending

Implementation checkout: `feature/managed-agents-p0-p8` at `51cb9977f8b1`
plus the P3 working-tree change described here

## 1. Problem

The Java control plane calls a Tool-only Runtime over HTTP. Reusing a Runtime
after a Java restart therefore requires the control plane to remember where the
Runtime was listening. Persisting only the URL is unsafe:

- a local port or Pod IP can be reused by another process;
- a Kubernetes Pod can be replaced under the same name with a different UID;
- an endpoint can remain routable while the Runtime belongs to an obsolete
  lease or workspace generation;
- a scheduler timeout does not prove that the resource does not exist; and
- two Java replicas can otherwise provision duplicate Runtimes after a lost
  response.

The durable unit must be a Runtime binding generation. Its endpoint is one
observed attribute of a scheduler-owned resource, not the resource identity.

## 2. Current implementation evidence

The P3 reference implementation now contains the restart-safety path described
by this design:

- Flyway and the standalone schema persist placement identity, encrypted
  provision seed, versioned resource handle, reconciliation time, and
  attestation generation. The production schema has no plaintext Runtime token
  column.
- Spring wires the three JDBC repositories and an AES-GCM secret protector when
  Runtime Broker is enabled; incomplete database or key configuration fails
  startup instead of falling back to process memory.
- `RuntimeBrokerService` fences scheduler work by owner and operation
  generation. A restored `READY` row keeps its local gate closed until
  scheduler reconciliation and authenticated Runtime attestation succeed.
  Reconciliation retries use bounded exponential backoff and an independent
  operation deadline that also bounds a single in-flight scheduler or
  attestation call; a timed-out local waiter releases its claim without
  deleting an uncertain external resource, so another replica can resume from
  MySQL.
- The local-process provisioner uses deterministic generation directories,
  records PID plus process-start identity, and can adopt the exact same-host
  process from a new JVM after the owner JVM exits. Child stdout/stderr do not
  remain attached to the parent JVM and are discarded by the reference
  provisioner.
- The Kubernetes reference provisioner creates deterministic bare Pod and
  Secret resources, persists UID/resourceVersion handles, observes Pod IP only
  as an endpoint, rejects same-name replacement UIDs, and deletes with identity
  preconditions.
- The Tool-only worker exposes an authenticated private `v2/attest` route whose
  response includes the immutable Runtime, lease, provision, and workspace
  identity.
- The execution ledger remains pinned to binding ID, binding generation, and
  the original `executionCallId`; uncertain post-dispatch outcomes are never
  redispatched.

Local validation covers the scheduler-neutral recovery state machine,
cross-JVM local-process adoption after the owner exits, the Kubernetes adapter
through a fake core-v1 API, strict HTTP attestation, Spring activation, and two
independent JVMs converging on one binding and one physical execution through
real MySQL. A real Kubernetes
cluster was not available in this checkout, so cluster networking, RBAC,
service-account rotation, Pod lifecycle timing, and conditional deletion still
require environment validation before production rollout.

## 3. Goals

- Persist enough information to find, authenticate, verify, and release the
  exact physical Runtime generation after a Java restart.
- Let multiple Java replicas converge on one external resource and one active
  binding generation through MySQL fencing.
- Keep Java as the HTTP client. Runtime does not need to call back into Java.
- Support local processes, Kubernetes, a statically managed Runtime, and future
  schedulers through one bounded provisioner contract.
- Preserve fast TTFT: model inference and client streaming do not wait for
  Runtime recovery until a tool boundary is reached.
- Fail closed for uncertain resources and uncertain tool side effects.

## 4. Non-goals

- Migrating old Broker rows. These tables are still pre-production and the
  target Flyway migration creates the final schema directly.
- Moving model inference or conversation authority into Tool Runtime.
- Adding Runtime-to-Java callbacks, WebSockets, or a second event system.
- Automatically replaying an execution whose outcome is unknown.
- Installing cluster-specific NetworkPolicy, quotas, image policy, or a future
  Runtime operator. The reference adapter emits Pod and Secret resources; the
  platform deployment owns those controls.
- Sharing one session-isolated Runtime between unrelated Sessions.

## 5. Decisions

### 5.1 Endpoint is an observation, not identity

The Broker persists `runtime_endpoint` to avoid rediscovery on every request,
but a restored endpoint is unusable until reconciliation succeeds. Physical
identity is the tuple:

```text
bindingId
+ runtimeGeneration
+ provisionerKind
+ placementDomain
+ provisionRequestId
+ resourceHandle
+ runtimeInstanceId
+ leaseId
+ epoch
```

The endpoint and token are never exposed through public Agent, Session, or
WebShell APIs.

### 5.2 MySQL remains the control-plane source of truth

The scheduler owns the physical resource; MySQL owns binding intent,
generation, operation fencing, current observation, and tool idempotency. A
Kubernetes object is not a replacement for the Tool execution ledger, and a
database row is not proof that a Pod or process is alive.

There is no global Broker leader. A Java replica claims the existing per-binding
operation lease before create, reconcile, drain, or release. Other replicas
poll the durable record. Every asynchronous result is committed only when the
same operation owner and operation generation are still current.

### 5.3 Reconciliation precedes use

Loading a persisted `READY` row must not complete the in-process ready gate.
The first user of that binding after a JVM load forces scheduler reconciliation
and a private authenticated attestation call. Only then may
`HttpRuntimeTransport` send `prepare`, `execute`, `status`, `cancel`, or
`release`.

Add `POST /internal/managed-runtime/v2/attest`. It requires the bearer token,
lease ID, and epoch headers, accepts the immutable Runtime scope, and returns
the Runtime instance ID, Runtime incarnation, lease ID, epoch, and scope. The
existing `/health` route remains a liveness signal and is not sufficient for
recovery identity.

`lastHealthNanos` is strictly an in-process cache populated after a successful
check. It is never initialized merely because a database row says `READY`.

### 5.4 Unknown is not not-found

Scheduler timeout, permission failure, network partition, malformed state, or
an expired Java operation lease returns `UNKNOWN` or `CONFLICT`. The Broker
keeps the binding unavailable and does not provision a replacement. Only an
authoritative `NOT_FOUND` result permits a new physical generation, subject to
the Session and execution rules in Section 11.

## 6. Durable model

### 6.1 Placement identity

Add the following immutable fields to `RuntimeProvisionRequest` and include
them in `request_key` hashing:

| Field                   | Meaning                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisionerKind`       | Stable adapter identifier such as `local-process`, `kubernetes`, or `static`.                                                                                     |
| `placementDomain`       | Reachability and ownership domain. Examples: a stable host ID or `cluster-uid/namespace`.                                                                         |
| `runtimeTemplateDigest` | Digest of the worker deployment template: image or executable identity, entrypoint, protocol, and relevant mounts. Capability remains part of the scope identity. |

A loopback endpoint is valid only in the same local-process placement domain.
This prevents another Java host from reading `http://127.0.0.1:<port>` from
MySQL and accidentally calling its own local process.

### 6.2 Binding columns

The target `qwen_runtime_binding` schema keeps the existing scope, state,
generation, CAS, ownership, activity, endpoint, and lease columns and adds:

| Column                      | Contract                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provisioner_kind`          | Adapter that owns the resource-handle schema.                                                                              |
| `placement_domain`          | Domain in which the endpoint is reachable and adoptable.                                                                   |
| `runtime_template_digest`   | Prevents reuse across incompatible worker revisions.                                                                       |
| `provision_request_id`      | Globally unique, stable idempotency identity for this binding generation.                                                  |
| `provision_seed_ciphertext` | Authenticated encrypted seed containing the provisional Runtime identity, Runtime incarnation, lease ID, epoch, and token. |
| `credential_key_id`         | Key reference needed to decrypt the seed; never the key itself.                                                            |
| `resource_handle_version`   | Version of the opaque provider handle schema.                                                                              |
| `resource_handle_json`      | Bounded provider-private identity; never contains credentials.                                                             |
| `attestation_generation`    | Monotonic counter advanced only after scheduler reconciliation plus private authenticated attestation succeeds.            |
| `last_reconciled_at`        | Database-time audit timestamp of the last successful attestation.                                                          |

`resource_handle_json` is limited to 64 KiB and is decoded only by the named
provisioner. Core code treats it as an immutable JSON object. The current
plaintext `runtime_token` storage is replaced by the encrypted seed/credential
payload. A test codec is allowed in repository tests; production startup must
fail if no approved secret protector is configured.

The seed is generated and stored in the same transaction that allocates the
binding ID and generation, before any scheduler call. The Repository returns
the same seed to every contender. A stable `provision_request_id` lets an
adapter find a resource created just before a Java crash, even when its handle
was not yet committed.

### 6.3 Resource handle examples

Local process:

```json
{
  "schemaVersion": 1,
  "kind": "local-process",
  "generationDirectory": "<owned absolute path>",
  "pid": 12345,
  "processStartedAt": "2026-09-21T08:00:00Z"
}
```

Kubernetes:

```json
{
  "schemaVersion": 1,
  "kind": "kubernetes",
  "clusterUid": "cluster-a",
  "namespace": "qwen-runtimes",
  "podName": "qwen-runtime-0123456789abcdef0123456789abcdef",
  "podUid": "5ce4...",
  "podResourceVersion": "7821",
  "secretName": "qwen-runtime-0123456789abcdef0123456789abcdef",
  "secretUid": "94b1...",
  "secretResourceVersion": "7815"
}
```

If a per-Runtime Service is required, its name and UID are appended to the
Kubernetes handle. Pod or Service names alone are insufficient because a
deleted object can be recreated under the same name with a different UID.

## 7. Provisioner contract

Replace the current ready-lease-only abstraction with two explicit phases:

```java
interface RuntimeProvisioner {
    String kind();
    String placementDomain();

    CompletionStage<RuntimeResourceHandle> ensureResource(
        RuntimeProvisionRequest request,
        RuntimeProvisionSeed seed,
        RuntimeResourceHandle knownHandle);

    CompletionStage<RuntimeObservation> reconcile(
        RuntimeProvisionRequest request,
        RuntimeProvisionSeed seed,
        RuntimeResourceHandle handle,
        RuntimeLease lastLease);

    CompletionStage<Void> drain(RuntimeResourceContext resource);
    CompletionStage<Void> release(RuntimeResourceContext resource);
}
```

This is a semantic sketch; Java 11 implementations use ordinary final classes,
not records or sealed types.

`ensureResource` must be idempotent by `provisionRequestId`. It returns as soon
as the external resource identity exists so that the Broker can persist the
handle before waiting for startup. With no known handle, it first discovers an
existing resource by the provision request identity, then creates only when it
can authoritatively prove absence.

`reconcile` is observational and returns one of:

| Outcome     | Meaning                                                                   | Broker action                                                                                        |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `READY`     | Exact resource and seed identity match; a routable endpoint is available. | Call the private attestation route, persist lease/endpoint, advance attestation, then open the gate. |
| `STARTING`  | Exact resource exists but is not ready.                                   | Renew operation lease and poll with bounded backoff.                                                 |
| `NOT_FOUND` | Scheduler authoritatively proves the resource is absent or terminal.      | During initial provisioning, call `ensureResource`; for a formerly ready binding, mark it `LOST`.    |
| `CONFLICT`  | Name, UID, scope, template, or seed identity conflicts.                   | Fail closed, retain evidence, alert; never adopt or replace automatically.                           |
| `UNKNOWN`   | Scheduler state cannot currently be established.                          | Return retryable unavailability and keep the existing generation blocked.                            |

`RuntimeObservation` may refresh the endpoint and non-secret resource handle,
but its returned Runtime instance ID, lease ID, and epoch must match the
persisted seed. It never returns secret material; the Broker constructs the
credential from the decrypted seed. An identity mismatch is `CONFLICT`.

`release` is idempotent and conditionally deletes only the resource identified
by the handle. An adapter must never delete a same-name replacement.

## 8. Broker lifecycle

```mermaid
stateDiagram-v2
    [*] --> PROVISIONING: allocate binding and encrypted seed
    PROVISIONING --> PROVISIONING: ensure resource / STARTING
    PROVISIONING --> READY: reconcile + private attestation
    PROVISIONING --> RECOVERY_BLOCKED: non-retryable create or identity conflict
    READY --> READY: refresh endpoint and attestation
    READY --> DRAINING: idle, revoke, or requested drain
    READY --> LOST: authoritative resource absence
    READY --> RECOVERY_BLOCKED: resource or attestation conflict
    LOST --> DRAINING: idle generation is safe to replace
    DRAINING --> RELEASED: conditional release confirmed or resource absent
    DRAINING --> RECOVERY_BLOCKED: conditional release conflict
```

Reconciliation itself is an operation gate, not a new durable binding state.
This keeps the state machine small. A locally reconstructed `RuntimeBinding`
captures the stored `attestation_generation` and remains closed until this JVM
claims the operation gate and performs reconciliation plus a successful
attestation itself. A success committed by another Java replica releases the
durable claim, but does not make this JVM trust a cached endpoint without its
own check.

Provisioning and recovery follow this sequence:

1. Allocate `bindingId`, `runtimeGeneration`, and encrypted seed atomically.
2. Claim the per-binding operation lease using database time.
3. Call `ensureResource` with the durable seed and any known handle.
4. Persist the handle while the same claim generation is still owned.
5. Poll `reconcile` until `READY`, a terminal result, or the operation deadline.
   Reconcile retries start at 50 ms, ensure retries start at 100 ms, both double
   up to 2 seconds, and the deadline is four operation-lease durations. The
   deadline is scheduled independently, so it also bounds one scheduler or
   attestation future that never completes.
6. Build the `RuntimeLease`, call the private attestation route, and verify the
   lease headers, Runtime identity, and immutable scope.
7. CAS the endpoint, handle, `READY` state, health time, and incremented
   attestation generation in one update.
8. Complete the local ready gate. Tool Session `prepare` may now run.

If a Java process loses its operation lease or reaches the deadline at any
point, its late result is discarded. The external resource remains discoverable
through `provisionRequestId`, allowing the new owner to converge without
duplication.

## 9. Endpoint use and refresh

- `runtime_endpoint` must be an HTTP(S) origin without user info, query, or
  fragment.
- The provisioner validates that the address belongs to its placement domain.
- Every Runtime request carries bearer authentication, lease ID, and epoch.
- An endpoint change is persisted before use and advances the binding record
  version and successful attestation generation.
- Health caching starts only after reconciliation in the current JVM.
- A transport failure after tool dispatch does not trigger replay. The Broker
  queries the original execution reference through `status`; if the resource
  cannot be reconciled, the durable execution becomes `UNKNOWN`.
- No-tool model turns remain independent of Runtime readiness. Warm-up can run
  concurrently, but only an actual tool boundary waits for this gate.

## 10. Provisioner-specific behavior

### 10.1 Local process

`local-process` is a same-host development and single-node adapter, not a
multi-host placement mechanism.

It must implement the seeded path and use the durable seed rather than generate
new credentials in memory. Its resource handle records an owned generation
directory plus a PID and process-start fingerprint. Recovery validates:

- placement domain equals the current stable host identity;
- all paths are owner-controlled, bounded beneath the configured state root,
  and have the required permissions;
- PID and start fingerprint identify the same process, preventing PID reuse;
- the ready record exactly matches the seed and Runtime scope;
- the endpoint is a loopback origin; and
- private attestation accepts the stored lease and epoch and returns the exact
  Runtime identity and scope.

If the process is definitely absent, reconciliation returns `NOT_FOUND`. If a
PID, path, or ready record is ambiguous, it returns `CONFLICT` or `UNKNOWN` and
does not spawn a second process. Explicit Runtime release must durably move the
binding through `DRAINING` before killing its child. An ordinary Java process
shutdown may leave a durable child alive for same-host takeover. Crash recovery
may adopt a matching child or conditionally reap it; it may not treat a missing
Java `Process` object as proof that the child stopped.

The child process inherits no stdout/stderr pipe from Java. The reference
provisioner discards both streams so the child remains healthy after the
creating JVM exits. A production deployment must route structured worker logs
independently of the creating JVM.

### 10.2 Kubernetes

The reference Kubernetes adapter creates one bare Pod per Runtime generation,
with `restartPolicy: Never`, rather than a Deployment that can silently replace
the physical Runtime. A later operator may own a Runtime CRD, but it implements
the same Broker contract.

The Pod and Secret use deterministic names and labels derived from the
`provisionRequestId`, binding ID, and generation. Raw tenant IDs, working
directories, and credentials are not labels or annotations. Creation is
GET-or-create and rejects an existing object whose immutable identity labels or
template digest differ.

For an in-cluster Java control plane, the current adapter uses the ready Pod IP
and port as the endpoint. Pod IP is an observation; Pod UID remains the
identity. This reference implementation does not create a Service or inspect
EndpointSlices. If another network topology requires a per-Runtime ClusterIP
Service, that future adapter must select exactly one binding generation,
persist the Service UID, and verify EndpointSlice `ready`/`serving` and
`terminating` conditions before returning `READY`.

The emitted Pod uses TCP startup and readiness probes, but Kubernetes readiness
does not replace the Broker's private attestation. The boot document is injected
from a per-Runtime Secret through `QWEN_MANAGED_RUNTIME_BOOT`, and the worker
starts through its supported `--boot-env` contract. The adapter does not create
NetworkPolicy; production deployment must allow Runtime ingress only from the
Java control-plane workload and permit only required Runtime egress.
The in-cluster client requires an HTTPS API-server origin and validates the
configured service-account CA. It currently loads the projected token once;
token rotation remains part of real-cluster acceptance.

The current `clusterUid` is trusted deployment configuration, not an identity
discovered from the Kubernetes API. Production configuration must source an
immutable identifier that is unique to the target cluster. Real-cluster
acceptance must also prove that every Java replica receives the same value and
that a value from another cluster is rejected before a persisted handle is
used.

Release uses the persisted UID as the Kubernetes delete precondition. The
observed resourceVersion remains in the durable handle for diagnosis and
reconciliation, but is intentionally not used for ordinary release because Pod
status updates change it after provisioning. A same-name object with a
different UID is a conflict and is never deleted.

Kubernetes controllers are reconciliation loops, Kubernetes object UIDs
distinguish recreated objects, and delete preconditions accept UID and
resourceVersion. Those properties are the basis of the current adapter rather
than Pod names or cached IPs; EndpointSlice conditions apply to the future
Service-based extension described above:

- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Object names and UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/)
- [Pod lifecycle and replacement identity](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [API delete preconditions](https://kubernetes.io/docs/reference/kubernetes-api/definitions/preconditions-v1-meta/)
- [Startup, readiness, and liveness probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)

### 10.3 Other schedulers

VM, batch, container-service, or static adapters store their provider identity
in the same versioned handle. They must provide the same five reconciliation
outcomes, stable idempotent provision identity, conditional release, placement
domain validation, and endpoint attestation. No scheduler-specific field is
added to Broker APIs or public Session APIs.

The static adapter remains development-only in durable mode until it can return
a stable resource handle and credential reference. A fixed URL alone does not
satisfy recovery identity.

## 11. Session and execution recovery

Recovering the same physical Runtime keeps the existing Runtime Session record
and calls `prepare` idempotently with the original Session identity.

When a formerly ready Runtime is authoritatively `NOT_FOUND`:

1. mark the binding `LOST` and stop sending requests to its endpoint;
2. inspect every Tool execution pinned to that binding generation;
3. if any execution is non-terminal or already `UNKNOWN`, keep the Runtime
   Session pinned to the `LOST` binding and reject further Runtime operations;
   never create a replacement automatically;
4. if there is no active Runtime Session and no active execution, the Broker
   conditionally releases the lost resource record and allocates a new binding
   generation for the same request; and
5. all old execution records remain pinned to the old binding ID and generation
   so late results cannot enter the replacement Runtime Session.

Transparent rebind of an active Runtime Session remains forbidden. The
implemented automatic replacement is limited to an idle binding with no active
Runtime Session or execution; otherwise the binding stays `LOST` and recovery
is explicitly blocked.

## 12. Spring integration

The Runtime Broker remains an embedded component of
`managed-agent-server`; this design does not require a separate Java service.

The activation change adds `V3__runtime_broker.sql`, creates the three JDBC
Repository beans from the existing Spring `DataSource`, injects them into the
full `RuntimeBrokerService` constructor, and assigns every Java process a
unique `brokerOwnerId`. When the Runtime Broker feature is enabled, database or
secret-protector failure fails startup. There is no silent fallback to the
in-memory repositories.

`JdbcRuntimeBrokerSchema.initialize` remains a standalone/test helper. Flyway
owns production schema lifecycle. The bundled test schema and Flyway schema
must be checked for semantic parity.

Recovery stays on demand: startup does not scan every historical binding.
`warm`, Session acquire, execution status/cancel, or an explicit bounded
janitor loads and reconciles the relevant binding. A future orphan janitor may
scan aged active bindings in pages, but it uses the same operation claim and
provisioner contract.

## 13. Failure matrix

| Failure point                                            | Required recovery                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Before binding transaction commits                       | No scheduler call occurred. A retry allocates normally.                                        |
| After seed commit, before external create                | New owner gets the same seed; authoritative absence allows idempotent create.                  |
| After external create, before handle commit              | `ensureResource` discovers by `provisionRequestId` and returns the existing resource.          |
| After handle commit, before endpoint/READY commit        | Reconcile the exact handle and publish the endpoint only after private attestation.            |
| Java restart with persisted `READY`                      | Keep local gate closed; force reconcile and private attestation.                               |
| Scheduler API timeout                                    | `UNKNOWN`; retain generation and do not create or delete anything.                             |
| Endpoint points at another process/Pod                   | Lease or resource identity mismatch gives `CONFLICT`; never send a tool request.               |
| Runtime dies before tool dispatch                        | Fail the pending tool boundary; replacement follows binding policy.                            |
| Runtime dies after dispatch or response is lost          | Query original `executionCallId`; if the resource cannot answer, mark `UNKNOWN`, never replay. |
| Operation lease changes while an adapter call is running | Ignore the late result; the new owner reconciles using the durable request ID.                 |
| MySQL unavailable                                        | Fail closed; do not fall back to process memory or provision outside the ledger.               |

## 14. Delivery plan

### P3a-1: Durable identity — implemented

- Extend request identity and binding records with provisioner, placement, and
  template digest.
- Generate and persist one encrypted seed per binding generation.
- Persist versioned resource handles and attestation generation.
- Remove production plaintext Runtime-token persistence.
- Extend H2 and real-MySQL Repository contract tests.

### P3a-2: Reconcile gate — implemented

- Introduce `ensureResource` and `reconcile` results.
- Add the owned-worker private `v2/attest` route and strict identity response.
- Prevent restored `READY` from completing before reconciliation.
- Make local-process use the durable seed and implement same-host adoption or
  fail-closed cleanup.
- Add fault tests at every failure point in Section 13.

### P3a-3: Spring activation and proof — implemented locally

- Add Flyway V3 and Spring JDBC/secret-protector wiring.
- Run two independent Java service instances against one real MySQL database.
- Prove one physical provision, one binding generation, one execution dispatch,
  and restart reuse across independent JVMs; Repository fencing tests separately
  prove expired-owner takeover and stale-owner rejection on real MySQL.
- Preserve the existing no-tool/non-blocking warm-up contract. Production TTFT
  and first-tool wait measurement remains a deployment benchmark, not a Broker
  correctness test.

### P3b: Kubernetes adapter — implemented, real-cluster proof pending

- Implement the bare-Pod/Secret adapter behind the same contract.
- Validate with a real test cluster: Java restart, API timeout, Pod deletion,
  same-name/different-UID conflict, delayed readiness, endpoint change,
  conditional cleanup, and an in-flight tool crash.
- Safe replacement is implemented only for an idle binding with no active
  Runtime Session or execution.

## 15. Validation and acceptance criteria

Implementation status against the acceptance criteria:

- Spring uses JDBC repositories whenever the Runtime Broker is enabled and
  never silently falls back to memory.
- A binding seed is committed before the first scheduler side effect and is
  identical across two Java contenders.
- A resource created before a simulated crash is discovered rather than
  duplicated after restart.
- A restored `READY` row cannot cause any Runtime operation before scheduler
  reconciliation and private authenticated attestation.
- A recycled local port, same-name/different-UID Pod, stale lease, stale epoch,
  or incompatible template is rejected.
- `UNKNOWN` never triggers automatic provision or delete.
- Two concurrent Java processes plus real MySQL converge on one binding and one
  physical execution; real-MySQL Repository tests also cover expired-owner
  takeover, and a later JVM reuses the settled generation after restart.
- Loss after tool dispatch queries the original `executionCallId` and never
  causes a second physical execution.
- No-tool turns can produce their first token while Runtime is still starting;
  only a real tool boundary waits.
- Secrets are encrypted or referenced, redacted from logs, and absent from
  public APIs and resource handles.
- Local-process and Kubernetes adapters pass the scheduler-neutral Broker
  recovery tests and adapter-specific fault tests.
- A second JVM adopts the same local worker after the creating JVM has exited;
  retryable observations back off, hit a bounded deadline, release the stale
  local claim, and can be resumed by a later request.

All code-level criteria above are covered by local tests. Production acceptance
still requires the real-cluster P3b matrix: Java restart, Kubernetes API
timeout, Pod deletion, same-name/different-UID replacement, delayed readiness,
Pod-IP change, conditional cleanup, and an in-flight tool crash. The Hosted
Harness TTFT and first-tool-wait benchmark must also be repeated in the target
deployment; neither item is represented as completed by fake-API tests.

## 16. Observability

Emit structured metrics and logs keyed by non-secret `bindingId`, generation,
provisioner kind, placement-domain hash, and operation generation:

- provision and reconcile duration/outcome;
- operation-claim contention and takeover;
- binding state counts and age since successful attestation;
- endpoint refreshes and private attestation failures;
- resource-handle conflicts and orphan discoveries;
- blocked Session recovery and unknown executions; and
- physical provision/delete counts compared with logical binding counts.

Do not log Runtime tokens, decrypted seeds, raw working directories, or tenant
identifiers. Endpoint logging is disabled by default or reduced to a redacted
host-class and port.
