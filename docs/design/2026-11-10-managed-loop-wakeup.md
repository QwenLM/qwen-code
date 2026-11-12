# Managed self-paced loop wakeups

[English](2026-11-10-managed-loop-wakeup.md) | [简体中文](2026-11-10-managed-loop-wakeup.zh-CN.md)

Status: proposal, not implemented. This is the self-paced arm of `/loop`
support for Managed Sessions, a follow-up to the
[H6 automation design](2026-10-04-managed-automation.md) and its
[runtime](2026-10-07-managed-automation-runtime.md). It reuses the H3
embedded wake scheduler of the
[Shell/Monitor runtime](2026-10-03-managed-shell-monitor-runtime.md) and
the input/wake authority of
[H0c](2026-09-27-managed-extension-authority.md). The fixed-interval arm
of `/loop` maps onto H6 automation definitions in the
[sibling design](2026-11-10-managed-loop-schedule.md); nothing here
creates a definition.

## Problem

`/loop` (the bundled skill at
`packages/core/src/skills/bundled/loop/SKILL.md`) runs a prompt repeatedly.
Its self-paced paths — prompt-only, autonomous, and the `loop.md` dynamic
sentinel — arm the next tick with `loop_wakeup`, which calls
`CronScheduler.scheduleWakeup`: a second-resolution, in-memory,
session-only one-shot that dies with the process and never persists.

A Managed Session cannot run this path today:

- The Hosted tool profiles (`hosted-workspace-profiles.ts`:
  `hosted-workspace-files/1`–`/3`, `hosted-workspace-shell/1`,
  `hosted-workspace-team-lead/1`, `hosted-workspace-read/1`) declare no
  `loop_wakeup`, no cron tools, and the Hosted skill catalog carries no
  loop skill.
- Even with the tool exposed, an in-memory wakeup would not survive a
  Harness restart or takeover, and the daemon-local scheduler is forbidden
  from firing Managed work: the H6 runtime design, decision 14, keeps
  `cronScheduler.ts` out of Managed definitions, and the H6 design lists
  "a second scheduler or model loop" as a non-goal.

The wakeup must therefore become a Session-journal fact that the existing
embedded wake pump delivers, with the local tool's semantics preserved and
its budget bounded — without a control-plane scanner, a schedule record,
or any new scheduler.

## Current state

The facts below are from this repository at `488845a4a81`.

- **Local semantics** (`packages/core/src/services/cronScheduler.ts`,
  `packages/core/src/tools/loop-wakeup.ts`). `scheduleWakeup` clamps the
  delay to `[WAKEUP_MIN_SECONDS, WAKEUP_MAX_SECONDS]` = `[60, 3600]`
  seconds; non-finite input falls back to the 1200 s default heartbeat.
  One pending wakeup per scheduler: a new arm replaces it (`replacedId`).
  The chain anchor (`wakeupChainStartedAt`) is set on the first successful
  arm and reset only by `stop()`/`destroy()`; an arm whose fire time would
  exceed the anchor plus `WAKEUP_CHAIN_MAX_AGE_MS` (24 h) is refused, and
  the prior pending wakeup is dropped _before_ the budget check so a
  rejected re-arm leaves nothing behind. A fired wakeup leaves the
  pending map immediately, before its turn runs. `cancelWakeup(id)` and
  `cancelAllWakeups()` consume pending wakeups without a model turn. The
  tool's `getDefaultPermission()` returns `'ask'` and
  `toAutoClassifierInput()` forwards the continuation prompt to the AUTO
  classifier, because scheduling future model input is side-effectful.
  The prompt schema caps `prompt` at 10000 characters. Locally
  `cron_list` lists wakeups alongside cron jobs (`@wakeup`) and
  `CronScheduler.delete` falls through to `cancelWakeup` — the union
  shape the Managed surface preserves.
- **Hosted wake machinery** (`packages/cli/src/serve/hosted-wake-intake.ts`,
  `hosted-monitor-wake.ts`, `hosted-harness-session.ts`). An input commits
  as `input.accepted` plus an authority-generated `wake.requested` in one
  transaction (`inputEvents` in `managed-session-authority.ts`).
  `pendingSessionInputs` derives the pending set from the journal alone:
  an input is consumed exactly when a turn settles under its `turnId`.
  `HostedMonitorWakeScheduler` picks the oldest pending wake input
  (`isWakeInputSource`: `monitor`, `channel`, `automation`, child
  notifications, session messages) and runs it as an ordinary text turn
  immediately; it has no delayed-delivery concept. Its retry cadence is
  500 ms (busy/blocked) and 15 s (held). `settlePendingMonitorInputs`
  settles unstarted notification inputs model-free on the close path,
  guarded by `wakeHasPriorAttempt` so a turn that already started belongs
  to the recovery fleet instead.
- **The input contract is closed** (`managed-session-records.ts`,
  `EVENT_SCHEMAS`). `input.accepted` carries exactly `inputId`, `turnId`,
  `source`, `contentRef`, `deadline`, `admissionRef`. `deadline` already
  has a meaning — the absolute turn deadline the G3 step-3 recovery and
  the team-member 30-minute limit read — so it must not be repurposed as a
  wakeup fire time. The schema has an optional-field precedent
  (`activation.changed`'s `renewalSeq`). The envelope is a `managed-input`
  resource holding `{ text }`; `admissionRef` is a `managed-admission`
  resource (the monitor publishes `{}`).
- **H6 automation** creates definitions only through the control plane's
  public routes, fires them with the scanner's lease/fence ledger, and
  settles each run from its turn. None of that is needed for a one-shot
  self-paced wakeup, and none of it may be duplicated here.

## Goals

- Run `/loop`'s self-paced paths in a Managed Session with the local
  tool's semantics: clamp, default heartbeat, single pending, replacement,
  24 h chain cap, cancel answers.
- Make the wakeup durable in the Session journal: a Harness restart or
  takeover re-derives it, and an overdue wakeup fires exactly once late.
- Reuse the H3 embedded wake pump as the only delivery mechanism; no
  control-plane scanner, no `schedule`/`automation_run` records, no second
  scheduler.
- Bound the budget structurally: one unfired wakeup per Session, a 24 h
  chain, and the existing input size limits.

## Non-goals

- **The fixed-interval arm.** `/loop 5m …` maps onto H6 automation
  definitions (a Session-side creation tool over the existing
  `define_schedule` funnel); that is a separate slice.
- **Gate probes.** A self-paced loop decides its own continuation; the
  managed automation gate solves the per-slot cost of a cron watch, which
  does not apply here.
- **Channel delivery (H5) and `per_run` targets (H4).** A wakeup's result
  stays in its Session's transcript.
- **A Web Shell scheduling UI.** Journal-derived reads may display the
  pending wakeup; no new mutation surface is designed here.
- **Migrating the local `CronScheduler`.** The daemon and TUI keep their
  behavior unchanged.

## Decisions

1. **A wakeup is a Session input, not a schedule.** Arming publishes the
   prompt as a `managed-input` resource (`{ text }`, verbatim — no control
   sentence, unlike `AUTOMATION_RUN_INSTRUCTION`: the continuation is the
   model's own instruction) and an arm-time `managed-admission` resource
   recording the requested and clamped delay, the reason, and the
   classifier verdict. It then commits, in one journal transaction, an
   `input.accepted` with source `loop` and the authority-generated
   `wake.requested`. The input and turn id are `loop:<wakeupId>` with a
   fresh `wakeupId` per arm. The autonomous and `loop.md` sentinels
   (`<<autonomous-loop-dynamic>>`, `<<loop.md-dynamic>>`) ride in the
   envelope verbatim and are expanded at fire time, not at arm time: the
   funnel expands them when the pump picks the input, mirroring the
   local fire-time expansion. The expansion reuses the shared
   loop-task-file reader, so it carries the local guards rather than a
   bare file read: the project `.qwen/loop.md` is read only when the
   workspace is trusted under the Hosted trust gate (the slice pins that
   gate's evaluation model; the local reader's `allowProjectFile`
   defaults to false), otherwise the home file (the process-global
   `QWEN_HOME`) or the absent-file tick; the content is byte-capped at
   `LOOP_TASK_FILE_MAX_BYTES` (25 000) with the local truncation warning;
   an absent file converges on the autonomous tick and a transient read
   failure on the no-op re-arm tick, so a thrown turn never ends the loop
   forever. Because the arm-time classifier reviewed the sentinel
   constant, not the file text, the expansion is classifier-visible: the
   `managed-admission` record persists the last-reviewed content, and a
   fire whose resolved content differs from that last-reviewed value is
   re-reviewed before it runs — steady-state unchanged content is not
   re-reviewed on every tick. A denied re-review settles the input
   `cancelled` with stop reason `loop_admission_denied` (ending the loop),
   rather than re-picking it forever or dropping it silently. A changed
   task file is thus picked up on the next fire, and a restart or
   compaction re-provides the full guidance. No `schedule` or
   `automation_run` record, no control-plane row, and no scanner
   involvement: the journal is the only fact, exactly as for a monitor
   notification.
2. **`notBefore` is a new optional `input.accepted` payload field**
   (`timeOrNull`), and the loop wakeup is its first producer. Semantics:
   an input whose `notBefore` is in the future must not start a turn
   before that instant; `deadline` keeps its existing meaning. The field
   is source-agnostic in the contract, so a later producer (a scheduled
   channel delivery, say) inherits it without another schema change.
   Delivery metadata belongs in the payload — the `deadline`/`admissionRef`
   precedent — which keeps the pump's deferral decision and every
   list/cancel read journal-only. The alternative, carrying the fire time
   inside the `managed-input` envelope, avoids the contract change but
   puts a Store read on the deferral path and hides the fact from
   journal-only consumers; it is rejected. The closed schema grows by one
   optional field (`EVENT_SCHEMAS`, the `managed-event-envelope-v1` schema
   and fixtures, the `managed-session-store-v1` fixtures), replayed by
   TypeScript and Java alike; existing producers omit it and every
   existing fixture stays byte-identical.
3. **The pump defers, it does not poll.** `next()` skips inputs whose
   `notBefore` is in the future, picks the oldest _due_ wake input, and
   reports the earliest future `notBefore` it skipped; the scheduler arms
   exactly one timer at that instant instead of its 500 ms retry cadence.
   A kick (a new arm, a cancel, a load) re-evaluates. Not-yet-due loop
   inputs never block a due monitor/channel/automation input behind them:
   deferral is per input, not a head-of-line park. `pendingSessionInputs`
   passes `notBefore` through so the pick stays one journal read.
4. **Admission enforces the local semantics, atomically.** The delay is
   clamped to `[60, 3600]` s with the 1200 s non-finite default; the prompt
   must be non-empty, at most 10000 characters, and its wrapped envelope
   at most `MANAGED_AUTOMATION_LIMITS.maxInputBytes` (64 KiB). At most one
   unfired loop input per Session — one pending input with no prior
   attempt. An arm replaces such an input in the same transaction that
   commits the new one (the replaced input's `turnId` settles `cancelled`
   with stop reason `loop_replaced`), under the same `wakeHasPriorAttempt`
   guard as the close path. An input whose turn already started is never
   replaced: the normal continuation arms during the firing turn, whose
   input stays pending until `turn.settled` consumes it — locally the
   fired wakeup leaves the pending map at fire time, and the journal
   model reproduces that by leaving the firing input to settle naturally
   while the new input coexists with it. The chain anchor is the
   `occurredAt` of the Session's first committed `loop` input — derived
   from the journal, stable across restarts; a cancel does not reset it.
   An arm whose fire time (`now + clampedDelay`) exceeds the anchor plus
   24 h is refused, and the unfired replacement is dropped in the same
   decision, so a rejected re-arm leaves no unfired wakeup pending — the
   local drop-before-check rule, made atomic by the transaction; a firing
   input is never dropped. The turn-result's fixed `turn:<turnId>` event
   id is a second reason an early settle is unlawful: it would collide
   with the running turn's own settle.
5. **Firing is an ordinary text turn; continuation is the model's job.**
   The existing `runTurn` path delivers the envelope text under the
   input's `turnId`; `turn.settled` consumes the input. The loop continues
   only if that turn arms another wakeup. A crash inside the loop turn
   rides the existing wake aftermath (`failed` with `outcome_unknown`
   where the journal cannot prove either way); nothing re-arms
   automatically, so a crashed tick ends the loop unless a later turn
   revives it.
6. **An overdue wakeup fires once late.** A restart re-derives the pending
   set from the journal; a `notBefore` in the past is due immediately.
   There is no catch-up count to keep: at most one unfired wakeup is ever
   pending, and it fires at most once because its turn consumes it. The chain
   budget is checked at arm time, so a wakeup armed within budget may
   fire past the 24 h mark — the local contract reads the same way.
7. **Cancel is a journal-only consume, routed by `cron_delete`.** A
   `loop:<wakeupId>` id passed to `cron_delete` settles the pending
   input's `turnId` `cancelled` with stop reason `loop_cancelled`, under
   the same `wakeHasPriorAttempt` guard as the close path: a wakeup whose
   turn already started belongs to recovery and the cancel is refused.
   The answer is idempotent — an id that is not pending answers "not
   cancelled", mirroring `cancelWakeup`'s boolean. `/loop clear` rides
   the skill's existing `cron_list` + `cron_delete` routing and cancels
   the single unfired pending wakeup. The close path adds `loop` to its
   model-free settle sources, settling the unfired pending `loop` input
   (the `wakeHasPriorAttempt` filter excludes a firing one). A firing loop
   turn is not settled model-free: the close aborts it and the existing
   wake recovery aftermath settles it, exactly as for any started wake
   turn — a second `cancelled` line on a turn that ran would collide with
   its fixed `turn:<turnId>` settle (decision 4). Together these leave no
   pending `loop` input stranded as `hosted_turn_recovery_required` at the
   next open.
8. **The tool surface is `loop_wakeup` plus the shared cron
   list/cancel.** `loop_wakeup` is declared by new revisions of the
   write-capable profiles, following the `files/3` precedent that added
   `todo_write`. A profile revision is a persisted vocabulary, so each
   slice ships its own: the
   [fixed-interval sibling](2026-11-10-managed-loop-schedule.md) pins the
   next revisions for its cron trio, and this slice takes the revisions
   after them (numbering assigned at landing, in landing order);
   whichever slice lands first declares `cron_list`/`cron_delete`, and
   this slice extends them to the union — `cron_list` adds the pending
   unfired loop input (id, fire time, prompt), `cron_delete` routes
   `loop:<wakeupId>` to the cancel of decision 7. There is no `loop_list`
   or `loop_cancel`: the local tools already cover both kinds, and the
   skill's `allowedTools` stay unchanged. The read profile never
   declares `loop_wakeup`. A deployment gate,
   `qwen.managed-agent.loop.enabled`, defaults to false until the
   acceptance evidence lands, mirroring the automation opt-in history.
   It is a process-scoped Harness contract, not a control-plane settings
   key: the deployment enables it by setting
   `QWEN_MANAGED_AGENT_LOOP_ENABLED=true` in the Harness environment.
   The gate alone does not select the tool surface: the session must also
   run on the `hosted-workspace-shell/3` profile, which the Harness
   advertises through `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` (the profile
   list must include `hosted-workspace-shell/3`).
   The gate gates arming only: with it off, `loop_wakeup` is refused,
   but an already-armed wakeup survives — the pump delivers journal
   inputs regardless of tool declarations — and `cron_list`/`cron_delete`
   still list and cancel it. Because that cancel is a model-called tool,
   an operator also has a non-model path: the control plane's internal
   Session route settles the pending loop input journal-only, independent
   of the tool surface and the gate. Turning the feature off therefore
   never strands what it already scheduled.
9. **Arm-time classifier review replaces the interactive dialog.** The
   local tool returns `'ask'` so the AUTO classifier vets the continuation
   prompt; a Hosted Session has no interactive approval, so the funnel
   submits the same classifier input (`delaySeconds`, `prompt`, `reason`)
   at arm time through the Hosted permission classifier, and an explicit
   deny rule refuses the arm in every mode. The verdict is recorded in the
   arm's `managed-admission` resource. Scheduling future model input keeps
   the scrutiny the local tool's comment demands; nothing fires that was
   not admitted. For a sentinel arm the admitted value is the constant, so
   decision 1's fire-time expansion re-reviews the resolved content when it
   differs — the admission gate covers what actually runs, not only the
   sentinel.
10. **The budget is structural, not a new quota table.** One unfired
    wakeup (decision 4), a 24 h chain (decision 4), the prompt and
    envelope bounds (decision 4), and the deployment gate (decision 8)
    are the whole budget. No definition quota is consumed because no
    definition exists; the Session's existing turn and tool budgets price
    each fired tick like any other turn, including a fire-time re-review
    (decision 1) — which only runs when the resolved content changed, not
    on every steady-state tick.

## The pipeline, step by step

| Step | Where                      | Commit                                                                                                                                                                                                                                           |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `loop_wakeup` (the funnel) | classifier review; `managed-input` + `managed-admission` published; one transaction: replaced unfired input's `cancelled` settle (if any) + `input.accepted` (`loop`, `notBefore`) + `wake.requested`; answers id, fire time, clamp, replaced id |
| 2    | wake pump                  | no commit; `next()` skips the not-yet-due input, one timer armed at the earliest `notBefore`                                                                                                                                                     |
| 3    | wake pump `runTurn`        | an ordinary text turn under the input's `turnId`; `turn.settled` consumes the input                                                                                                                                                              |
| 4    | the fired turn             | another `loop_wakeup` (back to step 1) or none — the loop ends                                                                                                                                                                                   |
| 5    | `cron_delete` (loop id)    | the pending input's `cancelled` settle (`loop_cancelled`), no prior attempt; idempotent                                                                                                                                                          |
| 6    | close path                 | model-free `cancelled` settle (`session_closing`) for the unfired pending loop input; a firing loop turn is aborted and settled by the wake recovery aftermath, not a model-free line                                                            |
| 7    | load after a restart       | no commit; the pending set is re-derived, an overdue wakeup is due immediately                                                                                                                                                                   |

## Contract touchpoints

- `packages/core/src/managed-runtime/managed-session-records.ts`:
  `EVENT_SCHEMAS['input.accepted']` gains the optional `notBefore`
  (`timeOrNull`); the payload rule accepts it for every source.
- `packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.schema.json`,
  `managed-event-envelope-v1.fixtures.json`,
  `managed-session-store-v1.fixtures.json`: the optional field and a
  `loop`-source witness; existing fixtures unchanged.
- The Java fixture replay (`ManagedEventEnvelopes` digests the whole
  event, so the new field rides the existing digest path; the replay test
  proves both hosts agree).
- `packages/cli/src/serve/hosted-wake-intake.ts`: `PendingSessionInput`
  passes `notBefore` through.
- `packages/cli/src/serve/hosted-monitor-wake.ts`: the `next()` contract
  gains the deferral signal; one timer at the earliest `notBefore`.
- `packages/cli/src/serve/hosted-harness-session.ts`: `isWakeInputSource`
  admits `loop`; the pump's pick honors `notBefore`; the close path's
  settle sources gain `loop`.
- A new `hosted-loop-session.ts` funnel (the `HostedAutomationSession`
  shape): arm, the fire-time sentinel expansion, and the cancel routed
  from `cron_delete`, serialized with the journal.
- `packages/cli/src/serve/hosted-workspace-profiles.ts` and the Hosted
  tool turn: the new profile revisions and `loop_wakeup`'s declaration,
  plus the union extension of `cron_list`/`cron_delete` shared with the
  sibling slice.
- The managed loop skill variant (shared with the sibling slice):
  `allowedTools` unchanged; the skill asset is a touchpoint of both
  designs.
- `packages/cli/src/serve/capability-parity.ts`: entries for the loop
  surface and the gate; the stale `scheduled_task_gate` entry is
  corrected separately (the managed automation gate shipped on
  2026-10-22).
- The deployment gate (a process-scoped Harness environment contract, not
  a control-plane settings key): `QWEN_MANAGED_AGENT_LOOP_ENABLED`.

## Validation plan

- Fixture parity: both hosts replay the extended envelope and store
  fixtures identically; every pre-existing fixture stays byte-identical.
- Admission matrix: 59 s clamps to 60, 3601 s to 3600, non-finite to
  1200; an empty prompt, a 10001-character prompt, and a wrapped envelope
  over 64 KiB are each refused.
- Chain: the anchor is the first committed `loop` input; an arm at the
  24 h boundary is admitted, one past it refused _and_ the unfired
  pending wakeup dropped (the atomicity witness); a cancel does not
  reset the anchor; a restart preserves it.
- Replacement: a second arm consumes the unfired first input
  (`loop_replaced`) and exactly one unfired input stays pending; an arm
  during the firing turn leaves the running turn's input untouched and,
  after the turn settles, exactly the new input remains pending; a
  rejected re-arm leaves no unfired input, and never drops a firing one.
- Pump, on a fake clock: a 3600 s wakeup arms one timer and costs no
  500 ms polls; a due monitor input behind a not-yet-due loop input runs
  first; an arm or cancel kick re-evaluates the deferral; a transient
  envelope read fault retries on the existing cadence.
- Restart: a pending wakeup survives a Harness kill and fires exactly
  once after reload, late; a wakeup whose turn already started goes to
  recovery, never a second fire.
- Crash inside the loop turn: the aftermath settles it
  `failed`/`outcome_unknown`; no wakeup is re-armed automatically.
- Sentinels: a `loop.md` sentinel expands at fire time from the current
  file, so a change between arm and fire is picked up; after a restart
  or compaction the full guidance is re-provided; unchanged content
  delivers the short reminder; an absent file delivers the autonomous
  tick (no throw, no empty prompt); a transiently unreadable file
  delivers the no-op re-arm tick; the autonomous sentinel expands
  without a file. A 100 KB `loop.md` fires a truncated, warned input
  capped at `LOOP_TASK_FILE_MAX_BYTES`. An untrusted workspace's
  `.qwen/loop.md` yields the absent-file tick, not its content.
- Sentinel admission: arming `<<loop.md-dynamic>>` then changing the file
  before the fire re-reviews the resolved content rather than executing
  it unreviewed; a denied re-review settles the input `cancelled`
  (`loop_admission_denied`); steady-state unchanged content is not
  re-reviewed on every tick.
- Cancel: a `loop:<wakeupId>` id routes through `cron_delete`;
  idempotent; refused once the turn has a prior attempt; `/loop clear`
  consumes the single unfired pending wakeup. With the gate off, an
  armed wakeup still fires and stays listable/cancellable (including via
  the operator's internal route), while a new arm is refused.
- Close: the unfired pending loop input settles model-free; a firing loop
  turn is aborted and settled by the wake recovery aftermath (no second
  `cancelled` line); the next open is not wedged.
- Classifier: a deny rule refuses the arm; the admission resource
  records the verdict.
- Mutation checks: each decision's guard disabled in turn fails a test
  (the deferral skip, the replacement settle, the drop-before-check, the
  chain anchor, the prior-attempt guards on cancel and replacement, the
  fire-time expansion, the gate-off cancel path, the gate).

## Acceptance criteria

- A Managed Session with a loop profile arms a wakeup, the Harness
  restarts before it is due, and the wakeup fires exactly once after
  reload.
- At most one unfired loop input (no prior attempt) is pending per
  Session at any time; a rejected re-arm leaves none, and an arm during
  a firing turn never cancels the running turn's input.
- No loop operation creates a `schedule` record, an `automation_run`
  record, or a control-plane scanner row.
- A 3600 s wakeup costs one timer, not a poll cadence.
- An armed wakeup survives the deployment gate going off and stays
  cancellable through `cron_delete`.
- A `loop.md` sentinel fire reads the current file, capped and warned; an
  untrusted workspace's file is not read; changed content is re-reviewed
  before it runs.
- The clamp, default, chain cap, replacement, and cancel answers match
  `CronScheduler.scheduleWakeup`'s contract.
- Both hosts replay the extended fixtures identically.

## Open questions

1. **Chain anchor scope.** The local anchor resets on `stop()` (which a
   cron reload also triggers); the proposed journal anchor is
   per-Session and never resets. A Hosted Session can outlive a TUI
   session by days: 24 h after its first loop input, no new loop could
   arm even though the previous one ended long ago. Confirm the stricter
   reading, or adopt a journal-derivable reset — for example, an arm that
   finds no live loop (no unfired pending input and no firing loop turn)
   starts a new chain. Note the tension explicitly: such a reset is a
   property of starting a new loop at arm time, not of the cancel itself,
   but a cancel that ends the loop would let the next arm start a new
   chain — so adopting it supersedes decision 4's "a cancel does not reset
   the anchor" reading. The bypass also needs a non-loop turn: inside a
   firing loop turn a live loop always exists, so the reset cannot fire
   there — a model-driven cancel-then-arm restarts the 24 h budget only
   from an ordinary turn. Name the rule, and which reading it replaces,
   before implementation.
2. **Profile revision numbers.** Landing first, this slice takes
   `hosted-workspace-shell/3`, skipping the `shell/2` retired by the
   unified Shell lifecycle (#15330); the
   [fixed-interval sibling](2026-11-10-managed-loop-schedule.md) swaps to
   the later revision per its landing-order note. The control plane's
   canonical Shell admission recognizes `shell/3` as a public Shell on
   lifecycle protocol 2 (`WorkspaceToolProfiles.isPublicShell`), landed
   with this slice; the retired `shell/2` stays refused.
3. **Gate default timeline.** False until the acceptance evidence lands,
   then true by default like `qwen.managed-agent.automation.enabled`;
   confirm the enablement order with the deployment owners.
