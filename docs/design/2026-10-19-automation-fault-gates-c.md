# Hosted automation fault gates FG11c, slice 1: Harness process crashes

[English](2026-10-19-automation-fault-gates-c.md) | [简体中文](2026-10-19-automation-fault-gates-c.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 of #12380. FG11c gates process
crashes. This slice covers the **Harness half**: a SIGKILL at each of a
run's three revisions, on the packaged stack. The Spring half — kill
after the occurrence row is `firing` and before or after the answer, and
two scanners racing the lease — needs an out-of-process Spring fixture
and ships as slice 2. The live-run reconcile cell is already pinned on
the real stack by FG11a's `reconcile-reply` (#14534) and at the route
level by #14480; deleting `session.active === undefined &&` turns that
case red, so this slice does not duplicate it.

The property under gate: a Harness killed at any point in a run's three
revisions either completes on re-drive or settles honestly exactly once.
No second run, no second accepted input, no second model Turn. A crash
after `turn.settled` settles from the journal, not as
`failed`/`outcome_unknown`.

Three cases ship, all in one boot, in
`fg11cHarnessCrashesNeverRunTwiceOnMySql`:

| Case            | Injection                                                                                                            | Expect                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim-crash`   | SIGKILL between revision 1 (the claim) and revision 2 (the dispatch), which the Harness was holding before the store | The scanner re-drives the same claim; the replay completes revision 2 on the reloaded Session. One run chain (`:1`, `:2`, `:3`), one accepted input, one model Turn, occurrence `fired`           |
| `turn-crash`    | SIGKILL with the wake turn's model call in flight. A later slot of the same every-minute definition then comes due   | The later slot's reconcile loads the Session; the aftermath settles the run once as `failed`/`outcome_unknown`. One settle revision, one accepted input, one model Turn; the turn is never re-run |
| `settled-crash` | SIGKILL after `turn.settled`, before revision 3 reached the store                                                    | On reload the open path's `reconcileRuns` settles the run from the journal's `turn.settled` as `completed`, exactly once. One settle revision, one accepted input, one model Turn                 |

Every case ends with the tenant holding no `unknown` occurrence.

## Current state

- **Revisions.** `fire` commits the claim (revision 1) and, in one
  transaction with the run's input and wake, the dispatch (revision 2)
  (`hosted-automation-session.ts`). `settleRun` commits revision 3.
- **The replay.** A re-driven fire whose run is `intent` completes the
  dispatch; one whose run is `dispatch_started` answers the committed run
  (`fire`, the `existing !== undefined` branch).
- **The settle.** `settleRunUnserialized` reads the journal's own
  `turn.settled` first and the projected turn result second, then commits
  revision 3 under `settleRun`. `reconcileRuns` sweeps every dispatched
  run whose turn settled when the Session opens.
- **The crash aftermath.** A wake turn that died before its settle leaves
  a prior attempt in the transcript. The pump classifies it `recovery`,
  and `wakeAftermath` settles it with `settleRunFailedUnknown` — `failed`
  with `outcome_unknown` — once, cancelling parked executions and
  consuming the input.
- **The writer lease.** The restarted Harness cannot take the Session
  over until the dead writer's lease lapses. This method sets it to 15 s.

## Gate ledger

Ground truth is the Session journal (`ma_session_journal_tx` commands and
event ids), the run record (`ma_session_record.task_state`), the
`ma_schedule_occurrence` row and the model stub's prompts. The store
relay records every commit it saw; a crash case checks that the armed
commit was held and never committed.

## Fixture design

- **Store relay.** This method places a `HostedLifecycleRelay` between the
  Harness and the Session Store. Its `before` hook parks the one armed
  commit and, after the Harness is killed, drops it: the revision never
  reached the store.
- **Cold restart.** The Harness is SIGKILLed and started on the same port
  with a fresh HOME. The dead writer's 15 s lease is waited out by the
  case's later slot, as in FG11b slice 2.
- **The later slot.** `turn-crash` and `settled-crash` use an every-minute
  definition: a later slot's count-based refusal makes the scanner ask
  `reconcile_run`, which loads the Session and runs the settle paths. The
  definition is retired after the target run settles.
- **The model hold.** The stub holds only the manual occurrence's wake
  turn (`Occurrence: manual:`), so the later scheduled slot still runs
  while the crashed one is reconciled.

## Findings

- **Re-drive counts are not stable.** `claim-crash` can meet transient
  409s before the re-drive is accepted: the reloaded Harness's first
  loads answer `managed_session_writer_conflict` until the dead lease
  lapses, and the connector can answer `Hosted Harness generation
changed`. The case therefore asserts that the occurrence was fired at
  least once, never an exact re-drive count; the journal's one run chain
  is the invariant.
- **The reconcile may fail once and be retried by the next slot.**
  `turn-crash` and `settled-crash` record one `automation reconcile
failed ... Hosted Harness generation changed` WARN in the measured
  runs; the next due slot re-drives the repair and the run settles. That
  is the #14116 shape the issue names, not a lost slot.
- **`settled-crash` needs no repair from the reconcile route, but the
  route still reconciles runs.** Its input was consumed before revision 3,
  so `firstPendingWakeInput` is undefined and the route answers
  `repaired: false`; the same load still calls `reconcileRuns()`, so
  either the route or the open path commits revision 3.

## Mutation witnesses

Each witness has been run against its own case alone and restored byte
for byte; the table records the expected red.

| Witness | Mutation                                                                  | Expected red at                                                                                                            |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| c1      | A replay of an `intent` run answers the committed run without dispatching | `claim-crash`: revisions stay `:1`; the run never completes                                                                |
| c2      | `wakeHasPriorAttempt` always answers false                                | `turn-crash`: the pump re-runs the turn instead of settling it, so the run is not `failed` and a second model Turn appears |
| c3      | `HostedAutomationSession.reconcileRuns()` returns early                   | `settled-crash`: revision 3 never commits and the run stays `running`                                                      |

**c3 must target the method, not one call site.** The mutation skipped only
the lifecycle handler's call (`POST /session/:id/lifecycle`,
`hosted-harness-session.ts:6206`) and `settled-crash` stayed green (39.6 s).
The surviving path is the session-open call at
`hosted-harness-session.ts:5946`, which runs right after the Session is
registered and which `POST /session/:id/load` reaches through the `open`
helper: the crashed Harness is re-driven by the next slot's `reconcile_run`,
that route loads the Session, and the load reconciles the runs there. The
`reconcile_run` route has no independent `reconcileRuns()` call of its own —
it runs the wake aftermath when needed and reads the run. Short-circuiting
`HostedAutomationSession.reconcileRuns()` turns `settled-crash` red with
`ConditionTimeoutException: expected "completed"` at the case's terminal
state assertion, after 216.5 s. The case gates whether a crashed run gets
reconciled at all, not one particular call site.

## Budget

The three cases measured 48 s, 124 s and 110 s locally on JDK 21 +
MySQL 8.0.46 when selected individually; the whole method measured
144.8 s in its acceptance run. The method is budgeted at 550 s (2×),
composed onto
`main`'s healthy sum: 6285 s → 6835 s, and the Hosted fork from 6885 s to
7435 s with the method's 600 s ceiling. The Verify step moves from 125 to
134 minutes, and the job ceiling from 218 to 227 minutes.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean. That goal runs only
  the default execution; CI also runs
  `checkstyle:check@runtime-broker-checkstyle`, which reports 12 indentation
  violations in `RuntimeBrokerService.java:602-614` that belong to `main`
  (the file is byte-identical here, and `main`'s run 39154767029 fails the
  same execution at the same lines). The upstream re-indent PR owns it; it
  is outside this slice.

- All three cases green locally on JDK 21 + MySQL 8.0.46, each selected
  with `-Dqwen.fg11c.case=<case>`, and every witness red before merge.
- `scripts/tests/hosted-process-ci.test.js` green with the fork budget
  composed.
- The three cases share one `@Test`, so a first red names one case and the
  cases after it never run. Re-run each with `-Dqwen.fg11c.case=<case>`.
- This design ships in both languages with matching structure.

## Open questions

- Whether a crashed run should be reconciled at boot rather than on a
  later slot is #14116, out of scope.
- The Spring SIGKILL cells and the two-scanner lease race remain for
  slice 2; they need an out-of-process Spring fixture.
