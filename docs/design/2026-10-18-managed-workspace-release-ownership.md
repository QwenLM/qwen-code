# Managed Workspace: release ownership when the worker refuses or hangs

[English](2026-10-18-managed-workspace-release-ownership.md) | [简体中文](2026-10-18-managed-workspace-release-ownership.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-10-18
- **Baseline:** `0fac9973df`
- **Issue:** [#12937](https://github.com/QwenLM/qwen-code/issues/12937) (split out of [#12868](https://github.com/QwenLM/qwen-code/pull/12868))
- **Modules:** `packages/managed-agent-server`, `packages/cli/src/serve`, `packages/core/src/tools`

Every claim in "Current state" was re-read at the baseline commit above. "Proposed"
marks behavior that does not exist yet; the status table in §2.6 separates the two.

## 1. Problem

A Workspace Runtime Session owns its storage through a durable row. The release
path clears that row only after the worker acknowledges, so a worker refusal,
timeout, or hang leaves the storage permanently owned by a Session that can
never use it again:

- every later `acquire` on that storage fails `claim()` with `409 workspace_busy`;
- a retry of the same Runtime Session stays in `RELEASING`;
- no other automatic path clears the row.

The fix must free the durable lease on a path that does not require a successful
worker answer, without weakening the acquire-side rule that a missing response
proves nothing.

## 2. Current state

### 2.1 Acquire keeps ownership on an uncertain answer

`WorkspaceRuntimeTransport.acquire` claims the storage before it installs or
activates anything, and deliberately keeps the claim when the install result is
uncertain (`WorkspaceRuntimeTransport.java:104-105`):

```java
ownership.claim(context.binding(), context.session());
// Failure retains ownership: a missing response cannot prove the worker did nothing.
```

`acquireUncertain` then reports a retryable failure. This invariant is the reason
a blind compensating release on a transport failure is not acceptable.

### 2.2 Release clears ownership only after the worker answers

`WorkspaceRuntimeTransport.release` (`:409-435`) has three stages:

```java
return delegate.release(lease, session).thenCompose(released -> {
    if (!Boolean.TRUE.equals(released)) {
        throw WorkspaceExecutionStore.unavailable();      // :424-426
    }
    return delegate.activateWorkspace(context.runtime(), context.session(), context.binding(), false);
})
.thenApply(ignored -> {
    ownership.release(context.binding(), context.session()); // :430
    detachOwed.remove(detach);
    return true;
});
```

Any throw or timeout before the last stage skips `ownership.release`. The
`RELEASING` shortcut at `:416-421` does not help: it requires
`!ownership.isHeld(...)`, and the holder is exactly what is stuck.

`ownership.release` has two call sites today, not one: `:430` (full release) and
`:455` (`releaseMount`). The second belongs to the separate mount-handback
operation and is not a compensation path for a failed full release.

### 2.3 The Broker leaves the Session in RELEASING

`RuntimeBrokerService.completeSessionRelease` (`:3085`) transitions the Session
to `RELEASING` before calling the transport (`:3101`), calls
`transport.release(...)` (`:3112`), and only on success calls
`finishSessionRelease` (`:3124`). On error it clears the latch and completes
exceptionally (`:3116-3121`); the durable Session row stays `RELEASING`.

A retry rebuilds the same chain and reaches the same worker refusal. The
worker's memoized release promise (see 2.5) is what makes this permanent.

### 2.4 The holder row is durable and exact-match

`ma_storage_owner` (`V1__managed_schema.sql:861-891`) stores
`holder_key`, `binding_id`, `runtime_generation`, `runtime_session_id`, plus the
maintenance-hold columns. There is no holder generation, expiry, or heartbeat
column.

- `WorkspaceExecutionStore.claim` (`:337`) takes the row `FOR UPDATE` and
  refuses a different holder with `busy()` (`:703`, `409 workspace_busy`,
  retryable). It has no supersede rule.
- `WorkspaceExecutionStore.release` (`:422`) clears the row only when the
  binding at `(binding_id, generation)` is still `READY` or `DRAINING`, and only
  for the exact `holder_key` (`:447-450`). A `LOST` or `RELEASED` binding makes
  it throw `workspace_unavailable`.

### 2.5 Worker release is memoized and unbounded

`managed-runtime-provider-worker.ts:297-327`:

```ts
if (session.release) return session.release;              // :308
...
entry.release = (async () => {
  await entry.value?.runtime.releasePrepared();           // :316
  ...
})().catch((error) => { entry.release = undefined; throw error; }); // :323-326
```

`ManagedToolRuntime.releasePrepared()` (`managed-tool-runtime.ts:919-932`)
refuses while an execution is unfinished:

```ts
throw new Error('Managed Runtime still owns unfinished execution.');
```

and otherwise awaits `entry.cancellation` promises with no deadline. Two
consequences:

1. A refusal is a plain `Error`. The worker's response mapper
   (`managed-runtime-provider-worker.ts:726-731`) turns it into `409` with
   `code: managed_runtime_provider_operation_failed`, so the Broker cannot tell
   a deliberate refusal from an unrelated provider failure.
2. A hang keeps `entry.release` pending forever; every retry returns the same
   promise. The Broker's HTTP client times out (`HttpRuntimeTransport.java:50`,
   `REQUEST_TIMEOUT = Duration.ofSeconds(30)`), but the worker never retries.

### 2.6 Other paths that clear the holder

| Path                                                        | Proof it requires                                        | Reaches the stuck case?               |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `ownership.release` in `WorkspaceRuntimeTransport` (`:430`) | worker acknowledged                                      | no                                    |
| `releaseMount` (`:455`)                                     | separate mount-handback operation                        | no                                    |
| `WorkspaceExecutionStore.releaseLost` (clear at `:650`)     | binding `LOST` + `hasStoppedWriters()` + operation lease | no (binding is still `READY`)         |
| `WorkspaceMaintenanceRecovery` (`:162`)                     | maintenance hold                                         | no (operator/maintenance driven only) |
| `WorkspaceOperatorRecoveryStore`                            | operator recovery operation                              | no (manual)                           |

`RuntimeBrokerService.releaseStoppedSession` (`:5838`) is the one path that
durably retires a Session **without** calling the transport: it requires a
drain receipt matching the binding and no active executions, then calls
`finishSessionRelease` and removes the in-memory session. It never clears
`ma_storage_owner`, so even the successful close cascade can retire a Session
while its storage stays owned.

`releaseUnusableSession` (`:3137`) handles a dead worker: it invalidates a
`READY` binding to `LOST` and fails with `runtime_reconciliation_required`. The
holder is then W0e's (`releaseLost`) responsibility, which requires durable stop
evidence.

| Behavior                                                           | At baseline `0fac9973df` |
| ------------------------------------------------------------------ | ------------------------ |
| Acquire retains ownership on an uncertain answer                   | Implemented              |
| Release clears ownership only after worker ack                     | Implemented              |
| `RELEASING` Session with a stranded holder has an automatic escape | **Not implemented**      |
| Local Session retirement clears the holder                         | **Not implemented**      |
| Worker release is bounded and retry-safe                           | **Not implemented**      |
| Refusal carries a distinguishable retryable code                   | **Not implemented**      |

## 3. Failure modes

**F1 — refusal.** The Broker settled an execution the worker still considers
unfinished. `releasePrepared()` throws; the worker answers `409`; the Broker
fails the release; the Session stays `RELEASING`; the holder stays. The worker
may never finish, so retries never converge.

**F2 — hang.** `releasePrepared()` awaits a cancellation promise that never
settles. The memoized `entry.release` never settles either, so every later
attempt returns the same hung promise. The Broker times out each time; the
holder stays forever.

**F3 — crash window.** A Broker that dies between `claim` and `release` (or
mid-release) leaves the row behind. This design does not solve F3 by itself;
the existing reconciliation and `releaseLost` paths remain the owners.

## 4. Goals and non-goals

**Goals**

- G1: after the Broker has durably retired a Session, its storage holder is
  cleared without requiring a successful worker answer.
- G2: no compensating release on a mere transport failure; the acquire-side
  invariant in §2.1 is preserved.
- G3: a hung worker release is abandoned at a bound and can be retried.
- G4: a worker refusal is distinguishable from an unrelated provider failure.

**Non-goals**

- Changing `claim` to supersede a holder by time or generation alone (§6, D-1).
- Compensating on `releaseUnusableSession` without stop evidence (§6, D-4).
- Changing the public/WebShell API, the OpenAPI contract, or the schema.
- Automatically draining a Workspace on N failed routine releases; that is a
  control-plane policy decision, not an ownership primitive.

## 5. Proposal

### 5.1 Worker: bounded, distinguishable release

File: `packages/cli/src/serve/managed-runtime-provider-worker.ts`.

1. Give `ProviderSession` a monotonically increasing `releaseAttempt`.
2. Race the first step against a deadline:

   ```ts
   const attempt = ++entry.releaseAttempt;
   try {
     await withDeadline(
       entry.value?.runtime.releasePrepared(),
       RELEASE_DEADLINE_MS,
     );
   } catch (error) {
     throw isDeadline(error)
       ? conflict(
           'Managed Runtime release timed out.',
           'managed_runtime_release_timeout',
         )
       : conflict(messageOf(error), 'managed_runtime_owner_hold_pending');
   }
   ```

   `managed_runtime_owner_hold_pending` already exists
   (`managed-runtime-provider-worker.ts:312`) and already means "the worker
   still owns work". `managed_runtime_release_timeout` is new and retryable.

3. Before mutating provider state (`closeSessionAdmission`, `forgetSession`,
   `closed = true`, push to `released`), require the attempt to still own the
   identity:

   ```ts
   if (this.sessions.get(id) !== entry || entry.releaseAttempt !== attempt) {
     return true; // an abandoned attempt must not retire a re-acquired Session
   }
   ```

4. The abandoned `releasePrepared()` promise keeps running; attach a no-op
   rejection handler so it cannot surface as an unhandled rejection.

5. `entry.release` is cleared only when the failing attempt is still current, so
   a timed-out attempt can be retried with a fresh one.

`RELEASE_DEADLINE_MS` must stay below `HttpRuntimeTransport.REQUEST_TIMEOUT`
(30 s) so the Broker sees a clean retryable `409` instead of a client timeout.
The initial value is 20 s; see §11.

Core stays unchanged: the deadline belongs to the memoizing caller, and the
core runtime keeps its synchronous refusal contract.

### 5.2 Broker: `releaseRetired` with a durable proof predicate

Add a transport hook. The default is a no-op because only the Workspace
transport owns durable storage:

```java
/**
 * Finishes durable ownership for a Session the Broker has already retired.
 * The caller must hold durable proof that the Runtime no longer holds the
 * Session: a persisted drain receipt matching the binding and no active
 * executions. Never call this on a mere transport failure.
 */
default CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
    return CompletableFuture.completedFuture(true);
}
```

`WorkspaceRuntimeTransport` overrides it and re-verifies the proof against the
durable rows it already injects (`bindings`, `sessions`):

```java
@Override
public CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
    if (!managed(session)) {
        return CompletableFuture.completedFuture(true);
    }
    Context context = context(lease, session, false);
    RuntimeBindingRecord binding = bindings.findById(context.binding().getBindingId());
    if (binding != null && binding.getState() == RuntimeBindingRecord.State.LOST) {
        // The LOST family owns this holder; its evidence gate is stricter.
        return CompletableFuture.completedFuture(true);
    }
    boolean proven = binding != null
            && binding.getGeneration() == context.binding().getGeneration()
            && binding.getState() == RuntimeBindingRecord.State.DRAINING
            && binding.getDrainReceipt() != null
            && binding.getDrainReceipt().matches(binding);
    if (!proven) {
        // Held without proof is a refusal; nothing held is already settled.
        return CompletableFuture.completedFuture(
                !ownership.isHeld(context.binding(), context.session()));
    }
    ownership.release(context.binding(), context.session());
    detachOwed.remove(detachKey(context));
    return CompletableFuture.completedFuture(true);
}
```

Return contract: `true` means the caller may proceed (cleared, never held, or
owned by the `LOST` evidence path); `false` means a holder exists but this path
has no proof, and the caller must fail the release rather than leave a silent
wedge.

The proof predicate is deliberately narrow:

- **P1** the binding at `(binding_id, generation)` is `DRAINING` — the drain
  claim is the fence that also refuses a new `claim`
  (`WorkspaceExecutionStore.claim` requires `!drain_requested`);
- **P2** `drain_receipt` is non-null and matches the binding — the worker was
  stopped, not merely unreachable;
- **P3** the caller has already verified no active executions for
  `(binding_id, generation)` — `releaseStoppedSession` does this before it
  retires the Session;
- **P4** `WorkspaceExecutionStore.release` clears only the exact
  `(holder_key, binding_id, runtime_generation, runtime_session_id)` tuple, so a
  newer holder can never be cleared by an older retirement.

`LOST` bindings are excluded on purpose: their stop evidence and holder clearing
belong to `releaseLost`.

### 5.3 Broker: drain-arm escalation

D1–D2 are not reachable in F1/F2 if the drain cascade waits for the worker
before it stops it. Today `drainClaimedBinding` releases every Session first and
only then calls `stopAcknowledgedRuntime`; a refusing worker fails the first
step, so the stop is never attempted.

Change `drainClaimedBinding` so that one worker refusal escalates once:

1. Run `drainSessions` as today.
2. If a session release fails with `managed_runtime_owner_hold_pending` or
   `managed_runtime_release_timeout`, call `provisioner.stopDrained(binding)`,
   persist the receipt with `renewal.persistDrainReceipt(...)`, and run
   `drainSessions` again.
3. On the second pass every active Session takes `releaseStoppedSession`
   (receipt present, no active executions), which calls
   `transport.releaseRetired(...)` before `finishSessionRelease`.
4. A second refusal, or a provisioner without `supportsDrainedStop`, fails the
   drain with the existing error. The holder then stays for operator recovery;
   the failure is explicit rather than silent.

This matches the documented drain semantics ("the drain arm stops what is live
first") and keeps routine release (`drain = false`) non-destructive: only the
close cascade may stop a worker.

### 5.4 Ordering and crash windows

`releaseStoppedSession` calls `releaseRetired` **before**
`finishSessionRelease`:

- compensation succeeds, then the durable `RELEASED` commit — the normal case;
- compensation fails — the release fails, the Session stays `RELEASING`, the
  drain claim stays retryable, and the holder is untouched;
- the Broker crashes between the two — the Session is still active with no
  holder. A retry takes the existing absent-holder shortcut
  (`WorkspaceRuntimeTransport.java:416-421`) and completes. No wedge, and no
  storage was handed to a second writer.

Compensating after `finishSessionRelease` would be strictly worse: a crash in
between leaves `RELEASED` plus a stranded holder, and a retry short-circuits on
the `RELEASED` row without ever reaching the compensation.

`releaseStoppedSession` is synchronous today (`:5838`). It becomes
`CompletionStage`-returning; the two callers (`releaseSavedSession` at `:747`
and `drainSessions`) are already asynchronous compositions.

### 5.5 Not changing

- `claim` conflict semantics and the `409 workspace_busy` contract.
- The acquire-side retention rule and `acquireUncertain`.
- `releaseUnusableSession` and `releaseLost`.
- The `ma_storage_owner` schema.
- `RuntimeBrokerService.mapFailure` (`:5538`), which already preserves a
  `RuntimeBrokerException` unchanged, so the new worker codes reach the drain
  escalation intact.

## 6. Decisions and rationale

**D-1: proof-gated compensation, not holder expiry or generation supersede.**
An expiry or generation counter can prove that a holder is _old_, never that the
worker _stopped_. Superseding on age would let a second Session claim storage a
live worker may still be writing, which is exactly the invariant §2.1 protects.
The issue lists expiry as an alternative; this design rejects it because the
proof it needs is the same drain receipt, and storing the proof durably adds a
column without adding a capability.

**D-2: compensation before the durable release, not after.** See §5.4. The
failure and crash windows both converge to a retryable state instead of a
`RELEASED` row with a stuck holder.

**D-3: escalate only in the drain arm.** A routine release is required to stop
nothing. The close cascade already owns stop semantics, so the escalation is a
repair of that arm's ordering, not a new policy.

**D-4: do not compensate in `releaseUnusableSession`.** A dead process is
stronger than a missing response, but it is not proof that orphaned children or
the storage mount stopped writing. `releaseLost` already encodes that stricter
evidence and remains the owner of the `LOST` path.

**D-5: bound the release where it is memoized.** The hang lives in the memoized
promise, not in `releasePrepared`'s individual awaits. Bounding at the provider
keeps core free of a timeout contract and lets the existing `.catch` reset the
memo.

**D-6: no schema change.** The drain receipt, binding state, and exact holder
columns already carry the proof. A new column would be a second source of truth.

## 7. Invariants

1. A holder is cleared only when the worker is proven stopped (drain receipt
   matching the binding, no active executions) or has acknowledged the release.
2. A transport failure alone never clears a holder.
3. Clearing is exact-match; it can never clear a newer holder.
4. An abandoned worker release attempt never mutates provider state for an
   identity it no longer owns.
5. A routine release never stops a worker.

## 8. Risks and mitigations

| Risk                                                    | Mitigation                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Compensation clears a holder a live worker still writes | P1–P3; `LOST` excluded; `releaseLost` keeps its own evidence gate                                                       |
| Stale worker attempt retires a re-acquired Session      | `releaseAttempt` token plus identity check after the await (§5.1)                                                       |
| Deadline fires while `releasePrepared` later succeeds   | the abandoned attempt only returns; the next attempt re-runs `releasePrepared`, which is idempotent for settled entries |
| Escalation stops a shared worker serving other Sessions | the close cascade is binding-wide by design; `drainSessions` releases every active Session on the binding               |
| Provisioner without `supportsDrainedStop`               | explicit failure, operator recovery remains; documented as a residual gap                                               |
| `releaseStoppedSession` signature change ripples        | only two callers, both already `CompletionStage` compositions                                                           |
| Abandoned promise rejection becomes unhandled           | attach a no-op rejection handler in `withDeadline`                                                                      |

## 9. Validation plan

**Java (H2, then `mysql-integration`)**

- `WorkspaceExecutionStoreTest`: `release` still refuses a `LOST`/`RELEASED`
  binding; exact-match clearing; no newer-holder clearing.
- `WorkspaceRuntimeTransportTest` (new cases):
  - a worker refusal leaves the holder intact (invariant);
  - `releaseRetired` without a matching receipt returns `false` and does not
    clear;
  - `releaseRetired` with a matching `DRAINING` binding and receipt clears it;
  - `releaseRetired` is idempotent when nothing is held.
- `RuntimeBrokerServiceTest`:
  - drain cascade: refusal → `stopDrained` → second pass clears the Session and
    the holder;
  - routine release: refusal does not stop the worker and does not clear;
  - second refusal fails the drain explicitly.
- MySQL profile required for the transaction/SQL behavior (per module AGENTS).

**TypeScript**

- `managed-runtime-provider-worker.test.ts`:
  - refusal maps to `managed_runtime_owner_hold_pending`;
  - timeout maps to `managed_runtime_release_timeout` and clears the memo;
  - the next attempt runs `releasePrepared` again;
  - an abandoned attempt that resolves later does not close a re-acquired
    Session (identity token).
- `managed-tool-runtime.test.ts` stays as-is; core behavior is unchanged.

**End-to-end**

- Managed Workspace with a worker forced to refuse `release`: close the
  Session; assert `ma_storage_owner.holder_key IS NULL`, the Session reaches
  `RELEASED`, and a later `acquire` on the same storage succeeds.
- Negative: a transport-level failure without a receipt leaves `holder_key`
  set, and the Session stays `RELEASING`.

**Reference checks**

- `npm run lint` and Prettier for the touched TS/Java-adjacent docs; `mvn verify`
  for the Java module (delete `target/` before root lint, per module AGENTS).

## 10. Acceptance criteria

1. With a worker that refuses release with `managed_runtime_owner_hold_pending`,
   the close cascade clears `ma_storage_owner.holder_key` for that Session, and
   a later acquire on the same storage succeeds.
2. With a worker whose `releasePrepared()` never settles, the release returns a
   retryable error within `RELEASE_DEADLINE_MS`; the next release is a fresh
   attempt; the Broker never waits past its own request timeout.
3. A plain transport failure (connection error, client timeout) with no drain
   receipt leaves the holder set and the Session `RELEASING`.
4. `releaseRetired` cannot clear a holder that does not match the exact
   `(holder_key, binding_id, runtime_generation, runtime_session_id)` tuple.
5. No schema migration and no OpenAPI change.
6. New tests in §9 pass, and the existing module suites stay green.

## 11. Open questions

1. **Deadline value.** 20 s is chosen below the 30 s HTTP timeout. Should it be
   configurable, or fixed to keep one behavior across deployments?
2. **Escalation trigger.** Should the drain escalate on the first refusal, or
   after a retry budget (for example, two consecutive refusals) to avoid
   stopping a worker that was about to settle?
3. **Control-plane retry budget.** Should the control plane auto-drain after N
   failed routine releases? This design deliberately leaves that policy alone.
4. **`releaseMount` symmetry.** `releaseMount` already clears the holder without
   a worker answer. It is safe today because the execution mount is separate
   from the installation, but the two proofs should be documented together in a
   follow-up.

## 12. Implementation order

1. Worker refusal code and bounded release (§5.1) — independently testable,
   already closes F2.
2. `RuntimeTransport.releaseRetired` plus the `WorkspaceRuntimeTransport`
   override (§5.2).
3. `releaseStoppedSession` compensation and its async signature (§5.4).
4. Drain-arm escalation (§5.3).
5. Tests from §9, then the MySQL profile.
