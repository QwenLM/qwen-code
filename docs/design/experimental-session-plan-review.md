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

## Boundaries

The Workflow remains observational. It does not schedule dependencies, retry
Agents, propagate completion, or add a Workflow store. `blockedBy` and
`todo_id` remain optional for sessions outside Plan & Review.
