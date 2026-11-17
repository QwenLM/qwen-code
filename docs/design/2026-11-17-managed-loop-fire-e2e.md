# Managed /loop scheduled-fire observation E2E

- Status: proposed
- Date: 2026-11-17
- Related: [Managed loop skill asset](2026-11-14-managed-loop-skill-asset.md)
  (#17272, #17433, #17470 merged), [Managed loop schedule](2026-11-10-managed-loop-schedule.md)
  (#17088, #17197, #17235 merged), [Managed loop wakeup](2026-11-10-managed-loop-wakeup.md)
  (#16835 merged)
- 中文版本: [2026-11-17-managed-loop-fire-e2e.zh-CN.md](2026-11-17-managed-loop-fire-e2e.zh-CN.md)

## Problem statement

The managed `/loop` chain is complete and merged: a creator-bearing profile
receives the cron loop variant at admission, the model drives the real
`cron_create` / `cron_list` / `cron_delete` tools, and the full-stack E2E
(`npm run test:e2e:managed-loop-skill`, a full-tier `hosted-failover-e2e` CI
step) attests that lifecycle. The skill-asset design states the remaining gap
explicitly: "observing a scheduled fire remains out of scope."

Today the E2E retires the schedule before it can fire (a five-minute cron,
cleared in the same run). Nothing in the packaged-stack E2E proves that a
committed schedule actually fires on its own: that the Java scanner claims the
armed definition, derives the due minute slot, relays `fire_run` to the
Harness, that the Harness dispatches an automation input whose framing reaches
the model as a new turn, and that the control plane settles the occurrence
`fired` with trigger `scheduled`. The Java integration tests exercise the
scanner against a fake Harness; the CLI unit tests exercise the fire route
against an in-process store. The two halves have never been observed together
on the real socket/filesystem/route stack.

## Current state (verified at 91690e86e5)

The fire chain, end to end:

1. `cron_create` on a files/4 Session runs the arm-time classifier review and
   commits the definition through the control plane
   (`packages/cli/src/serve/hosted-cron-session.ts`, create path). The ledger
   arms it (state `live`).
2. `AutomationScanner.scan()`
   (`packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/automation/AutomationScanner.java:111`)
   runs on `managedAutomationScheduler` at
   `${qwen.managed-agent.automation.scan-delay:10s}`; automation is enabled by
   default (`server/src/main/resources/application.yml:97-101`, env
   `QWEN_MANAGED_AGENT_AUTOMATION_SCAN_DELAY`). Each tick claims armed rows,
   derives minute-granularity cron slots (`CronSlots`), records one decision
   per slot, and fires an admitted occurrence as one idempotent Harness
   operation. The fire body carries `kind: "fire_run"`, the minted
   `scheduleId`, `definitionRevision`, `occurrenceKey`, `trigger` and
   `firedAt` (AutomationScanner.java, `fire`).
3. The Harness route `fire_run`
   (`packages/cli/src/serve/hosted-harness-session.ts:14238`) calls
   `automations.fire`, which dispatches an input whose text is
   `automationTurnText`
   (`packages/core/src/managed-runtime/managed-automation-operations.ts:699`):
   a framing block (`Scheduled automation: <goal>`, `Automation ID:`,
   `Schedule:`, `Occurrence:`, `Triggered at:`, `Trigger: <trigger>`), the
   `AUTOMATION_RUN_INSTRUCTION` sentence, then the schedule's prompt. The
   input's source is `automation`
   (`managed-automation-operations.ts:80`). The wake pump starts the turn the
   moment the Session idles; the runtime worker drives the model.
4. The scanner settles the occurrence `fired` on the relay answer. The public
   read route `GET /v1/agent-automations/{automationId}/runs`
   (`ManagedAutomationController.java:89`) answers `PublicAutomationRun`
   records (`ApiModels.java:794`) carrying `trigger`, `outcome`,
   `occurrence_key`, `slot` and `state`.

Timing: cron slots are minute-granularity and the watermark advances to
`floor(now / 60s)` (AutomationScanner.java, `work`). A schedule armed mid-minute
fires at the next minute boundary, on the first tick after it; the worst-case
wait is one minute plus the scan delay. `*/1 * * * *` is the skill's `1m`
mapping and compiles like `* * * * *`.

The runner (`scripts/run-managed-agent-server-e2e.ts`) already starts MySQL,
the packaged Spring jar, the hosted harness, the embedded runtime broker and a
fake OpenAI server; `waitForTerminal` polls the public event stream; the
`--loop-skill` arm's fake model answers the classifier's `respond_in_schema`
side query by matching the block schema. The fire arm reuses all of it.

## Proposed changes

A new exclusive runner mode `--loop-fire`, wired as the thirtieth
`hosted-failover-e2e` arm. One scenario, one question: does a committed
every-minute schedule fire on its own and drive a model turn?

### Scenario

1. Create a files/4 definition and a Session whose input is
   `/loop 1m LOOP-FIRE-PROMPT check the deploy`. No caller skills are sent
   (decision D4). The injected variant loads before the first round; the
   scripted model calls `cron_create` with `cron: "*/1 * * * *"`,
   `prompt: "LOOP-FIRE-PROMPT check the deploy"`, `recurring: true`,
   `durable: true`, then confirms. The create turn must settle as exactly one
   `turn.completed`.
2. The runner extracts the minted `asch_` id from the create tool result
   (matched by `tool_call_id`, not substring).
3. The runner sends no further input and reads
   `GET /v1/agent-automations/{id}/runs` until an occurrence answers
   `trigger: "scheduled"`, `outcome: "fired"`, `state: "completed"`. A
   harness-driven wake turn does not ride the public turn event stream — that
   stream is written by the control plane's dispatched-turn pipeline — so the
   run mirror is its public lifecycle: `state: "completed"` settles from the
   wake turn's own committed result and proves the turn ran and completed.
4. The fire's prompt must have reached the model in a streamed round whose
   latest user text is the automation framing. The fake model answers that
   round with the wake marker and no tools, so the completed run proves the
   marker answer ran.
5. The guard ties the two witnesses to one occurrence (decision D3) and the
   arm asserts the negative: no create-turn round carries the automation
   framing.
6. Cleanup: a `/loop clear` client turn, queued from the create cursor (the
   wake turn added no public events), drives `cron_delete` against the minted
   id; the delete result must state the retirement and the client turn must
   settle as exactly one `turn.completed`. A live every-minute schedule must
   not survive the arm.

### Fake model

The `--loop-fire` branch answers, in order: the classifier's block-schema side
query with an allow (the same schema-match the skill arm uses); a wake round —
the latest user text carries the `Scheduled automation:` framing header — with
the terminal marker content and no tool calls; a `/loop clear` round with
`cron_delete` of the id the create result printed, then a confirmation; any
other round with the `cron_create` fixture, then a confirmation once that
call's own result is in the history. The fake model and the round search match
the header only; the scheduled-trigger discrimination lives in the guard
alone, so a relayed trigger drift reddens the guard while the wake turn still
runs.

### Guard

A top-level pure function `assertScheduledFireWitness(runs, wakeText,
scheduleId)` so the meta-test can extract and execute it:

- some run has `trigger === 'scheduled'` and `outcome === 'fired'`, else throw
  (a manual or skipped occurrence must not pass);
- that run's `occurrence_key` appears verbatim in `wakeText`, else throw (the
  model round and the ledger must name the same occurrence);
- `wakeText` carries `Automation ID: <scheduleId>` and `Trigger: scheduled`,
  else throw (the round must be the fire's framing, not a client prompt).

### CI wiring

- `package.json`: `test:e2e:managed-loop-fire` runs the runner with
  `--loop-fire`.
- `.github/workflows/sdk-java.yml`: a `Run /loop scheduled-fire E2E` step after
  the skill arm, same `failover_prerequisites` gate, `timeout-minutes: 10`;
  job ceiling 315 → 325 (30 arms × 10 + cgroup 10 = 310, + ~13 setup + 2).
- `scripts/tests/hosted-process-ci.test.js`: the `failoverArms` row, the
  `--loop-fire` flag-exclusivity entry, the ceiling table `[310, 325, 15]`,
  the arm-count comment.
- `scripts/tests/managed-agent-server-e2e.test.js`: a pin test for the arm's
  contracts plus executable assertions over the extracted guard.

## Design decisions

- **D1 — a separate arm, not an extension of `--loop-skill`.** The skill arm's
  create → list → clear contract is merged and pinned; the fire arm asks a
  different question and needs a different clock (a minute-boundary wait).
  Separate arms keep failure attribution clean and leave every existing pin
  untouched. They share the runner and the packaged stack, per the established
  one-runner pattern.
- **D2 — a real scheduled trigger, no shortcut.** The witness must be
  `trigger: "scheduled"`. No manual-run route, no clock injection: the arm
  sets `QWEN_MANAGED_AGENT_AUTOMATION_SCAN_DELAY=1s` (this mode only) and waits
  for the real minute boundary. Worst-case wait ≈ 60s + 1s tick + relay + turn;
  the runs-route poll budget is 150s and the CI step keeps the 10-minute
  ceiling every arm uses.
- **D3 — bidirectional witness, one occurrence.** A fired ledger row alone
  could ride a wake turn the model never saw; a model round alone could be a
  client prompt in disguise. The guard requires the ledger's `occurrence_key`
  verbatim inside the round's framing, the framing's `Automation ID` to equal
  the minted id, and the trigger to be `scheduled` on both sides. The negative
  (no framing in any create-turn round) proves the fire round is new. The
  wake turn's terminal is witnessed by the run mirror's `completed` state,
  which settles from the turn's own committed result: a harness-driven wake
  turn does not ride the public turn event stream (that stream is written by
  the control plane's dispatched-turn pipeline), so the runs route is the
  public surface for its lifecycle.
- **D4 — no caller skills in this arm.** files/4 admission injects the variant
  unconditionally, and the replace path already has its bidirectional
  attestation in the skill arm. Omitting caller skills keeps this arm minimal
  and avoids duplicating that attestation.
- **D5 — the cleanup leg is a model turn.** `/loop clear` drives the real
  `cron_delete` and the result must state the retirement of the minted id,
  proving the schedule stays cancellable after a fire and leaving no live
  every-minute definition behind.
- **D6 — the guard is executable in the meta-test.** Text pins alone do not
  prove a guard runs (the round-2 lesson of #17470): the guard is a top-level
  pure declaration, the meta-test loads it through the existing
  load/extracted harness and exercises each throw direction plus the pass.

## Files affected

| File                                                               | Change                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `scripts/run-managed-agent-server-e2e.ts`                          | `--loop-fire` flag, exclusivity, usage, scan-delay env, fake-model branch, scenario, guard, result JSON |
| `scripts/tests/managed-agent-server-e2e.test.js`                   | arm pin test + executable guard assertions                                                              |
| `scripts/tests/hosted-process-ci.test.js`                          | failoverArms row, flag exclusivity, ceiling table, arm-count comment                                    |
| `package.json`                                                     | `test:e2e:managed-loop-fire` script                                                                     |
| `.github/workflows/sdk-java.yml`                                   | new arm step, job ceiling 325, arm-count comment                                                        |
| `docs/design/2026-11-17-managed-loop-fire-e2e.md` + `.zh-CN.md`    | this design                                                                                             |
| `docs/design/2026-11-14-managed-loop-skill-asset.md` + `.zh-CN.md` | the out-of-scope sentence notes the follow-up arm                                                       |

## Scope boundaries

- Only the `scheduled` trigger. `manual` and `catch_up` are out of scope; the
  guard rejects a manual occurrence as a witness.
- No gate probe: files/4 declares no Shell lane, and a gate is refused at
  create time. Gated fires are out of scope.
- Overlap and catch-up policies, multi-fire endurance, and the self-paced
  `loop_wakeup` sibling are out of scope. One fire is observed, then retired.
- The model is fake; everything else (MySQL, Spring scanner, Harness relay,
  runtime broker, wake pump, event stream) is the real packaged stack.

## Acceptance criteria

- The create and clear client turns each settle exactly one `turn.completed`;
  the create result names a minted `asch_` id; no create-turn round carries
  the automation framing.
- With no client input after create, the runs list answers an occurrence with
  `trigger: "scheduled"`, `outcome: "fired"`, `state: "completed"` — the run
  mirror settles from the wake turn's own committed result, proving the
  harness-driven turn ran and completed (it does not ride the public turn
  event stream).
- A streamed round's latest user message carries the framing with the minted
  id, `Trigger: scheduled`, the occurrence key and the prompt marker; the
  ledger row's `occurrence_key` appears verbatim in that framing.
- The clear leg retires the minted id and the delete result states the
  retirement.
- The meta-test executes the guard: a missing fired row, a manual trigger, an
  occurrence key absent from the wake text, and a framing without the minted
  id each throw; the matching witness passes. Severing the guard reddens the
  executable assertions while the text pins stay green.
- The CI meta-tests pin the new step's name, script, flag, timeout, condition
  and the ceiling arithmetic; the workflow size gate stays within its
  allowance.
- Local full-stack run green on the merged-main build. Mutation witnesses:
  swapping the scanner's relayed `trigger` to `manual` (jar rebuild) reddens
  the arm at the guard while the wake turn still runs; restoring the bytes and
  rebuilding returns green.

## Open questions

None blocking. The arm name, the one-minute cadence and the 150s wake budget
are decided above; the cadence is the cron minimum, so the wait cannot be
shortened without faking the clock, which D2 forbids.
