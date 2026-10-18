# Hosted automation fault gates FG11b, slice 2: Harness-side store faults

[English](2026-10-18-automation-fault-gates-b2.md) | [简体中文](2026-10-18-automation-fault-gates-b2.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 of #12380. FG11b gates store failures.
Slice 1 (#14551, [design](2026-10-18-automation-fault-gates-b.md)) gated
the Spring-side ledger writes. This slice gates the **Harness-side half**:
the journal commits the Harness sends the Session Store for an automation
operation.

The property under gate: when a journal commit of an automation operation
fails or its answer is lost, the Harness never writes that Session again
until it is reloaded. The caller gets a retryable answer, never a refusal.
On the reloaded Session, the same operation completes once: one run chain
and one model Turn for a fire, and one revision for a definition change.

Four cases ship, all in one boot, in a third method of
`HostedAutomationFaultGatesIT`, `fg11bHarnessStoreFaultsNeverRunTwiceOnMySql`:

| Case              | Injection                                                                                                | Expect                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store-transport` | The store commits a manual run's first revision, and its answer to the Harness is lost on the connection | The store client's bounded retry sends the same command again. The store answers it as the commit it holds, and the fire goes on: the manual run answers `202` at once, the commit is seen twice and committed once, with one run chain and one model Turn, and no restart |
| `revision-1`      | MySQL refuses the journal commit of a manual run's revision 1 (the claim)                                | `503 automation_operation_unknown` after the store client's three attempts. Nothing is committed. Once the refusal drops, the same key still answers `503`: the Session writes nothing more. After a cold restart, the retry fires the same run once                       |
| `revision-2`      | MySQL refuses revision 2 (the dispatch, with the input and the wake)                                     | The same, with the claim committed and left at `intent`. After the restart, the replay completes revision 2: `:1` and `:2` once each, one accepted input, one model Turn                                                                                                   |
| `projection`      | MySQL refuses the `schedule` mirror's projection of an update, inside the journal commit's transaction   | `503 automation_operation_unknown`. The revision rolls back with the projection: neither the journal nor the mirror moves past revision 1. After a cold restart, the retry under the same key commits revision 2 once, and the journal and the mirror agree                |

Every case ends with the tenant holding no `skipped` or `unknown`
occurrence.

## Current state

- **Commits.** The Harness commits each journal transaction through its
  HTTP store client (`http-managed-session-store.ts`). An uncertain failure
  is retried up to three attempts in all: a 429 or 5xx, a transport error or
  a timeout. The retry sends the same command id, and the store answers a
  command it already holds with that commit's receipt.
- **The write latch.** When a commit still fails, the Session's authority
  records the failure (`writeFailure`, `managed-session-authority.ts`).
  Every later command answers `ManagedSessionWritesStoppedError` until the
  Session is loaded again. It cannot know whether the records landed.
- **What the caller sees.** The automation route answers a store failure
  `503 automation_operation_failed`. Spring's client treats every Harness
  5xx as an ambiguous outcome, so the public routes answer
  `503 automation_operation_unknown` ("retry the same key"). A manual run's
  occurrence stays `firing`, and the scanner re-drives it.
- **The projection.** The `schedule` mirror is projected inside the store's
  journal-commit transaction (`ManagedExtensionRecordStore` →
  `AutomationLedgerStore.projectSchedule`), so a refused projection refuses
  the commit.

## Gate ledger

Ground truth is the Session journal (`ma_session_journal_tx`), the
records and the mirror (`ma_session_record`, `ma_schedule`,
`ma_schedule_occurrence`), the writer generation (`ma_session_head`), the
store relay's commit log and the model stub's prompts.

The refusals are slice 1's tenant-fenced triggers, now on
`ma_session_journal_tx` and `ma_schedule`. Each records what it refused
(the command id, or the definition revision), so a case checks that every
attempt was the same commit and that at least three were made.

## Fixture design

- **Store relay.** Only this method puts a `HostedLifecycleRelay` between
  the Harness and the Session Store (`session-store.base-url`). It records
  every commit's command id, and drops the store's answer to the one armed
  command after the store committed it.
- **Cold restart.** The Harness is SIGKILLed and started on the same port
  with a fresh HOME. The Spring writer lease is 15 s for this method, so the
  dead writer's lease lapses quickly. The next request that reaches the
  Session reloads it, which is the case's own retry or the scanner's
  re-drive. The case checks that a new writer generation holds the Session.
- **Retry until accepted.** After the restart, the case retries the same
  request under the same key until it answers `202`. Before the lease
  lapses, the cold Harness's load is refused, and the public route passes
  that through as `409 managed_session_writer_conflict` (see Findings). Any
  other refusal fails the case.
- **Teardown.** It drops each trigger on its own, so one failing drop
  leaves none of the others on the shared fork's schema. Then it drops the
  refusal table.

## Findings

- **A transient writer conflict reaches the public caller as a 409.**
  Right after a Harness restart, the public manual-run route answered
  `409 managed_session_writer_conflict` until the dead writer's lease
  lapsed. The update route relays through the same translation
  (`ManagedAutomationService.translate`, a Harness 409 stays a 409). The
  scanner re-drives this, because the code is not one of its definitive
  refusals, so a manual run is not lost. But the public answer is a 4xx
  conflict that a client is unlikely to retry, and nothing else re-drives a
  definition update. A retry under the same key does recover, because the
  receipt stays claimed and unanswered. This slice records the behaviour,
  and the gate retries through it rather than pinning it.

## Mutation witnesses

Each witness was run against its own case alone and restored byte for
byte.

| Witness | Mutation                                                                                                           | Red at                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| c1      | The Harness keeps writing a Session after a commit it could not confirm (bundle patch of the `writeFailure` latch) | `revision-1`: once the refusal dropped, the same key answered `202` without a restart                                                       |
| c2      | The `schedule` projection's failure is swallowed, so the journal commits without it                                | `projection`: the update committed revision 2 to the journal while the mirror stayed at 1, and answered `automation_projection_unavailable` |
| c3      | The store no longer answers a command it holds as that commit                                                      | `store-transport`: the lost answer was not absorbed; the manual run answered `503`                                                          |
| c4      | A claim whose answer is unobtainable is given up at once (`MAX_FIRE_ATTEMPTS` 1)                                   | `revision-2`: the occurrence settled `unknown` after the first failure, and the retry was answered with it instead of a re-drive            |

## Budget

The method measured 62.1 s, 72.4 s and 71.6 s locally on JDK 21 +
MySQL 8.4.6, with three cold restarts. It is budgeted at about 145 s (2×
the heaviest run), composed onto `main`'s fork budget at push time: the
healthy sum moves from 4888 s to 5033 s and the fork from 5498 s to
5643 s. Fork + 600 s = 6243 s stays inside the Verify step's 105 minutes,
so no step or job ceiling moves.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- All three test methods green locally on JDK 21 + MySQL 8.4.6, and every
  witness red before merge.
- `scripts/tests/hosted-process-ci.test.js` green with the fork budget
  composed.
- The four cases share one `@Test`, so a first red names one case and the
  cases after it never run. Re-run each with `-Dqwen.fg11b.case=<case>`.
- This design ships in both languages with matching structure.

## Open questions

- Whether the public automation routes should answer a writer conflict as
  a retryable `503`, the way they answer every other unobtained outcome.
  See Findings.
- A store transport failure before the store sees the commit, on every
  attempt, behaves like `revision-1`: nothing commits, and the Session
  latches. This slice gates only the answer-lost variant, which is the one
  the store client's own retry absorbs.
