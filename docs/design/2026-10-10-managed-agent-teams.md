# Managed agent teams: the record contract (H4e-a)

[English](2026-10-10-managed-agent-teams.md) | [简体中文](2026-10-10-managed-agent-teams.zh-CN.md)

Status: implemented in this change. Landed: the `managed-team_state`, `managed-team_task`, `managed-team_message` and `managed-team_plan` record bodies, registered and validated in TypeScript and Java, with the commit-time rules that bind every team record to its lead Session. None of the four domains is enabled for submission. Still design: the runtime that creates teams, spawns members, relays the mailbox, resolves plans and shuts members down (H4e-b, Follow-up work), except its lead-side half, which the [H4e-b1 design](2026-10-10-managed-agent-team-lead-runtime.md) implements with the team domains still disabled. This is the record-contract half of slice **H4e** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13745](https://github.com/QwenLM/qwen-code/issues/13745). It follows H4a ([record contract](2026-10-06-managed-child-agent-runtime.md), #13505), H4b ([child Session runtime](2026-10-07-managed-child-session-runtime.md), #13550), H4c ([workflow kind](2026-10-09-managed-workflow-child-kind.md), #13754) and H4d-a ([Session messages](2026-10-09-managed-session-messages.md), #13786). Below, "the automation design" is section 5.1 of the [automation, Channels and child delivery design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) at the commit that #12827 pins.

## Problem and scope

The child agents H4b runs answer only their parent. A team is the construct that lets several of them work together: a lead Session, named members, a shared task board, a mailbox between them, and plan approval for members that must plan before they act. On the Managed path none of that exists. The four team domains are registered names with no body, so nothing about a team can be committed, rebuilt or checked.

Issue #13745 asked for three items: E1 (the team record domains), E2 (detach to an independent durable owner) and E3 (the close cascade under teams). Its triage left three questions for a human: which durable owner a detached child takes, where the teammate routing that H4b left to H4e goes, and whether the team domains project the Legacy team model or stand beside it. This design settles the scope as follows:

- **H4e is split like H4d.** This change lands E1 as the record half: every team fact the runtime will need is a committed record with commit-time rules in both languages. The runtime half is H4e-b. It also takes what the H4a delivery map assigns to H4e beyond the records: the seven team tools, `resolveTeamPlan`, `requestMemberShutdown`, legacy team import, the mailbox relay that H4d-a moved here, and the managed Agent tool's `name` parameter, which H4b decision 11 left for teammate routing. E3, the close cascade under teams, needs the runtime too, so it is H4e-b's.
- **E2 (detach) is not H4e.** The H4a delivery map gives detach its own follow-up row ("Detach"), and the H4b and H4c designs repeat it. The question of which durable owner a detached child takes moves with it. The [H4 design](2026-10-04-managed-child-agents.md) assigned that question to H4c, and now points to the Detach follow-up.
- **The team domains are the durable form of the Legacy team model, not a parallel one.** The automation design requires the migration to reuse the rules of `agents/team/TeamManager.ts`, its tasks, mailbox and identity. The H4a map also gives H4e the import of legacy teams. So the records keep the Legacy vocabulary: sanitized team and member names, the reserved `leader`, the board statuses, the mailbox message types and plan approval. Where the Legacy model rewrites two files to keep one fact, a record keeps the fact once (decision 5).

This follows the H4a → H4b, H4d-a → H4d-b and H6a → H6b cadence: the record contract lands first, validated ahead of any writer, and enablement ships with the producers.

## Current state

The facts below are from `main` at `9ec44d45c4`.

- **Domains.** `team_state`, `team_task`, `team_message` and `team_plan` are in the closed v1 domain index (`MANAGED_SESSION_DOMAINS`) and in Java's `ManagedExtensionRecords.DOMAINS`. They have no body in either language, no store rule, no task kind and no enablement. `team_plan` is also a value of `MANAGED_SESSION_ACTION_SOURCES`, so a D6 action can already name a team plan as its source.
- **Legacy model.** `packages/core/src/agents/team/` keeps a team in files under `~/.qwen/teams/{team}` and `~/.qwen/tasks/{team}`. `TeamFile` holds the lead and an append-only member list of at most `MAX_TEAMMATES` (10) members. A member is removed only when its own spawn rolls back. Names are sanitized to `[a-z0-9-]`, and `leader` names the lead. A `SwarmTask` has a positive integer id, `subject`, `description`, `activeForm`, `owner`, status `pending | in_progress | completed`, both dependency directions (`blocks` and `blockedBy`) and `metadata` of at most 32 KiB. `task_update` deletes a task with `status: 'deleted'`, merges metadata and only adds edges. It mirrors each edge into the other task, removes a completed or deleted task from its dependents' `blockedBy`, and gives an `in_progress` task without an owner its caller as owner. The mailbox carries `shutdown_request`, `shutdown_approved`, `shutdown_rejected`, `plan_approval_request`, `plan_approval_response` and `task_assignment`. Plain text goes through each agent's in-memory queue. All of it lives in the lead's process and its local files, and the Managed path has none of it.
- **Seven team tools.** `team_create`, `team_delete`, `task_create`, `task_update`, `task_list`, `team_plan_approval` and `request_shutdown` act on that model.

## Decisions

1. **All four domains live in the lead Session's journal.** A team is a persistent domain resource under the lead Session's authority (the automation design, §5.1). Every team record is committed by the lead Session's single writer and names its `teamId`. The `team_state` record names the lead as `leadSessionId`, and the authority requires that to be its own Session. A member's own Session holds no team record. A member acts through an identity-checked command to the lead, and a message reaches it as an input in its own journal (open question 1). One journal is enough here, unlike H4d's two, because the lead authorizes every team fact.
2. **Names keep the Legacy form.** A team name and a member name are the output of Legacy `sanitizeName`: lowercase letters and digits in dash-separated runs, at most 64 characters. A member is never named `leader`. Where a record names a participant (a task owner, a message's sender or recipient), `leader` is the lead and any other name is a member of the team.
3. **`team_state` is the roster and the lifecycle.** Members are append-only, and only while the team is `active`. Each revision appends at most one, so each membership fact is committed on its own. `membershipRevision` counts membership facts: it opens at 1 with no members and is always one more than the member count. Each member names its child run in the lead's journal (`childRunId`) and whether it must plan before it acts. The lifecycle follows the automation design: `active → closing → deleted`, one step at a time. The run block is a purely logical lifecycle, `admitted` while the team lives and `cancelled` once it is deleted, which freezes the record.
4. **A member is a live child Session run of the lead, in exactly one team.** When a member joins, its `childRunId` must name a child Session run (`child_agent` or `workflow`) of the lead's journal that has not ended. No other team of the lead may list that run. A member keeps its entry after its run ends, as a Legacy member keeps its file entry, so the roster is the team's history. Its run's state is the member's liveness.
5. **`team_task` keeps one fact once.** A task's identity is its `taskId`, which is unique in the journal. Its `number` is the board's `#N`, unique within the team and never reused. Its subject, description, active form, metadata, owner and status follow `task_update`. `in_progress` needs an owner, and `deleted` is terminal: the run moves from `admitted` to `cancelled` and the task freezes. Dependencies are stored in one direction only, as `blockedBy`, and only grow. A Legacy edge always reaches the dependent's `blockedBy`, so `blocks` is the reverse index, not a second copy. Whether a dependency still blocks is read from the blocker's status: a completed or deleted blocker no longer blocks. So a write commits one record, where Legacy rewrites both tasks of an edge and every dependent of a completed task. A new edge must name a task of the same team and must not close a cycle. The revision of the task record serves as its `expectedTaskRevision`. A task assignment is a `team_message` of kind `task_assignment` (decision 6). The task carries no delivery line, because one task is assigned again and again and a delivery line ends.
6. **`team_message` is the mailbox.** Each record is one message to one recipient, so each recipient has its own delivery, acceptance and consumption. A broadcast is one record per recipient, and a broadcast that partly fails never resends to a member that already accepted. The record follows the H4d-a outbox entry: settled from its first revision, naming its sending call, with a `session` delivery line (`planned → accepting → accepted → consumed`, plus `cancelled`, `unknown` and `rejected`), a target Session fixed once at handover, and the target's `inputId` exactly once accepted. The content is at most 64 KiB and bound to its digest. `kind` is plain `message` or one of the six Legacy mailbox types, each with a fixed direction:

   | Kind                                                              | From     | To          |
   | ----------------------------------------------------------------- | -------- | ----------- |
   | `message`                                                         | anyone   | anyone else |
   | `task_assignment`                                                 | anyone   | a member    |
   | `plan_approval_request`, `shutdown_approved`, `shutdown_rejected` | a member | `leader`    |
   | `plan_approval_response`, `shutdown_request`                      | `leader` | a member    |

   A message to `leader` targets the lead Session. A message to a member targets the Session its child run attached, so a message to a member whose run has not attached yet stays `planned`.

7. **`team_plan` is the approval state, not its transport.** A plan request is keyed by `requestId`, the id of the D6 action that asks the leader to decide (source `team_plan`). It names the member, the member's `planRevision` and the plan content. Its run opens `waiting` for the decision and ends `settled` with `decision: approved | rejected` and optional feedback. It ends `cancelled` with no decision when the plan is withdrawn or superseded: a revised plan opens a new request with a later revision, so a decision never applies to a plan it did not see. The request and the decision travel as `plan_approval_request` and `plan_approval_response` messages, and the decision itself is resolved through the D6 action (`resolveAction`) before H4e-b commits it here. A plan request can come only from a member that requires plan mode.
8. **Commit-time rules check what the lead's journal holds.** Both the TypeScript authority and the Java store check:

   | Rule                                                                                                                              | Domain                                   |
   | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
   | The team is led by this Session                                                                                                   | `team_state`                             |
   | A joining member names a child Session run of this Session that has not ended and that no other team lists                        | `team_state`                             |
   | A record opens only in a team of this Session that is `active`                                                                    | `team_task`, `team_message`, `team_plan` |
   | A task number is unique in its team                                                                                               | `team_task`                              |
   | A task owner, whenever it changes, is `leader` or a member of the team                                                            | `team_task`                              |
   | A new dependency names a task of the same team and closes no cycle                                                                | `team_task`                              |
   | A message travels between `leader` and members of its team, and targets the lead Session or the Session its member's run attached | `team_message`                           |
   | A plan request comes from a member of its team that requires plan mode                                                            | `team_plan`                              |

   A record of a team that is closing or deleted can still take its later revisions: a message in flight is still delivered, a pending plan request is still withdrawn, and a task can still be updated. Only new records are refused, so a team in `closing` admits no new work while it drains.

9. **The four domains stay disabled and project no task.** None is in `MANAGED_SESSION_ENABLED_DOMAINS`, and a commit is refused with "registered but not enabled" before anything publishes. The Java store validates all four ahead of any writer, in the server-first order of H1 through H4d-a. None is on the list of domains that Java's lifecycle gate admits for a Session under a close or delete claim, and H4e-b decides what a closing lead may still commit (open question 3). A team task is a board item, not a runtime task, so all four register a null task kind and their Java rows carry null task columns.

## Records

All four are schema version 1. All keys are required, and a nullable key holds `null`. Every run block is purely logical: no definition pin, effect, dispatch, Channel delivery, execution or Runtime binding. Only `team_message` names an `executionCallId` and carries a delivery.

### `managed-team_state`

Chain identity: `teamId`.

| Key                  | Rule                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `teamId`             | id: the team, minted by the lead                                                                                             |
| `name`               | team name (decision 2)                                                                                                       |
| `leadSessionId`      | id: the lead Session                                                                                                         |
| `lifecycle`          | `active`, `closing` or `deleted`                                                                                             |
| `membershipRevision` | integer, exactly one more than the number of members                                                                         |
| `members`            | at most 10 entries of `{ name, childRunId, planModeRequired }`; names and child runs are unique; no member is named `leader` |
| `run`                | `admitted` while `active` or `closing`, `cancelled` once `deleted`                                                           |

- **Opening.** `active`, no members, run `admitted`.
- **Successors.** `teamId`, `name` and `leadSessionId` never change. The lifecycle stays or takes one step. The members of a revision are the previous members plus at most one more, and only an `active` team that stays `active` gains one. A deleted team is frozen.

### `managed-team_task`

Chain identity: `taskId`.

| Key              | Rule                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `teamId`         | id: the team                                                       |
| `taskId`         | id: the task, unique in the journal                                |
| `number`         | integer from 1: the board's `#N`                                   |
| `subject`        | bounded text                                                       |
| `descriptionRef` | durable ref, at most 65536 bytes                                   |
| `activeForm`     | null or bounded text                                               |
| `metadataRef`    | null or durable ref, at most 32768 bytes (the Legacy metadata cap) |
| `owner`          | null or a participant name; required while `in_progress`           |
| `status`         | `pending`, `in_progress`, `completed` or `deleted`                 |
| `blockedBy`      | at most 64 distinct task ids, never this task's own                |
| `run`            | `admitted` unless `deleted`, `cancelled` once `deleted`            |

- **Opening.** Any status but `deleted`, so an import can open a completed task.
- **Successors.** `teamId`, `taskId` and `number` never change. `blockedBy` keeps every earlier entry in order and may append more. Every other field may change until the task is deleted, which freezes it.

### `managed-team_message`

Chain identity: `messageId`.

| Key               | Rule                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `teamId`          | id: the team                                                                                                     |
| `messageId`       | id: the message to one recipient, minted by the sender                                                           |
| `kind`            | `message` or a Legacy mailbox type, with the direction decision 6 fixes                                          |
| `from`, `to`      | participant names, never equal                                                                                   |
| `contentRef`      | durable ref, at most 65536 bytes                                                                                 |
| `contentDigest`   | digest: must equal `contentRef.digest`                                                                           |
| `targetSessionId` | null or id: set once, required once the delivery is past `planned` except at `cancelled`                         |
| `inputId`         | null or id: the input carrying the message in the target; set once, present exactly at `accepted` and `consumed` |
| `run`             | settled, naming its sending call in `executionCallId`, with a `session` delivery                                 |

- **Opening.** Delivery `planned`.
- **Successors.** Every key but `targetSessionId`, `inputId` and the run is fixed. The target and the input are set once. The delivery takes one shared step at a time.

### `managed-team_plan`

Chain identity: `requestId`.

| Key            | Rule                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `teamId`       | id: the team                                                          |
| `requestId`    | id: the D6 action that asks the leader                                |
| `member`       | member name: the member whose plan it is                              |
| `planRevision` | integer from 1                                                        |
| `planRef`      | durable ref, at most 65536 bytes                                      |
| `decision`     | null, `approved` or `rejected`; set exactly when the run is `settled` |
| `feedbackRef`  | null or durable ref of at most 65536 bytes; only with a decision      |
| `run`          | `waiting`, then `settled` or `cancelled`                              |

- **Opening.** Run `waiting`, no decision and no feedback.
- **Successors.** `teamId`, `requestId`, `member`, `planRevision` and `planRef` never change. The run ends once, which fixes the decision and the feedback.

## Non-goals

- **The runtime (H4e-b):** the seven team tools on the managed path, the managed Agent tool's `name` and teammate routing, the mailbox relay and the member-side delivery, plan resolution through D6 actions, member shutdown, the close cascade over team membership, legacy team import, and enablement.
- **Detach** (the Detach follow-up of the H4a map) and **cross-workspace teams**.
- **Any public contract change.** The OpenAPI contract, routes and Flyway migrations stay as they are. A team resource on the public surface belongs with #13785.

## Files affected

- `packages/core/src/managed-runtime/managed-team-record.ts` (new): the four bodies, their start and successor rules.
- `packages/core/src/managed-runtime/contracts/managed-team-record-v1.fixtures.json` (new): the shared cases. `managed-extension-projection-v1.fixtures.json` gains the four domains with a null task kind.
- `packages/core/src/managed-runtime/managed-extension-projection.ts`: the body registrations.
- `packages/core/src/managed-runtime/managed-session-authority.ts`: resource closure and the rules of decision 8.
- `packages/sdk-java/managed-agent-server`:
  - `ManagedTeamRecords` (new): the validator.
  - `ManagedExtensionProjection`: the body registrations.
  - `ManagedExtensionRecordStore`: closure and the rules of decision 8.
- Tests in both languages: the TypeScript fixture replay and `managed-session-authority.team.test.ts`, then `ManagedTeamRecordContractTest` and `ManagedTeamStoreTest`.
- This design in both languages, plus pointers from the H4 and H4a designs.

## Validation

- **Fixture parity.** The shared cases and successors replay in both languages, and every invalid case names the clause both validators must report.
- **Authority.** The suite lifts the domain gate to plant records, except where it tests the gate itself:
  - The real gate refuses each of the four domains, and nothing publishes.
  - A team opens, gains members one at a time, closes and is deleted. Its tasks, messages and plan requests chain to their ends, and a reopened log rebuilds every chain.
  - Every rule of decision 8 refuses its violation with the named message.
- **Java store.** The same chains commit over H2 in MySQL mode, the same rules refuse with `managed_session_extension_record_rejected`, and a team row projects no task.
- **Mutation checks.** Each new guard is disabled in turn, and its witness goes red in its own language.

## Acceptance criteria

- TypeScript and Java accept and refuse identical team records and successors from the shared fixtures, and every existing contract corpus replays unchanged.
- The four domains stay off the enabled list and are refused before anything publishes.
- In both languages, every rule of decision 8 refuses its violation, and a lawful team, task, message and plan request commit and rebuild.
- No public API or migration changes, and every existing H1–H4d-a suite stays green.

## Open questions

1. **The member-side receipt.** A message to a member becomes an input in the member's journal, and that journal needs its own record to recognize a redelivery. The H4d-a `session_message` receipt fits a lead that is also the member's parent, but a member Session has no team record. H4e-b decides whether to reuse that receipt or add one.
2. **The input of a message to the leader.** A message to `leader` is accepted in the lead's own journal, so its input could commit with the `accepted` revision, as H4b's `sent` acceptance does. This contract does not yet bind them. H4e-b adds the binding when its relay uses it.
3. **What a closing lead commits.** The close cascade under teams (issue E3) cancels member runs through the child-run funnel. Whether team records must also commit while the lead Session is closing, which the lifecycle gate would then have to admit, is H4e-b's call. Answered by the [H4e-b1 design](2026-10-10-managed-agent-team-lead-runtime.md), decision 8: no team record commits during close, and a team's life is bounded by its lead Session's.
4. **A member whose run is continued.** A continuation (H4d-a) is a new child run, but a roster entry names one run forever. H4e-b decides whether a continued member re-joins under a new entry or the roster follows the continuation.

## Follow-up work

| Slice  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4e-b  | The seven team tools on the managed path; the managed Agent tool's `name` with teammate routing (H4b decision 11); the mailbox relay and member-side delivery (open questions 1 and 2); plan resolution through D6 actions; `requestMemberShutdown`; the close cascade over team membership (#13745 E3, open question 3); legacy team import; enablement after a physical acceptance pass, as for H3 (#13532). Split into H4e-b1 (the lead-side team and E3, see the [H4e-b1 design](2026-10-10-managed-agent-team-lead-runtime.md)), H4e-b2 (the mailbox, after H4d-b) and H4e-b3 (plan approval, shutdown and legacy import). |
| Detach | Migrating an explicitly detached child to an independent durable owner across parent close (#13745 E2), with the owner question the [H4 design](2026-10-04-managed-child-agents.md) leaves open.                                                                                                                                                                                                                                                                                                                                                                                                                                |
