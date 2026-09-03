# Web Shell Monitor Details

## Goal

Let users open a monitor task from the background-tasks list in the Web Shell
right panel and keep its details current without adding another polling loop.

## Design

- Keep the status-bar task entry as the monitor discovery surface.
- Treat a monitor tool call as background-task activity so the existing task
  polling starts when a monitor is created.
- In the embedded background-tasks list, opening a monitor closes the dialog
  and opens a dedicated right-panel tab.
- Clicking a monitor tool in the transcript resolves the task through its
  launching tool-call ID and opens the same right-panel tab. Older snapshots may
  fall back to the monitor ID embedded in the tool result.
- Gate transcript-to-panel navigation on the `session_monitor_tool_correlation`
  capability. Older daemons retain the original inline tool expansion.
- If a capable daemon cannot resolve the clicked tool to a monitor snapshot,
  fall back to inline expansion instead of surfacing an error.
- Key the tab by monitor task ID so reopening the same monitor selects and
  refreshes the existing tab.
- Store the latest monitor snapshot in the tab. While the existing background
  task hook is polling, synchronize matching open tabs from those snapshots.
  The right panel does not fetch or poll independently.
- Wake the existing background-task poller when a monitor opens so resumed
  sessions stay live even when the originating tool call is outside the loaded
  transcript window.
- Render the existing task-detail presentation in the right panel so runtime,
  command, event count, dropped lines, exit code, and failure/stopped reason
  remain consistent with the background-tasks dialog.
- Follow the Subagent detail hierarchy: description first, status in a Badge
  tag beside the Stop action, compact metrics below, and the command in a
  monospace block.
- Keep the existing stop action available in the right-panel detail and refresh
  its snapshot immediately after cancellation.
- Keep shell and agent rows on their existing inline-detail behavior.

## Lifecycle

An active monitor continues to update through the existing background-task
poll. When it reaches a terminal state, the final snapshot updates the tab and
polling stops under the existing rules. Closing or reopening the task dialog
does not discard an already-open monitor tab.
