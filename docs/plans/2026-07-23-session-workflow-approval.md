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

## Verification

- Component test: Plan Mode approval renders a Todo dependency workflow.
- Component test: Plan Mode approval without Todos preserves its text content.
- Adapter test: ACP exit-plan content reaches the approval request.
- Wiring tests: main and split session approvals receive their own active Todo
  snapshot.
- Run the focused Web Shell tests, typecheck, and build.
