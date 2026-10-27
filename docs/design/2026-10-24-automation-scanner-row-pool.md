# Automation scanner row pool

[English](2026-10-24-automation-scanner-row-pool.md) | [简体中文](2026-10-24-automation-scanner-row-pool.zh-CN.md)

- Status: implemented (2026-10-24)
- Issue: [#15418](https://github.com/QwenLM/qwen-code/issues/15418)
- Supersedes the open question "Scanner capacity" in
  [§10 of the Managed automation gate design](2026-10-22-managed-automation-gate.md).

## Problem

The scanner holds its only thread for the whole duration of every blocking
Harness call. A gated `fire_run` waits for the probe (up to 20 s) inside the
relay's 30 s, and any fire can first wait for a Session load up to
`load-timeout` (120 s). One slow definition therefore delays every definition
on the node: once a slot's probes take the whole period, ticks overrun, fires
land minutes late, and due slots pass `late-tolerance` (5 min) and are recorded
`missed` for all definitions alike. The reporter measured 10–13 s gate runs,
which puts the ceiling at about four one-minute PR watches per node.

## Decision

Work the tick's rows on a bounded pool (the gate design's first route) and
defer the asynchronous fire answer (its second route). Guarding points:

1. Claim inside the task. `tick(now)` fans its candidate snapshot —
   `findArmed` plus `findFiringSchedules` rows, each appearing once — onto a
   bounded executor, and each task claims its own row. Rows are already leased
   individually under one atomic `claim()` guard (`lease_until IS NULL OR
lease_until < ?`) with fence-checked ledger writes, so working different
   rows concurrently is safe by construction; two tasks racing one row meet
   the same guard two nodes do. Submitting after an upfront claim loop would
   queue tasks that hold expiring leases while they wait, so no claim happens
   outside a task.
2. Lease from the claim time, not the tick's start. `claim()` is the only
   lease writer, there is no renewal path, and a task can start halfway
   through a lease's lifetime. A tick-start lease would be born part-expired
   and immediately stealable on a multi-node deployment.
3. The tick joins before returning. `scan()` keeps its `fixedDelay` semantics
   — ticks never overlap — and never returns with submitted work outstanding.
4. A separate executor bean (`automationScannerExecutor`), not a bigger
   `managedAutomationScheduler`. The tick holds the scheduler's thread while
   joining, so scanning on its own scheduler deadlocks at pool size 1 and
   parks one thread per pending join otherwise.
5. Finish in-flight work at shutdown; never interrupt it. The pool's
   `destroy()` returns immediately (`awaitTerminationSeconds(0)`), so the pool
   adds no shutdown wait of its own. A tick caught mid-join is still bounded by
   the scheduler that invokes it (`managedAutomationScheduler`, itself a
   `SmartLifecycle`): the lifecycle processor caps that bean's stop at
   `spring.lifecycle.timeout-per-shutdown-phase` (30 s here). That is an upper
   bound on the close rather than a fixed wait, and it predates this change.
   Claims are durable: an interrupted answer is re-driven by a later tick.

The asynchronous fire answer is rejected for this change: today's `firing`
means "answer pending inside this call", and persisting a pending state means
a wire change (no event envelope carries gate verdicts to the control plane),
new settle semantics, and a moved manual-run contract. It stays the right
follow-up if probe durations keep saturating
`2 × SCAN_LIMIT × scanner-threads`.

## Configuration

- `automation.scanner-threads` (default 4, positive, validated at startup).
  It is distinct from `automation.concurrency` (default 4): the latter caps a
  definition's non-terminal runs and one decision's reconcile fan-out, and is
  not a thread count.
- Deployment note, not a code requirement: one fire can run load-timeout +
  relay-timeout long, so on deployments where that routinely exceeds the row
  lease, operators may size `automation.lease` ≥ `load-timeout` +
  `request-timeout`.

## Residual ceilings (accepted, documented)

- The Harness runs each probe inside the automation funnel's serial queue per
  Session, so the pool parallelizes across Sessions, not within one.
- Admission decisions for definitions sharing one Session are made
  concurrently: with no public Turn open, both due definitions fire — across
  definitions the admission guards only on public Turns (`hasOpenTurn`, which
  automation fires never create: they leave no `ma_turn` row) and on
  per-definition active counts. Their runs still serialize in the Harness
  funnel, so a Session's executions stay one at a time. Accepted semantics,
  pinned by `twoDefinitionsSharingOneSessionBothFireWhenDueTogether`
  (#15442 verify lane, finding 1).
- One fire can still out-live the 60 s lease while a cold Session loads (up to
  120 s before the relay starts). The fence denies the stale holder's writes,
  the occurrence stays `firing`, and a later tick re-drives it idempotently on
  the derived run id. No renewal run is added in this change.
- In one row, slots, re-drives and reconcile calls stay serial; the pool
  parallelizes rows. `SCAN_LIMIT` (100) bounds each of the tick's two row
  queries, so one tick submits at most 2 × `SCAN_LIMIT` (200) tasks; a row
  both queries return is submitted once.
- At context close the pool also runs its **queued** rows, not only the
  in-flight one, on its non-daemon threads: `destroy()` still returns
  immediately, but process exit waits for queued work. Every queued row
  claims and fires under the same fence, and a lost answer is re-driven by
  a later tick (#15442 verify lane, finding 3).

## Validation

- Unit (H2, against the existing fake funnel):
  `firesDueTogetherSettleAcrossTheRowPool`,
  `theLeaseRunsFromTheClaimNotTheTick`,
  `aHolderThatLostItsLeaseMidFireCannotSettleAndTheNewOwnerRedrives`,
  `aBacklogDeeperThanThePoolStillCompletesWithinTheTick`,
  `aTickJoinsEveryRowBeforeItReportsOneFailure`,
  `theScannerWorksRowsOnItsOwnBoundedPool`,
  `theScannerRowPoolFinishesInFlightWorkInsteadOfInterruptingIt`,
  `theScannerRowPoolStillBootsWithAnUnvalidatedSizeWhileAutomationIsOff`,
  `twoDefinitionsSharingOneSessionBothFireWhenDueTogether`,
  `aRowBothQueriesReturnIsSubmittedOnce`,
  `anInterruptedJoinReportsTheInterruptAndLeavesTheRowItsClaim`,
  plus binding/startup validation of the new property. The pre-existing lease
  and fence suite runs unchanged through a direct executor, pinning the serial
  shape of the same fan-out and join. `aTickJoinsEveryRowBeforeItReportsOneFailure`
  runs on a real one-thread pool with the second row's claim in flight when
  the first one throws: a direct executor cannot pin the join, because its
  tasks finish during submission (#15442 verify lane, finding 2).
- MySQL (`AutomationScannerConcurrencyMySqlIT`, `mysql-integration` profile):
  racing claims reach exactly one fence winner under InnoDB row locks, a stale
  owner cannot move the ledger after a takeover, and two scanners settle one
  run per occurrence across the pool.
