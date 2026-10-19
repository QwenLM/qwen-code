# Hosted automation fault gates FG11c, slice 2: Spring crashes and the scanner lease

[English](2026-10-19-automation-fault-gates-c2.md) | [简体中文](2026-10-19-automation-fault-gates-c2.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 for the automation domains `schedule` and
`automation_run`. Slice 1 (merged as #14601) gated Harness-process crashes:
the three SIGKILL points on a run's revisions, all on the packaged stack.
This slice covers the cells that live in Spring, where the scanner and its
lease run:

| Case                           | Injection                                                                                                                               | Expected                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spring-kill-before-answer`    | The occurrence row is `firing` and the fixture parks the scanner's `runAutomationOperation` call; SIGKILL the Spring child. Restart it. | The re-driven fire meets the same derived `arun_` id. One run chain, one accepted input, one model Turn. The occurrence is `fired` exactly once.                                 |
| `spring-kill-before-watermark` | The answer landed (revision 2 committed) and the fixture parks `advanceWatermark`; SIGKILL the Spring child, then restart.              | No second fire for the same slot. The watermark catches up and the ledger holds one run chain. The wake turn may be aborted by the kill, so its model Turn is not asserted here. |
| `two-scanner-race`             | Two Spring children on one MySQL and tenant, with a short lease and one due slot.                                                       | Exactly one child claims the slot. The loser writes no occurrence, no run and no watermark; the ledger holds one chain.                                                          |
| `parked-tool-harness-kill`     | The wake turn is parked on a Runtime tool call; SIGKILL the Harness child.                                                              | Deferred: see the note under Budget.                                                                                                                                             |

The live-run reconcile case ("a wake turn is live past its first transcript
write, drive `reconcile_run` through an overlap-`skip` slot, the run stays
`running`") is already pinned by #14480's route test and is not repeated.

## What the gate pins

At most one run and one model Turn per occurrence. A Spring process that
dies mid-fire must not produce a second run on restart, and a scanner that
lost its lease must move neither the watermark nor the ledger. A run whose
wake turn settled must settle from the journal's `turn.settled`, never as
`failed`/`outcome_unknown`, even when the settling process died before
writing revision 3.

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
  `BeanPostProcessor` and parks `runAutomationOperation` behind a latch
  the control plane arms. A test-side proxy cannot express this window:
  relaying the Spring-to-Harness connection breaks its streaming channel,
  so the warm turn never completes.
- **A watermark hold.** For `spring-kill-before-watermark` the fixture
  registers a primary `AutomationLedgerStore` whose `advanceWatermark`
  parks on a latch. A schedule-row lock cannot express this window: the
  settle's `HELD` proof reads the same row, so an outside lock blocks the
  occurrence write too and the crash point never arrives.
- **Two children.** `two-scanner-race` starts two fixture JVMs against the
  same MySQL and tenant, each with its own internal port and its own
  `ready.json`, and points both at the same Harness.

## Ledger

The facts come from the Session journal, the run records
(`ma_session_record.task_state`), `ma_schedule_occurrence` and
`ma_schedule` (watermark and lease), plus the model stub's prompts.

## Mutation witnesses

Each witness runs alone against its own case and is restored byte for byte.

| Witness | Mutation                                                                     | Expected red at                                                          |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| s1      | `automationRunId` gains a per-call nonce, so a re-drive derives a new run id | `spring-kill-before-answer`: a second run chain beside the re-driven one |
| s2      | The lease claim drops the owner and fence predicate                          | `two-scanner-race`: two run chains, or a second model Turn               |
| s3      | Removed with the deferred cell (settle order stays pinned by slice 1)        | -                                                                        |

## Budget

The class runs five tests — the fixture smoke, the fire path, and the three
windows — in one fork with one Harness and up to two Spring children. The
whole class measured 262.0 s locally on JDK 21 + MySQL 8.0.46, budgeted at
524 s (2x): `main`'s healthy sum 6835 s to 7359 s, the Hosted fork 7435 s to
7959 s with the method's 600 s ceiling, the Verify step 134 to 143 minutes,
and the job ceiling 227 to 236 minutes.

`parked-tool-harness-kill` is deferred: slice 1's `turn-crash` already pins
"the Harness dies mid-turn and the run settles exactly once as
`failed`/`outcome_unknown`", and the merged #14526 gates pin the parked
execution's cancellation and lease release. The remaining delta — a Runtime
tool call is not replayed — would need a tool-call model stub and broker
wiring whose cost outweighs the increment.

## Acceptance

- `mvn -Pmysql-integration -DskipTests test-compile checkstyle:check` clean,
  and `checkstyle:check@runtime-broker-checkstyle` clean on this tree.
- Each case green on JDK 21 with a real MySQL, selected by
  `-Dqwen.fg11c2.case=<case>`; the whole class green.
- Every witness red at the site the table names, restored byte for byte.
- `scripts/tests/hosted-process-ci.test.js` green with the composed budget.
- This design is delivered in both languages with matching structure.

## Open questions

- Whether a crashed scanner should reconcile on boot rather than on the next
  due slot is #14116's scope, not this slice.
- Whether the losing scanner should observe the winner's claim immediately
  or only on its next tick is left to today's behaviour; the gate pins that
  it moves nothing, not the timing of its observation.
