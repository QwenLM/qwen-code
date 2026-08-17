# Session Workflow Approval Implementation

## Scope

Show the current Todo workflow inside the existing `exit_plan_mode` permission
panel so a user can review the dependency graph before execution starts.

## Implementation

1. Add an optional Todo snapshot to `ToolApproval` and render
   `PlanExecutionView` only for Plan Mode exit approvals.
2. Pass the active Todo snapshot from both the main session view and split
   session panes.
3. Preserve the ACP plan body as the text-only fallback when no Todo snapshot
   exists and leave non-Plan-Mode approvals unchanged.
4. Make workflow nodes selectable and show the selected Todo's full content,
   status, dependencies, and linked Agent executions below the graph.
5. Reuse the existing subagent detail panel for live progress and final output;
   do not add execution output to Todo snapshots or task polling.

## Verification

- Component test: Plan Mode approval renders a Todo dependency workflow.
- Component test: Plan Mode approval without Todos preserves its text content.
- Adapter test: ACP exit-plan content reaches the approval request.
- Wiring tests: main and split session approvals receive their own active Todo
  snapshot.
- Workflow test: selecting a node exposes its details and linked subagent opens
  the existing detail callback.
- Run the focused Web Shell tests, typecheck, and build.
