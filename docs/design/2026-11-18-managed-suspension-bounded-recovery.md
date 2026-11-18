# Managed Suspension Bounded Recovery (Open Question 8)

[English](2026-11-18-managed-suspension-bounded-recovery.md) | [简体中文](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)

Status: resolves open question 8 of the [stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md). Date: 2026-11-18. Implemented in the phase-1 PR (#17690). No schema or Store protocol change.

## 1. Question

When a suspension teardown fails or returns an uncertain result at the retry cap, must an operator recover the Session, or can the existing Store protocol guarantee bounded automatic recovery? The design noted the obstacle: a new client with the same Harness boot id cannot serve as a successor-fencing proof, because while the writer lease is live a same-writer acquire extends the same generation.

## 2. Proof

`JournalWriterLifecycle.acquireWriter` extends the same generation only when the head is ACTIVE **and the writer lease is unexpired** (`writerLeaseUntil.after(now)`) and the writer id and token match. Once the lease expires, every acquire — including one with the same boot id and token — falls through to the generation-increment branch. `sealWriter` fences on generation, so a seal carrying the old generation is rejected once any successor acquires.

At the retry cap the suspension driver makes no further seal attempt, and the blocked branch stops renewal. **Two renewals exist and both must end.** The activation renewal lives in the Session assembly; the writer lease's own `/writers:renew` timer lives in the Store client, and only `sealGrant()` or `stopLocal()` used to stop it. A teardown that fails before its writer step reaches neither, so the removed resident would keep extending the lease forever and the bound below would prove nothing. The teardown therefore calls the Store client's `stopWriterRenewal()` at the start of its writer step, and the blocked branch calls it again for every earlier failure. That call ends the timer without fencing the client — `stopLocal()` would also refuse the seal reconciliation the same client still owes — and an on-demand renewal for a commit still runs, so retries keep working.

The gate refuses this Harness's own loads, so no same-process client can acquire while the lease is live. After a bounded wait exceeding the writer lease plus the Store request timeout:

1. the writer lease has expired (both renewals stopped; a renewal already in flight when the cap was reached can extend the lease by one full lease from its own completion, which the timeout term covers), and
2. the capped attempt's in-flight seal request has timed out, so no old seal remains in flight.

From then on, any acquire bumps the generation and fences the old seal. The head is then in one of three states, all safe:

- **SEALED at the old generation** — the teardown's own seal committed; complete.
- **Generation advanced** — a successor already fenced the old seal.
- **ACTIVE at the old generation, lease expired** — the next acquire (including this Harness's cold open) bumps the generation and fences the old seal.

The gate can therefore clear automatically after the bound; the next load cold-opens safely. Resource obligations (runtime lease, cleanup debt, owners) are reconciled by the load's existing takeover/cleanup paths — the same shape as the design's "Harness crashes mid-suspension" fault mode. An operator is needed only if the Store stays unreachable, which surfaces as the load's own transient Store failure, not a suspension-gate refusal.

The design's obstacle applies only while the lease is live; the bounded wait expires it first, so the obstacle does not block the proof.

## 3. Behavior

- On a capped uncertain teardown the Harness stops streams, the activation renewal and the writer lease renewal, keeps the gate **blocked** (refusing loads with `hosted_session_teardown_blocked`), and schedules a gate clear after `suspensionReconcileMs(leaseDurationMs)` — the Session's own writer lease plus the 30s Store request timeout plus a 10s margin. It is derived, not fixed: the lease is client-supplied up to `MAX_LEASE_MILLIS` (300s), so a constant tuned for the 60s default would clear the gate while a configured lease is still live. `HOSTED_SUSPEND_RECONCILE_MS` is that function at the 60s default (100s), a candidate validated against the real Store timeout before enablement.
- After the bound the gate entry is removed (if still blocked and not reused); the next load cold-opens. A `reconciledGates` counter records the automatic recovery.
- The control-plane classification of `hosted_session_teardown_blocked` is unchanged (a refusal, not a budget-exempt wait): the Turn whose teardown wedged fails under that code; the Session itself recovers for subsequent requests. Session-level recovery is automatic; the in-flight Turn is the cost of the wedged teardown.
- If the Store is still unreachable when the gate clears, the cold open fails with a transient Store error and retries until the Store returns; no operator is required for the gate itself.

## 4. Tests

- During the reconciliation wait, loads and reads meet `hosted_session_teardown_blocked`; the gate is not silently removed.
- After the bound the gate auto-clears (`reconciledGates` increments) and a subsequent load is no longer gate-refused.
- A persistent Store outage still surfaces as a load failure (not the gate refusal) after the gate clears.
- A capped teardown ends the writer lease renewal, so the removed resident cannot keep the lease alive past the bound.
- The clean suspend→cold-open path is unchanged.

## 5. Boundaries

- The reconcile wait is a candidate constant; like the idle period and cold-open cap it is validated by measurement before enablement. It must exceed the writer lease plus the Store request timeout, because both an in-flight renewal and the capped attempt's in-flight seal are bounded by that timeout.
- The bound is measured from the moment the renewals stop. A deployment whose writer lease or Store request timeout differs from the 60s/30s defaults must re-derive the constant; it is not a universal safe value.
- This resolves the Session-level recovery question; it does not change the control-plane Turn classification or add a receipt.
