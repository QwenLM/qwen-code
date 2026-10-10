# Managed public task cancel (H4f)

[English](2026-10-10-managed-task-cancel.md) | [简体中文](2026-10-10-managed-task-cancel.zh-CN.md)

Status: implemented in this change for `child_agent` tasks. `cancelSessionTask` and `cancelWebShellTask` move from `planned` to `partial` in contract `1.40.0` (provisional: open pull requests already claim `1.39.0`). Landed: durable `task_cancel` admission in the order the task contract fixes, delivery that reads every outcome from the task's committed record, a bounded retry that parks instead of holding the Session, the child result relay's stop arm that physically stops a child, the `cancel` action on the task view, and the WebShell request's trace-only `requestId`. Still open: every other task kind's cancel path, output events for child tasks, and the channel-delivery half (Follow-up work).

This is slice **H4f** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13746](https://github.com/QwenLM/qwen-code/issues/13746). It implements the cancel semantics that [#12847](https://github.com/QwenLM/qwen-code/issues/12847) A6/A7 asked for and #12998 settled in contract v1.23 ([task contract](2026-09-27-managed-agent-task-contract.md), sections 4.4 and 4.5). It adds #12847 B12 and answers open question 1 of [H4b](2026-10-07-managed-child-session-runtime.md), which asked how an operator closes an `unknown` delivery.

## Problem

A caller can list a task (v1.19), read it and watch its events (v1.31), but cannot stop it. Since H4b, the `child_agent` kind produces real tasks: each is a child Session doing model work in the parent's Workspace. The only way to stop one today is to close the whole parent Session, because the cascade is the only caller of the child run's stop request.

The contract already pins the semantics. Three facts must stay separate:

- Java durably admitted the command (`202`).
- The task authority recorded the cancellation (`completed`, with a receipt).
- The task physically settled `cancelled`.

The slice must avoid two failure modes: a cancel that reports success without the authority recording it, and a replay that becomes a second cancellation.

## Current state

The facts below are from `main` at `ba8615f4c4` (Flyway V60, contract `1.38.0`).

- **Contract.**
  - Both cancel routes are `planned`, with v1.23's settled text: the check order (A6) and the outcomes (A7).
  - `PublicCommandOperation.task_id`, `WebShellCommandOperation.taskId` and the `task_cancel` outcome conditional are `planned`.
  - `WebShellTaskCancelRequest` is `planned` and has no `requestId` (#12847 B12).
  - `TaskActionCapability` is `partial`.
- **Operation table.** `managed_agent_operation` (V17) holds the lifecycle, cwd and action-response operations.
  - Failure codes live in `error_code` (V24). There is no `task_id` column.
  - "One open operation per Session" is `ManagedAgentStore.hasOpenOperation`. It counts operations in `PENDING`, `RUNNING` and `RECOVERY_BLOCKED`, and pending mutation commands.
  - The lifecycle coordinator's scan (`findDeliverableOperations`) takes every kind except `ACTION_RESPONSE`.
- **Task view.** `ManagedTaskService` answers `action_capabilities` with a constant empty list. Every task-projecting record, `child_run` included, appends a `state_changed` event to the H3 per-task journal on each view change (`ManagedExtensionRecordStore` → `ManagedTaskEventStore.appendStateChange`).
- **Stop primitives (H4b).**
  - The Hosted Harness route `POST /session/:id/children/operations` takes `kind: "cancel"`. That calls `requestStop`, which commits `stopRequested: true` on the `child_run` record. The flag is set once and never cleared, and a terminal run freezes it (`isChildRunSuccessor`).
  - `kind: "close_scope"` settles the run `cancelled` by `stop_requested`.
  - Their only caller is the close cascade in `SessionLifecycleCoordinator`, which waits for a child's active Turn to end on its own.
  - The child result relay watches a child's Turn. A `CANCELLED` or `FAILED` Turn settles the run as `failed` by `child_failed`.
- **Other task kinds.**
  - `background_shell` and `monitor` are disabled behind the H3 acceptance gates (#13532/#13533). The Shell publisher settles `exited` even after `stopRequested`, and `monitor_run` has no stop flag.
  - `workflow` has no runtime (H4c registered it disabled).
  - `automation_run` has no stop request at all.
- **Channel deliveries.** `channel_delivery` projects no task, so a delivery is not a task. H5's public channel routes are read-only. Their mutations (resend) are deferred, and the Hosted `cancel_delivery` verb is internal.

## Decisions

1. **v1 cancels `child_agent` tasks only, and says so in the task view.**
   - `ManagedExtensionProjection.taskActions(kind, state)` is the single rule. It advertises `cancel` exactly for a `child_agent` task in `pending`, `running`, `waiting` or `degraded`.
   - Every other kind, and any terminal or `recovery_blocked` task, advertises no action. A new cancel for it answers `409 task_action_unavailable`.
   - The task view and the admission recheck read the same function, so the advertised action and the route agree.
   - A task whose stop is already recorded still advertises `cancel`: requests coalesce (contract section 4.4) and each operation gets its own outcome.

2. **Admission runs in the A6 order, with authorization decided here.**
   - The checks run in this order:
     1. the key: missing is `400 invalid_request`, malformed is `400 invalid_idempotency_key`;
     2. current access: `404 session_not_found`, then `404 task_not_found`, then `403 task_forbidden`;
     3. under the Session lock, the retained key, scoped to tenant, Session, kind, actor and key;
     4. only for a new request: `409 session_not_active`, then `409 task_action_unavailable` (re-read with a locking read of the task's own projection row, which serializes admission with the transition that would settle it), then `409 session_operation_active`;
     5. the insert.
   - `capabilities.tasks` is always true, so `400 unsupported_feature` is unreachable.
   - The digest covers the Session, the kind and the task id. It does not cover the trace-only request id.
   - Authorization follows Turn cancel: OPERATOR or above on a bound Session's Workspace. A readable caller below that gets `403 task_forbidden`.
   - Unlike Turn cancel, the Session's executable shape is not an authorization fact. The delivery records a stop request on the parent's own journal and runs no new work, so a Session that stopped serving work answers the new-request checks instead.
   - An unbound Session has no role model beyond read access.
   - Unlike the cwd and lifecycle admissions, the role is checked before the replay, because A6 says a retained key never bypasses current access.

3. **Storage: one column and two exclusions.**
   - V62 adds `task_id` to `managed_agent_operation`. Failure codes reuse `error_code`.
   - `TASK_CANCEL` is excluded from the lifecycle coordinator's scan, because it has its own coordinator.
   - It is also excluded from the bound later-Turn barrier (`hasOpenExecutionOperation`): stopping one task changes no Session context.
   - A `recovery_blocked` task cancel does not count as open. Its acceptance is reconciled from the record, so it must never hold close, archive or delete hostage. Every other kind's `RECOVERY_BLOCKED` still counts, as before.
   - The migration and recovery idle checks still count a parked cancel. They stay conservative until it reconciles; the parent close ends the run, which reconciles it.

4. **Every outcome is read from the committed record, never from the wire.** `TaskCancelCoordinator` claims the operation through the shared lease, then reads the task's latest committed record. The Java store mirrors that record in the authority's commit transaction, so it is the authority's own durable statement.

   | Committed record                   | Operation outcome                                                           |
   | ---------------------------------- | --------------------------------------------------------------------------- |
   | `stopRequested` is set             | `completed`: `harness_confirmed`, `confirmed`, receipt                      |
   | the run ended without it           | `failed` `task_already_settled`: `java_durable`, `blocked`                  |
   | the task's kind has no cancel path | `failed` `task_action_unavailable`                                          |
   | the task no longer exists          | `failed` `task_not_found`                                                   |
   | the run is live and has no request | send `kind: "cancel"` through the child operation route, then read it again |
   - A terminal run freezes everything but its delivery line, so "ended without a stop request" proves the request can never land later. That is the only definitive refusal.
   - A refusal or a lost reply from the Harness proves nothing by itself. The record is read again.
   - The receipt is an opaque `rcpt_` handle, minted when the record proves the request. It is not a journal reference, as the contract requires.
   - No TypeScript change is needed: the existing `requestStop` is replay-safe (an already-set flag is a no-op), and a terminal run refuses the request.

5. **A bounded delivery parks; a parked cancel only reconciles.**
   - A live run whose request is still not visible retries with the dispatch backoff, up to 16 attempts. With the 1 s to 1 min defaults the 15 waits add up to about ten minutes.
   - After that the operation becomes `recovery_blocked` with `task_cancel_unconfirmed`, `java_durable`, `blocked`.
   - Every five minutes the parked cancel re-reads the record:
     - a stop request recorded since (another cancel, the close cascade) completes it;
     - an end without one fails it;
     - otherwise it parks again.
   - It is never sent again. The contract forbids re-executing an operation of unknown acceptance, and the caller can always issue a new cancel, because a parked one is not open.

6. **The relay stops the child physically.**
   - Its new stop arm runs before any other arm for a run whose committed record has `stopRequested` and has not ended. The relay already owns the child's walk, so no second driver races its ledger row.
   - What the arm does depends on the child:

     | Child                                           | Stop arm                                                                                                                                                                                                                                                            |
     | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | No child minted (ledger and lineage both empty) | Settle `close_scope` `started: false` without creating one. The verdict/mint commit gate refuses this if a creation lands first, and the retry then names the child.                                                                                                |
     | Child Turn still running                        | Cancel that Turn through the child's own durable Turn cancel (`ManagedAgentService.cancelChildTurn`, keyed by parent, run and Turn), then look again on the heartbeat. A Turn already `CANCELLING` is only waited on.                                               |
     | Child Turn ended without a result               | Get the start pairing from committed evidence (`reconcileAttach`, which replays a lost dispatch or attach). Admit the child's close, then settle `close_scope`. A minted child that never started dies named. A close-incapable host keeps the close debt as today. |
     | Child Turn completed first                      | The ordinary walk delivers the result. The settled run keeps the recorded request.                                                                                                                                                                                  |

   - The task becomes `cancelled` only through that settlement, and its runtime reads `draining` until then. A foreground parent waiting on the child is answered "Child agent run cancelled (stop_requested)" by its existing waiter.

7. **The `unknown` delivery's operator story (H4b open question 1).**
   - A `child_run` delivery becomes `unknown` only on a run that already settled with a result, so its task is terminal and has no `cancel`.
   - H4f adds no operator verb for it. The delivery stays visibly `unknown`, is never fed to a model and never re-executed, and the parent Session's close classifies its ledger row `orphaned`.
   - A live run is never stranded behind an `unknown` ledger row: the relay's give-up chain commits the terminal `fail` before it classifies.
   - What an operator does in each case:
     - a live but stuck child: cancel the task;
     - a parked cancel: issue a new cancel or close the Session;
     - an unproven delivery: close the Session.

8. **B12: the WebShell request carries a trace-only `requestId`.**
   - The field is optional, nullable and at most 128 characters. It becomes the `202`'s `X-Request-Id` through `RequestIdFilter.useClientId`, which the spec now declares, and it stays out of the digest.
   - `WebShellLifecycleRequest`'s matching gap stays with the change that makes the client send lifecycle commands, as B12 says.

9. **Child task streams (#13746 F2) need no new journal.**
   - A child task's view changes, including the stop request's `draining`, already ride the H3 per-task journal with its retention floor and cursors. Its `output_cursor` is the journal tail. This change pins that with a real-record test.
   - A child task advertises no `read_output`, so under the contract it produces no `output` events.
   - The child's own transcript lives in the child Session. Linking a task to that Session, or relaying its output as task events, is a separate decision (Follow-up work).

10. **Channel deliveries (#13746 F3) are not tasks.**
    - `cancelSessionTask` never targets a delivery, because `channel_delivery` projects no task.
    - The H5 delivery cancel belongs with H5's deferred public mutation routes (resend first). It should reuse this slice's model, not grow its own vocabulary:
      - the shared operation table;
      - the A6 admission order;
      - the A7 outcomes;
      - the record-first verdict, where the delivery's `cancelRequested` plays the stop request's role.

## Contract changes (1.40.0)

- `cancelSessionTask` and `cancelWebShellTask`: `planned` → `partial`.
- The `task_id`/`taskId` operation properties and the `task_cancel` outcome conditional: served (no marker).
- `WebShellTaskCancelRequest`: served, and gains `requestId`. The WebShell `202` declares `X-Request-Id`.
- `TaskActionCapability`'s description names the kinds that advertise `cancel`, and `info.description` gains the v1.40 paragraph.
- The generated WebShell types gain the route, the request and `taskId`.

## Validation

- **Store, on H2 with Flyway** (`ManagedTaskCancelOperationTest`, 7 tests):
  - admission, replay and digest conflict, including across actors;
  - a retained key replaying through a `CLOSING` and then a `DELETED` Session;
  - the action rule per state;
  - one open operation per Session in both directions (a cancel blocks close), and two competing keys admitting exactly one;
  - a parked cancel that is never claimed again, does not count as open, and reconciles only while parked;
  - the contract's state fields per outcome, under the claim.
- **Delivery** (`TaskCancelCoordinatorTest`, 7 tests):
  - completion from the record, and coalescing without a send;
  - `task_already_settled` without a send;
  - a refusal and a lost reply judged by the record;
  - the budgeted retry, then the parking;
  - a kind without a cancel path;
  - parked reconciliation that never re-sends.
- **Relay** (`ChildResultRelayTest`, 6 new tests):
  - unstarted settlement without creation;
  - Turn cancel, then a `close_scope` `started: true` settlement with the close admitted;
  - a completion that wins the race;
  - a minted, never-dispatched child that dies named;
  - a refused settlement that defers instead of classifying;
  - an ended run that is never stopped again.
- **Real records** (`ManagedExtensionRecordStoreTest`): a `child_agent` chain committed through the Session store, through stop request and cancellation. It checks:
  - the advertised action at each step;
  - `draining`;
  - the target the delivery reads;
  - the five journaled `state_changed` events and the output cursor (F2).
- **Contract:**
  - `ManagedAgentApiContractTest` serves both routes: `202`, replay, cross-surface replay, conflict, action refusal, `400`, `404`, the tenant filter's `403`, and the operation read-back carrying `task_id`.
  - `PlannedTaskContractTest` now pins both routes as `partial` and checks the `requestId` instances.
  - `SurfaceRegistry` gains both routes under a new `TASK_OPERATOR` rule class, which `SurfaceAdmissionAcceptanceTest` probes on both surfaces: `404` below read, `403 task_forbidden` for a reader, and an OPERATOR or owner-rank caller admitted to the route's own `409`.
- **Not run:**
  - a product-stack run with a live Hosted Harness and a real child Session;
  - the #12380 Stage F fault round for this kind (lost cancel reply, cancel during settlement, cancel racing the parent close, cancel after the owner is gone). The unit suites above cover each of those orderings against the recorded control-plane calls, not on a real stack.

## Follow-up work

| Item                    | Scope                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 kinds                | When `background_shell` and `monitor` enable: Shell settles `stop_requested` after its request (the publisher settles `exited` today), Monitor gains a stop request, and both join `CANCELLABLE_TASK_KINDS` with a delivery arm. |
| Workflow, automation    | With the workflow runtime (#13803) and H6 per_run: a stop request on their records, then the same delivery and stop arms.                                                                                                        |
| Channel delivery cancel | With H5's public mutation routes: reuse this slice's operation model (decision 10).                                                                                                                                              |
| Child output            | Link a child task to its child Session, or relay its output as task events behind `read_output`.                                                                                                                                 |
| WebShell                | A task panel with a cancel control, and client methods for the task routes.                                                                                                                                                      |
| Stage F                 | The product-stack fault round named under Validation.                                                                                                                                                                            |
