# Hosted automation fault gates FG11c, slice 2: Spring crashes and the scanner lease

[English](2026-10-19-automation-fault-gates-c2.md) | [简体中文](2026-10-19-automation-fault-gates-c2.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 for the automation domains `schedule` and
`automation_run`. Slice 1 (merged as #14601) gated Harness-process crashes:
the three SIGKILL points on a run's revisions, all on the packaged stack.
This slice covers the cells that live in Spring, where the scanner and its
lease run:

| Case                           | Injection                                                                                                                                                      | Expected                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spring-kill-before-answer`    | The occurrence row is `firing`; the Harness's fire answer is held by a test proxy; SIGKILL the Spring child. Restart it.                                       | The re-driven fire meets the same derived `arun_` id. One run chain, one accepted input, one model Turn. The occurrence is `fired` exactly once.                           |
| `spring-kill-before-watermark` | The answer landed (revision 2 committed) and the schedule row is locked so the watermark write blocks; SIGKILL the Spring child. Release the lock and restart. | No second fire for the same slot. The watermark catches up, one run chain, one model Turn.                                                                                 |
| `two-scanner-race`             | Two Spring children on one MySQL and tenant, with a short lease and one due slot.                                                                              | Exactly one child claims the slot. The loser writes no occurrence, no run and no watermark; the ledger holds one chain.                                                    |
| `parked-tool-harness-kill`     | The wake turn is parked on a Runtime tool call; SIGKILL the Harness child.                                                                                     | The run settles once as `failed`/`outcome_unknown`, its parked executions are cancelled, its Workspace lease is released and its input is consumed. No replay of the tool. |

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
- **A Harness proxy.** The fixture's `FG7C_HARNESS_URL` points at a
  test-owned HTTP proxy in front of the real packaged Harness. The proxy
  forwards every request and holds only `POST
/session/:id/automations/operations` for the armed run until the test
  releases it. This is what opens the `firing`-before-answer window
  deterministically instead of polling.
- **A watermark lock.** For `spring-kill-before-watermark` the test holds
  the schedule row with `SELECT ... FOR UPDATE` on its own connection, so
  the scanner's watermark write blocks after the answer has committed; the
  kill happens in that window, and the lock is released afterwards.
- **Two children.** `two-scanner-race` starts two fixture JVMs against the
  same MySQL and tenant, each with its own internal port and its own
  `ready.json`, and points both at the same Harness.

## Ledger

The facts come from the Session journal, the run records
(`ma_session_record.task_state`), `ma_schedule_occurrence` and
`ma_schedule` (watermark and lease), plus the model stub's prompts and the
proxy's request log. The proxy records every fire it saw, so a second fire
is visible even when both were answered.

## Mutation witnesses

Each witness runs alone against its own case and is restored byte for byte.

| Witness | Mutation                                                                       | Expected red at                                                                |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| s1      | The scanner re-fires without claiming the occurrence first                     | `spring-kill-before-answer`: a second run chain beside the re-driven one       |
| s2      | The watermark update drops the lease-fence predicate                           | `two-scanner-race`: the losing child advances the watermark                    |
| s3      | The settle reads the projected turn result before the journal's `turn.settled` | `parked-tool-harness-kill`: the run settles `failed` although the turn settled |

## Budget

The four cases run in one class with one Harness that the parked-tool
case kills and restarts, and up to two Spring children. The measured runtime is recorded here before merge and
composed into `hostedForkHealthySeconds` and the packaged lane's Verify and
job ceilings by the same meta-test as slice 1. No budget number is asserted
until the case has been measured on the acceptance host.

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
