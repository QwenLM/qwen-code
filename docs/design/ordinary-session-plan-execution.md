# Ordinary Session Plan Execution

## Goal

Show an ordinary session's Todo plan as a dependency graph and connect each
node to the Agent executions that implement it. Reuse the existing ACP plan
stream, session task snapshot, and subagent detail session.

This feature is observational. It does not schedule, retry, unblock, or
complete work.

## Ownership and lifecycle

The feature deliberately keeps one source of truth per concern:

- Core owns the persisted Todo snapshot, dependency validation, and stable
  `planId` lifecycle.
- ACP plan updates carry the portable Todo projection plus Qwen metadata; no
  second workflow protocol or graph store is introduced.
- The session task registry owns live execution state. Agent sidecars retain
  only the durable identity needed after live tasks expire.
- Web Shell joins these streams for presentation. It never writes execution
  state or infers scheduler behavior from the graph.

This separation lets ordinary sessions continue without a planning gate while
Plan Mode adds an opt-in approval boundary over the same data.

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
5. Select a workflow node to inspect its full Todo content, status,
   dependencies, and linked Agent executions below the graph.
6. Open the existing live subagent detail panel from a linked Agent execution;
   it remains the source for streamed progress, tool calls, and final output.
7. Put missing or unknown `todo_id` bindings in an Unassigned group.

No graph library is added. Plans without dependency metadata keep list-style
presentation.

## Completed-session history

Each persisted Todo snapshot keeps a collapsed plan-execution entry in the
session transcript. Expanding it rebuilds the matching plan revision and its
root Agent executions from the parent transcript. If the matching revision
crosses the initially loaded history page, expansion uses the existing
transcript pagination path until it reaches the prior plan boundary or the
start of history. Nested Agent calls live in
their own transcripts, so the Web Shell then uses the existing subagent
resolver to read only lightweight descendant metadata from that session's
sidecars: task ID, parent task ID, tool-call ID, title, and lifecycle status.
Concurrent history consumers share the same pagination request and wait for
the loaded messages to commit before deciding that a plan boundary was reached.
If pagination fails, the history view remains explicitly marked as incomplete.

The sidecar projection is lazy, runtime-scoped, cycle-safe, and contains no
prompt, result, output path, or transcript content. Clicking either a root or
nested Agent continues to load the existing virtual subagent session by its
exact tool-call ID. This preserves the full subagent tree after the live task
registry has released foreground children without adding a graph endpoint or
duplicating execution data in Todo history.

The resolver indexes sidecars and parent Agent call metrics on demand. Indexes
are identity-scoped, bounded, shared across concurrent root lookups, and
actively evicted after a short TTL. Oversized lineage is reported as truncated
and the UI labels it as partial instead of silently presenting incomplete data
as authoritative.

## Plan Mode approval

Plan Mode is the opt-in execution gate for users who want to review a workflow
before work begins. When `exit_plan_mode` requests permission, Web Shell shows
the authoritative ACP plan body followed by the active Todo workflow in the
existing approval panel. The Todo view is supplemental because its snapshot can
differ from the submitted plan text. A dependency-aware workflow is rendered as
the same DAG used by the Tasks dialog; a workflow without dependencies keeps the
list presentation.

The existing permission lifecycle remains authoritative: approving exits Plan
Mode and starts execution, while rejecting keeps the session in Plan Mode. If
there is no active Todo snapshot, the approval keeps its existing text-only
presentation using the plan body carried by ACP. Sessions that do not enter
Plan Mode are unchanged.

Approval reads the latest active persisted Todo snapshot, independently of the
bottom panel's per-turn visibility rule. A user message can hide that footer,
but it does not clear the plan and therefore must not remove the approval DAG;
only an explicit empty or terminal snapshot does.

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
- Older daemons without nested lineage metadata retain the root execution view.
- Todo nodes do not invent step output; execution detail comes from linked
  Agent tool calls and the existing subagent detail session.
- Strict plan-first enforcement for every session remains out of scope because
  a session-level existence check could accept a stale plan.
