# Managed Lost-Runtime Turn Settlement

[English](2026-11-20-managed-lost-runtime-turn-settlement.md) | [简体中文](2026-11-20-managed-lost-runtime-turn-settlement.zh-CN.md)

Status: implements the #17542 follow-up deferred by [recovery from durable native terminals](2026-11-19-managed-recovery-native-terminal.md) §5. Date: 2026-11-20. No schema change, no new Harness verb, no Broker change; the fix is one passive-load arm in the Hosted Harness recovery.

## 1. Problem

When a Runtime is terminated out-of-band (idle reclaim, platform eviction, a kill that is not a host reboot) while a Turn is in flight, the Turn never settles. The control plane parks it on `managed_runtime_recovery_blocked` and re-drives the cancellation on the RECHECK cadence forever; the recovery view keeps answering `awaiting_evidence` / `operator_required` with `nextTurnAllowed=false`.

§5 of the native-terminal design located the blocker at cancellation readiness: `HarnessRuntimeRecovery.isCancellationReady` refuses a park whose Runtime execution outcome is `unknown`, and that outcome can only become known if the Broker treats the terminated generation as authoritative evidence that its executions stopped. Reading the current code shows the chain is closer to complete than §5 assumed, and identifies the one remaining link:

1. A dead lease invalidates the binding to `LOST` (`RuntimeBindingRegistry.invalidateBinding`). The local provisioner's observation of a provably absent worker returns `notFound` with `JOURNAL_LOST` evidence but **no** `WRITERS_STOPPED` evidence (`LocalProcessRuntimeProvisioner.observeDurable`).
2. The loss reclaim abandons the generation's tool executions (`JdbcToolExecutionRepository.abandonByBinding` → `ABANDONED`, terminally fenced) but **cannot release** the binding or its Runtime Sessions: release requires `hasStoppedWriters()` (loss **and** stop evidence). Stop evidence is produced only by a trusted host reboot, an operator attestation, or a clean drain — never by a same-boot out-of-band kill. This is intentional fail-closed behavior: a SIGKILL'd worker may leave orphaned tool process groups still writing the workspace, so worker-PID absence alone is not writer-stop proof (see the [shell/monitor runtime design](2026-10-03-managed-shell-monitor-runtime.md) and the [operator recovery design](2026-09-29-hosted-operator-recovery.md)).
3. Every Harness recovery load first adopts the Runtime Session (`recoverHostedRuntimeTurn` → `broker.acquire()` → `ensureBinding`). A `LOST` binding with no stop evidence reclaims to `runtime_broker_runtime_lost` and provisions no replacement, so the adopt fails and the load throws before it ever reads the executions. The control plane catches the throw and re-parks. Loop.

The escape hatch already exists but is unreachable: the Broker's status route answers a terminally `ABANDONED` record from the durable ledger **without an adopted Session** (`RuntimeBrokerService.getExecution` → `requireOwnedExecution`'s terminal arm only requires the saved binding/session rows at the same generation, which persist while the binding is `LOST`-stuck), and the cancellation machinery already accepts abandoned executions as "stopped but unobserved" and journals honest unobservable outcomes (`stopParkedRuntimeExecutions`, `settleParkedTurnCancelled`). Only the passive load's acquire-before-read ordering blocks it.

## 2. Decision

Let the passive takeover settle a park whose every pending Runtime execution is terminally abandoned, even when the adopt is refused as lost. In `recoverHostedRuntimeTurn`:

- Wrap `broker.acquire()`; on `runtime_broker_runtime_lost` (503) record the refusal and skip adoption instead of throwing. Any other acquire failure propagates unchanged.
- In the passive per-execution read, when the adopt was refused as lost, read each pending execution's durable status **without** reconciling against the dead Runtime. Only `state === 'abandoned'` is accepted; any other state, or a read that cannot answer, rethrows the captured lost refusal so the load parks exactly as before.
- The tolerance requires at least one pending execution: with none (an all-settled `results_ready` park) there is no abandoned fence to prove, so the captured refusal is rethrown and the load parks as before. The settled scope is therefore precisely "one or more pending executions, every one terminally abandoned".
- An all-abandoned park reports every execution `known` / `abandoned`, so `isCancellationReady` holds and the coordinator drives the existing cancellation, which journals the settlement. The report is never continuation-ready: `isContinuationReady` additionally requires every execution `settled`, which an abandoned fence is not.

No Broker, control-plane, schema, or protocol change: the durable facts the fix reads already exist, and the settlement it triggers is the existing CANCELLING-lane machinery.

## 3. Invariants preserved

- **No settlement over a live writer.** The load proceeds only when every pending execution is terminally abandoned — a fence the Broker writes solely on loss evidence. A still-`UNKNOWN` execution (writers unproven) keeps the lost refusal and the park. The duplicate-execution guard (#14387 / D7-2) is intact: nothing is re-dispatched against the lost generation, and continuation stays blocked by the settled-state requirement.
- **Writer-stop still gates re-provisioning.** The binding stays `LOST`; the fix reads durable records, it does not release the binding or mint stop evidence. A replacement Runtime is still provisioned only on loss **and** stop evidence (reboot / operator / clean drain). The fix closes the infinite-settlement gap, not the writer-stop proof gap.
- **Honest outcomes.** Abandoned executions settle as the unobservable outcome the parked-Runtime settle already journals, never a witnessed cancellation.
- **Adoption discipline.** A skipped adopt acquires nothing, so no lease is owed and no compensation release runs; the non-lost acquire-failure path keeps its existing propagation and owed-adoption behavior.

## 4. Residuals

- The settled Turn's Session reads `ready` (durable native terminal, no unsettled work), but a subsequent Turn that needs the Runtime still meets `runtime_broker_runtime_lost` at admission and fails on the ordinary bounded retry budget instead of hanging. Restoring tool execution requires writer-stop evidence (operator recovery or a trusted reboot) — the documented safety posture, unchanged by this fix. Making a platform destruction attestation produce stop evidence automatically is a provisioner-specific follow-up.
- The wake-turn crash aftermath (`settleCrashedWakeTurnAftermath`) tolerates released/releasing adopt refusals on its own path; this fix changes only the passive takeover the parked-Turn recheck drives. Extending the same lost-tolerance to the wake path is a separate, symmetric follow-up if that lane is shown to wedge.
- H3 background executions are not abandoned on same-boot loss by design; this fix does not touch that rule.
- A park with any non-abandoned pending execution — including one whose ledger record is already `settled` (the kill landed in the broker-settle → harness-fold window) — and an all-settled park with no pending execution, both keep the lost refusal and park exactly as before this fix; the lost branch accepts only an all-abandoned pending park. Neither is a regression (the pre-fix load failed at acquire before reading anything). A settled result is a witnessed outcome that a follow-up could safely accept alongside `abandoned`; this PR keeps the narrower all-abandoned scope.

## 5. Validation

- `hosted-runtime-recovery.test.ts`: a passive load whose adopt is refused `runtime_broker_runtime_lost` reports an all-abandoned park `known`/`abandoned` and drivable (the coordinator cancels over it), with no owed lease and no compensation release; a non-abandoned execution, a mixed abandoned/unknown park, a faulting durable read, and an all-settled park with no pending execution each keep the specific lost refusal (retriably). The full 100-case file passes, including the existing abandoned-distinction, acquire-failure-propagation, and owed-adoption cases.
- `DurableRuntimeRecoveryTest.aLostGenerationsAbandonedExecutionStaysReadableWithoutAdoption` (H2): a loss-only reclaim leaves the execution `ABANDONED` and the binding `LOST`; a replacement Broker process with no in-memory Session reads the abandoned record via `getExecution`, while its acquire still fails `runtime_broker_runtime_lost` and the binding stays `LOST`. The full 39-case class passes.
- Still owed to CI: the Linux real-process Hosted/fault recovery profiles and the MySQL profile (this change is recovery-adjacent); the complete vitest suite, Checkstyle and SpotBugs. Local evidence is the focused TS file and the focused H2 class above.
