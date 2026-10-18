# Hosted automation fault gates FG11a: lost replies

[English](2026-10-18-automation-fault-gates-a.md) | [简体中文](2026-10-18-automation-fault-gates-a.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 of #12380: fault gates for the
automation domains `schedule` and `automation_run`. The round has six
letters (FG11a–f). This slice implements **FG11a, lost replies**, and
nothing else. It also stands up the packaged automation stack that the
later letters build on.

The property under gate: when an automation operation committed and its
answer was lost, the re-drive meets the **same identity** and answers what
committed. It never commits a second time, never runs a second model Turn,
and never records an occurrence that is not true.

- A scheduled fire's re-drive meets the same derived `arun_` run.
- A manual run retried under its Idempotency-Key meets the same run.
- A retried definition mutation answers its own committed revision and
  never commits over a newer one.
- A lost reconcile answer leaves the slot skipped under its own refusal,
  never `unknown`.

Eight cases ship, all in one boot:

| Case                   | Injection                                                                                                 | Expect                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-reply`         | The Harness `202` of a create (`define_schedule`) is dropped after it committed                           | The public answer is `503 automation_operation_unknown`. The retry under the same key re-drives the same operation id and answers revision 1. One `defineSchedule` commit                                                 |
| `update-reply`         | An update's `202` is dropped; a newer update under another key then lands (revision 3)                    | The retry of the lost update answers its own revision 2. The definition stays at revision 3, with three `defineSchedule` commits in all                                                                                   |
| `noop-update-reply`    | The `202` of an update that changes nothing is dropped                                                    | The retry answers revision 1. Only the create and the no-op's replay marker are committed                                                                                                                                 |
| `retire-reply`         | A retire's `202` is dropped                                                                               | The retry answers the committed retire as its replay (`X-Qwen-Idempotent-Replay: true`) without asking the Harness again. One `retireSchedule` commit. The every-minute definition records no occurrence after the retire |
| `manual-run-reply`     | A manual run's `fire_run` `202` is dropped after both run revisions committed and the Turn woke           | `503 automation_operation_unknown`. The retry under the same key meets the same run. One run chain (`:1`, `:2`, `:3`), one accepted input, one `turn.settled`, one model Turn                                             |
| `public-reply`         | Spring settled a create's receipt; its own `202` is dropped on the way to the caller                      | The retry replays the receipt (`X-Qwen-Idempotent-Replay: true`). The Harness saw the operation once                                                                                                                      |
| `scheduled-fire-reply` | The scanner's fire of the next minute's slot commits, and its `202` is dropped                            | The scanner re-drives the occurrence once (`attempts` 1) and settles it `fired`. Every fire names the same occurrence. One run chain, one accepted input, one `turn.settled`, one model Turn                              |
| `reconcile-reply`      | A held manual run keeps the skip policy's count closed; the next slot's `reconcile_run` answer is dropped | The slot is `skipped` under `overlap` or `count_limit`, never `unknown`, and the held run stays `running`. Released, it completes                                                                                         |

Every case ends with the tenant holding no `unknown` occurrence.

Deferred to later slices of #14446: FG11b–f, the Harness-side lost
answers of the Session Store (FG11b), and every process kill (FG11c).

## Current state

- No packaged lane turned automation on before this slice.
  `qwen.managed-agent.automation.enabled` defaults to `false`. The only
  automation tests were on H2, against `AutomationHarnessFake`.
- The Harness route is `POST /session/{id}/automations/operations`
  (`hosted-harness-session.ts`). Spring reaches it through
  `QwenHostedHarnessConnector.runAutomationOperation`, whose client turns
  a lost answer into `MutationOutcomeUnknownException` with no retry of
  its own.
- The scanner (`AutomationScanner`) defers such an occurrence with backoff
  (2 s, 4 s, …) and re-drives it for up to 64 attempts. The public routes
  answer `503 automation_operation_unknown`, and a retry under the same
  key re-drives the claimed receipt.
- Definition operations carry an operation id derived from the tenant and
  the Idempotency-Key, so the Harness's `mutationReplay` answers a re-drive
  with the revision it committed. A run's id is derived from the schedule
  and the occurrence key, so a re-driven fire meets the committed run.

## Gate ledger

Ground truth comes from three sources:

- The relay's record of every automation operation Spring sent the
  Harness, with its kind, schedule, occurrence and whether its reply was
  dropped.
- The Session journal (`ma_session_journal_tx` commands, and event ids
  decoded from `record_bytes`).
- The Java mirror (`ma_schedule_occurrence`, `ma_session_record`).

The model stub records every prompt, so a second model Turn would show as
a second prompt naming the occurrence.

Each case first establishes its injection: the relay must show the dropped
operation (`dropped=true`), and every armed rule must have fired by the
end of the run.

## Fixture design

`HostedAutomationFaultGatesIT` follows `HostedPublicWorkspaceIT`'s boot:

- in-JVM Spring on real MySQL (absence fails rather than skips), with the
  Harness connector and the scanner on (`automation.enabled=true`,
  `scan-delay=1s`);
- one Workspace mount, registered on Linux;
- a real Harness, and a model stub that answers at once unless the prompt
  carries `FG11A_HOLD`.

Spring's `harness.base-url` points at a `HostedLifecycleRelay`. For a
matching automation operation, the relay lets the Harness answer and then
closes the connection without the reply, which is a connection-level loss
after commit. A second relay fronts Spring for `public-reply` and drops one
`202` by its Idempotency-Key.

Each case uses its own public Workspace Session. The Session runs one
Turn first (see Findings).

The three clock-bound cases (`scheduled-fire-reply`, `reconcile-reply`,
`retire-reply`) use an every-minute cron. They arm first and are settled
last, so they share one minute boundary while the other cases run.

- While they set up, `SchedulerHold` parks the only thread of
  `managedAutomationScheduler`. No slot can fire before its fault is
  armed or before the held manual run is live; manual runs fire on the
  request thread and are unaffected. A boundary that passes during the
  hold is still within the late tolerance when the scanner resumes.
- Their exactly-once checks are scoped to the occurrence under test:
  its fires, its run's commands, its input, its `turn.settled` and its
  model prompt. A later slot of the same every-minute definition, due
  while the other cases run on a slow runner, is a legitimate run of its
  own.

The class runs one case alone with `-Dqwen.fg11a.case=<case>`.

## Findings

- **An automation on a Session that never ran a Turn is refused.** The
  Turn and rename paths call `createOrLoad` with
  `loadExisting = session.harnessBootId() != null`. The automation verbs
  go through `attachment(…, true)`, which always loads. A Session created
  with no input has never been created on the Harness, so the load answers
  `404 managed_session_not_found` and creating an automation fails with
  that code. The fixture runs one Turn per Session first. Fixing the
  connector also means recording the Harness boot id the way the Turn path
  does, so it is left out of this test-only slice and reported separately.

## Mutation witnesses

Each witness was run red against the full class and restored byte for
byte.

| Witness | Mutation                                                                                        | First red                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| m1      | `ManagedAutomationService.operationIdFor` mints a random id instead of deriving it from the key | `create-reply`: the retry re-drove under a second operation id                                                                                         |
| m2      | `AutomationScanner.MAX_FIRE_ATTEMPTS` is 1, so a lost answer is given up at once                | `manual-run-reply` in the full class; `scheduled-fire-reply` alone (`-Dqwen.fg11a.case=scheduled-fire-reply`): the slot settled `unknown`, not `fired` |
| m3      | A reconcile that failed counts its occurrence as resolved                                       | `reconcile-reply`: the slot did not settle `skipped`                                                                                                   |
| m4      | `ManagedAutomationService.replay` re-drives a receipt that already holds its answer             | `public-reply`: the Harness saw a second `define_schedule`                                                                                             |
| m5      | A manual run's occurrence key gains a random suffix, so a retry no longer meets its occurrence  | `manual-run-reply`: the retry was refused `automation_run_skipped` (overlap) behind its own first run                                                  |

One narrower mutation is equivalent and is not a witness: rethrowing a
failed reconcile only postpones the decision. Run against
`reconcile-reply` alone it stayed green, because the next scan, a second
later, asks again and records the same `skipped`.

## Budget

The class measured 46.3 s, 85.0 s, 57.1 s and 67.0 s locally on JDK 21 +
MySQL 8.4.6. Most of the spread is the wait for the next minute boundary.
It is budgeted at about 170 s (2× the heaviest run). The shared fork's
healthy sum and its timeout move by that amount, composed onto `main`'s
values at push time. On top of `main` after #14533 the fork reaches
5218 s, so the Verify step moves from 95 to 100 minutes (fork + 600 s =
5818 s) and the job ceiling from 190 to 195.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- The class green locally on JDK 21 + MySQL 8.4.6, and every mutation
  witness red before merge.
- `scripts/tests/hosted-process-ci.test.js` green, with the class in the
  pinned list and the fork budget composed.
- The eight cases share one `@Test`, so a first red names one case and
  the cases after it never run. Read a red per case: re-run each with
  `-Dqwen.fg11a.case=<case>` rather than taking the others as passed.
- This design ships in both languages with matching structure.

## Open questions

- FG11c kills Spring, which owns the scanner and its lease, so it needs a
  child-JVM fixture like `HostedProcessCrashIT`'s rather than this class's
  in-JVM Spring.
- Whether FG11b's Harness-side store faults can reuse this relay unchanged
  or need the store-fronting proxy of the FG9/FG10 relay gates.
