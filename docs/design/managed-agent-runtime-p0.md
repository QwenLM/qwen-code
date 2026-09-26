# Managed Agent Runtime P0

> Historical milestone: the in-Core broker and Tool-wrapper experiment from
> this phase was removed in P7. The active prototype now uses the
> Gateway-owned model loop and the source-bound ACP Tool-only transport
> described in P6 and P7, avoiding a second unwired Runtime protocol and Core
> Scheduler changes.

## Status

This document defines the first protocol-level slice for evolving Qwen Code from a complete daemon inside each execution environment toward a resident, multi-tenant agent service with replaceable Harness Workers and execution runtimes.

The P0 is deliberately in-process and read-only. It validates the Tool Call boundary without introducing Kubernetes scheduling, a second agent loop, a new public service, or mutating-tool retry semantics.

## Problem

A session currently depends on the process that owns both model orchestration and local tool execution. When that process runs inside an on-demand Pod, Pod and daemon startup delay admission of the first prompt.

The target architecture starts inference in a resident Harness Worker while provisioning the execution environment concurrently. A tool call that needs the workspace waits at the execution boundary and resumes the same logical turn when an execution runtime becomes available.

## Target boundaries

```text
Client
  -> resident admission Gateway
       -> durable Session log and activation queue
       -> Harness scheduler and capacity registry
            -> replaceable stateless Harness Workers
                 -> versioned capability registry
                 -> runtime broker
                      -> replaceable execution runtime / sandbox
```

The service is logically multi-tenant. Session state, activation leases, runtime leases, capability versions, credentials, and workspaces remain tenant- and session-scoped. A Harness Worker may process multiple bounded session activations concurrently and different tenants over time, but only one activation lease may advance a session at once.

`Harness Worker` is a deployment-neutral service process, not a synonym for a Kubernetes Pod. One Worker can advertise multiple bounded activation slots, and a fleet can contain one process or many. Kubernetes may run one Worker process per Pod, while a VM, bare-metal host, or local runner may supervise the same process directly. The protocol and recovery model must not depend on either choice.

The long-term resource model has five independently versioned objects:

- `AgentDefinition`: model, instructions, tool schemas, skills, and policy.
- `EnvironmentDefinition`: image, resources, network, storage, and local MCP servers.
- `Session`: append-only events and the agent/environment versions selected at creation.
- `SessionActivationLease`: the Harness Worker currently allowed to advance one Session, fenced by a monotonically increasing epoch and TTL.
- `RuntimeLease`: the current execution runtime for one tenant/session, fenced by a monotonically increasing epoch.

## Process, task, and memory model

The Harness does not allocate an operating-system process or thread per Session. A small number of long-lived Worker processes each run many bounded asynchronous activation tasks:

```text
host / container / Pod
  -> Harness Worker process
       -> shared immutable definition and capability caches
       -> bounded asynchronous activation tasks
            -> temporarily advance Sessions
```

A Session has no permanent process or thread affinity. The activation lease identifies the Worker process and lease epoch; a thread id is an implementation detail and is never durable identity. Model streams and remote Tool waits use asynchronous I/O. CPU-heavy work uses a bounded shared thread pool or separate service rather than creating a thread for every Session.

For an initial single-host deployment, the Gateway, Harness scheduler, and one Worker loop may share one service process while preserving their logical interfaces. Additional Worker processes are introduced for failure isolation, CPU use, memory/GC isolation, or deployment scale—not in proportion to Session count. Node.js can use event-loop tasks with a bounded worker-thread pool; Rust can use tasks on a multi-thread Tokio runtime. The protocol is independent of that implementation choice.

Memory admission is separate from process count. A deployment budgets approximately:

```text
worker count * (base process RSS + process-local shared-cache budget)
  + active activation slots * p95 activation working set
  + safety headroom
```

Admission requires both an available slot and memory headroom. A Worker stops claiming new activations before its memory or event-loop health limit is reached, even if its nominal slot count is not exhausted. Durable Session state is loaded only for the current activation window; at a durable wait boundary the Worker persists the transition, drops activation-local buffers, and releases the slot. Caches are shared by tasks within one process but duplicated across Worker processes, so the process count remains a memory consideration. They are keyed by immutable definition or capability digest and must not contain tenant credentials.

Execution runtimes remain a separate isolation and capacity domain. Their process, container, or VM memory is not part of the Harness slot budget.

## Invariants

1. The Harness Worker holding the current activation lease is the only owner allowed to advance the agent loop and final answer.
2. Tool schemas are available before an execution runtime is ready. Runtime readiness never changes the capability set within a turn.
3. An execution runtime owns only an execution lease. It never owns the Session.
4. Every execution is identified by `tenantId`, `sessionId`, `turnId`, and `toolCallId`.
5. An execution runtime must present the capability digest pinned by the Session.
6. Results from a replaced lease epoch are rejected.
7. Reusing a `toolCallId` with different input fails closed.
8. P0 does not retry an execution after dispatch. Automatic retry is unsafe until mutating tools have a durable side-effect ledger.
9. Durable event appends are conditional on the current activation epoch, so a stalled or replaced Harness Worker cannot continue writing.

## Harness capacity and admission

The Harness fleet is resident and may be elastic. “Stateless” means that a Harness Worker is replaceable and is not the sole durable owner of a Session; it does not mean that the fleet scales to zero. Meeting the TTFT objective requires a configured warm-capacity floor even when the deployment has no autoscaler.

Capacity is counted in bounded activation slots rather than Worker, thread, or Pod count. A slot is an asynchronous-task admission token, not a dedicated thread. Admission atomically reserves a slot and acquires the Session activation lease before dispatching work. A Worker advertises its available slots and renews the leases for activations it owns.

An activation slot is held only while a Harness Worker is actively advancing the Session, such as assembling context, streaming a model response, or committing a transition. At a durable wait boundary—runtime provisioning, remote Tool execution, user approval, or scheduled wakeup—the Worker appends the waiting event and releases both the activation lease and slot. The completion event queues a new activation that may run on any Worker. An in-flight model stream is not migratable and keeps its slot until it completes or fails.

When no slot is immediately available, the Gateway must:

1. place the activation in a durable, bounded, per-tenant fair queue;
2. request additional Worker capacity through a deployment adapter;
3. return an explicit queued status while preserving the client stream; and
4. reject with a retryable overload response when the tenant or global queue limit, or the maximum queue wait, is exceeded.

Scale-out is an optimization, not a correctness dependency. A fixed-capacity deployment can use a no-op adapter, and a local adapter can start another supervised process. Either adapter may decline the request; bounded queueing and overload rejection must still work.

A transport acknowledgement while waiting for Harness capacity is not model TTFT. Under overload, useful TTFT necessarily increases; the service must expose that delay rather than hide it behind an acknowledgement.

Autoscaling should use available activation slots, queue depth, oldest queued age, event-loop delay, and memory pressure. CPU alone is insufficient for an I/O-heavy model-streaming service. Per-tenant concurrency and queue quotas prevent one tenant from consuming all warm capacity.

The Harness scheduler depends only on Worker registration, heartbeat, available-slot reporting, reservation, and release. It may emit a capacity-demand signal, but it does not create Pods or processes itself. An optional deployment adapter consumes that signal outside the agent protocol:

| Environment          | Typical Worker mapping                                                |
| -------------------- | --------------------------------------------------------------------- |
| Kubernetes           | Usually one Harness Worker process per Deployment-managed Pod         |
| VM or bare metal     | One or more systemd/supervisor-managed Worker processes               |
| Container service    | One Worker process per task/container                                 |
| Single-host embedded | Gateway and one Worker may share a process but keep logical contracts |
| Local development    | One or more child Worker processes managed by a local runner          |

All mappings use the same Session store, activation lease, capacity, and recovery contracts. The execution runtime is independently pluggable: it may be a Kubernetes Pod, container, VM, remote daemon, or local sandbox.

## Historical P0 implementation (removed)

The original experiment added three small seams:

- `ToolExecutionContext` binds the scheduler-owned session, turn, call, and resolved tool name to the existing invocation Promise.
- `ManagedRuntimeReadTool` wraps an existing read-only tool. It preserves the original schema, validation, permission decision, descriptions, output limits, and tool locations, but sends execution to the runtime broker.
- `ManagedRuntimeBroker` waits for a matching execution runtime, supplies lease metadata to it, forwards progress, caches the result by call id, and fences stale runtimes.

The wrapper could be registered before any runtime attached, so the model saw the same function declaration during its first inference. The existing `CoreToolScheduler` waited for the invocation Promise and submitted its result to the next model step; no second agent loop was introduced.

The P0 wrapper options are created from authenticated, Session-scoped admission state. Its `tenantId` and capability digest are immutable for that Session tool view; a process-global wrapper with a mutable or user-supplied tenant identity is invalid in a multi-tenant Harness.

P0 follows the minimum process model: it creates no Harness process or thread pool and uses the existing process's asynchronous execution path. It does not implement the Harness scheduler, activation queue, Session activation lease, durable suspension, memory admission, or a deployment adapter. Its in-process broker intentionally holds the scheduler invocation Promise while waiting for a runtime; this validates only the same-turn Harness-to-runtime boundary and must not be described or deployed as a production Harness pool.

```text
model emits read_file(call-1)
  -> scheduler validates and applies permission policy
  -> wrapper calls broker.execute(call-1)
  -> broker waits because no lease exists
  -> execution runtime attaches as runtime-a@1
  -> execution runtime executes call-1
  -> broker accepts the epoch-1 result
  -> scheduler records the result and continues the same turn
```

## Protocol

The Harness-to-runtime request contains:

```ts
interface ManagedRuntimeExecuteRequest {
  tenantId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  capabilityDigest: string;
  toolName: string;
  input: Record<string, unknown>;
  runtimeId: string;
  leaseEpoch: number;
}
```

The execution runtime returns an ordered stream:

```ts
type ManagedRuntimeExecuteEvent =
  | { type: 'started' }
  | { type: 'progress'; output: ToolResultDisplay }
  | { type: 'result'; result: ToolResult }
  | { type: 'error'; error: { message: string; code?: string } };
```

The production transport may use an outbound runtime connection or a work queue. It must preserve these identifiers and must not trust tenant or session identifiers supplied by an end user; the Gateway derives them from authenticated admission state.

## Session events

The durable control plane should append, at minimum:

```text
user.message
harness.queued
harness.assigned
assistant.delta
assistant.message
tool.requested
runtime.requested
runtime.attached
tool.started
tool.progress
tool.result
tool.error
runtime.released
harness.released
turn.completed
turn.cancelled
```

Preview deltas are not authoritative. `assistant.message`, Tool Call requests, and Tool Call results are the replayable state.

Qwen Code already records model turns and completed tool results in its append-only transcript. P0 intentionally leaves runtime-wait and lease events in memory. Process-restart recovery requires a shared Session store and a `wake(sessionId)` path and is the next control-plane slice, not a property claimed by this implementation.

## Failure semantics

| Failure                                    | P0 behavior                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| No execution runtime yet                   | Wait until attach or caller cancellation                               |
| Capability digest mismatch                 | Fail closed without dispatch                                           |
| Same call id and same input                | Return the original Promise/result                                     |
| Same call id and different input           | Reject as an identity collision                                        |
| Runtime replaced during execution          | Abort cooperatively and reject the stale result                        |
| Runtime stream ends without result/error   | Reject as a protocol violation                                         |
| Session disposed                           | Abort the active lease, reject waiters, and clear the in-memory ledger |
| Runtime fails after an unknown side effect | Return an error; never retry automatically                             |

The scheduler's existing tool timeout remains the upper bound for an execution runtime that ignores cancellation.

## Security boundary

- Authentication supplies `tenantId`; model output and runtime payloads do not.
- Capability schemas and permission decisions remain in the Harness.
- The execution runtime receives only the selected Tool Call and a session-scoped runtime credential.
- Model-provider credentials and broad cloud credentials must not enter the execution runtime.
- Runtime registration must be outbound-only or authenticated through an equivalent private channel.
- Workspace, network policy, volume, and credential references are scoped to the runtime lease.

## Measurement

The Gateway must record separate timestamps for:

- prompt admitted;
- Harness slot requested, queued, and assigned;
- first model delta;
- first Tool Call requested;
- runtime requested and ready;
- tool started and completed;
- authoritative assistant message completed.

The primary comparisons are wait-for-Harness time, model TTFT, wait-for-runtime time, time-to-first-tool-result, total completion time, and unused-provisioning rate. A fast acknowledgement is not counted as useful TTFT unless it is model output that advances the task.

Before selecting immediate, delayed, or predictive provisioning, production traces should measure the first three turns: percentage requiring local tools, time to first local Tool Call, tool/MCP/skill distribution, and Pod/daemon readiness p50/p95.

### Directional DataAgent baseline

A read-only SLS sample was taken on 2026-09-01 over the preceding 24 hours. It selected up to 30 of the newest interaction traces for each `interaction.sequence` and environment, discarded tool events outside the interaction interval, and treated shell, file, search, skill, and workspace-aware agent tools as local-runtime capabilities. The aggregation did not use prompt contents, and no raw trace file was retained.

| Environment | Turn | Traces / users | No local tool | First local tool p50 / p95 | Most frequent local calls     |
| ----------- | ---: | -------------: | ------------: | -------------------------: | ----------------------------- |
| Internal    |    1 |         30 / 5 |         30.0% |               9.8s / 33.2s | shell 251, skill 29, read 19  |
| Internal    |    2 |         16 / 2 |         12.5% |              11.5s / 38.5s | shell 93, read 8, skill 6     |
| Internal    |    3 |         11 / 1 |          9.1% |             12.4s / 121.1s | shell 71, skill 8, read 6     |
| Public      |    1 |        30 / 13 |         93.3% |                3.1s / 4.0s | read 6, skill 2, shell 2      |
| Public      |    2 |        30 / 23 |         20.0% |              11.1s / 99.9s | shell 202, read 43, skill 14  |
| Public      |    3 |        30 / 20 |         30.0% |              20.7s / 76.3s | shell 125, read 33, search 12 |

The first-local-tool percentiles include only turns that used a local tool. Median model TTFT ranged from 2.0-2.4 seconds in the internal sample and 2.3-4.1 seconds in the valid public samples. One invalid TTFT outlier was excluded because it exceeded the entire interaction duration.

This sample supports concurrent execution-runtime provisioning: most tool-using turns give the control plane roughly 10 seconds before the first local execution boundary. It does not support a universal delayed-start policy. Internal first turns were local-tool-heavy, while public first turns were mostly model-only, so admission policy must be measured per workload. Shell is the dominant next capability after the read-only P0.

The internal second- and third-turn samples contain only two and one distinct users, respectively, and scheduled or automated sessions may dominate the counts. These numbers are directional, not a population estimate. Current traces also expose daemon session restoration for only one sampled first turn and do not expose Pod provisioning, so Pod/daemon startup p50/p95 remains an instrumentation gap.

## P0 verification

Automated coverage proves that:

- a call remains pending before runtime attach and completes afterward;
- the scheduler supplies the original session, turn, and call identifiers;
- capability metadata is visible before attach;
- progress and terminal results cross the boundary;
- a runtime attached for another tenant cannot wake the call;
- duplicate calls execute once;
- conflicting identities, stale leases, mismatched capabilities, cancellation, disposal, and incomplete runtime streams fail closed;
- mutating tools cannot use the P0 adapter.

## Non-goals

- Kubernetes provisioning or warm pools;
- a production Harness fleet, activation queue, autoscaler, or deployment adapter;
- a network protocol or externally reachable runtime API;
- remote shell, file mutation, MCP, or skill execution;
- durable runtime queues and process-restart recovery;
- credentials, vaults, or egress substitution;
- CRIU/eBPF checkpoints or predictive provisioning;
- replacing the existing daemon or choosing a Rust control-plane implementation.

## Next slice

After P0, define the durable Session store, fenced Session activation lease, and bounded activation scheduler inside the existing long-lived service process. Validate slot and memory backpressure with the embedded Worker first, then run the same contract through a local supervised-process adapter for crash isolation before adding Kubernetes-specific scaling. Replace the in-process runtime attachment with an authenticated outbound runtime transport and persist `tool.requested`, runtime lease, and terminal execution events. Only after recovery and side-effect semantics are proven should the adapter expand beyond read-only tools.

`managed-agent-activation-p1.md` implements the activation journal, fencing, and embedded scheduling contract. Live Prompt integration remains gated on the separate authoritative `user.message` store described there.
