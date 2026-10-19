# Hosted automation fault gates FG11c, slice 2: Spring crashes and the scanner lease

[English](2026-10-19-automation-fault-gates-c2.md) | [简体中文](2026-10-19-automation-fault-gates-c2.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 for the automation domains `schedule` and
`automation_run`. Slice 1 (merged as #14601) gated Harness-process crashes:
the three SIGKILL points on a run's revisions, all on the packaged stack.
This slice covers the cells that live in Spring, where the scanner and its
lease run:

| Case                           | Injection                                                                                                                                                       | Expected                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spring-kill-before-answer`    | The occurrence is `firing`, the Harness has committed the run, and the fixture holds the answer before Spring settles it; SIGKILL the Spring child. Restart it. | The re-driven fire reuses the committed `arun_` identity: one committed `automation_run` and one accepted input, with the occurrence `fired` exactly once. The kill drops the Harness Session, so the wake turn may be aborted and its Turn count is not asserted. |
| `spring-kill-before-watermark` | The answer landed (revision 2 committed) and the fixture parks `advanceWatermark`; SIGKILL the Spring child, then restart.                                      | No second fire for the same slot. The watermark catches up and the ledger holds one run chain. The wake turn may be aborted by the kill, so its model Turn is not asserted here.                                                                                   |
| `two-scanner-race`             | Two Spring children on one MySQL and tenant, with one due slot, both ticked.                                                                                    | The ledger deduplicates: one occurrence, one committed `automation_run`, one model Turn. This case does not stage a lease takeover; fencing is enforced by the store's `lease_owner`/`fence` predicates on `claim`, `settleOccurrence` and `advanceWatermark`.     |
| `parked-tool-harness-kill`     | The wake turn is parked on a Runtime tool call; SIGKILL the Harness child.                                                                                      | Deferred: see the note under Budget.                                                                                                                                                                                                                               |

The live-run reconcile case ("a wake turn is live past its first transcript
write, drive `reconcile_run` through an overlap-`skip` slot, the run stays
`running`") is already pinned by #14480's route test and is not repeated.

## What the gate pins

At most one run and one committed input per occurrence, and one model
Turn wherever the wake turn completes, plus one committed
`automation_run` for the slot. A Spring process
that dies mid-fire must not produce a second run on restart. A run whose
wake turn settled must settle from the journal's `turn.settled`, never as
`failed`/`outcome_unknown`, even when the settling process died before
writing revision 3.

These cases gate deduplication, not lease takeover: fencing is the store's
own `lease_owner`/`fence` predicates on `claim`, `settleOccurrence` and
`advanceWatermark`, and a stale-writer takeover is not staged here.

## Fixture

FG7c already provides the out-of-process Spring fixture this slice needs:
`HostedChannelCrashFixtureMain` boots the application in a child JVM,
publishes `ready.json` with its internal and control URLs, and
`HostedChannelProcessCrashIT` kills it with `destroyForcibly()` and starts a
fresh generation on the same ports.

This slice reuses that shape with an automation fixture main, and adds:

- **Automation enabled.** `--qwen.managed-agent.automation.enabled=true`
  with a test-scaled `scan-delay`, `lease` and `late-tolerance`; the
  scanner is `AutomationScanner`, scheduled on `managedAutomationScheduler`.
- **A fire hold.** The fixture wraps `HarnessConnector` in a
  `BeanPostProcessor` and parks `runAutomationOperation` after the Harness
  commits, so the answer is lost while the run is durable. A test-side proxy cannot express this window:
  relaying the Spring-to-Harness connection breaks its streaming channel,
  so the warm turn never completes.
- **A watermark hold.** For `spring-kill-before-watermark` the fixture
  registers a primary `AutomationLedgerStore` whose `advanceWatermark`
  parks on a latch. A schedule-row lock cannot express this window: the
  settle's `HELD` proof reads the same row, so an outside lock blocks the
  occurrence write too and the crash point never arrives.
- **Two children.** `two-scanner-race` starts two fixture JVMs against the
  same MySQL and tenant, both pointed at the same Harness. Only the first
  binds an internal listener; the second runs with that listener off and
  advertises the first child's session-store URL, which is the store the
  session was created against.

## Ledger

The facts come from the Session journal, the run records
(`ma_session_record.task_state`), `ma_schedule_occurrence` and
`ma_schedule` (watermark and lease), plus the model stub's prompts.

## Mutation witnesses

Each witness runs alone against its own case and is restored byte for byte.

| Witness | Mutation                                                                                     | Expected red at                                                          |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| s1      | `automationRunId` gains a per-call nonce, so a re-drive derives a new run id                 | `spring-kill-before-answer`: a second run chain beside the re-driven one |
| s2      | `CronSlots.occurrenceKey` gains a per-call nonce, so the two scanners derive different slots | `two-scanner-race`: two occurrence rows and two run chains               |
| s3      | Removed with the deferred cell (settle order stays pinned by slice 1)                        | -                                                                        |

Both witnesses were run against the case alone and went red at the sites
above. The first s2 candidate — forcing the lease claim's free-lease
predicate true — stayed green: both scanners then claim, but the run id
derives from the same occurrence key, so the ledger still holds one chain.
The witness therefore targets the occurrence key, which is what makes the
loser's write a second row.

## Budget

The class runs five tests — the fixture smoke, the fire path, and the three
windows — in one fork with one Harness and up to two Spring children. The
whole class measured 262.0 s locally on JDK 21 + MySQL 8.0.46, budgeted at
524 s (2x): `main`'s healthy sum 6985 s to 7509 s, the Hosted fork 7585 s to
8109 s with the method's 600 s ceiling, the Verify step 137 to 146 minutes,
and the job ceiling 230 to 239 minutes.

`parked-tool-harness-kill` is deferred: slice 1's `turn-crash` already pins
"the Harness dies mid-turn and the run settles exactly once as
`failed`/`outcome_unknown`", and the merged #14526 gates pin the per-run
cancel path (a cancelled occurrence makes no model call, no duplicate
execution). The remaining delta — a Runtime tool call is not replayed —
would need a tool-call model stub and broker wiring whose cost outweighs
the increment.

## Acceptance

- `mvn -Pmysql-integration -DskipTests test-compile checkstyle:check` clean,
  and `checkstyle:check@runtime-broker-checkstyle` clean on this tree.
- Each implemented case green on JDK 21 with a real MySQL, selected with
  `mvn -Phosted-automation-gates -Dit.test=HostedAutomationSpringCrashIT#<method>`
  `failsafe:integration-test`; the whole class green.
- Every witness red at the site the table names, restored byte for byte.
- `scripts/tests/hosted-process-ci.test.js` green with the composed budget.
- This design is delivered in both languages with matching structure.

## Open questions

- Whether a crashed scanner should reconcile on boot rather than on the next
  due slot is #14116's scope, not this slice.
- A controlled lease takeover — one scanner losing the lease and then
  attempting a stale write — is not staged by these cases; it would need a
  pause point inside the scanner's claim, which the product does not expose.
  Fencing itself is the store's `lease_owner`/`fence` predicates.
