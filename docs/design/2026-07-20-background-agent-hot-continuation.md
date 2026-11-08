# Background Agent Hot Continuation

## Context

A completed background subagent currently loses its in-process runtime. A later
`send_message` reconstructs a new `AgentHeadless` from the JSONL transcript.
This preserves most visible conversation history, but recreates the chat, tool
surface, per-agent registries, and provider-side cache state.

The launch path also constructs ordinary background agents twice: once with the
parent emitter and again with the dedicated background emitter. The first
instance is never executed or disposed.

This design addresses the in-session lifecycle. Logical discovery and
continuation after restoring the parent session are handled separately by the
background-agent roster restore design.

The distinction is behavioral, not just an implementation detail. Within one
session, transcript revival already preserves the model-visible conversation,
so hot continuation primarily avoids runtime reconstruction and preserves
provider/tool state. Across a parent-session restore, the original in-memory
runtime cannot survive process teardown. Logical continuity therefore comes
from restoring the task identity and transcript into the new session, followed
by one cold reconstruction.

## Goals

- Create one runtime for a fresh ordinary background agent.
- Keep that runtime resident after a successful turn.
- Continue a completed task on the same chat and prepared tool surface.
- Preserve the current task row, task ID, per-turn start/completion events, and
  terminal notifications.
- Keep transcript revival as the fallback when no compatible resident runtime
  exists.
- Release resident resources on failure, cancellation, session shutdown/reset,
  terminal-entry eviction, working-directory changes, branch switches, and ACP
  session close/disposal.
- Atomically claim input queued in the finishing window before publishing a
  successful completion.

## Non-goals

- Persisting a live runtime across processes or parent-session restoration.
- Adding an `idle` value to the shared task-status union.
- Changing how messages sent to an actively running agent are injected between
  tool rounds.
- Making fork agents persistent.
- Extending temporary worktree lifetime across completed turns.
- Making globally registered frontmatter hooks safe to leave installed while an
  agent is idle.

## Design

### Reusable headless runtime

`AgentHeadless` keeps its `GeminiChat` and prepared tool declarations as
instance state. Its public `execute()` remains a per-turn operation:

- only one call may run at a time;
- final text and termination mode are reset at the start; statistics reset for
  a new parent instruction but remain cumulative across internal stop-hook
  retries of that instruction;
- the first call creates the chat and prepares tools;
- later calls append a new user turn to the same chat and emit an external
  message event so the JSONL transcript remains complete.

This keeps the existing `AgentHeadless` hooks, telemetry, external-message
drain, and terminal result contract. `AgentInteractive` is not used because its
queue API does not provide the per-turn completion result and notification
semantics required by background tasks.

### Resident controller

`BackgroundTaskRegistry` owns an in-memory controller table keyed by task ID.
The controller is intentionally separate from `AgentTask`, which remains a
serializable UI/status record.

A controller can:

- start a continuation from a completed row;
- abort and dispose its runtime.

On a completed `send_message`, the tool first asks the registry for a resident
continuation. A hit synchronously changes the existing row back to `running`,
claims a normal background execution slot, and schedules the new turn after
the previous turn has fully settled. A miss uses the existing transcript
revival service.

`completed` continues to mean “the latest turn completed.” Runtime residency is
an internal implementation fact, so the shared task status and UI do not gain a
new idle state.

### Per-turn and resident resources

Each continuation receives a fresh abort controller, SubagentStart/Stop hook
pair, trace span, task-start event, completion notification, and sidecar status
transition. A runtime that would need a child-only AUTO permission lease is not
retained because those leases are not reference-counted across concurrent
subagents.

The chat, prepared tools, JSONL writer, event listeners, agent-scoped tool
registry, and per-agent MCP resources remain alive while the controller is
resident. Disposal is idempotent.

The existing terminal-entry retention limit also bounds resident controllers.
Pruning a row disposes its controller. Registry reset and shutdown dispose all
controllers, including already-completed ones.

### Compatibility exclusions

The first version retains only ordinary named background agents that:

- completed normally;
- do not use `isolation: "worktree"`;
- do not declare frontmatter hooks;
- do not require a child-only AUTO permission lease.

Temporary worktrees are currently finalized after each turn, so retaining a
runtime would leave its Config pointing at a removed directory. Frontmatter
hooks are currently registered globally for their lifetime, so retaining them
while idle could affect unrelated work. Child-only AUTO leases mutate the
parent permission manager and are not reference-counted across concurrent
subagents, so reacquiring them per hot turn would be unsafe. Hooked,
worktree-isolated, and child-only AUTO agents continue through the existing
JSONL revival flow. The reconstructed worktree agent runs from the current
parent working directory because its temporary launch worktree has already
been finalized.

## Races and failure handling

- Immediately before a compatible runtime publishes successful completion, the
  active turn drains the registry queue without yielding. If it claims input,
  the same headless runtime executes that input and the task remains running.
  If the queue is empty, transcript persistence and the running-to-completed
  transition happen synchronously, so a later `send_message` observes the
  completed row and uses the resident-continuation path instead of receiving a
  misleading queued acknowledgement. Worktree-isolated turns perform their
  final drain before teardown because their runtime is intentionally not
  continuable afterward.
- The registry performs the completed-to-running transition synchronously
  before the continuation promise is scheduled. A second concurrent
  `send_message` therefore observes `running` and uses the existing in-round
  message queue.
- The next turn is chained after the prior turn promise, covering the window in
  which the completion notification is emitted before the prior `finally`
  block has finished.
- Failed and cancelled turns remove and dispose the resident controller.
- If claiming a background slot fails, the row stays completed and the caller
  can use the existing cold-revival error path.
- Disposal during an active turn aborts its controller and defers destructive
  resource cleanup to the turn's finalizer.

## Validation

Unit tests must prove:

- a fresh background launch creates exactly one `AgentHeadless`;
- two sequential turns use one `GeminiChat` and one prepared tool list;
- completed `send_message` prefers the resident controller;
- absence of a resident controller still invokes transcript revival;
- the second user instruction is present in JSONL;
- reset, shutdown/cancellation, and terminal pruning dispose exactly once.
- `/branch` refuses running background work and disposes terminal residents only
  after the branch has initialized successfully;
- working-directory changes and ACP session disposal release resident runtimes.

The E2E scenario uses one task ID for two completed phases and verifies that the
second phase remembers a nonce from the first. Physical runtime identity is
verified by unit tests because stream JSON does not expose constructor counts.
