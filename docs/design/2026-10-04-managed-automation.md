# Managed Automation (H6)

[English](2026-10-04-managed-automation.md) | [简体中文](2026-10-04-managed-automation.zh-CN.md)

Status: proposed design; its H6a record contract is now implemented as
[Record bodies](#record-bodies-h6a-contract) spells out — the two bodies,
their validators, occurrence identity and transition witnesses, the shared
fixtures TypeScript and Java replay, the `MANAGED_EXTENSION_RECORD_BODIES`
entries and the Java mirrors. No domain it names is enabled for submission:
`schedule` and `automation_run` stay out of `MANAGED_SESSION_ENABLED_DOMAINS`,
and `commitExtensionRecord` still refuses them. H6b and H6c remain proposed.
This is the design for slice H6 of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the
Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
It builds on the task contract of H0a
([design](2026-09-27-managed-agent-task-contract.md)), the record contract of
H0b ([design](2026-09-27-managed-extension-record-contract.md)) and the
authority of H0c ([design](2026-09-27-managed-extension-authority.md)). Below,
"the reference design" is sections 1, 3, 7, 11, 12, 13 and 14 of the
proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md),
whose preamble leaves the field-level contract of Schedule resources to its
[automation design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md),
at the commit that #12827 pins.

## Problem

Automation splits into a `ScheduleDefinition` and its `AutomationRun`s
(reference design, section 7). The Scheduler only discovers candidates and
claims runs; it never drives a model. Each trigger must get a stable `runId`
and `occurrenceKey` before any effect, so that two scanner instances, a
retry, or a catch-up pass can never double-fire one occurrence into two
model runs. Legacy scheduled tasks run in the daemon: `scheduled-task-run.ts`
and the `/scheduled-tasks` serve routes create a fresh child Session per
fire, with the trigger instructions injected as a control sentence
(`SCHEDULED_TASK_RUN_INSTRUCTION`). Their schedule state lives in
daemon-local storage, one node owns firing at a time by construction, and a
missed window or a node replacement has no committed facts to reconcile
against. Section 1 of the reference design makes every dispatch start with a
stable ID and a persisted intent, and forbids blind retry of unknown
effects. H6 must answer: how an occurrence is identified; how exactly one of
several Java nodes claims it; what happens to runs that overlap, were
missed, or whose target dispatch is uncertain; and how a settled run reaches
its delivery without ever re-running the model.

## Current state

The facts below are from `main` at `5ddfacc9d4`; a bullet that H6a changed
when it landed says so.

- **Domain index.** `schedule` and `automation_run` are registered in the
  closed v1 domain index of
  `packages/core/src/managed-runtime/managed-session-records.ts`.
  Registration is not enablement: neither is in
  `MANAGED_SESSION_ENABLED_DOMAINS`, and `commitExtensionRecord` refuses
  them. Since the H6a contract landed, both have record bodies in
  `MANAGED_EXTENSION_RECORD_BODIES` (`managed-extension-projection.ts`),
  each body under the shared `managed-automation-record/1` contract.
- **Task projection.** The task kind `automation_run` is declared
  (`MANAGED_TASK_KINDS`) and frozen in the public `TaskKind` enum, and the
  H0b run block carries the run, execution and delivery lines an
  `AutomationRun` needs.
- **Public contract.** H0a named the automation resources
  (`GET /v1/agent-automations`, `GET /v1/agent-automations/{automationId}/runs`)
  as `planned` in v1.16 and assigned their shapes to H6: definition CRUD,
  manual run and run query, with definitions and historical runs paged
  separately (reference section 11). Mutations take an `Idempotency-Key`
  and answer `202 + operationId`.
- **Legacy scheduled tasks.** `packages/cli/src/runtime/scheduled-task-run.ts`
  builds one per-fire child Session named from the task label plus trigger
  time, and `packages/cli/src/serve/scheduled-task-*.ts` keep the daemon
  routes and keepalive. Nothing there is a committed schedule ledger;
  nothing survives a node replacement as a reconcilable fact.
- **Wake and input.** H0c decision 2: no `WakeIntent` record; a revision may
  commit a notification input with its `input.accepted` and
  `wake.requested` in one transaction. A wake consumer does not exist yet
  (H0c open question 6).
- **Fencing primitives.** W0 workspace binding with generation fencing,
  durable local-process provisioning (on by default with an opt-out flag;
  dedicated Linux reboot acceptance pending,
  [W0e](2026-09-27-managed-workspace-recovery.md)), and the Runtime
  Broker's claim/generation model give H6 the lease vocabulary; the
  automation scanner lease itself is designed here and is not implemented.
- **Dependencies of later slices.** H4 owns the managed child Session a
  `per_run` run creates; H5 owns the Channel delivery contract a run's
  delivery policy uses. H6 consumes both rather than duplicating them.
- **Java bodies.** The Java store materializes only known bodies; a body H6
  adds must ship on both sides before any writer commits the domain (H0c
  open question 7).

## Goals

- Define the `schedule` (definition) and `automation_run` record bodies on
  top of the H0b run block.
- Pin occurrence identity: for a timer trigger, `occurrenceKey` is
  `schedule:<slot>` with the slot the canonical UTC instant the scanner
  derives from the definition, and the scheduleId and revision it fired
  with freeze beside it on the run; a manual run uses its command ID and
  a webhook trigger its verified event ID.
- Add a scanner that discovers due occurrences and claims each run under a
  workspace lease/fencing token, so several Java nodes yield exactly one
  claimant.
- Pin the overlap policy (`skip` default, `queue_one`, `allow`) and the
  catch-up policy (`none` default, `latest`, bounded), with unbounded
  catch-up forbidden.
- Execute a run as a `persistent` target Session input or a `per_run`
  child Session, with the target frozen in the run's intent revision.
- Deliver a settled run through its committed delivery policy — a Channel
  outbox entry — without ever re-running the model after a send failure.

## Non-goals

- **A second scheduler or model loop.** Goal, Live, channel loop, webhook
  and background-completion notifications keep entering a Session through
  the unified internal input queue with their own priorities and budgets
  (reference section 7); their migration onto this ledger is later work,
  and none of them gains a second scheduler here.
- **Webhook ingress.** Verified-event-ID triggers need a webhook surface
  that does not exist in these slices; the occurrence identity reserves
  `eventId` for them, and the trigger kind is refused at admission until
  its slice lands.
- **H4/H5 scope.** Child Session creation details (H4) and Channel delivery
  receipts (H5) are consumed, not redesigned.
- **Legacy daemon routes.** The `/scheduled-tasks` routes stay an internal
  adapter source (reference section 11); no daemon route changes.
- **Budget enforcement beyond count caps.** The definition pins its budget
  policy; enforcing model/tool spend against it reuses the Session's
  existing machinery, and new budget kinds are a later slice.
- **Definition field changes mid-run.** A started run pins the definition
  revision fired with; definition updates affect later occurrences only
  (reference section 1, item 5).

## Decisions

1. **Definition and run are separate records.** `schedule` (chain identity
   `scheduleId`) holds the definition revisions: cron expression and
   timezone, prompt resource revision, target Session mode, delivery
   policy, missed/catch-up policy, concurrency and budget policy —
   append-only revisions with a content digest, as the
   AgentDefinition contract (D8a) does. `automation_run` (chain identity
   `automationRunId`) holds one occurrence: its `occurrenceKey`, the
   pinned definition revision, the frozen target, its
   run/execution/delivery lines, and the task kind `automation_run`, so
   every run is visible in the bound Session's `SessionTaskView`.
2. **The occurrence is identified before it is claimed.** For a timer
   trigger, the run's `occurrenceKey` is `schedule:<slot>` — the slot the
   canonical UTC instant to the second that the scanner derives from the
   definition's cron and timezone, so DST folds and gaps have exactly one
   reading; the `scheduleId` and the definition `revision` it fired with
   freeze beside it on the same run record. A manual run uses its
   admission command ID (the `Idempotency-Key`). A webhook run uses the
   verified event ID. Two claims of the same `occurrenceKey` resolve to
   one run; the second claimant reads the committed run instead of
   creating one.
   **A definition revision never re-arms a covered slot.** The run ledger
   keeps a per-schedule watermark `latestAdmittedSlot` across all
   revisions: the greatest scheduled instant (`scheduleId`, whatever
   revision) for which an `automation_run` was committed. Claim and
   catch-up decisions consult the watermark, never the revision key
   alone: an occurrence whose `slot` is at or below the watermark is
   covered, and catch-up (`latest` or bounded) proposes only slots
   strictly above the watermark, plus the missed ones between the
   watermark and now — whatever revision wrote the committed ones. A
   prompt-only update that bumps the revision therefore cannot replay a
   slot the old revision already ran, and an `r2` that re-derives the
   same instant under `catch_up: latest` sees it covered rather than
   fired again (reference section 7: a definition update affects only
   later occurrences and never replays a committed slot).
3. **Exactly one scanner claims.** Scanners run on Java nodes and contend a
   workspace-scoped claim under a lease with fencing, the same discipline
   the Runtime Broker applies to bindings: the lease carries a fencing
   token, and a runner that lost the fence can query and reconcile but
   cannot create effects. A scan tick computes due occurrences, commits
   `automation_run` start revisions for them one transaction each, and
   only then dispatches. A timeout, 404 or incomplete answer from the
   dispatch path proves nothing about whether the target got the intent —
   the scanner reconciles the original `occurrenceKey` and `runId` and
   never re-fires blind (reference sections 1 and 7).
4. **Overlap is the definition's explicit choice.** `skip` (default): a due
   occurrence whose previous run is not terminal is dropped and the drop
   is recorded on the run ledger as a skipped occurrence, not a run.
   `queue_one`: at most one occurrence waits; a third fire while one runs
   and one waits skips with the same record. `allow`: overlaps proceed,
   bounded by the concurrency quota, which refuses with H0b's
   `count_limit` beyond it.
5. **Catch-up is bounded or absent.** `none` (default): missed windows are
   recorded as missed and never fired. `latest`: at most the newest missed
   occurrence fires once. `bounded: N`: at most the newest N missed
   occurrences fire, oldest first. Unbounded catch-up is rejected at
   definition admission.
6. **Two target modes, frozen at intent.** `persistent`: the run submits
   its input to the bound task Session with the H0c mechanism (input plus
   wake in one transaction); the bound Session is part of the definition.
   `per_run`: the run creates an independent child Session through H4's
   pipeline, with its own history and lifecycle. The mode and the concrete
   target (Session, bundle revision, workspace context) freeze into the
   run's start revision and cannot migrate mid-run; a Workspace change in
   progress defers admission rather than falling back to a daemon primary
   or default workspace (the v1.9/v1.10 Workspace/cwd contract addendum of
   the reference design).
7. **Delivery never re-runs the model.** When a run settles, its committed
   delivery policy creates the `channel_delivery` outbox entries (H5's
   contract). A send failure, `partial` or `unknown` delivery reconciles
   on H5's rules; the run's model work is never retried because a
   delivery is outstanding (reference sections 7 and 14, item 6).
8. **History and retention follow the run ledger.** Definitions and
   historical runs page separately on the public API (reference section
   11). Run records pin their result Artifacts under O4's Session-rooted
   retention, so a delivered-or-not run's evidence survives Event expiry,
   in the same bounded-aggregation spirit that reference section 14, item
   8 states for high-frequency Monitor output.

## Record bodies (H6a contract)

Both bodies embed the H0b run block unchanged. The closed field sets,
validators and transition rules below are the shipped H6a contract, pinned
by `managed-automation-record-v1.fixtures.json`, which TypeScript and Java
both replay — including each anchored timezone replayed through the
validator. Where the direction above named more (the delivery-policy
snapshot shape, the concurrency and budget policy fields, the `per_run`
child intent with its cross-Session target), version 1 deliberately
carries less: the delivery policy's shape lands with its H5/H6 producers,
the child intent lands with H4, and `allow` overlaps stay a policy name
whose concurrency quota H6b enforces, with refusals carrying the shared
`count_limit` reason. This section is the byte-level truth.

- `managed-schedule` version 1 (chain identity `scheduleId`): the
  `ownerScopeId`, `goal` (bounded text), a five-field `cron` of minute,
  hour, day-of-month, month and day-of-week digit/range atoms whose
  values stay inside the field's bounds with positive, bounded steps and
  no wrapping range, an IANA `timezone` name accepted on form alone —
  the hosts disagree about which names resolve, so the resolution is an
  H6b admission concern and the seven fixture anchors replay through the
  validator on each host — the definition `definitionRevision` and
  `definitionDigest`, the `promptRef` resource reference, `sessionMode`
  (`persistent` | `per_run`) with `targetSessionId` set exactly for
  `persistent`, the `overlap` policy (`skip` | `queue_one` | `allow`),
  the `catchUp` policy (`none` | `latest` | `bounded`) with
  `catchUpLimit` of at least 1 set exactly for `bounded`, and an
  `enabled` flag. Definition revisions are append-only: every successor
  revision carries `definitionRevision + 1`, and the run block is a
  purely logical lifecycle (no execution, delivery, dispatch or
  definition pin); once the run is terminal the definition freezes for
  good — a later revision can no longer exist (the
  `schedule-frozen-when-terminal` fixture pins it on both hosts).
- `managed-automation_run` version 1 (chain identity `automationRunId`):
  the `scheduleId` and pinned `definitionRevision`, the closed
  `occurrenceKey` union — `schedule:<slot>` (the slot a canonical UTC
  instant to the second, so DST folds and gaps have exactly one reading;
  open question 1 answered) or `manual:<commandId>`, with
  `webhook:<eventId>` registered and refused until the webhook ingress
  slice lands — `sessionMode` and the frozen `targetSessionId` (set for
  `persistent`, null for `per_run` until H4 gives the child intent a
  place), and the H0b run block with task kind `automation_run`. Its run
  names its durable `dispatchId` from the first revision and no
  `executionCallId` or definition pin; its execution line tracks the
  target dispatch; its delivery line (on the H5 path its target is
  `channel`) may move past `planned` only once the run ended, so a
  delivered-or-not run never re-runs the model. The run block holds no
  definition pin of its own, so an `automation_run` task row always
  reads `definitionRevision: null`; the authoritative revision lives on
  the record itself.
- Fixed-across-revisions fields follow H0b's rule: the schedule's identity
  (`kind`, `scheduleId`, `ownerScopeId`) and, for the run, everything but
  the run block itself — the occurrence identity, the pinned definition
  revision and the frozen target never change once the chain exists, so
  only the run moves.

## Slice plan

| Slice | Scope                                                                                                                                                                                                                                                                 | Exit gates                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H6a   | Record contract: both bodies, validators, occurrence-identity canonicalization (canonical UTC slot, timezone anchors), in the shared `managed-automation-record-v1` fixtures; `MANAGED_EXTENSION_RECORD_BODIES` entries; Java replay. Landed.                         | TypeScript and Java produce and refuse identical chains from the fixtures (met). Both domains stay absent from `MANAGED_SESSION_ENABLED_DOMAINS`; `commitExtensionRecord` still refuses them (met). The Java store ships the bodies before any writer can commit (met — H0c open question 7). No production caller constructs either body (met).                                                                                            |
| H6b   | Definition CRUD under the planned public routes (moved to `partial`), manual run via command ID, the scanner with workspace lease/fencing and single-claim, the run ledger with skip/queue records, and overlap/catch-up enforcement. Domains enabled for submission. | Two scanner instances claim exactly one run per occurrence (reference section 14, item 6): the loser reads the committed run. A missed window under `none` is recorded and never fires; under `latest` at most one catch-up fires; under `bounded: N` at most N. A manual run replays its `Idempotency-Key`. Definitions and runs page separately; every mutation answers `202 + operationId`.                                              |
| H6c   | Execution targets and delivery: `persistent` input admission with wake, `per_run` child Sessions through H4, delivery-policy projection onto H5 `channel_delivery` entries.                                                                                           | A `persistent` run's input commits with its wake in one transaction and a scanner crash between claim and admission reconciles by `runId`. A `per_run` dispatch whose answer is unknown never produces a second child for the same `occurrenceKey`. A settled run creates exactly its committed deliveries; a Channel send failure, `partial` or `unknown` reconciles without touching the run's model work (reference section 14, item 6). |

Later H6 slices (not scheduled here): webhook triggers with verified event
IDs; Goal/Live/channel-loop migration onto the ledger; new budget kinds.

## Validation plan

- Fixture parity for both bodies, replayed by TypeScript and by Java —
  the seven host-tz anchors replayed through the validator on each
  host. The occurrence canonicalization tables (timezone offsets, DST
  fold and gap witnesses) belong to the H6b scanner that derives the
  slots; the record contract pins only the canonical UTC slot form.
- Scanner contention tests: two claimants, fence loss mid-dispatch,
  lease expiry during reconciliation, and scanner restart between claim
  commit and dispatch.
- Policy matrices automated: every (overlap × catch-up) pair against
  scripted missed and overlapping windows, asserting the exact run
  population and the skip/miss records.
- Java store materialization (a Flyway migration after main's V34), with
  refusal rollback and outbox columns exercised for runs that deliver.
- Fault-injection E2E on H6c: crash before input commit, between commit
  and dispatch, and between settle and delivery creation; each ends in at
  most one model run per occurrence, or a visible
  `unknown`/`recovery_blocked`.
- Mutation checks: each identity, policy and fencing rule disabled in
  turn fails a test.

## Acceptance criteria

- Reference section 14, item 6: two scanners claim one run per occurrence;
  an unknown `per_run` dispatch never double-fires into the parent; a
  Channel send failure after model completion never re-runs the model.
- Reference section 14, item 10: every failure resolves to
  `not_started_proven`, settled, attachable, or `unknown`/`corrupt`, and
  `unknown` never masquerades as success or auto-reruns.
- Reference section 3.2: the definition's update history, the run ledger
  and the delivery line are three separately readable facts.
- Both domains are enabled for submission only in the slice that ships
  their producers, with the contract test proving enablement is explicit.

## Open questions

1. **Slot representation.** Answered by the shipped H6a contract: the
   slot is the canonical UTC instant to the second
   (`schedule:<instant>`), so DST folds and gaps have exactly one reading
   and the definition's timezone stays a property of the definition.
2. **Catch-up window bound.** Whether `bounded: N` also needs a maximum
   age, or the definition's enablement window bounds it, is an H6b
   decision.
3. **Lease sizing.** The scanner lease duration and scan period ship as
   deployment configuration; measured values precede enablement, as the
   capacity table of reference section 12 requires (active runs, triggers
   per window, model/tool budget).
4. **Manual-run admission scope.** Whether a manual run requires the
   definition's owner or merely a Session writer on the target is decided
   with the public route's authorization map in H6b.
