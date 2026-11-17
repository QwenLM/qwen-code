# Managed workflow task cancel

[English](2026-10-13-managed-workflow-task-cancel.md) | [简体中文](2026-10-13-managed-workflow-task-cancel.zh-CN.md)

Status: implemented in this change; Stage F verification pending. The `workflow` task kind joins the public task cancel path: `CANCELLABLE_TASK_KINDS` widens to admit it, and the contract names it in `1.46.0`. Every stop mechanic it rides already exists and is kind-blind; this change opens the gate and pins the path with workflow-chain tests. The kind's Stage F fault round (decision 6) is owed and has not run — the evidence cited below is the unit, contract and record tier only.

This is the remaining `child_run` kind of [#13746](https://github.com/QwenLM/qwen-code/issues/13746) F1. The H4f slice (#13823) cancelled `child_agent` tasks and deferred every other kind; its follow-up table named this one — "Workflow, automation: with the workflow runtime (#13803) … a stop request on their records, then the same delivery and stop arms" — as did [the workflow runtime note](2026-10-10-managed-workflow-child-runtime.md) ("public cancel — their own named slices") and the `CANCELLABLE_TASK_KINDS` comment itself. The slice's only prerequisite, the workflow child runtime, landed in #13858. This is slice H4f-b of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of [#12380](https://github.com/QwenLM/qwen-code/issues/12380).

## Problem

Since #13858 a workflow launch is a real task: a `child_run` record whose kind is `workflow`, projected onto both task surfaces with its per-task journal and output cursor. A caller can list it and watch it — and cannot stop it. A cancel admission answers `409 task_action_unavailable` for the kind, and the task view advertises no action. Stopping one today means closing the whole parent Session, because the close cascade is the only driver that stops a workflow child.

## Current state

Checked at `d28bc60d73` (Flyway V68, contract `1.44.0`):

- **The gate is one set.** `CANCELLABLE_TASK_KINDS` is `Set.of("child_agent")` (`ManagedExtensionProjection.java:130`). Its only readers are `taskActions` (:239) — shared by the task view (`ManagedTaskService.java:251`; the view advertises nothing in a Session that is not `ACTIVE`) and the admission recheck under the projection row's lock (`ManagedAgentStore.java:1710`) — and the delivery verdict (`TaskCancelCoordinator.java:207`). No fourth reader exists.
- **The stop path is kind-blind end to end.**
  - The relay's stop arm runs on `stopRequested && !ended` before the state switch, with no kind branch (`ChildResultRelay.java:245-262`); `stopChild` (:302-427) cancels the child's Turn through the child's own command line and settles `close_scope`, never reading the kind. The H4d-b message branch is inert for a workflow child: a workflow child Session takes no session messages (`hosted-child-agent-session.ts:700`).
  - The Hosted children/operations `cancel` verb and `requestStop` read no kind (`hosted-harness-session.ts:6786-6789`; `hosted-child-agent-session.ts:1429-1445`); the funnel already settles a workflow chain cancelled through the same verbs (pinned at `hosted-child-agent-session.test.ts:1123`).
  - A workflow child's first Turn runs its script in-process with the Turn's abort signal wired to `WorkflowRunner.abort()` (`hosted-workflow-turn.ts:261-273`); a registry-side cancel of a held start settles the Turn cancelled through `WorkflowStartCancelledError` (`hosted-harness-session.ts:3088-3096`). The `turn.cancel.requested` journal evidence the relay reads is the generic Turn-cancel record, identical for both kinds.
- **The authority already admits the record.** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` lists `workflow` (`managed-session-records.ts:199-203`), so a `stopRequested` revision on a workflow row commits today — the close cascade already produces exactly that revision.
- **The waiter text already names the kind.** `childRunEndedText` renders through `childKindLabel` (`hosted-child-agent-session.ts:346-360`): a stopped workflow child answers "Workflow child run cancelled (stop_requested).".
- **The contract names child_agent only.** The v1.40 paragraph of `info.description` and the `TaskActionCapability` description both describe cancel as a `child_agent` action.
- **The WebShell task panel shows `child_agent` tasks only** (`ManagedTaskPanel.tsx:103`), so its cancel client never observes a workflow task (the kind check at `use-managed-task-cancel.ts:311` is unreachable for one).

## Decisions

1. **One set member changes; no other Java production code moves.** `CANCELLABLE_TASK_KINDS` becomes `{child_agent, workflow}` and its comment is rewritten: a workflow run's cancel rides the same durable stop request, the same record-first verdict, the same bounded delivery and the same relay stop arm as a child agent's. The view, the admission recheck and the verdict align by construction, because all three read the one rule.
   - A workflow run's task states are the shared `child_run` vocabulary, so `CANCELLABLE_TASK_STATES` (`pending`, `running`, `waiting`, `degraded`) applies unchanged; a terminal or `recovery_blocked` workflow task advertises no action and a new cancel answers `409 task_action_unavailable`, exactly as a child agent's does.
   - The record-first verdict's load-bearing invariant holds for the kind: a terminal `child_run` revision freezes everything but its delivery line (`isChildRunSuccessor` serves both kinds), so "ended without a stop request" remains the only definitive refusal, and a natural completion that won the race keeps its ordinary settlement with the request recorded.
2. **No TypeScript production change.** The current-state list above is the whole path, and every rung of it is already kind-blind or already admits `workflow`. What this slice adds on the TS side is nothing; the existing workflow funnel tests (`hosted-child-agent-session.test.ts:1123`, the abort wiring pins in `hosted-workflow-turn.test.ts`) stand as the evidence.
3. **No migration.** `managed_agent_operation.task_id` (V62) is kind-agnostic and the operation row carries no kind. The one-open-operation rule, the parked-cancel exclusion and the lifecycle-scan exclusion already key on `TASK_CANCEL`, not on task kinds.
4. **Contract 1.46.0 names the kind; no shape or status changes.** Both cancel routes stay `partial` — the route set, the outcomes and the operation shape are v1.40's. The description texts that named `child_agent` alone are updated, and `info.description` gains the v1.46 paragraph. The slice was written against `1.45.0`; main's persistence consolidation (#14069) claimed `1.45.0` while this branch was in flight, so it ships as `1.46.0`.
5. **The WebShell panel stays child_agent-scoped in this slice.** The panel's task filter is #13936's own scope decision; widening the panel and its submit gate to workflow tasks is a WebShell follow-up, not part of serving the route. A server-advertised `cancel` on a workflow task is contract-truthful regardless: the route serves it.
6. **The kind's Stage F fault round rides with the slice.** #13746's Stage F note makes serving cancel on a kind owe the fault round for that kind — a lost cancel reply, a cancel during settlement, and a cancel after the owner is gone — run on a real stack in #13823's shape (the packaged chain, a scripted model, fault-injecting taps). The same session closes the `child_agent` round's one remaining ordering (a cancel after the owner is gone), deferred from #13823's acceptance.

## Contract changes (1.46.0)

- `info.version`: `1.45.0` → `1.46.0`.
- `info.description` gains: "v1.46 extends public task cancel to workflow tasks (the H4f follow-up of the workflow runtime): a workflow task in pending, running, waiting or degraded, in an active Session, advertises cancel; its cancel rides the same durable task_cancel operation as a child agent's, and the result relay stops the workflow child through its own Turn's abort."
- `TaskActionCapability`'s description: "cancel: the cancel route accepts a new command for this task (since 1.40 for child_agent and 1.46 for workflow, tasks of those kinds in pending, running, waiting or degraded, in an active Session); …" — the rest unchanged.
- The generated WebShell types are regenerated in the same change (`npm run generate:managed-agent-api` in `packages/web-shell`): the `TaskActionCapability` JSDoc syncs from the description, with no shape change. The parity gate `managed-agent-api.test.ts` compares the generated file against a fresh render of the contract and fails otherwise — regenerate on any contract text edit.
- Nothing else: no route, shape, code or status change.

## Validation

- **Store** (`ManagedTaskCancelOperationTest`, H2 + Flyway): the per-state action rule gains the workflow arm; admission, replay and digest conflict run once over a workflow task.
- **Delivery** (`TaskCancelCoordinatorTest`): the `TaskTarget` fixture gains a workflow shape; completion from the record, `task_already_settled` without a send, and a live send run for a workflow target.
- **Relay** (`ChildResultRelayTest`): unchanged — the stop arm is kind-invisible (`RelayRow` carries no task kind and the arm reads none), so its child_agent stop fixtures already are the workflow evidence; the kind-bearing tiers are the store and the real-record chain.
- **Real records** (`ManagedExtensionRecordStoreTest`): a workflow chain committed through the Session store, through stop request and cancellation — the advertised action at each step, the `draining` runtime, the journaled `state_changed` events and the output cursor, mirroring the child_agent pin.
- **Contract** (`ManagedAgentApiContractTest`, `PlannedTaskContractTest`, `SurfaceAdmissionAcceptanceTest`): a workflow task's cancel exchanges on both surfaces, and the description-text pins updated.
- **TS**: no new behavior; the funnel's workflow cancel verbs and the workflow Turn's abort wiring are already pinned (`hosted-child-agent-session.test.ts:1123`, `hosted-workflow-turn.test.ts`).
- **Real stack**: the Stage F round of decision 6, planned in `.qwen/e2e-tests/2026-10-13-managed-workflow-task-cancel.md`.

## Follow-up work

| Item                    | Scope                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 kinds                | **Delivered in [H4f-c](2026-10-17-managed-h3-task-cancel.md):** A8 (#13889) already settles a platform-stopped Shell `stop_requested`; both kinds join `CANCELLABLE_TASK_KINDS`, their delivery stops the process through the Runtime Broker, and a Monitor's `stop_requested` settlement is its recorded stop. |
| `automation_run`        | Carries no stop request; H6's per_run target owns it.                                                                                                                                                                                                                                                           |
| Channel delivery cancel | **Delivered in [#13746 F3](2026-10-17-managed-delivery-task-cancel.md):** a delivery projects as a task of its route Session (`channel_delivery`) and takes the same task cancel while no adapter has claimed it; decision 10's separate route is not needed.                                                   |
| Child output events     | Delivered by the [child Session link](2026-10-17-managed-child-task-session-link.md) (#13746 F2): a workflow task names its child Session like a child agent task.                                                                                                                                              |
| WebShell panel          | **Delivered:** the panel lists workflow tasks with every other kind and admits a cancel wherever the task advertises it ([panel note](2026-10-12-managed-child-task-panel.md)).                                                                                                                                 |
| Close stops the child   | [#13875](https://github.com/QwenLM/qwen-code/issues/13875), unchanged: the relay's stop arm still skips a parent that is no longer `ACTIVE`.                                                                                                                                                                    |
