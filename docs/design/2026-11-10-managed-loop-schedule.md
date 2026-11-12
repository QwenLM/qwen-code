# Managed loop schedules (the fixed-interval arm of /loop)

[English](2026-11-10-managed-loop-schedule.md) | [简体中文](2026-11-10-managed-loop-schedule.zh-CN.md)

Status: in implementation. The self-paced wakeup sibling landed first
with `hosted-workspace-shell/3`, so this slice takes the next revisions
(`hosted-workspace-files/4`, `hosted-workspace-shell/4`,
`hosted-workspace-team-lead/2`) per the landing-order note in decision 8.
This is the fixed-interval arm of
`/loop` support for Managed Sessions, the sibling of the
[self-paced wakeup design](2026-11-10-managed-loop-wakeup.md). It creates
[H6 automation definitions](2026-10-04-managed-automation.md) from inside
the Session through the
[H6b/H6c runtime](2026-10-07-managed-automation-runtime.md)'s existing
machinery; it adds no scheduler, no journal event kind, and no payload
field.

## Problem

`/loop`'s fixed-interval path (a leading interval token or a trailing
"every" clause, per `packages/core/src/skills/bundled/loop/SKILL.md`)
converts the interval to a five-field cron expression and calls
`cron_create` with `recurring: true`, then runs the prompt immediately;
`/loop list` and `/loop clear` ride `cron_list` and `cron_delete`. In the
daemon these tools drive the local `CronScheduler`, whose durable tasks
live in a daemon-local file.

A Managed Session cannot run this path: the Hosted tool profiles declare
no cron tools, and the local scheduler is forbidden from firing Managed
work (H6 runtime decision 14). H6 already has everything a recurring
schedule needs — definitions, the single-claim scanner, the run ledger,
overlap and catch-up policies, the gate probe, and the persistent fire
that wakes the bound Session — but definitions can only be created
through the control plane's public routes by the Session's creator. The
model inside the Session has no way to create one.

The gap is therefore an entry path, not a mechanism: a Session-side tool
that creates, lists, and retires H6 definitions with the same authority,
idempotency, and scanner discovery the public routes have.

## Current state

The facts below are from this repository at `488845a4a81`.

- **The create flow is control-plane-owned**
  (`ManagedAutomationService.java`). `create` checks the creator
  (`requireCreatorSession`) and the deployment gate (`requireEnabled`),
  derives `scheduleId` from the tenant and the `Idempotency-Key`, checks
  the per-Session capacity (`MAX_DEFINITIONS`), claims the command row
  (`claimCommand`), relays `define_schedule` to the Harness funnel,
  mirrors the committed definition (`committedDefinition`), and settles
  the command (`remember`). `update` and `retire` claim before the relay
  the same way; retiring a retired definition is its own replay, and a
  Session that is not ACTIVE retires locally as the fallback. Only
  `PRE_COMMIT_REFUSALS` (`automation_mode_disabled`,
  `automation_gate_unsupported`, `automation_gate_invalid`) release a
  claimed key; every other answer keeps the binding.
- **The scanner reads the mirror, not the journal.** `AutomationScanner`
  discovers due definitions from the ledger's `ScheduleRow`s. A
  definition committed only into the Session journal — a direct
  `define_schedule` call that bypasses the control plane — has no mirror
  row and never fires. The journal remains the only business fact; the
  mirror is the rebuildable index the scanner reads (H6b decision 12).
- **The Harness funnel** (`hosted-harness-session.ts`,
  `POST /session/:id/automations/operations`) maps `define_schedule`,
  `retire_schedule`, and `fire_run` onto `HostedAutomationSession` acts,
  replay-safe by derived command ids. A persistent fire commits the run's
  dispatch together with its input and wake in one transaction; the
  embedded wake pump runs it as an ordinary turn, and the turn settles
  the run (H6c).
- **An internal Session-scoped channel already exists.** The Harness
  reaches the control plane at
  `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` under
  `/internal/managed-session-store/v1/sessions/{sessionId}`, authenticated
  with the writer binding (`WRITER_TOKEN_HEADER`).
  `ManagedMemorySessionController`'s `memory:query` is the precedent for a
  Session-scoped operation on that channel, called by a Hosted tool.
- **Tool executions have a durable identity.** The managed tool executor
  journals each invocation under its `executionCallId` and replays its
  receipt; a re-driven execution keeps the same id.
- **The managed limits and grammar** (`managed-automation-operations.ts`,
  `managed-automation-record.ts`): `maxPromptBytes` and `maxInputBytes`
  are 64 KiB, `maxCronBytes` 400, `maxDefinitionsPerSession` 32; the cron
  is five fields of digit/range/list/step atoms under Vixie day
  semantics, and the IANA timezone resolves at admission
  (`automation_timezone_unknown`). The gate probe shipped on 2026-10-22
  and shares `gateCommandError` with the daemon's scheduled-task gate.
- **The local tool's contract** (`cron-create.ts`, `cronScheduler.ts`):
  `recurring` may be false (a one-shot), `durable` defaults to
  session-only, and recurring durable jobs auto-expire 7 days after
  creation (`DEFAULT_RECURRING_MAX_AGE_DAYS`). Hosted skills ride the
  Session Skills publication (the `managed-agent-skills` resource); the
  local `BundledSkillLoader` hides skills whose `allowedTools` start with
  `cron_` when cron is disabled — the visibility-gating precedent.

## Goals

- Run `/loop`'s fixed-interval path, `/loop list`, and `/loop clear` in a
  Managed Session, creating H6 definitions the scanner discovers and
  fires through the existing persistent pipeline.
- Keep the public routes' authority and idempotency: creator-scoped
  mutations, claimed keys, replay-safe retries, capacity and gate checks.
- Give the model a tool surface whose names match the skill's
  `allowedTools`, so the skill's parsing and interval-to-cron table ride
  unchanged.
- Add no scheduler, no journal event kind, and no payload field.

## Non-goals

- **The self-paced arm.** `loop_wakeup` and its journal-durable one-shot
  are the [sibling design](2026-11-10-managed-loop-wakeup.md).
- **One-shot schedules.** The legacy `recurring: false` has no H6
  representation; it is refused, not emulated.
- **`per_run` targets and channel delivery.** H4/H5 own them; every
  definition this slice creates is `persistent`, bound to its own
  Session.
- **A Web Shell scheduling UI.** The public read routes already serve it.
- **Changing the scanner, the funnel, or the fire pipeline.** This slice
  is an entry path onto them.

## Decisions

1. **The tools keep the legacy names, with Managed semantics.**
   `cron_create`, `cron_list`, `cron_delete` are declared by the Hosted
   profiles with Managed descriptions, the way `write_file`/`edit` carry
   profile-specific text today. The skill's `allowedTools` and its
   interval-to-cron conversion then ride unchanged; only the durable and
   expiry wording in the managed skill variant differs. The union
   list/cancel surface (decision 6) keeps the `list`/`clear` subcommands
   working without a whitelist change.
2. **Mutations go through the control plane, never the funnel alone.** A
   new internal route family under the store prefix —
   `automations:create`, `automations:list`, `automations:retire` on
   `/internal/managed-session-store/v1/sessions/{sessionId}` —
   authenticates with the writer binding exactly as `memory:query` does,
   derives the actor from the bound Session's creator, and delegates to
   `ManagedAutomationService`. The internal routes are Session-scoped, not
   actor-scoped: `create`'s target is the bound Session; `list` filters
   to the bound Session before pagination — the service's actor-scoped
   `list` reads every definition the creator can read across the
   Workspace, which would let one Session's writer see another's;
   `retire` verifies the target definition belongs to the bound Session
   before it executes or answers a replay. The creator actor alone does
   not provide this isolation: the same user may create several
   Sessions. This scoping is a carve-out for the internal routes only —
   the public controller calls the same service with no bound Session and
   keeps its actor scope, so the change must not regress the public API.
   The scoping lives inside the service/ledger, where filtering happens
   before the page limit and the `next` cursor is derived from the
   filtered stream — a controller-side post-filter would cut the page
   first and return a wrong cursor. The internal `list` uses a page size
   that covers the per-Session capacity (the ledger's 100-row cap), so a
   full Session fits one page. The delegation inherits the creator check,
   the mode gate, the capacity check, the command ledger, and the mirror
   write. The deployment gate gates creation and also halts the scanner
   (`AutomationScanner.scan` returns early on the same setting), so
   already-armed definitions stop firing while the gate is off. `list` is
   ungated today and stays available; `retire` calls `requireEnabled`
   today, so the slice ungates it for the internal route (a code change,
   not existing behaviour) so an operator can retire what the gate
   stopped. A direct funnel call is refused as a creation path: a
   journal-only definition has no mirror row, so the scanner would never
   fire it — the route, not the funnel, is what makes a definition
   discoverable.
3. **The Idempotency-Key derives from the tool execution's identity.**
   Each mutation uses a key derived from its `executionCallId` and verb
   (for example `loop:<executionCallId>:create`, within the key's 1–128
   printable-ASCII bound). A re-driven execution whose receipt was lost
   reuses the key, so the control plane replays
   the committed definition instead of minting a second one; a retry
   never mints a fresh key. The tool executor's journal owns
   at-most-once execution, and the derived key extends that guarantee
   across the control plane without new state.
4. **The parameter contract maps onto the definition, refusing what H6
   cannot represent.** `recurring` must be true — a one-shot is refused
   with a typed message. `durable: false` is refused: a Managed
   definition is always durable, and silently accepting the flag would
   promise a session-only lifetime the platform does not have; omission
   means durable. `timezone` is an optional IANA name defaulting to UTC,
   resolved at admission as every definition's is. The prompt obeys
   `maxPromptBytes` and the wrapped-input bound; the cron obeys
   `maxCronBytes` and the H6a grammar. An optional `gate` passes through
   to the definition, validated by the shared `gateCommandError`.
   Arm-time classifier review is a new requirement for model-created
   definitions, not something the managed gate design already specifies
   — that design's author-approval path has no classifier. The
   classifier input covers both the continuation prompt and the gate
   command, following the sibling design's decision 9 pattern.
5. **No auto-expiry in this slice.** The legacy 7-day expiry has no
   definition field; a tool-created definition persists until retired,
   exactly like one created through the public API. The budget is the
   per-Session capacity, the per-fire turn pricing, and the gate probe
   that makes a quiet watch cheap. The parity gap is recorded as an open
   question, not hidden: the managed skill variant tells the user the
   schedule runs until cancelled.
6. **List and delete cover both arms, as locally.** `cron_list` answers
   the union: the bound Session's definitions from the control plane
   ledger — the same rows the scanner reads — plus the pending unfired
   loop input from the journal, once the wakeup slice has landed. This
   design owns the union contract; the wakeup sibling references it rather
   than restating it. The internal `list` returns a full Session in one
   page (decision 2's capacity-covering page size), but the public list
   defaults to 20 rows while a Session may hold 32 definitions, so
   `cron_list` walks every page before answering regardless (the single
   journal wakeup rides alongside the last page); the unchanged skill
   `clear` recipe — list, then delete every returned id — therefore drains
   the whole Session. `create` mirrors before it answers, so a list after
   a create is consistent. `cron_delete` routes by id: a
   definition id retires (the relay commits the terminal journal
   revision and the mirror retires with it; retiring a retired
   definition answers the replay, and a Session that is not ACTIVE takes
   the inherited local-retire fallback); a `loop:<wakeupId>` id cancels
   the wakeup through the sibling slice's journal-only consume, under
   its prior-attempt guard. `cron_list` renders the wakeup id exactly as
   `cron_delete` accepts it (`loop:<wakeupId>`), so the id fed straight
   from list into delete cancels the wakeup — the local shape, where
   `cron_list` lists wakeups (`@wakeup`) and `CronScheduler.delete` falls
   through to `cancelWakeup`, with the prefix produced by list and
   consumed by delete. The skill's `list`/`clear` subcommands ride
   unchanged.
7. **Firing rides the existing pipeline unchanged.** A due slot becomes
   an `automation_run`, its input and wake commit in one transaction,
   the wake pump runs the turn, and the turn settles the run — overlap
   policies, open-Turn suppression, catch-up, and the gate probe all
   apply as they do for a public-API definition. The skill's immediate
   first run is the current turn; no mechanism is added for it.
8. **The tool surface ships on the next profile revisions.**
   `hosted-workspace-files/4`, `hosted-workspace-shell/4`, and
   `hosted-workspace-team-lead/2` declare the cron trio, following the
   `files/3` precedent. The wakeup sibling landed first and took
   `hosted-workspace-shell/3` (declaring `loop_wakeup` plus
   `cron_list`/`cron_delete`), so this slice's Shell revision is the next
   one, `shell/4`, which inherits `loop_wakeup` and adds `cron_create`;
   `files/4` and `team-lead/2` declare the cron trio without
   `loop_wakeup`. `shell/2` is
   deliberately skipped: it is a retired identifier, withdrawn by the
   [2026-10-23 Shell profile design](2026-10-23-managed-shell-profile.md)
   and pinned dead by regression tests, and re-minting it would invert
   them. Admission requires `qwen.managed-agent.automation.enabled` for
   `cron_create`; `cron_list` and `cron_delete` stay declared and usable
   with the gate off (decision 2). The read profile never declares them.
   Tool names are the persisted vocabulary, behavior may grow: this
   slice extends the already-declared `cron_list`/`cron_delete` to the
   union of decision 6 (definitions plus the pending wakeup). The managed
   loop skill variant ships as a skill asset through the existing
   Session Skills publication with the same `allowedTools` as the
   bundled skill; its visibility is gated with the tools, mirroring the
   local `BundledSkillLoader` rule that hides `cron_` skills when cron
   is off.
9. **Failure semantics split retryable from terminal.** A transport
   fault or a 503 leaves the tool execution pending; the re-drive derives
   the same key and meets the claim or the replay. The
   `PRE_COMMIT_REFUSALS` and every other definitive 4xx (capacity,
   conflict, grammar, timezone) are terminal tool errors carrying the
   typed code; the service releases the key only for the pre-commit
   refusals, exactly as the public route does. A committed definition
   whose answer was lost is answered by the replay, never re-created.
10. **The budget is inherited, not new.** The 32-definition per-Session
    capacity, the per-fire turn and tool pricing, and the gate probe are
    the whole budget; no quota table is added. A forgotten loop is
    visible in `cron_list` and cancellable with `cron_delete`, and its
    definitions are the same ledger rows an operator already manages.

## The pipeline, step by step

| Step | Where                              | Commit                                                                                                                                                                                                                            |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `cron_create` (the tool execution) | the executor journals the intent under `executionCallId`; the internal `automations:create` route claims the derived key, relays `define_schedule`, mirrors the definition, settles the command; the tool answers the schedule id |
| 2    | the skill's immediate first run    | the current turn — no new mechanism                                                                                                                                                                                               |
| 3    | scanner tick                       | the mirror row's due slot becomes an occurrence; `fire_run` commits the run, its input and wake; the wake pump runs the turn; the turn settles the run                                                                            |
| 4    | `cron_list`                        | the internal `automations:list` route walks every ledger page and adds the pending unfired wakeup; the tool answers the full union, each wakeup id rendered as `cron_delete` accepts it                                           |
| 5    | `cron_delete`                      | a definition id relays `retire_schedule` and retires the mirror (a retired id answers the replay); a `loop:<wakeupId>` id routes to the sibling slice's journal-only cancel                                                       |
| 6    | a re-driven execution              | the same `executionCallId` derives the same key; the control plane answers the replay, never a second definition                                                                                                                  |

## Contract touchpoints

- A new internal controller (the `ManagedMemorySessionController` shape)
  for the three verbs, authenticated by the writer binding
  (`X-Qwen-Managed-Writer-Token` + `workspaceId`/`writerId`/
  `writerGeneration` via `authorizeOrdinary`), with `SurfaceRegistry`
  entries (`Surface.INTERNAL`, `RuleClass.INTERNAL_WRITER`, new
  capabilities), the regenerated `managed-surface.txt` fixture, and
  `SurfaceRegistryGateTest`'s exact handler↔registry bijection. There is
  no internal OpenAPI file: the public contract walk
  (`ManagedAgentApiContractTest`) skips `/internal/`, so the registry +
  fixture + gate tests are the internal surface's contract pins. The
  internal routes have no user principal (`TenantContext.actorId` is
  null); the creator actor is derived from `ma_session.creator_actor_key`.
- `ManagedAutomationService`: the controller derives the creator actor
  and delegates; the internal routes' list/retire become Session-scoped
  inside the service/ledger (filter before the page limit, correct `next`
  cursor, capacity-covering page size) as a carve-out that leaves the
  public actor-scoped routes unchanged. `retire` is ungated for the
  internal route (it calls `requireEnabled` today — a code change);
  `list` is already ungated; creation stays gated.
- `packages/cli/src/serve/hosted-workspace-profiles.ts` and the Hosted
  tool turn: the new profile revisions (skipping the retired `shell/2`)
  and the cron trio's declarations and execution wiring, calling the
  internal routes over the existing store channel (`baseUrl` + writer
  binding). Shell identity is not centralised: the profile predicates
  (`isHostedWorkspaceShellProfile` and friends), the admission paths that
  compare the literal `hosted-workspace-shell/1`, and the control plane's
  canonical Shell admission must all recognise `shell/4`, or a `shell/4`
  Session loses the shell lane, child-agent and foreground-only
  admission. The unknown-profile fixtures that list `files/4` flip in the
  same change.
- The managed loop skill variant as a skill asset in the Session Skills
  publication.
- `packages/cli/src/serve/capability-parity.ts`: entries for the cron
  trio's Managed standing.
- No journal schema change: no new event kind, no new payload field.

## Validation plan

- Internal-route admission: the writer binding is required; a foreign
  Session or tenant is refused; the actor is the bound Session's
  creator; the deployment gate off refuses create but not list/retire.
- Session isolation: same tenant, same creator, two Sessions — one
  Session's writer neither lists nor retires the other's definitions,
  and create's target is always the bound Session. Page semantics: a
  bound Session owning 32 definitions among others returns all 32 on the
  first page with no further cursor.
- Replay: a re-driven execution with the same `executionCallId` answers
  the same `scheduleId` with the replay mark; a different body under one
  key answers the conflict.
- Scanner discovery: a tool-created definition fires at its next due
  slot; a journal-only definition (a direct funnel probe with no mirror
  row) never fires — the witness that the mirror is load-bearing.
- Parameter matrix: a one-shot, `durable: false`, an unresolvable
  timezone, a grammar-invalid cron, an over-bound prompt, and an invalid
  gate are each refused with their typed code; a valid gate rides the
  definition and the fire.
- List-after-create consistency; delete idempotency; the not-ACTIVE
  Session's local-retire fallback.
- Union surface (with the wakeup slice landed): `cron_list` returns the
  definitions plus the pending unfired wakeup; the id `cron_list` emits
  fed straight into `cron_delete` settles the pending loop input
  `cancelled`/`loop_cancelled`; a definition id retires. With 21+
  definitions, `cron_list` returns every id and `/loop clear` leaves zero
  live definitions.
- Profile admission: the retired `hosted-workspace-shell/2` stays
  refused; a `hosted-workspace-shell/4` Session keeps the shell lane,
  child-agent and foreground-only admission; the unknown-profile fixtures
  that list `files/4` flip in the same change that admits it.
- Failure split: a 503 re-drives with the same key; a pre-commit refusal
  releases the key; a lost answer replays.
- Skill E2E: `/loop 5m …` creates the definition and runs the prompt
  immediately; `/loop list` shows it; `/loop clear` retires it.
- Mutation checks: each decision's guard disabled in turn fails a test
  (the mirror write, the derived key, the one-shot refusal, the durable
  refusal, the creator derivation, the Session scoping, the gate-off
  list/retire, the gate).

## Acceptance criteria

- `/loop 5m …` in a Managed Session creates a definition the scanner
  fires at the next due slot, and the fire arrives as an automation turn
  in the same Session.
- A re-driven tool execution never creates a second definition.
- A definition committed only into the journal never fires: the internal
  route, not the funnel, is the creation path.
- `/loop list` and `/loop clear` work against tool-created definitions
  and, with the wakeup slice landed, the pending wakeup.
- One Session's writer cannot list or retire another Session's
  definitions, even under the same creator.
- No new journal event kind or payload field; no second scheduler.

## Companion follow-ups (same PR)

Two small wakeup-slice follow-ups land with this slice rather than as a
separate change:

1. **notBefore-aware wake-recovery exemption.** The control plane's
   `WakeRecovery.scan` attaches the Harness (`recoverForWake`) for any
   Session whose journal proves a pending wake input.
   `JdbcWakeRecoveryStore.hasPendingInput` counts every unsettled
   `input.accepted` whose source is in `SOURCES` (which already includes
   `loop`), regardless of `notBefore`. A Session whose only pending input
   is a not-yet-due loop wakeup is therefore re-attached prematurely on
   every recovery scan. The fix: when the pending input is a `loop`
   `input.accepted` carrying a future `notBefore`, do not count it as
   pending (it is deferred, not parked); a due or immediate loop input
   still counts. The exemption needs a clock reference in the store and
   a `WakeRecoveryTest` pair (future-only loop input → no attach; due
   loop input → attach).
2. **Fire-time sentinel Java fixture replay parity.** The journal-replay
   proof in `JdbcWakeRecoveryStore` must recognize the loop sentinel
   inputs the wakeup slice writes, with a fixture test replaying a
   journal that carries a sentinel loop input (and its `notBefore`) so
   the Java projection stays in parity with the Harness's fire-time
   expansion. This is the same `hasPendingInput`/`isWakeInput` domain as
   follow-up 1 and is pinned alongside it.

## Open questions

1. **Auto-expiry parity.** The legacy 7-day expiry protects against a
   forgotten loop; this slice ships without it. Decide whether a later
   definition field (`expiresAt`) is worth the contract change, or
   whether operator-visible ledger rows plus the gate are enough.
2. **Timezone default.** UTC is proposed; confirm whether the skill
   variant should resolve the user's zone instead, and from where.
3. **One-shot support.** The legacy `recurring: false` needs an H6
   contract extension (a one-shot trigger kind); deferred, refused with
   a typed message until then.
4. **Skill asset packaging.** Which AgentBundle ships the managed loop
   variant, and how the skill degrades when only one of the two slices
   has landed, is decided with the bundle's skill admission.
