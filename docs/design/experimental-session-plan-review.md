# Experimental Session Plan & Review

## Goal

Make ordinary-session Workflow visualization opt-in and let users review the
exact Todo dependency graph before execution. Reuse Plan Mode, Todo snapshots,
and the existing permission lifecycle.

## Rollout

`experimental.sessionWorkflow` is disabled by default. When disabled, the Web
Shell keeps the existing Todo list and Plan Mode behavior but does not render
the Workflow DAG or rename Plan Mode. The setting changes presentation only;
it does not register tools, alter Todo semantics, or create another approval
mode.

When enabled, the existing `plan` mode is presented as **Plan & Review**. Plan
Mode remains the execution gate: read-only investigation is allowed, mutating
tools remain blocked, rejecting `exit_plan_mode` stays in Plan Mode, and
approving exits Plan Mode.

## Delivery

### Phase 1: opt-in presentation

- Expose the default-off setting through the existing daemon workspace settings
  route.
- Read the effective setting from the Web Shell's active workspace and apply it
  consistently to its main chat, split panes, and side-task panes.
- Keep Todo list rendering unchanged while gating Workflow DAG inputs.
- Rename the existing Plan entry only while the setting is enabled.

### Phase 2: revision-bound approval

- In Plan & Review, require a structured Todo execution snapshot whose nodes
  remain pending before approval.
- Carry the Todo plan identity and source tool-call identity with the
  `exit_plan_mode` approval request.
- Resolve the approval DAG from that identity instead of the latest active
  Todo list.
- Reuse the existing plan ID lineage so later snapshots and Agent executions
  continue updating the same Workflow without another store.
- Fall back to the existing text-only approval when no matching snapshot is
  available.

### Phase 3: current-session cockpit

- Add an experimental Workflow full-page view beside the existing Chat view.
- Reuse the active Todo snapshot, daemon task polling, linked Agent tools, and
  the existing artifact panel instead of introducing another workflow model.
- Open the Workflow view when a matching `exit_plan_mode` approval arrives.
  After the approval resolves, keep the Workflow visible for observation; the
  user can return to Chat at any time.
- Keep Chat mounted while Workflow is visible so switching views does not
  interrupt execution or discard composer state.
- Summarize overall completion, active Agents, and steps needing attention from
  the same Todo and daemon-task snapshots used by the graph.
- Let a selected step show its upstream and downstream relationships plus the
  linked Agent's latest activity and runtime metrics. Opening an Agent continues
  into the existing transcript and artifact panel.
- Keep the Workflow entry available after completion, later chat turns, and
  session resume by reading the latest Todo snapshot from the transcript. The
  compact Todo panel still clears on the next user turn.
- Preserve an active Todo's existing dependencies when an update for the same
  ID omits `blockedBy`; an explicit empty array removes dependencies.

## Boundaries

The Workflow remains observational. It does not schedule dependencies, retry
Agents, propagate completion, or add a Workflow store. `blockedBy` and
`todo_id` remain optional for sessions outside Plan & Review.

The standalone cockpit mock remains a product reference rather than a second
application embedded through an iframe. The Web Shell Workflow page reuses the
mock's plan, progress, Agent activity, and detail concepts while leaving
DataWorks-specific scheduling, retry, and approval queues to their owning
product.
