# Managed background Shell and Monitor task cancel (H4f-c)

[English](2026-10-17-managed-h3-task-cancel.md) | [简体中文](2026-10-17-managed-h3-task-cancel.zh-CN.md)

Status: implemented in this change. The `background_shell` and `monitor` task kinds join the public task cancel path, and the contract names them in `1.54.0`. Landed: the two kinds in the one cancellable-kind rule, a delivery that stops the task's process through the embedded Runtime Broker, a verdict that reads a Monitor's `stop_requested` settlement as its recorded stop, and a real-stack gate (FG8g) that cancels a live background Shell and a live Monitor watch. No TypeScript changes.

This is the H3 part of [#13746](https://github.com/QwenLM/qwen-code/issues/13746) F1, slice H4f-c of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of [#12380](https://github.com/QwenLM/qwen-code/issues/12380). The H4f slice (#13823, [design](2026-10-10-managed-task-cancel.md)) cancelled `child_agent` tasks and the H4f-b slice (#14076, [design](2026-10-13-managed-workflow-task-cancel.md)) added `workflow`. Both deferred these two kinds until their gates lifted, which #13889 ([H3 enablement](2026-10-11-managed-h3-enablement.md)) did.

## Problem

Since #13889, a model can start a background Shell (`run_shell_command` with `is_background`) or a Monitor watch that outlives its turn and holds its Runtime until it exits. Both are tasks a caller can list and watch, but not stop: a cancel answers `409 task_action_unavailable` and the task view advertises no action. The only stop is the Session close's drain, which stops everything.

## Current state

Checked at `3bddf6e0bb` (contract `1.51.0`):

- **The gate.** `CANCELLABLE_TASK_KINDS` is `{child_agent, workflow}` (`ManagedExtensionProjection.java:130`). Its readers are the view's and the admission's `taskActions` and the delivery verdict in `TaskCancelCoordinator`.
- **Records.** A background Shell is a `child_run` record with `kind: "shell"`, and a Monitor is a `monitor_run` record. Each record id is the start call's `executionCallId` (`hosted-workspace-tool-turn.ts:4120`, `:4128`). The Shell body has a set-once `stopRequested`. The `monitor_run` body has none, and its key set is closed (`ManagedExtensionRecords.java:161`).
- **A platform stop already projects as a stop (A8, #13889).**
  - The worker's registry marks a run it is asked to stop before it kills it (`managed-background-shell-registry.ts:141`), and the Monitor registry delegates to it (`managed-monitor-registry.ts:80`).
  - The stop answers only with the run's completion, after the stop-marked finalize was delivered (`:146`).
  - The Hosted publisher settles a marked Shell end with `requestStop` then `settleStopRequested` (`hosted-shell-publisher.ts:919`). It hands a marked Monitor end to the watch's loop, which settles `stop_requested` (`:806`, `hosted-monitor-loop.ts:268`).
- **Who can stop one process.**
  - The Broker's drain sweep runs status, then the family's stop (`shell-terminate` or `monitor-stop`), then status again for every hold row of a Runtime Session (`RuntimeBrokerService.java:2658`). Only the worker's `exited` answer settles a row.
  - The client control route admits only Monitor kinds, for the Session's own watches (#13896). Shell kinds fall through to the provider protocol and are refused (`:828`).
  - The Hosted Harness has no route that stops one Shell or Monitor. `/children/operations` serves child Session kinds only, and its `cancel` on a Shell record throws (`hosted-child-agent-session.ts:1794`).
- **The H4f follow-up row** asked for "Shell settles `stop_requested` after its request, Monitor gains a stop request". A8 delivered the first half. Decision 2 replaces the second.

## Decisions

1. **Both H3 kinds join the one rule.**
   - `CANCELLABLE_TASK_KINDS` becomes `{child_agent, workflow, background_shell, monitor}`. The view, the admission recheck and the verdict read the same set, so they agree by construction.
   - The states are unchanged: `pending`, `running`, `waiting` or `degraded`, in an `ACTIVE` Session.
   - A `recovery_blocked` run still advertises nothing. A stop on a blocked run cannot reach its owner (H3 open question 3).

2. **The record's own stop is the authority's statement. A Monitor gains no field.**
   - A Shell's stop is its `stopRequested` flag, which A8 writes before the settlement.
   - A Monitor's stop is its `stop_requested` settlement. Adding a stop request to `monitor_run` would change a closed record body in both languages and its fixtures. It would also set a rollback floor: an older reader refuses the record.
   - The Monitor's stop is short and bounded (the worker's 5 s grace), so its acceptance and its physical settlement are the same commit. The verdict still reads only the committed record.
   - Consequences:
     - A Monitor's operation completes at the moment its task settles `cancelled`.
     - A Monitor never projects `draining`.
     - Any `stop_requested` settlement completes a pending Monitor cancel, for example the close drain's. Requests coalesce, as for the other kinds.

3. **Delivery stops the process through the embedded Broker, not the Harness.**
   - A new `RuntimeBrokerService.stopBackgroundProcess(tenant, session, executionCallId)` finds the hold row `<executionCallId>:process`. It requires:
     - that the row belongs to the task's Session: its Harness Session is the managed Session, and the Runtime Session's tenant matches;
     - that the Runtime Session is ready in this Broker.
   - It then runs the drain sweep's status → stop → status for that one row.
   - **Why the Broker.**
     - The Broker owns the hold row and already issues this exact stop for the close drain.
     - The Harness holds nothing for an idle background run that survives its restart. The publisher capture and the Monitor loop live in its process, and a held Runtime Session is re-acquired only by the close: each turn acquires a Runtime Session of its own id, so a later turn never re-acquires the one a background run holds.
     - A stop that never landed leaves the record live, so the coordinator's budgeted retry re-drives it. That gives a durable re-drive without a new scanner.
   - **Why unfenced.** It runs like the #13896 client Monitor control. The non-terminal hold row already keeps the Runtime Session from releasing. A fenced control would make a racing close's drain refuse `runtime_session_busy`.

4. **The outcomes follow the H4f table.**

   | Committed record                                                              | Operation outcome                                                         |
   | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
   | the stop is recorded (Shell `stopRequested`, Monitor `stop_requested`)        | `completed` with a receipt                                                |
   | the run ended without one (`exited`, `max_events`, `idle_timeout`, a failure) | `failed` `task_already_settled`                                           |
   | the run is live                                                               | stop through the Broker, then read the record again                       |
   | the stop is unproven                                                          | retry within the budget, then park as `recovery_blocked` (H4f decision 5) |
   - **What counts as unproven:** the worker cannot prove the end, or no Broker is configured.
   - **A Runtime Session this Broker holds no context for** (a fresh process after a Java restart, before the close acquires it again) parks the cancel at once instead of retrying: an idle Session's held Runtime Session comes back only with the close, and an open cancel would hold the Session's operation slot, and with it that close, for the whole budget. A parked cancel holds nothing, so the close goes ahead, and the close drain's `stop_requested` settlement completes the parked cancel at its next recheck. The record is read again first, so a process that ended meanwhile settles the cancel as usual.
   - **The natural-completion race:**
     - A natural end that the stop's first status read finds keeps its outcome.
     - An end inside the stop's own window is marked, because the worker marks before it kills. It projects `stop_requested`, by the same A8 rule the close drain follows.

5. **No TypeScript change.** The worker's marker, the publisher's A8 settlement and the Monitor loop's marked exit already exist. The verdict needs nothing beyond what the record already commits.

## Contract changes (1.54.0)

- `TaskActionCapability`'s description names `background_shell` and `monitor` beside `child_agent` and `workflow`.
- `info.description` gains the v1.54 paragraph.
- No route, schema or status changes. Both cancel routes stay `partial`.

## Validation

- **Delivery** (`TaskCancelCoordinatorTest`, 6 new tests):
  - a live Shell is stopped through the Broker, never the child operation route, and completes from its record;
  - a Monitor completes from its `stop_requested` settlement;
  - a process that ended first, with `exited` or `idle_timeout`, fails `task_already_settled`, and a settled one is never stopped;
  - an unproven stop and a missing Broker retry from the record;
  - a Runtime Session the Broker holds no context for parks the cancel at its first claim;
  - an unreachable stop over a process that ended meanwhile settles the cancel from the record instead of parking.
  - The kind without a cancel path is now `automation_run`.
- **Admission** (`ManagedTaskCancelOperationTest`, 1 new test): both kinds admit, replay and refuse by state like the other kinds. `automation_run` still answers `task_action_unavailable`.
- **Broker** (`RuntimeBrokerServiceTest`, 1 new test):
  - another Harness Session, another tenant, or an id with no hold row is `runtime_execution_not_found`, with no control sent;
  - an unproven stop asks status, stop, status and keeps the hold, so a routine release still answers `runtime_session_held`;
  - a proven stop settles the row with the start call as `targetOperationId`, after which release succeeds;
  - a settled row is never asked again.
- **Real stack** (FG8g, `HostedMonitorRunFaultGatesIT`, MySQL 8.4, packaged Harness, delegated cgroup v2): one case cancels a live background Shell held on its FIFO gate, and one cancels a live Monitor watch. Each case checks:
  - the task advertises `cancel`, and the public route answers `202` `task_cancel`;
  - the operation reads `completed`, and the same key replays it;
  - the task reads `cancelled` with no action;
  - over JDBC: one `TASK_CANCEL` row `COMPLETED` with a receipt, the record `cancelled` by `stop_requested` (a Shell also has `stopRequested`), and the hold row `SETTLED`.
  - **Result:** green in 5 runs on Linux x86_64 (MySQL 8.4.6, a delegated cgroup v2 root). Both processes ended by `SIGTERM`.
    - The Shell case completed on its second claim every time, 6.2 to 7.1 s after admission. The worker's first terminate answered before the unit reported empty, which is an unproven stop. The retry one backoff later found the retained exit and the settled record.
    - The Monitor case completed on its first claim, in 0.3 to 5.1 s.
- **Not covered:**
  - **The fault arms on the real stack.** A lost cancel reply, a Harness that is down when the worker finalizes, and a cancel after a Java restart are covered by the record-first unit tests only.
  - **The WebShell panel.** Listing these kinds there is the panel's own change.

## Constraints and risks

- **A Harness that is down when the worker finalizes.** If the publisher cannot take the finalize, the record stays live. The cancel retries, parks after its budget, and reconciles once the record settles: through the finalize's redrive, the next acquire's observation, or the close.
- **A Java restart.** A held Runtime Session is not in a fresh Broker process until the close re-acquires it. A cancel in that window parks at once (decision 4); the caller closes the Session, whose drain stops the process and completes the parked cancel.
- **Windows where a retry would have reached the process.** The early park trades them for a free close: a Java restart while the turn that holds the Runtime Session is still running, which that turn's takeover re-acquires under its own id about a lease later; a cancel landing between an acquire's scope check and its context registration; and a control plane with several replicas, where a claim can land on one that does not hold the context (several live control planes are outside the first release). In each the cancel parks unconfirmed and the caller issues a new one; nothing reports a stop that did not happen.
- **The marked race.** An exit within the stop's window projects `stop_requested` rather than `exited`. It is the close drain's rule, accepted in A8.

## Follow-up work

| Item                    | Scope                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation_run`        | Carries no stop request. H6's per_run target owns it.                                                                                                                                                                                                         |
| Channel delivery cancel | **Delivered in [#13746 F3](2026-10-17-managed-delivery-task-cancel.md):** a delivery projects as a task of its route Session (`channel_delivery`) and takes the same task cancel while no adapter has claimed it; decision 10's separate route is not needed. |
| Child output            | #13746 F2: link a child task to its child Session.                                                                                                                                                                                                            |
| WebShell panel          | Show `workflow`, `background_shell` and `monitor` tasks and admit their cancel (`ManagedTaskPanel.tsx`, `use-managed-task-cancel.ts`).                                                                                                                        |
| Stage F fault arms      | FG8g real-stack arms for a lost cancel reply, a Harness down at finalize and a cancel after a Java restart.                                                                                                                                                   |
