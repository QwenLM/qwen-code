# Managed Agent Activation P1

## Status

This document defines the next vertical slice after the in-process read-only
runtime handoff in `managed-agent-runtime-p0.md`. P1 adds a process-restart
durable activation journal, fenced Session activation leases, and a bounded
embedded Harness scheduler.

P1 is still a contract implementation. It does not replace the current daemon
Prompt route, start another process, or claim distributed coordination.

## Decision

Implement the first Harness control plane inside one existing long-lived Node.js
service process:

```text
durable caller-owned Session event
  -> enqueue activation metadata and fsync
  -> tenant-fair embedded scheduler
  -> reserve one async activation slot
  -> acquire Session activation lease at epoch N
  -> replay-safe activation handler
  -> conditionally append Session transition at epoch N
  -> release lease and slot
```

The scheduler creates asynchronous tasks, not a process or thread per Session.
`maxActiveSlots` bounds concurrent tasks. A caller-supplied memory gate can stop
new claims even when a nominal slot remains available.

## Why this is not wired into `sendPrompt` yet

The current daemon durably records Prompt lifecycle metadata and the Session
transcript, but it does not first persist the complete admitted user message in
a Gateway-owned event store before returning HTTP 202. The Prompt terminal
ledger deliberately contains no Prompt content.

Persisting only `harness.queued` and then moving the current Prompt callback
behind the new scheduler would therefore create a false recovery guarantee: a
restart could discover that work was queued without having the authoritative
input needed to continue it. Acquiring a global slot before the existing
per-Session FIFO would also waste the slot while an earlier Prompt runs.

Production route integration is gated on a durable `user.message` append and a
unified admission transaction. P1 instead accepts an opaque `payloadRef` whose
target the caller has already made durable.

## Objects

### Activation descriptor

```ts
interface ManagedActivationDescriptor {
  tenantId: string;
  sessionId: string;
  activationId: string;
  payloadRef: string;
  reason: 'user_message';
  recovery: 'replay_safe';
}
```

The journal never stores Prompt text, model credentials, tenant credentials, or
tool output. `payloadRef` names authoritative data in a separate Session store.
P1 accepts only `replay_safe`: after a crash the handler must reconstruct its
next step from durable Session state and make every authoritative append
conditional on the activation epoch. Mutating side effects without their own
idempotency ledger are not eligible. The handler may resolve only after its
authoritative Session transition is durable; the scheduler treats resolution
as permission to release the activation as completed.

### Activation lease

```ts
interface ManagedActivationLease {
  tenantId: string;
  sessionId: string;
  activationId: string;
  workerId: string;
  epoch: number;
  expiresAt: number;
}
```

Epochs increase monotonically per tenant/Session, not per process. A renew or
release carrying an older Worker or epoch fails closed. Only the oldest
unfinished activation for a Session can be assigned, preserving Session FIFO.

### Durable events

The local journal is append-only JSONL:

```text
activation.queued
activation.assigned
activation.renewed
activation.released
```

Every transition has a monotonic journal sequence and is synced before the API
acknowledges it. Startup replays complete lines, truncates only a torn final
line, and rejects malformed or inconsistent committed history. The Store
samples its authoritative clock inside the serialized state transition;
callers cannot submit a pre-sampled timestamp that becomes stale while waiting
for I/O.

This file implementation is a single-process adapter. Two processes must not
open the same journal concurrently. The later supervised-process slice must put
the same state machine behind a storage service or database transaction with a
single authoritative clock; it must not treat JSONL append as a distributed
lock.

## Admission and fairness

New activation admission is bounded by both global and per-tenant queued
limits. An idempotent duplicate is returned even when a limit is full; reusing
the same activation identity with a different descriptor fails closed.

Runnable work is selected round-robin across tenants. Within a tenant the
oldest runnable activation is selected, and within one Session no later
activation can pass an unfinished predecessor. Fairness is deliberately at the
tenant boundary so one tenant with many Sessions cannot monopolize all warm
slots.

Before every claim, the scheduler requires:

1. `activeSlots < maxActiveSlots`; and
2. the memory gate reports headroom.

When memory is unavailable, queued work remains durable and no lease is
acquired. The deployment adapter calls `notifyCapacityChanged()` after a new
memory sample; a slot release automatically pumps the queue. Unknown or stale
memory measurements should be mapped to “no headroom” by the production
adapter.

## Recovery

On startup, the scheduler considers:

- queued activations immediately runnable;
- assigned activations runnable only after their lease expires; and
- released activations terminal.

Reclaiming an expired assignment writes a new assignment with a higher Session
epoch. A late completion from the old epoch cannot release the new lease or
authoritatively advance the Session. The embedded scheduler renews leases while
its handler is active; losing the lease aborts that handler cooperatively. The
handler receives the stable fence identity and epoch, not a lease-expiry value
that would become stale after an automatic renewal.

The journal establishes control-plane recovery, not model-stream migration. An
in-flight model response may be regenerated from the last authoritative Session
event. Any preview deltas sent before the crash remain non-authoritative.

## Failure semantics

| Failure                                | Behavior                                                   |
| -------------------------------------- | ---------------------------------------------------------- |
| Queue limit reached                    | Reject new work with an explicit retryable admission error |
| Memory gate closed                     | Leave work queued; acquire no lease                        |
| Duplicate identity and descriptor      | Return the existing activation state                       |
| Duplicate identity with different data | Reject as an identity collision                            |
| Handler fails                          | Durably release the current epoch as `failed`              |
| Worker disappears                      | Reclaim only after TTL with a higher epoch                 |
| Stale renew or release                 | Reject; preserve the current owner                         |
| Journal append or sync fails           | Do not apply the in-memory transition; halt new scheduling |
| Torn final JSONL record                | Truncate on startup before accepting work                  |
| Corrupt committed record               | Fail startup closed                                        |

## Implementation boundary

P1 adds two internal components:

- a file-backed activation store implementing the journal state machine; and
- an embedded scheduler implementing slots, tenant fairness, lease renewal, and
  a caller-supplied memory gate.

It intentionally omits:

- daemon HTTP/SSE integration;
- Prompt body or model transcript storage;
- cross-process claims or a shared database;
- a process supervisor, Kubernetes adapter, or autoscaler;
- runtime provisioning;
- retry of non-replay-safe work;
- queued-activation cancellation, per-tenant active-slot caps, or maximum
  queue-age eviction;
- journal compaction and retention policy; and
- production telemetry and quota wiring.

## Exit criteria

Focused tests must prove:

- queued metadata survives store reopen;
- a torn tail does not destroy the next valid append;
- conflicting identity reuse fails closed;
- only one activation in a Session can hold the current epoch;
- expired work is reclaimed at a higher epoch and stale release is rejected;
- slots cap concurrent handler tasks;
- tenants alternate under contention while a Session remains FIFO;
- a closed memory gate acquires no lease and reopening it resumes work; and
- queue limits reject only new work, not idempotent duplicates.

After those contracts pass, the next slice is the durable `user.message`
admission path and unified per-Session/global scheduling seam. Only then should
the embedded scheduler sit on the live Prompt route.
