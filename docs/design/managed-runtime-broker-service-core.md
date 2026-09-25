# Managed Runtime Broker Service Core

[English](managed-runtime-broker-service-core.md) | [简体中文](managed-runtime-broker-service-core.zh-CN.md)

Status: Implemented at the framework-neutral Java service boundary

## Problem

The Runtime Broker repositories define durable identities, lifecycle states, compare-and-set versions, and operation or dispatch leases, but they do not coordinate the external work represented by those records. An embedding service still needs one place to resolve the authoritative Runtime scope, provision a Runtime, acquire a logical Runtime Session, dispatch and cancel a Tool execution, and release the Session without bypassing repository fencing.

## Goals

- Compose the existing Runtime binding, Runtime Session, and Tool execution repositories into one embeddable Java service.
- Keep authoritative tenant, workspace, generation, root, capability, and isolation scope resolution outside the Broker while requiring it before placement.
- Provision one Runtime generation per placement request and renew the repository operation lease until provisioning finishes.
- Acquire logical Runtime Sessions idempotently and route operations only through a process-local, attested Runtime lease.
- Dispatch each Tool execution once for one idempotency key, renew its dispatch lease while physical execution is in flight, and preserve ambiguous outcomes as `UNKNOWN`.
- Record cancellation intent before sending a physical cancellation signal and prevent release while an execution is active.
- Remain independent of Spring, HTTP, Hosted Harness internals, and any concrete process or container provider.

## Non-goals

- Exposing the Broker as an HTTP service or defining public Agent resources.
- Implementing a local process, container, Kubernetes, or remote Runtime provisioner.
- Adopting or reconciling a legacy binding after Broker process restart; a
  binding with durable identity is adopted by the Broker itself, as described
  in
  [Runtime binding reconciliation](2026-09-24-runtime-binding-reconciliation.md).
- Persisting Tool execution state in JDBC.
- Draining idle Runtime bindings or releasing physical Runtime processes.
- Implementing Hosted Harness callbacks or the Qwen CLI integration.

## Adapter boundary

`HarnessSessionResolver` returns the authoritative `RuntimeScope` for a Harness Session. Its result must remain stable for the lifetime of every Runtime Session created under that scope; a genuine scope change requires a new Runtime Session identity. The service derives a `RuntimeProvisionRequest`: workspace isolation has no isolation key and therefore shares a binding within the full scope, while session isolation uses the Harness Session identifier and therefore cannot share across Harness Sessions.

`RuntimeProvisioner` performs external provisioning and returns an attested `RuntimeLease`. Repeated calls for the same exact placement request must converge on one live resource, including after an ambiguous failure. The service owns the repository claim around that call, but it does not prescribe how a process or container is created.

`RuntimeTransport` implements acquire, control, execute, cancel, status, and release against one lease. `status` looks up an original invocation by its `reference` and is read-only; its default implementation fails closed with the non-retryable `runtime_execution_status_unsupported`, so a transport without the lookup can never settle an execution. It receives typed Runtime and Session identities; an HTTP adapter may project these calls onto the private protocol later without changing service state semantics.

## Binding lifecycle

The service calls `findOrCreate` for the exact placement request and converges concurrent work in the same process by binding identifier. A `PROVISIONING` record must be claimed through `claimOperation` before the provisioner is called. The service renews that operation claim while provisioning is in flight and writes `READY` only with the latest claimed version. A failed provision writes `FAILED` when the claim is still valid. A durable binding never writes `FAILED` once its scheduler resource is known: a non-retryable identity failure writes `RECOVERY_BLOCKED`, and a retryable failure keeps the record `PROVISIONING` so the retry converges on the ensured resource instead of minting a replacement. A lost or expired claim never publishes the returned lease.

A `READY` row is only durable control-plane evidence. It does not prove that its endpoint is alive or that a restarted Broker process owns the credentials and local resource. This service records leases attested by its own successful provisioning in process-local memory. When a repository returns `READY` without a matching process-local lease, a legacy binding fails with `runtime_reconciliation_required`, while a binding with durable identity enters Broker-side reconciliation: the provisioner observes the physical resource and the transport re-attests the Runtime identity before any Session may use the lease. Neither path silently reuses the endpoint or creates an in-memory replacement; see [Runtime binding reconciliation](2026-09-24-runtime-binding-reconciliation.md).

## Runtime Session lifecycle

`acquire` resolves scope before constructing the Session identity. Calls with the same Runtime Session identifier converge in process and must repeat the same Harness Session and turn kind, while the resolver must return the same scope. The service ensures a live binding, persists `ACQUIRING`, invokes transport acquire, and compare-and-sets the Session to `READY`. The Runtime acquire operation is required to be idempotent by Runtime Session identifier so a retry after an uncertain adapter boundary is safe. An acquire transport failure leaves the durable Session `ACQUIRING` and removes only the failed process-local attempt, allowing the same identity to retry safely instead of becoming terminal without authoritative failure evidence.

Control operations are limited to the existing private Runtime kinds: `bind-history`, `checkpoint`, `history`, `manifest`, `begin-turn`, `prepare`, `confirmation`, `confirm`, and `preflight`. They require a process-local Session whose repository record is still `READY`.

Release first rejects a Session with any unsettled execution. It persists `RELEASING`, calls the Runtime transport, and persists `RELEASED` only after positive release acknowledgement. An ambiguous or negative release remains `RELEASING`, so a caller can retry the idempotent Runtime release rather than reopening the Session. Once `RELEASED` is durable, a repeated release returns success without requiring the removed process-local route or calling the Runtime again.

## Tool execution lifecycle

Creation stores a `PREPARED` record whose immutable identity includes the binding generation, Harness Session, Runtime Session, prompt, Tool call, argument digest, and invocation reference. `findOrCreate` converges the idempotency key; changed request content is rejected before another physical dispatch.

The dispatcher claims the record, persists `EXECUTING` before calling the Runtime, and renews the dispatch lease until the call finishes. A valid result settles the current claimed record. A transport failure, missing result, or invalid result is ambiguous after physical dispatch may have started, so the service attempts to transition the execution to `UNKNOWN` instead of manufacturing an error result or replaying the Tool call. A same-key retry re-drives an unsent `DISPATCHING` record and uses repository takeover to fence an expired `EXECUTING` or `CANCEL_REQUESTED` claim as `UNKNOWN`; it never replays a Tool call whose dispatch lease is still live. Repository fencing remains authoritative if the claim expires or another owner takes over. The repository's clock decides whether a claim has expired; the service never compares a lease with its own clock. When the dispatch lease lapses before the Runtime answers, the result can no longer be written through the claim, so the dispatcher fences the record as `UNKNOWN` through the same takeover path.

Cancellation first uses the open repository path. A never-dispatched execution settles as cancelled. A `DISPATCHING` execution carries sticky cancellation intent for its owner to observe, and an `EXECUTING` execution becomes `CANCEL_REQUESTED` before the service sends the physical cancellation signal. A cancellation response settles the record only when it carries Runtime evidence with `state: settled` and a valid terminal result; a non-terminal acknowledgement leaves the sticky request for the dispatch result or later reconciliation. After the dispatch lease lapses, a cancellation still reaches an invocation that this process is running. A lapsed `CANCEL_REQUESTED` claim that nothing here is running is fenced as `UNKNOWN` instead, while a claim that is still live, whichever broker holds it, receives the physical cancellation signal. A settled acknowledgement that arrives after the lapse also fences the record as `UNKNOWN` rather than reporting a conflict.

## UNKNOWN reconciliation

`reconcileExecution` is the only caller of `resolveUnknown`. Each call makes at most one lookup and never retries internally; the caller polls, for example every 250 ms to 2 s with jitter, and should bound its own polling budget. It never calls `execute`, never claims the dispatch, and never derives a "not started" result itself.

- The record is read first and must belong to the caller's Harness and Runtime Session. A record that is not `UNKNOWN` is answered from the repository before any Session or liveness check: `ALREADY_SETTLED` ends polling, and `IN_FLIGHT` means the record is neither settled nor `UNKNOWN`, so there is nothing to reconcile yet. `IN_FLIGHT` does not prove that a dispatcher is still working. A lapsed `EXECUTING` or `CANCEL_REQUESTED` record stays there until a same-key retry or a cancel in a process holding the Session fences it as `UNKNOWN`, or until a takeover scan does; a same-key retry instead re-dispatches a `PREPARED` or lapsed `DISPATCHING` record, which never reached the Runtime. The reconciler itself never fences or claims a dispatch. Because this answer needs no local Session, a settled result stays readable after the Session is released; the embedding adapter's authorization decides who may call it.
- Only the original Runtime may answer. When the binding generation recorded on the execution is gone, replaced, or no longer `READY` or `DRAINING`, that generation is not usable for a lookup, and the call fails with the non-retryable `runtime_execution_evidence_unavailable`; restoring a generation that recovery blocked is operator work outside this slice. A dead lease also retires the binding, as every other operation on a dead lease does, and fails the same way, as does a Session whose lease this process already retired: that released the worker, even if the binding row still reads `READY` because another owner held its operation claim. When the generation could still answer but this process holds no attested route to it (the Session was not acquired here, is still being acquired, or its id is held here by another Harness), the call fails with the retryable `runtime_reconciliation_required`. It becomes answerable only after some Broker process adopts the binding and acquires that Runtime Session again with the same identity; the reconciler does neither. With a provisioner that cannot adopt, it never becomes answerable, so callers need their polling budget. A Session whose binding differs from the execution's is inconsistent data and fails with the non-retryable `runtime_execution_conflict`; it would take a resolver that changed a Harness Session's scope, which the adapter boundary forbids. The Session checks shared with other operations keep their codes: `runtime_session_not_found`, `runtime_session_conflict`, `runtime_session_not_ready`, and `runtime_scope_resolution_failed`. None of these sends a lookup.
- The service sends the record's `reference` and `lastSequence`. The response is closed: only `state` and, only when the state is `settled`, `result`. `state` is `prepared`, `executing`, `cancel_requested`, `settled`, or `unknown`. This contract version returns no events after `lastSequence`.
- `settled` with a valid result settles the record through `resolveUnknown` with the Runtime's own result (outcome `RESOLVED`). That includes `not_started` when the Runtime itself reports it. A racing cancel advances the version, so the service re-reads and retries the compare-and-set; a record another writer settled meanwhile is returned as `ALREADY_SETTLED` and not overwritten.
- Any other state keeps the record `UNKNOWN` (outcome `UNRESOLVED`). `unknown` means this Runtime holds no record of the reference; like a timeout or a 404, it is never evidence that the call did not run.
- A malformed response is the non-retryable `runtime_execution_status_invalid`. A transport or repository failure, a lookup still pending after the operation lease duration, or a record that keeps changing under the compare-and-set is the retryable `runtime_execution_reconcile_failed`. An error the transport classified itself, such as an incompatible route or identity conflict, keeps its code and retryability. In every failure case the record stays `UNKNOWN`.
- Concurrent calls for one execution share a single in-flight lookup. Closing the service fails its waiting callers; a Runtime answer that still arrives may settle the record, which the evidence rules allow. An answer that arrives after the lookup timed out is dropped instead, and the next poll asks again.

The lookup assumes that one `reference` identifies one invocation, which is how the Runtime keys it, and that the Runtime keeps a settled invocation's result available to `status`; the retention period belongs to the Runtime route contract that lands with the execute handler. That retention matters even in-process: when an invocation this process is still running finishes after its record became `UNKNOWN`, its result is not written through the lapsed claim, so a later lookup is what settles the record. The physical cancel of an `UNKNOWN` execution that the Runtime reports as still running, a durable receipt store that could prove "not started", operator recovery, and startup or takeover scans are out of scope for this slice. Until they exist, an `UNKNOWN` execution whose original generation cannot answer keeps its Runtime Session's release blocked. The busy check is keyed by Runtime Session id alone, so it also blocks releasing a Session another Harness holds under the same id in this process; that Harness also keeps the original Harness from acquiring the id here, so only another Broker process can adopt it. Keying the busy check by Session identity is a follow-up. A generation retired as `FAILED` does not block the scope: it is not active, so the next placement provisions a new one. A `LOST` generation does, and that state now exists — it stays active while an unsettled execution or an active Session references it, so any unsettled execution on a proven-`LOST` generation wedges its scope: `release` keeps answering the retryable `runtime_reconciliation_required`, and every new placement of that request gets `runtime_broker_runtime_lost`. `reconcileExecution` cannot clear it either — an `UNKNOWN` record gets the non-retryable `runtime_execution_evidence_unavailable`, while a record a crash left `EXECUTING` or `DISPATCHING` is answered as `IN_FLIGHT`, because nothing moves it to `UNKNOWN` without a same-key retry, a cancel, or a takeover scan. Settling or quarantining such executions needs a rule of its own, and that rule has to cover every unsettled state rather than only `UNKNOWN`; see [Runtime binding reconciliation](2026-09-24-runtime-binding-reconciliation.md).

## Concurrency and ownership

The service uses process-local futures only to coalesce duplicate provisioning, Session acquisition, and dispatch work within one Broker instance. Repository versions and leases remain the authority for state mutation. `brokerOwnerId` must identify one live Broker process; operation and dispatch claims are renewed at one third of their configured duration while external work is active.

Closing the service rejects new work, cancels its internal waiters, and stops its owned renewal scheduler. It does not assert that in-flight external work stopped; expired repository claims preserve the fail-closed takeover semantics.

## Errors and security

`RuntimeBrokerException` carries a stable code, retryability flag, and adapter-oriented status code. Validation, identity conflicts, a malformed execution lookup status, an execution whose original Runtime generation cannot answer, and a transport without the lookup are non-retryable. Provisioning, scope resolution, transport failure, claim loss, and missing reconciliation are retryable service-unavailable conditions.

Runtime tokens stay inside `RuntimeLease`. The service passes a lease to the binding repository and Runtime transport, and `warm` returns a binding record that carries the lease to the embedding caller. The JDBC binding repository persists secrets encrypted: a durable binding's provision seed (which carries the lease token) and a legacy binding's lease token are both stored as ciphertext through a required `SecretProtector` (`AesGcmSecretProtector` is included), and no plaintext token column remains in the schema. The key material must come from the embedding service's own durable secret store and stay stable across restarts and instances; the binding rows and their backups remain secret material that require restricted access and rotation controls. An embedding adapter must not serialize the lease or token to an untrusted caller. The service does not log tokens, invocation references, or Tool results. The embedding adapter remains responsible for authenticating callers and for mapping a caller to the Harness Session identifier supplied to this service.

## Validation

- Workspace-isolated Sessions share one provisioned binding; session-isolated Harness Sessions receive separate bindings.
- Concurrent acquisition of one Runtime Session invokes the Runtime acquire operation once in process.
- A persisted `READY` legacy binding without process-local attestation fails closed; a durable binding is reconciled and adopted instead.
- Duplicate execution creation converges on one record and one dispatch; changed content for the same idempotency key conflicts.
- Cancellation intent is persisted before the Runtime cancellation call and survives until the physical result settles.
- Ambiguous execution transport failure becomes `UNKNOWN`.
- Reconciliation settles an `UNKNOWN` execution only on a `settled` lookup with a valid result. Non-terminal states, `unknown`, malformed responses, and transport failures keep it `UNKNOWN`, and no case calls `execute` again.
- Reconciliation asks only the original, live, attested binding generation; a generation that can no longer answer stops polling with a non-retryable error; a record that is not `UNKNOWN` is answered as `ALREADY_SETTLED` or `IN_FLIGHT` without a liveness check; concurrent lookups share one bounded Runtime call; a racing cancel is re-read before settling.
- An active execution blocks Session release; successful release transitions the Session to `RELEASED` and removes its process-local route.
- Dispatch claims are renewed across an execution longer than one lease interval.
- Maven unit tests and Checkstyle pass on Java 21.

## Acceptance criteria

- No external operation starts without the corresponding repository identity and, where defined, a live claim.
- A stale provisioning owner cannot publish a Runtime lease.
- A stale dispatch owner cannot settle or mutate a Tool execution.
- One idempotency key cannot cause two physical dispatches within a Broker process.
- An ambiguous physical dispatch is never converted into a replayable error result.
- An `UNKNOWN` execution settles only on the original Runtime's own terminal evidence.
- Persisted readiness is never treated as liveness after process restart.
- Runtime Session release cannot race an unsettled Tool execution.
- No Spring, HTTP server, Hosted Harness, or concrete Runtime provider dependency is introduced.

## Follow-up work

Adoption and reconciliation of a durable binding after a Broker restart are implemented; the remaining slices are recoverable local-process provisioning, JDBC Tool execution persistence for multi-instance dispatch convergence, and exposing this core through a private HTTP adapter. The Java HTTP tool transport is implemented, but its worker routes and service adapter remain follow-up work. The adapter must supply `toolName`/`input` separately from the stored four-field reference and project status replies to `{state, result}` after wire validation; see [the tool contract](2026-09-24-managed-runtime-tool-contract.md#41-java-transport). Physical Runtime draining, Hosted Harness integration, and the Qwen-side Broker client remain separate reviewable slices.
