# Managed Child Agents, Workflows and Teams (H4)

[English](2026-10-04-managed-child-agents.md) | [简体中文](2026-10-04-managed-child-agents.zh-CN.md)

Status: proposed design; nothing in this document is implemented, and no domain it
names is enabled for submission. This is the design for slice H4 of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the
Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
It builds on the task contract of H0a
([design](2026-09-27-managed-agent-task-contract.md)), the record contract of
H0b ([design](2026-09-27-managed-extension-record-contract.md)) and the
authority of H0c ([design](2026-09-27-managed-extension-authority.md)). Below,
"the reference design" is sections 1, 3, 8, 11, 12, 13 and 14 of the
proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md),
whose preamble leaves the field-level contract of child/team resources to its
[automation design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md),
at the commit that #12827 pins.

## Problem

A child agent is an independent execution scope. When it must run longer than a
turn, recover cold, or live in another process, the reference design (section 8)
requires a full child Session, driven by a durable pipeline rather than a
callback:

```text
parent Session commits child_run launch + outbox
  → Java creates the child Session / Runtime binding idempotently
  → child Harness executes and commits the terminal result
  → child result outbox
  → parent acceptChildResult (accepted) + wake
  → parent Harness consumes (consumed)
```

Legacy subagents are in-process: the Agent tool, default-background top-level
subagents ([design](2026-07-16-default-background-subagents.md)), roster
restore ([design](2026-07-22-background-agent-roster-restore.md)) and headless
forks with optional worktree isolation
([design](2026-07-21-headless-fork-subagents.md)) keep completion callbacks,
rosters and results in the parent's process memory. Section 1 of the reference
design is explicit that an in-memory callback, Promise, PID or `notified=true`
flag is not a recovery credential. On the Managed path a Harness can be
replaced and a Runtime reclaimed, so H4 must answer: which committed records
carry a child's launch, execution and result; how a restarted relay tells a
child that exists from one that must be created; when the parent has accepted a
result versus merely received it; how workspaces are isolated; and what happens
to children when the parent closes.

## Current state

The facts below are from `main` at `5ddfacc9d4`.

- **Domain index.** `child_run` and `child_acceptance` are registered in the
  closed v1 domain index of `packages/core/src/managed-runtime/managed-session-records.ts`,
  alongside `team_state`, `team_task`, `team_message` and `team_plan`.
  Registration is not enablement: none of them has a record body in
  `MANAGED_EXTENSION_RECORD_BODIES` (`managed-extension-projection.ts`), none
  is in `MANAGED_SESSION_ENABLED_DOMAINS`, and
  `LocalManagedSessionAuthority.commitExtensionRecord` refuses a domain
  without a body or one that is not enabled. `monitor_run` has a body and
  still stays disabled until H3.
- **Shared run block.** H0b's `run` block (`managed-extension-record/1`)
  already separates the three state lines every child needs: the logical run
  (`reserved → admitted → running/waiting → settled/failed/cancelled/recovery_blocked`),
  the physical execution (`intent → dispatch_started → running_attached → settled/not_started_proven/outcome_unknown/corrupt`),
  and the delivery line. The delivery target `session` has exactly the
  acceptance states a child result needs:
  `planned → accepting → accepted → consumed`, plus `unknown`, `rejected`
  and `cancelled`.
- **Outbox.** H0c derives the outbox from the committed delivery line:
  `planned`, `sending`, `partial`, `accepting` or `unknown` means still to
  send or to reconcile. The Java store materializes it in
  `qwen_managed_session_extension_record` (Flyway V18) in the commit's SQL
  transaction. Nothing reads the outbox yet; H0c assigns the dispatchers to
  H4 and H5.
- **Wake.** H0c decision 2: there is no `WakeIntent` record. A Stage H
  revision may commit a notification input in the same transaction, and the
  authority generates its `input.accepted` plus `wake.requested`, as
  `submitInput` does. The Session inbox (`managed-session-inbox.ts`) is a
  user-message queue, not a wake carrier. A consumer for committed wakes
  does not exist yet (H0c open question 6).
- **Task projection.** The task kinds `child_agent` and `workflow` are
  declared (`MANAGED_TASK_KINDS`) and frozen in the public `TaskKind` enum.
  Task list and detail are served (`partial`, contract v1.19); task events
  and cancel stay `planned` with settled semantics (v1.23).
- **Lifecycle.** D4 made close, archive and delete durable command
  operations (#12881, contract v1.18). Reliable close for Workspace-bound
  Sessions (#13135, V32) moves `ACTIVE → CLOSING` under the public Session
  lock, refuses active Turns with `409 turn_active`, and seals the writer
  last. O4 retirement (#13084, V30) and collection (V34) pin Session-owned
  outputs through close. None of these paths knows about children today.
- **Java bodies.** The Java store materializes only the record bodies it
  knows and passes other `domain.committed` events through (H0c open
  question 7). A body added by H4 must therefore ship on both sides before
  any writer commits the domain.
- **Prerequisites merged.** Verified on this baseline: H0a–H0c (#12855);
  H1 MCP bodies (#12946 and successors, V23) and H2 Hook bodies (#13129,
  V27/V28), both enabled for submission; hosted foreground Shell tool turns
  behind an explicit private profile
  ([design](2026-09-27-hosted-shell-tool-turn.md)); O2 hosted result storage
  (#12894), O3 public result/Artifact projection (V26, contract v1.27) and
  O4-1 retirement (#13084); W0 workspace binding with generation fencing,
  and durable local-process provisioning and trusted reboot recovery that
  are on by default with opt-out flags
  (`runtime-broker.durable-local-process`,
  `runtime-broker.trusted-local-reboot-recovery`; dedicated Linux reboot
  acceptance is still pending, see
  [W0e](2026-09-27-managed-workspace-recovery.md)).

## Goals

- Define the `child_run` and `child_acceptance` record bodies on top of the
  H0b run block, with the identities the pipeline needs (`childRunId`,
  `rootSessionId`, `parentSessionId`, `childSessionId`, `dispatchId`,
  `deliveryId`).
- Commit child terminal, parent accepted and parent consumed as three
  separately observable facts, and make a restarted relay re-send only the
  original result that was never accepted — never create a second child.
- Give the relay idempotent child Session creation and recovery after a
  crash between any two steps of the pipeline.
- Pin one workspace isolation policy for the first slices: a read-only
  snapshot of the parent binding.
- Bind child cancellation and detachment to the durable close path.

## Non-goals

- **Independent-worktree and shared-serialized workspaces.** Section 8 of
  the reference design makes an independent worktree the default for a
  child that writes, and allows a shared workspace only with explicit
  serialization. H4's first slices deliberately defer both: a write-requiring
  launch is refused at admission rather than silently downgraded. The
  worktree lifecycle, its quota, close-time merge policy and Runtime hold
  need their own contract and land in a later H4 slice. Section 8's default
  is hereby narrowed, explicitly, not forgotten.
- **Workflows.** The `workflow` task kind is registered, but a step-graph
  plan, per-step records and step-level recovery are a later slice.
- **Teams and mailbox.** `team_state`, `team_task`, `team_message` and
  `team_plan` are registered domain names only. Section 8 makes a team a
  persistent domain resource under the lead Session's authority, with
  membership, assignment and messaging over outbox/ACK. None of that is
  designed or enabled here.
- **Task events and output streaming to the parent.** `output_cursor` and
  the task events route stay `planned`; a child that must stream output uses
  Artifacts, as every Stage H capability does.
- **Legacy subagent changes.** The in-process Agent tool keeps its current
  behavior; the Managed path is a separate engine selection, and the
  reference design forbids switching engines on a running Session.
- **Cross-tenant or cross-workspace children.** A child Session is created
  in the parent's tenant and workspace binding in these slices.

## Decisions

1. **Two domains, in the two Sessions that own the facts.** The parent
   Session authority commits `child_run`: it is the parent's task, so it
   appears in the parent's `SessionTaskView` with kind `child_agent`. The
   child Session authority commits `child_acceptance`: it is the child's
   durable statement that its terminal result was committed and handed to
   the relay. Splitting the facts this way keeps each Session's journal
   single-writer (H0b/H0c: no second write path) and lets the relay
   reconcile from committed state on both sides instead of trusting either
   process.
2. **Three facts, three lines.** A child reaching a terminal state is the
   `child_acceptance` run becoming `settled`/`failed`/`cancelled` — the
   first fact. The parent accepting the result is the `child_run` delivery
   line reaching `accepted` — the second. The parent's model consuming it is
   the delivery reaching `consumed` — the third. None covers another:
   `accepted` waits for the model, not the dispatcher (H0c decision 6), and
   a settled child says nothing about the parent.
3. **Identities are stable before the first effect.** The parent commits
   the launch revision with `childRunId` and `dispatchId` before Java
   attempts any creation, so a crash between commit and dispatch reconciles
   by identity instead of guessing. Java creates the child Session under a
   durable, idempotent command keyed by the launch, records the
   `childSessionId` back onto the `child_run` chain, and the child pins the
   AgentBundle revision given at launch. A timeout, 404 or incomplete
   answer from creation proves nothing by itself: the relay re-queries the
   original occurrence and never re-fires blind.
4. **The result crosses by outbox and idempotent acceptance.** The child
   commits its terminal `child_acceptance` revision, which carries the
   result reference (an Artifact, per the O-slices) and a delivery line of
   target `session`. The two child kinds cross differently (reference
   section 8: a foreground child returns only the original tool result, a
   background child crosses only by the persistent notification input —
   never both). A **foreground** child commits its terminal `child_run` /
   `child_acceptance` revision, and the same tool call answers the parent
   with the original result in the same store transaction. Acceptance to
   `accepted` commits with that answer — the parent's own durable record
   of having the result — while **nothing is committed as `consumed`**:
   consumption is a separate, later revision, which the parent authority
   commits only when its consuming progress is real (a harness crash
   between the accepted answer and that progress leaves `accepted` alone,
   and a restart re-reads it as accepted-not-consumed — never as already
   consumed). No notification input is committed and no wake is minted on
   the foreground arm either — but the three facts stay three. A
   **background** or detached
   child commits its terminal `child_acceptance` revision the same way;
   the relay — reading the outbox columns the Java
   store already materializes — submits `acceptChildResult` to the parent
   as a trusted-entry operation: the parent commits the delivery step to
   `accepted` together with the notification input and its wake in one
   transaction. A replayed acceptance answers the recorded revision and
   sends nothing twice. When the Turn that consumed the notification has
   its `turn.settled`, a successor revision commits `consumed`. A result
   that reaches a closed or deleted parent is kept as orphaned — recorded,
   never fed to a model, and never a reason to reopen the parent (reference
   section 14, item 7).
5. **Workspace isolation: read-only snapshot, and only that.** The
   `child_run` body carries a closed policy name. The registered names are
   the reference design's three — `read_only_snapshot`,
   `independent_worktree`, `shared_serialized` — but the first slices admit
   only `read_only_snapshot`: the child receives a frozen, read-only view
   of the parent binding at the recorded context revision, and any tool
   that would write is refused by admission policy. The other two names
   stay reserved and are rejected at admission until their slice lands
   (non-goal 1), so no reader can meet them unprepared. A child never
   inherits the parent's model context implicitly, as section 8 requires;
   its purpose, depth and budget travel in the record.
6. **Foreground and background children return differently.** A foreground
   child returns only its tool result in the parent's turn; a background
   child returns only through a persistent notification input. A launch
   picks one; the record's kind fixes it, and no path may deliver both
   (reference section 8).
7. **Close cascades bind to the durable close path.** Parent close follows
   the reference design's fixed order (section 12): seal new inputs and
   dispatch, cancel or detach long-running children, collect outstanding
   receipts, close the Harness activation, verify no Runtime hold, then
   release the Runtime and end the writer. H4 adds the second step to the
   existing CLOSING path (#13135): a child still not terminal is cancelled
   by default; a child explicitly detached before close must first take an
   independent durable owner — a detached child with no owner refuses the
   detach, not the close. Late results become orphaned per decision 4. The
   close path keeps its `409 turn_active` refusal for active Turns; child
   cancellation runs as part of close rather than blocking it forever, and
   the observation timeout of the close API never releases a physical
   owner.
8. **Quotas use the shared reasons.** Depth, concurrent-child, and
   model/tool budgets refuse with H0b's quota reasons (`depth_limit`,
   `count_limit`, `budget_exhausted`), so the projection and the public
   `recovery_blocked`/`failed` states need no new vocabulary.

## Record bodies (H4a contract direction)

**Body version and the registered Shell body.** `managed-child_run` is
already registered on main with the H3, single-kind body: `kind:
'shell'`, `recordId = shellId`, projection task kind `background_shell` —
and the H3 body's own header names this exact step: H4 extends the domain
to the other child kinds under its own body version. H4a therefore does
not rewrite the v1 body; it defines **body version 2** as a kind-union:
`kind: 'shell'` keeps the v1 field set verbatim (byte-identical JSON for
every committed Shell — a migration is a rename to nothing), and `kind:
'child_agent'` carries the new body below with `recordId = childRunId`
and projection task kind `child_agent`. The `domain.committed` payload
version admits `1 | 2` for this one domain only; every other domain keeps
`version == 1` (admission matrices pinned by shared fixtures in both
languages), and `child_acceptance`, `schedule` and the other H series
stay at their own v1.

Both bodies embed the H0b run block unchanged. The closed field sets,
validators and transition rules are pinned by the H4a change in the shared
schema and fixture files that TypeScript and Java both replay, as H0b/H0c
did. This section fixes the direction, not the byte-level schema.

- `managed-child_run` (committed by the parent authority, chain identity
  `childRunId`): `rootSessionId`, `parentSessionId`, purpose (bounded
  text), `depth`, the AgentBundle definition pin (`DefinitionPin`), model
  and tool budget references, the workspace isolation policy (decision 5),
  `deliveryId`, and — once assigned — `childSessionId`, `dispatchId` and
  the child Runtime binding. Its run line is the logical child lifecycle,
  its execution line the physical child Session/binding, and its delivery
  line the result acceptance of decision 4. A `run.delivery.target` of
  `session` is required.
- `managed-child_acceptance` (committed by the child authority, chain
  identity `childRunId` of its parent): the child's own session identity,
  the terminal outcome, the result reference, and the delivery line toward
  the parent. Its terminal revision is the first of the three facts.
- Fixed-across-revisions fields follow H0b's rule (`MONITOR_FIXED_KEYS` is
  the precedent): the identities, the definition pin, the policy and the
  budget never change once the chain exists.

## Slice plan

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Exit gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4a   | Record contract: both bodies, validators, fixed-field rules and transition witnesses, added to the shared schema and `managed-extension-record-v1` fixtures; `MANAGED_EXTENSION_RECORD_BODIES` entries; Java replay.                                                                                                                                                                                                                                   | TypeScript and Java produce and refuse identical chains from the fixtures. Both domains stay absent from `MANAGED_SESSION_ENABLED_DOMAINS`; `commitExtensionRecord` still refuses them. No production caller constructs either body. The Java store ships the bodies before any writer can commit (H0c open question 7).                                                                                                                                                                                   |
| H4b   | Foreground child, read-only snapshot: parent launch commit + outbox, idempotent child creation, child terminal commit, the original tool result answered in the same store transaction — acceptance to `accepted` folds in there, never a notification input and never a wake, and `consumed` commits only as its own later consumption-progress revision (a crash between them leaves `accepted` alone). The domains are enabled for submission here. | The three facts are separately observable in the task view and record chain: a crash after the answer leaves `accepted` without `consumed`, and a parent restart re-reads that without ever widening it. A parent restart re-sends only an un-`accepted` original result and never creates a second child for the same `dispatchId`. A relay crash between creation and acceptance reconciles from the committed occurrence. Identical re-acceptance is idempotent. A closing parent refuses new launches. |
| H4c   | Background child notification; close cascade (cancel default, detach with durable owner, orphaned results); child task cancel via the planned cancel route; depth/concurrency/budget quotas.                                                                                                                                                                                                                                                           | Closing a parent cancels its non-detached children and never resurrects for an orphaned result; detaching without an independent durable owner is refused. Cancel is durable, ordered and idempotent under the v1.23 semantics. Quota refusals carry the H0b reasons. Task events and `output_cursor` remain `planned`.                                                                                                                                                                                    |

Later H4 slices (not scheduled here): `independent_worktree` with its
lifecycle and merge policy; `shared_serialized` with its generation/barrier;
the `workflow` task kind; team domains and mailbox; cross-workspace children.

## Validation plan

- Fixture parity for both bodies, replayed by TypeScript and by Java, as
  the H0b/H0c fixture files already pin for `monitor_run`, MCP and Hooks.
- Authority suites for launch, acceptance replay, fixed-field immutability,
  close-time launch refusal and orphaned-result recording.
- Java store materialization of the new bodies (a Flyway migration after
  main's V34), including outbox columns and refusal rollback.
- Mutation checks: every transition rule, fixed-field rule and idempotency
  check is disabled in turn and fails a test, as H0c required.
- Fault-injection E2E on the H4b pipeline: crash before launch commit,
  between commit and creation, between creation and terminal, between
  terminal and acceptance, and between acceptance and consumption; each run
  ends in exactly one child and at most one delivered result, or in a
  visibly `unknown`/`recovery_blocked` state, never a silent duplicate.

## Acceptance criteria

- Section 14 of the reference design, items 2 and 7, hold for the pipeline:
  disconnect/reconnect changes no child's state; child terminal, parent
  accepted and parent consumed are separately observable; a restarted
  parent relay only re-sends the original result; an orphaned result never
  revives a closed parent.
- Every failure resolves to `not_started_proven`, settled, attachable, or
  `unknown`/`corrupt`, and `unknown` never masquerades as success or
  auto-reruns (reference section 14, item 10).
- No public API change in H4a–H4c beyond the already-planned task surface:
  the task list shows `child_agent` tasks, cancel moves to `partial` when
  H4c wires it, and events stay `planned`.
- Both domains are enabled for submission only in the slice that ships
  their producers, with the contract test proving enablement is explicit.

## Open questions

1. **Where the foreground result boundary sits.** A foreground child's
   result returns in the parent's tool result; whether that result must
   also stage as an Artifact (O-slice rules) or may travel inline under the
   tool-result store is decided with H4b.
2. **Consumption transaction grouping.** Whether the `consumed` revision
   commits in the `turn.settled` transaction or a later one; H4b pins it.
3. **Rebuild cost.** H0c open question 1 (unbounded chain replay) applies
   to long-running children with many acceptance revisions; a checkpointed
   task view may be required before H4c enables cancel at scale.
4. **Detached-child ownership.** What durable owner a detached child takes
   (a tenant-level retention policy, or the root Session authority) is left
   to H4c; the close path only enforces that one exists.
