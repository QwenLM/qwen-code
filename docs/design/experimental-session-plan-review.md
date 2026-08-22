# Experimental Session Plan & Review

## Goal

Make ordinary-session Workflow visualization opt-in and let users review the
exact Todo dependency graph before execution. Reuse Plan Mode, Todo snapshots,
and the existing permission lifecycle.

## Rollout

`experimental.sessionWorkflow` is disabled by default. When disabled, Core,
the ACP session, and the Web Shell retain their existing Todo, Agent, approval,
and split-view behavior. No Workflow marker or revision context is created.

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
- Mark Todo output only while the experimental setting and Plan/revision
  context are both active. The Web Shell ignores ordinary Todo snapshots.
- After approval, require top-level Agent calls to use a `todo_id` from the
  approved revision. Nested Agents and ordinary sessions keep existing rules.
- Fall back to the existing text-only approval when no matching snapshot is
  available.

### Phase 3: current-session Workflow

- Add an experimental Workflow full-page view beside the existing Chat view.
- Reuse the active Todo snapshot, daemon task polling, linked Agent tools, and
  the existing artifact panel instead of introducing another workflow model.
- Keep a matching `exit_plan_mode` approval in Chat. After approval, the user
  can open Workflow for observation at any time.
- Keep Chat mounted while Workflow is visible so switching views does not
  interrupt execution or discard composer state.
- Reuse the existing dependency graph as the main Workflow surface and derive
  activity, deliverables, and attention from the same Todo and daemon-task
  snapshots.
- Let a selected step show its upstream and downstream relationships plus the
  linked Agent's latest activity and runtime metrics. Opening an Agent continues
  into the existing transcript and artifact panel.
- Show Skill calls from the Agent transcript, Session artifacts from the
  existing artifact store, and keep current permission decisions in the
  existing Chat approval component.
- Keep the Workflow entry available after completion, later chat turns, and
  session resume by reading marked Todo snapshots from the transcript. Opening
  the Session normally restores the entry when a marked snapshot exists.
- Preserve an active Todo's existing dependencies when an update for the same
  ID omits `blockedBy`; an explicit empty array removes dependencies.

## Boundaries

The Workflow remains observational. It does not schedule dependencies, retry
Agents, propagate completion, or add a Workflow store. `blockedBy` and
`todo_id` remain optional for sessions outside Plan & Review. Skill versions
and a durable decision ledger are not claimed because the current transcript
does not provide them.

The standalone cockpit mock remains a product reference rather than a second
application embedded through an iframe. The Web Shell Workflow page reuses the
mock's plan, progress, Agent activity, and detail concepts while leaving
DataWorks-specific scheduling, retry, and approval queues to their owning
product.
