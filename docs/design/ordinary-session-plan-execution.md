# Ordinary Session Plan Execution

## Goal

Show an ordinary session's Todo plan as a dependency graph and connect each
node to the Agent executions that implement it. Reuse the existing ACP plan
stream, session task snapshot, and subagent detail session.

This feature is observational. It does not schedule, retry, unblock, or
complete work.

## Data contract

`todo_write` accepts optional `blockedBy` Todo IDs. The runtime validates that
IDs are unique, references exist, dependencies are not duplicated or
self-referential, and the graph is acyclic.

The Todo sidecar stores a runtime-generated `planId` with the current snapshot.
The ID remains stable while an active plan is revised. Clearing a plan, or
starting non-empty work after the prior plan completed, starts a new plan.

Todo result displays carry the `planId`, allowing live ACP projection and
history replay to produce the same metadata:

- plan update `_meta.qwenTodoPlan.id`: stable plan identity
- plan update `_meta.qwenTranscript.planToolCallId`: source Todo tool call
- plan entry `_meta.qwenTodo.id`: original Todo ID
- plan entry `_meta.qwenTodo.blockedBy`: dependency IDs when present

Clients that ignore `_meta` continue to receive standard ACP plan entries.

The Agent tool accepts optional `todo_id`. It is guidance, not a runtime gate:
top-level Agent calls should provide it when an active Todo graph exists.
Existing `AgentTask.toolUseId` joins the Agent tool call to live task status, so
the task API needs no additional field.

## UI flow

The active Todo pill continues to render the existing compact list. Clicking
it opens the existing Tasks dialog. When plan metadata is present, that dialog
adds a native CSS plan-execution section above the existing task tree:

1. Topologically layer nodes from `blockedBy`.
2. Group top-level Agent tool calls by `args.todo_id`.
3. Join live task rows through `task.toolUseId === tool.callId`.
4. Keep nested Agent rows under the root via `parentAgentId`.
5. Open the existing subagent detail panel with the Agent tool call.
6. Put missing or unknown `todo_id` bindings in an Unassigned group.

No graph library is added. Plans without dependency metadata keep list-style
presentation.

## Status composition

Todo status remains the business source of truth. Agent state is an execution
overlay:

1. Any linked execution running: Running
2. Otherwise, any linked execution paused: Paused
3. Todo completed: Completed
4. Any dependency Todo incomplete: Blocked
5. Todo in progress: In progress
6. Otherwise: Ready

A failed or cancelled execution adds a Needs attention badge without changing
the Todo status.

## Compatibility and boundaries

- Old Todo snapshots without IDs or dependencies remain readable.
- Agent calls without `todo_id` remain valid.
- Empty Todo snapshots must clear active state immediately.
- Full subagent results stay out of the three-second task polling response.
- Strict plan-first enforcement remains out of scope because a session-level
  existence check could accept a stale plan.
