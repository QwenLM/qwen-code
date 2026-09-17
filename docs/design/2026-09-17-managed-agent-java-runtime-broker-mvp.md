# Managed Agent Java Runtime Broker MVP

[English](2026-09-17-managed-agent-java-runtime-broker-mvp.md) | [简体中文](2026-09-17-managed-agent-java-runtime-broker-mvp.zh-CN.md)

Executable plan: [Managed Agent Hosted Runtime](../plans/2026-09-17-managed-agent-hosted-runtime-execution.md)

Status: Implementation in progress
Date: 2026-09-17
Source baseline: `65a6adf882bc8cf543d691ef6850c49b64b3718d`

## 1. Problem

The current daemon can select the Managed execution engine, run the Agent loop in-process, and delegate tools through a `ManagedRuntimeProvider`. Its production-default local provider still reaches a hidden `managed-gateway` ACP session, while the experimental auto-local provider owns Node worker lifecycle inside `qwen serve`.

The hosted target requires a different ownership boundary: the Java product service owns tenant identity, Runtime provisioning, binding, quotas, and execution receipts; `qwen serve` owns the model loop and recoverable Harness state; the Tool Runtime owns workspace side effects and never receives a user Prompt or model credential.

The first implementation must prove that Runtime cold start does not delay the first model token and that a Tool Call in the same turn can wait for the Runtime and continue without changing execution engine or replaying an uncertain side effect.

## 2. Goals

- Add a Hosted Harness profile to `qwen serve`.
- Add a broker-backed Managed Runtime provider that calls the Java service rather than a Runtime endpoint.
- Let Java begin Runtime provisioning when it accepts the first Prompt.
- Keep model inference independent from Runtime readiness until a Tool Call occurs.
- Persist Runtime bindings and tool execution identities in Java-owned abstractions.
- Reuse the existing Managed Tool v2 behavior instead of reimplementing tool semantics in Java.
- Fail closed without falling back to Local Runtime or Legacy execution.
- Prove cancellation by physical process-tree exit and absence of post-cancel writes.

## 3. Non-goals

- Kubernetes provisioning in the first slice.
- Public Agent CRUD or field-level OpenAI Agents API compatibility.
- MCP, Hooks, Channels, scheduled tasks, worktrees, or Legacy-to-Managed conversion.
- Cross-Harness shared Session Authority in the first slice.
- Removal of the experimental `/managed/sessions*` surface before replacement coverage exists.
- Rewriting the TypeScript Agent loop in Java.

## 4. Architecture

```text
Client
  |
  v
Java product service
  |-- AgentSessionService
  |-- PublicEventStore
  |-- HarnessClient ------------------------------+
  |-- RuntimeBrokerService                        |
  |-- RuntimeBindingRepository                    |
  |-- ExecutionLedger                             |
  `-- RuntimeProvisioner                          |
          |                                       |
          | HTTP/SSE                              | HTTP/SSE
          v                                       v
Tool Runtime                               qwen serve sidecar
  |-- workspace                              |-- Managed Harness
  |-- tools                                  |-- model loop
  |-- file history                           |-- Session Authority
  `-- no model credentials                   `-- BrokerManagedRuntimeProvider
                                                       |
                                                       `-- HTTP -> Java broker
```

The Java-to-Harness and Harness-to-Java calls form an intentional asynchronous loop. A public request must not retain a blocking Java request thread while waiting for the Harness. Java durably accepts input, schedules the turn, and exposes progress through SSE.

## 5. Authority boundaries

| State                                               | Authority              |
| --------------------------------------------------- | ---------------------- |
| User, tenant, workspace authorization               | Java                   |
| Public Agent, Session, Turn, Item, and Artifact IDs | Java                   |
| Session execution-engine choice and Agent revision  | Java, verified by qwen |
| Model context, checkpoints, and Harness recovery    | qwen Session Authority |
| Runtime lifecycle and binding                       | Java Runtime Broker    |
| Logical tool execution state                        | Java Execution Ledger  |
| Physical execution receipt                          | Tool Runtime           |
| Public event sequence                               | Java PublicEventStore  |
| Runtime endpoint, lease, and token                  | Java only              |

Java may persist a public Item projection, but it does not become a second model-history authority in this milestone.

## 6. Identity model

The following IDs are distinct:

```text
publicSessionId   Java public Session
harnessSessionId  qwen internal Session
runtimeSessionId  one Managed Tool Session
runtimeBindingId  one provisioned workspace Runtime binding
turnId            one Agent turn
toolCallId        the model-produced Tool Call
executionCallId   the durable physical tool execution identity
```

Java stores a `SessionBackendBinding` from `publicSessionId` to `harnessSessionId`, tenant, workspace generation, fixed execution engine, Agent revision, and capability digest. The execution engine and revision are immutable after Session creation.

The default Runtime reuse key is:

```text
tenantId
+ workspaceId
+ workspaceGeneration
+ canonicalCwd
+ capabilityDigest
+ isolationClass
+ sessionIdentity when isolationClass=session
```

Agent revisions with the same executable capabilities may share a Runtime. Strong-isolation workloads use `isolationClass=session`, which adds the owning Harness Session to the binding key and forces the provisioner to return a distinct Runtime.

## 7. Data models

### 7.1 SessionBackendBinding

```ts
interface SessionBackendBinding {
  publicSessionId: string;
  harnessSessionId: string;
  tenantId: string;
  workspaceId: string;
  workspaceGeneration: string;
  executionEngine: 'legacy' | 'managed';
  agentId: string;
  agentRevision: string;
  capabilityDigest: string;
  status: 'active' | 'closing' | 'closed';
}
```

### 7.2 RuntimeBinding

```ts
interface RuntimeBinding {
  runtimeBindingId: string;
  tenantId: string;
  workspaceId: string;
  workspaceGeneration: string;
  canonicalCwd: string;
  capabilityDigest: string;
  isolationClass: 'workspace' | 'session';
  state: 'provisioning' | 'ready' | 'draining' | 'released' | 'failed';
  runtimeInstanceId?: string;
  leaseId?: string;
  leaseEpoch: number;
  idleDeadline?: string;
}
```

```text
ABSENT -> PROVISIONING -> READY -> DRAINING -> RELEASED
                       `-> FAILED
```

### 7.3 ToolExecution

```ts
interface ToolExecution {
  executionCallId: string;
  idempotencyKey: string;
  runtimeBindingId: string;
  harnessSessionId: string;
  runtimeSessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  requestDigest: string;
  state:
    | 'accepted'
    | 'waiting_runtime'
    | 'dispatched'
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'recovery_blocked';
  resultRef?: string;
  errorCode?: string;
}
```

```text
ACCEPTED -> WAITING_RUNTIME -> DISPATCHED -> STARTED
                                             |-> SUCCEEDED
                                             |-> FAILED
                                             |-> CANCELLED
                                             `-> RECOVERY_BLOCKED
```

## 8. Harness-to-Broker contract

`qwen serve` adds `BrokerManagedRuntimeProvider`, `ManagedRuntimeBrokerClient`, and a Hosted Harness profile. The provider sends only internal Session and invocation identities. Java resolves tenant and workspace scope from the authenticated `harnessSessionId`; it does not trust tenant or Runtime endpoint fields supplied by the Harness.

The private API is:

```text
POST /internal/runtime-broker/v1/tool-sessions:acquire
POST /internal/runtime-broker/v1/tool-sessions/{runtimeSessionId}/control
POST /internal/runtime-broker/v1/executions
GET  /internal/runtime-broker/v1/executions/{executionCallId}
GET  /internal/runtime-broker/v1/executions/{executionCallId}/events
POST /internal/runtime-broker/v1/executions/{executionCallId}:cancel
POST /internal/runtime-broker/v1/tool-sessions/{runtimeSessionId}:release
```

The P2 client polls `GET /executions/{executionCallId}`. The `/events` route and its sequence semantics are reserved here and are implemented with the product event store in P3/P4.

The qwen client produces a typed discriminated union for the existing Managed Tool v2 operations: manifest, file-history bind/checkpoint/snapshot, begin-turn, prepare, confirmation, confirm, and preflight. Java validates the closed operation-name set; the Managed Runtime remains the field-level payload validator in P2. This is not an arbitrary URL or HTTP-method proxy.

Every command has a stable request ID. Physical tool execution additionally uses the Java Execution Ledger.

## 9. First-Prompt flow

When Java accepts the first Prompt it:

1. Resolves tenant and workspace authorization.
2. Fixes the execution engine, Agent revision, and workspace generation.
3. Durably records the input and Turn.
4. Starts `RuntimeBrokerService.ensureBinding()` asynchronously.
5. Submits the Prompt through `HarnessClient` without waiting for Runtime readiness.
6. Returns `202 Accepted`; the client observes the turn through Java SSE.

For a no-Tool turn, model inference and completion never wait for Runtime. Provisioning may continue so later turns reuse the warm Runtime.

For a cold Tool turn, the Harness creates or resolves a `ToolExecution`; Java keeps it in `waiting_runtime`, dispatches it when the original binding is ready and attested, returns the result to the Harness, and the same model loop continues.

## 10. Idempotency and uncertain results

The execution idempotency key is derived from:

```text
harnessSessionId + turnId + toolCallId + requestDigest
```

- The same key and request returns the original `executionCallId`.
- The same key with different content is a conflict.
- Java records `accepted` before dispatch.
- Runtime deduplicates by `executionCallId` and retains a receipt while the binding is alive.
- A lost response is recovered by querying the original Runtime and execution ID.
- Java never changes Runtime and replays an execution whose start is uncertain.
- If neither the original Runtime nor a durable receipt can prove the terminal state, the execution becomes `recovery_blocked`.

## 11. Cancellation

Cancellation is a durable request, not an HTTP disconnect:

```text
client cancel
  -> Java records cancel intent
  -> HarnessClient cancels the turn
  -> RuntimeBroker cancels the execution
  -> Runtime terminates the tool root and descendants
  -> Java observes a proved terminal state
  -> Java settles the Turn
```

A cancel ACK, an aborted request, or a delivered signal is insufficient proof. Acceptance requires root and descendant exit and no post-cancel writes.

## 12. Hosted Harness profile

`qwen serve --profile hosted-harness` must:

- bind only to loopback;
- require a Java Broker origin and service credential;
- refuse Local Runtime fallback;
- refuse to start or discover Runtime processes;
- never expose Runtime endpoint, lease, or token;
- reject direct browser access;
- refuse client MCP, CDP tunnelling, and channel hosting;
- hold model credentials but no Kubernetes management credential;
- fail Managed turns without retrying through Legacy;
- fail at boot when Broker configuration is incomplete.

Local and open-source modes continue to use the existing Local provider.

## 13. Java-to-Runtime transport

The first slice reuses the existing authenticated Managed Tool v2 worker protocol. Java provides:

```text
RuntimeProvisioner
|-- StaticRuntimeProvisioner        initial contract and E2E
|-- LocalProcessRuntimeProvisioner  first owned lifecycle implementation
`-- KubernetesRuntimeProvisioner    later milestone

RuntimeTransport
`-- HttpRuntimeTransport
```

The current Node worker boot path uses Node IPC and is not a Java process contract. The local-process milestone adds a standalone boot input and one bounded ready record, for example:

```text
node managed-runtime-worker.js --boot-config /owned/path/boot.json
```

```json
{
  "type": "ready",
  "runtimeInstanceId": "rt_123",
  "endpoint": "http://127.0.0.1:12345",
  "leaseId": "lease_456",
  "epoch": 1
}
```

Normal Runtime logs do not share the ready-record channel.

## 14. Concurrency and events

- One Harness process serves multiple Sessions.
- Turns within one Session are serial.
- A Runtime is reused by compatible Sessions in the same workspace scope.
- MVP tool executions are serial per Runtime binding.
- Public events receive one Java-assigned monotonic `eventSequence`.
- Java projects Harness events to public Items; Broker events remain internal unless they add unique user-visible progress.
- `executionCallId` deduplicates overlapping Harness and Broker observations.
- SSE supports `Last-Event-ID`; client disconnect does not cancel the Turn.

## 15. Compatibility and rollout

- The existing ordinary `/session` Managed path is the only production-direction Harness entry.
- The experimental `/managed/sessions*` path is not extended into the public Agent API.
- The old path remains until the replacement covers admission, events, cancellation, and recovery.
- Rollout is gated by tenant/workspace compatibility and affects only new Sessions.
- Existing Session execution-engine ownership never changes during rollback.
- Managed initialization or execution failure never retries the Turn through Legacy.

## 16. Implementation slices

1. Shared contract types, validators, state machines, fake Broker, and delayed Runtime fixtures.
2. qwen Hosted Harness profile, broker client, provider, root Session identity propagation, and focused unit tests.
3. Java in-memory Broker, static provisioner, HTTP Runtime transport, and authenticated qwen callbacks.
4. Prompt-time parallel `ensureBinding`, Java event streaming, and the 15-second cold Runtime E2E.
5. Java-owned local process lifecycle, standalone worker boot protocol, status/cancel/release, and process-tree verification.
6. Durable repositories, public Agent/Session/Turn/Item APIs, Artifacts, and retirement of the old experimental control plane.

The embeddable Java Broker lives in `packages/sdk-java/runtime-broker`. Product services provide their authenticated Session resolver and Runtime provisioner without adding Spring or scheduler dependencies to the Broker core.

### 16.1 Implemented in the current qwen slice

- `qwen serve --profile hosted-harness` with loopback-only, bearer-authenticated, API-only startup validation.
- Dedicated Broker URL and credential inputs with secret scrubbing from child Runtime environments.
- A broker-backed Managed Tool v2 provider for typed control, durable execution creation/status/cancel, and terminal release.
- Propagation of the owning Harness Session ID independently from the Runtime Session ID.
- Fail-closed ordinary-session engine selection and removal of Local Runtime fallback in Hosted mode.
- Lazy Broker acquisition, so a no-Tool turn does not contact or wait for the Broker.

Prompt-time product-service `warm()`, public event projection, standalone Runtime boot protocol, and durable repositories remain later slices.

### 16.2 Implemented in the current Java slice

- A Java 11 embeddable `RuntimeBrokerService` with authenticated Harness Session scope resolution and compatible Runtime binding reuse.
- Asynchronous `warm()` and acquisition, allowing the product service to start provisioning without blocking model inference.
- An in-memory execution ledger that returns one `executionCallId` and dispatches once for one idempotency key.
- Cross-Harness identity rejection, terminal cancellation precedence, active-execution release fencing, and failed-provisioning retry.
- A reference `/internal/runtime-broker/v1` HTTP adapter and an HTTP transport for the existing Managed Runtime v1/v2 worker routes.
- Maven tests and CI coverage for the new module.

Prompt admission still needs to call `warm()` from the real Java product service. Durable repositories, public events, standalone Runtime process ownership, and physical process-tree cancellation remain later slices.

## 17. Validation plan

- Unit-test request validation, scope resolution, idempotency, state transitions, and fail-closed provider selection.
- Contract-test every Broker operation against a fake Java server.
- Run a two-process E2E with Runtime readiness delayed by 15 seconds.
- Inject lost execute responses, duplicate requests, cancellation races, Runtime exit, Java restart, and Harness disconnect.
- Verify process-tree liveness and filesystem writes after cancellation.
- Verify Runtime environment does not contain model credentials and Harness environment does not contain provisioner credentials.
- Measure first model event, Runtime-ready time, first-tool wait, Turn completion, and duplicate-prevention counters independently.

## 18. Acceptance criteria

1. A 15-second Runtime delay does not delay the first model event.
2. A no-Tool turn completes while Runtime is not ready.
3. A Tool Call in the same turn waits for Runtime and then completes.
4. Runtime performs no model call and receives no user Prompt.
5. Hosted mode cannot fall back to Local Runtime or Legacy execution.
6. One idempotency key produces at most one physical execution.
7. Java can recover an execution from the original `executionCallId` while the Runtime receipt remains available.
8. An unprovable started execution becomes `recovery_blocked` and is not replayed.
9. Cancellation proves root and descendant process exit and no later writes.
10. Tenant, workspace, and generation mismatches are rejected before side effects.
11. Multiple Sessions in one Harness do not share model context, permissions, or event ownership.
12. Public responses never expose Runtime endpoint, token, lease, Pod name, ACP client ID, or Harness instance ID.
