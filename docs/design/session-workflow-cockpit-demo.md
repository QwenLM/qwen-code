# Session Workflow Cockpit Demo

## Purpose

This branch turns the collaboration-cockpit reference into a real Web Shell page without introducing another workflow engine. The cockpit and the technical Workflow page are two projections of the same persisted session transcript and daemon task snapshot.

## Data and control flow

- The latest `todo_write` snapshot supplies stable Todo IDs, status, content, and `blockedBy` dependencies.
- Agent calls are linked to a Todo through `todo_id`; daemon task snapshots supply live status, activity, usage, and persisted transcript/output paths.
- `exit_plan_mode` remains the execution gate. When the experimental Session Workflow setting is enabled, a revision-bound approval opens the cockpit's four-step plan review before execution.
- Approval uses the existing permission API. The cockpit does not schedule, pause, or persist tasks itself.
- The Chat header opens either the collaboration cockpit or the technical DAG. The cockpit links back to Chat and to the technical Workflow, and Agent cards open the existing transcript detail panel.
- `?view=cockpit` makes the cockpit directly addressable and browser navigation returns to Chat.

## Demo

Enable **Experimental → Session Workflow Plan & Review**, enter Plan mode, and send:

> Review how the experimental Session Workflow feature is implemented in this repository and prepare a concise implementation assessment. Before asking to execute, call todo_write with exactly these pending steps and dependency IDs: inspect-ui; inspect-daemon; compare-cockpit blocked by inspect-ui and inspect-daemon; write-assessment blocked by compare-cockpit. Then call exit_plan_mode. After approval, delegate inspect-ui and inspect-daemon to two subagents in parallel, passing the matching todo_id to each Agent call. Keep all work read-only and return the final assessment in chat.

Expected flow:

1. The pending `exit_plan_mode` request opens the cockpit plan review with four nodes and the two-way fan-in dependency.
2. Approval starts execution and keeps the cockpit open as the live dashboard.
3. Selecting a Todo shows its dependencies and linked Agent; selecting the Agent opens its persisted transcript.
4. **技术 DAG** opens the compact execution graph, and Back returns to the cockpit.
5. **返回 Chat** resumes the conversation. The header or `?view=cockpit` reopens the completed workflow later.

## Deliberate boundary

The reference design's synthetic organization-wide queues, policy engine, and scheduler are not reproduced. “待我处理” is derived only from real failed or cancelled Agent tasks so the demo does not claim data or controls that the daemon does not provide.
