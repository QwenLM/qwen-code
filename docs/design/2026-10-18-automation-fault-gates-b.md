# Hosted automation fault gates FG11b, slice 1: Spring-side store faults

[English](2026-10-18-automation-fault-gates-b.md) | [简体中文](2026-10-18-automation-fault-gates-b.zh-CN.md)

## Problem and scope

Issue #14446 is Stage F round FG11 of #12380: fault gates for the
automation domains `schedule` and `automation_run`. FG11a (#14534) gated
lost replies and stood up the packaged automation stack. This slice
implements the **Spring-side half of FG11b, store failures**. It also adds
the revision-race cell that the tracker's FG11b discussion asked for.

The property under gate: a store fault never fires a slot twice, never
records a slot that is not true, and never settles a slot `skipped`. Only a
definitive refusal, or a stale, retired or missing definition, may do that.

Six cases ship, all in one boot:

| Case                | Injection                                                                                  | Expect                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `occurrence-insert` | MySQL refuses the scanner's record of the next slot (`ma_schedule_occurrence` insert)      | Nothing fires while the record is refused, and no row exists; every refusal names the same slot. Once the refusal drops, that slot itself, still timely, is recorded and fires once (`attempts` 0): one run chain, one model Turn. A later minute firing in its place fails the case |
| `occurrence-settle` | The fire commits on the Harness, and settling its occurrence `fired` is refused            | The occurrence stays `firing` and is re-driven with backoff. Every re-drive names the same occurrence. Once the refusal drops it settles `fired`: one run chain, one accepted input, one model Turn                                                                                  |
| `watermark`         | The slot fires and settles, and the watermark advance after it is refused                  | Every later tick derives the same slot again, and its recorded decision stands: one occurrence, one fire. The watermark moves once the refusal drops                                                                                                                                 |
| `receipt-claim`     | MySQL refuses the create's request receipt                                                 | A server failure, not a refusal the caller would not retry. Nothing reaches the Harness. After the refusal drops, the retry creates the definition once                                                                                                                              |
| `receipt-settle`    | The Harness commits the create, and Spring's settle of the receipt is refused              | A server failure. The retry finds the receipt claimed but unanswered and re-drives the same operation id. It answers revision 1, with one `defineSchedule` commit                                                                                                                    |
| `revision-race`     | The scanner's fire of revision 1 is parked at the relay while an update commits revision 2 | The Harness answers `409 automation_revision_stale`. The scanner re-pins the occurrence and fires revision 2, which settles `fired`. One run chain, and its one model Turn carries revision 2's prompt                                                                               |

Every case ends with the tenant holding no `skipped` or `unknown`
occurrence.

The Harness-side store faults are the second slice of FG11b:

- refusing revision 1 or revision 2 of a run;
- refusing the `schedule` projection, so it rolls back with the journal;
- failing the Harness's store transport.

Those leave the Harness Session with its writes stopped, so their cells
restart the Harness. They are in
[slice 2's design](2026-10-18-automation-fault-gates-b2.md).

## Current state

- The scanner records an occurrence `firing` before it asks the Harness
  (`AutomationScanner.decide`). A refused insert therefore throws before
  anything is fired; the definition's scan logs the failure and its lease
  is released.
- A fire whose settle throws is deferred like a lost answer
  (`AutomationScanner.defer`): `attempts` + 1, then backoff of 2 s, 4 s,
  and so on. The re-drive (`redrive`) fires the stored occurrence again,
  and the Harness answers the committed run.
- The watermark advance runs after every slot of a tick. When it throws,
  the next tick starts from the old watermark, and `decide` finds the slot's
  decision already recorded.
- Create, update and retire claim a request receipt before they relay
  (`ManagedAutomationService`), and settle it with the answer. A retry
  replays a settled receipt, and re-drives one that is claimed but
  unanswered under the operation id derived from the key.
- A fire that meets a newer definition answers
  `409 automation_revision_stale`. The scanner re-reads the definition,
  re-pins the occurrence and fires once more (`AutomationScanner.fire`).
  #14446's discussion found, by static reading, that a define and a fire
  cannot race into `automation_operation_conflict` inside one Harness,
  because both run through one serial queue. This cell is the
  classification witness the tracker asked for.

## Gate ledger

Ground truth is the relay's operation log, the Session journal, the Java
mirror (`ma_schedule_occurrence`, `ma_schedule`, `ma_request_receipt`) and
the model stub's prompts.

Each refusal is a MySQL `BEFORE` trigger fenced by this tenant. As in
FG9b and FG10c, it refuses every matching write until it is dropped.
First it writes a row to a MyISAM table, which survives the rollback, so
the case counts its refusals before it drops them. The row also records
what was refused (the occurrence key, or the watermark slot), so
`occurrence-insert` and `occurrence-settle` check that the slot they
recover is the one that was refused.

The model-Turn check matches a prompt by both its `Automation ID` and its
`Occurrence`, because the four clock-bound definitions share one slot key.

## Fixture design

The cases run in the second test method of `HostedAutomationFaultGatesIT`,
`fg11bStoreFaultsNeverFireTwiceOnMySql`, on the FG11a boot. The letter
names the tenant (`fg11-b-…`), the case selector (`-Dqwen.fg11b.case=…`)
and the evidence directory (`target/fg11-cases/fg11b/`).

- The four clock-bound cases set up while `SchedulerHold` parks the
  scanner, as FG11a's do, so each refusal or hold is in place before the
  boundary.
- The relay gains a hold rule that parks a matching operation before it
  reaches the Harness. `revision-race` lands its update from a background
  task the moment the fire is parked, and then lets it go. A fire parked
  past the connector's 30 s request timeout would be re-driven on its own.
  An earlier draft that updated from the settle phase showed exactly that:
  the re-drive fired revision 1 while the parked request was still waiting.
- Teardown releases every hold, then drops each trigger on its own (one
  failing drop leaves none of the others behind) and the refusal table, so
  nothing leaks into the classes after it on the shared fork's schema.

## Mutation witnesses

Each witness was run against its own case alone and restored byte for
byte.

| Witness | Mutation                                                                     | Red at                                                                              |
| ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| b1      | A refused record is swallowed, and the decision fires anyway                 | `occurrence-insert`: a fire reached the Harness while the record was refused        |
| b2      | Each re-drive names a fresh occurrence key instead of the claimed one        | `occurrence-settle`: a second occurrence row appeared beside the one still `firing` |
| b3      | Neither the recorded decision nor its outcome stops a later tick from firing | `watermark`: the slot was fired again on the ticks after it                         |
| b4      | A refused receipt claim is swallowed, and the create relays anyway           | `receipt-claim`: the create reached the Harness without a receipt                   |
| b5      | The re-drive mints a fresh operation id instead of the one the key derives   | `receipt-settle`: the retry's define carried a second operation id                  |
| b6      | A stale answer is never re-read and re-pinned                                | `revision-race`: the slot settled `skipped` (`revision_stale`)                      |

One narrower mutation is equivalent and is not a witness. Removing only the
lookup of the recorded decision (b3a) stayed green on `watermark`: the
occurrence insert keeps the first decision under its primary key
(`INSERT IGNORE`), and its recorded `fired` outcome stops the fire. b3
removes both layers.

## Budget

`fg11bStoreFaultsNeverFireTwiceOnMySql` measured 30.8 s, 64.5 s and 64.1 s locally on
JDK 21 + MySQL 8.4.6. Most of the spread is the wait for the next minute
boundary. It is budgeted at about 130 s (2× the heaviest run), composed onto
`main`'s fork budget at push time. On top of `main` after #14541 the
healthy sum moves from 4758 s to 4888 s and the fork from 5368 s to
5498 s. Fork + 600 s = 6098 s outgrows the Verify step's 100 minutes, so
the step moves to 105 minutes and the job ceiling from 195 to 200 (steps
185, plus 13 for the uncapped setup, plus 2).

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- Both test methods green locally on JDK 21 + MySQL 8.4.6, and every
  witness red before merge.
- `scripts/tests/hosted-process-ci.test.js` green with the fork budget
  composed.
- The six cases share one `@Test`, so a first red names one case and the
  cases after it never run. Re-run each with `-Dqwen.fg11b.case=<case>`.
- This design ships in both languages with matching structure.

## Open questions

- Slice 2's Harness-side faults stop the Session's writes. Each needs a
  restart, and its expectation has to be shown on a reloaded Session. This
  is answered in [slice 2](2026-10-18-automation-fault-gates-b2.md): the
  public answer is a retryable `503 automation_operation_unknown`, and the
  reloaded Session completes the operation once.
- Whether `revision-race` should also cover a fire parked past the request
  timeout. That interleaving re-drives under the old revision while the
  original request is still in flight. This slice only records that it
  exists.
