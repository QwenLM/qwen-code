# Managed child Agent task panel

[English](2026-10-12-managed-child-task-panel.md) | [简体中文](2026-10-12-managed-child-task-panel.zh-CN.md)

## Problem and current state

Managed Sessions expose task list, detail and event reads and durable task cancellation after #13823 and #13877. Web Shell has no provider methods or interface for these tasks. Cancellation operation completion proves a recorded stop request, not physical task settlement. Child Agent final text is not yet associated with public task Artifacts.

## Behavior and scope

The first version listed only `child_agent` tasks, showed their current state and event history, and requested cancellation. It does not create tasks, send task input, read a child transcript, or publish final results. Existing public Artifact references can be viewed through the existing bounded Artifact reader; missing references show an explicit empty state.

The Session header gains a Session tasks button (a child Agent tasks button before the follow-up below) when the provider supports reads and `capabilities.tasks` is explicitly true. If that capability is removed while a saved cancellation remains, a separately labeled resume task cancellation entry allows recovery, with all new cancellation controls disabled. A page container at least 1100px wide displays a 360px right panel; narrower containers use the shared Dialog and Web Shell portal. Opening and closing the panel preserve the composer, conversation and transcript pagination. The list shows a short task ID, state and creation time; detail shows the full ID, timestamps, elapsed time, available Runtime state, events and Artifacts. Returning to the list restores its page and scroll position.

The server has no kind filter. Read one raw page of 50 tasks, preserve its opaque cursor and order, and display its entries (the first version displayed only child Agent entries, so an empty filtered page with more pages was not evidence that the Session had no child tasks; since the follow-up below every entry is displayed). Previous and next buttons browse raw pages. Do not scan all pages or present a total count.

Task-panel translations use a separate bilingual dictionary. The read-only transcript build replaces it with an empty stub through the existing Vite message boundary, so exported transcripts retain their payload budget without carrying task-panel copy.

### Every task kind (follow-up of #13746)

The panel now lists every task the Session projects, each labeled by its kind: Child Agent, Workflow, Background Shell, Monitor, Automation run, Channel delivery, or a generic Task label for a kind this client does not know. Its title becomes "Session tasks" (会话任务).

- **Cancel follows the server.** The cancel control and the cancel hook no longer check the kind. A task offers cancel exactly when its view advertises `cancel` in `actionCapabilities`, the same rule the server's admission rechecks. Which kinds and states advertise it is the contract's decision (`TaskActionCapability`), so a kind that gains a cancel path needs no client change.
- **Reads take every kind.** The task reads no longer refuse a task whose kind is not `child_agent`. The resume path still checks the Session and task identity.
- **What a kind shows.** The detail view shows the kind above the task ID. A background Shell's or a Monitor's output events and output Artifact show through the existing timeline and Artifact reader. A channel delivery, once the server projects deliveries as tasks (#13746 F3), has no runtime state; until then its label is simply unused.

## Provider and synchronization

Add optional `tasks.list`, `tasks.get`, `tasks.listEvents`, `tasks.cancel.submit` and `tasks.cancel.query` to the Managed provider and carry optional `capabilities.tasks` in the summary. Types alias the generated WebShell task, event and command operation schemas. Java reads use the existing `/tasks/query`, `/tasks/get` and `/tasks/events/query` POST endpoints under `/api/agent/web-shell/v1`; mutations use `/tasks/cancel` and `/operations/query`. No endpoint, table, contract capability or Session event is added. Daemon has no task group. Java exposes cancellation only with an explicit `productScope` containing tenant and actor identity.

Separate task reads and cancellation recovery into two Session-level hooks. While the panel and browser tab are visible, refresh the current raw page, selected task and event page with serial completion-to-next-start 3-second polling. Closing the panel pauses ordinary reads; reopening or restoring visibility refreshes them. Events start from the retention floor, are deduplicated by opaque cursor and do not overwrite the task snapshot. Unknown event types advance the cursor without rendering. On `cursor_expired`, announce the missing history and restart at the floor. A page with `hasMore` requires the user to load more before tail following resumes. Session/provider/account changes abort requests and clear read caches; request ownership prevents delayed responses from changing another selection.

Background polling keeps cached reads interactive and does not announce a new loading state every three seconds; initial reads and explicit refresh/navigation show loading. Timestamps follow the panel language, and detail labels and values use separate columns.

The `cancel` task action describes task support, not actor permission. Do not infer Workspace roles or use `workspaceTurns` to authorize cancellation. Server `403 task_forbidden` is shown as insufficient permission. A local cancel does not lock sending, cancel the parent or resolve approvals.

## Cancellation and recovery

Use inline confirmation. Explain that stopping takes time and existing results are retained. Save the original Session, task and idempotency key in `sessionStorage` before sending; scope records by provider identity, Session and task. If the first save fails, send nothing. Save the operation ID after admission.

Known operations are automatically queried when returning to the Session, even if the task capability was removed. An intent without an operation ID requires a user click to replay the original request with its original key. Query with 1/2/3-second waits and then 3-second waits, with a 30-second budget for each confirmation round. A timeout, failed query, lost reply or `recovery_blocked` remains unconfirmed and offers continue confirmation. Do not invent a new key, automatically resend a blocked operation or offer abandonment as cancellation.

Pending/running commands display submitting cancellation; a completed command with a nonterminal task displays stop requested, waiting for task settlement. Only the authoritative task state displays cancelled, completed or failed. Natural completion wins its race. A definitive operation failure clears the recovery intent, reports its reason and refreshes the task; a new attempt requires a new user submission. A completed command is retained until a terminal task snapshot is read. A terminal task alone cannot settle an unknown command. Ordinary task reads and recovered completed cancellations keep tracking physical settlement, and elapsed waiting never converts confirmed admission into failure.

Before clearing an accepted cancellation, publish its validated task snapshot into the list and selected detail. Delayed nonterminal reads cannot replace a known terminal snapshot. Once a terminal task is observed, remove stale admission-contention/action-unavailable messages; retain other explicit command failures and unknown operation recovery.

Local duplicate cancellation for the same task is disabled. Other tasks and other tabs use server admission; `session_operation_active` reports contention. Query permission errors and missing operations retain uncertainty. Requests are aborted on identity changes and late replies are ignored.

## Verification and delivery

Deliver one frontend PR with this complete bilingual design and a tracked bilingual E2E plan. Use shared Button, Badge, Dialog and Artifact content UI, preserve React 18/19 refs and portal theme isolation, and cover keyboard access, focus recovery and status announcements.

Verify raw pagination with mixed kinds and empty filtered pages; events, expiry and absent Artifacts; pending/running cancellation, draining Runtime and natural-completion races; lost 202, original-key replay, reload, timeouts, revoked permissions and unavailable storage; old servers, Daemon, read-only hosts, delayed replies and two-tab contention. Validate that the composer and history survive and command completion cannot render task cancellation prematurely. Run affected client/provider/hook/component tests, Java task/cancel regressions, a real Java + Hosted child-task scenario, build, typecheck and two clean self-audit passes. Record platform and live-model limitations honestly. Final-result publication is a separate follow-up. There are no unresolved product decisions or migrations.
