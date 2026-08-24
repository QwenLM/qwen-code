# Web Shell agent-task callback

## Goal

Let an embedding host react when the active session gains or loses subagents
without polling daemon task APIs or reproducing Web Shell's transcript merge.

## Design

Add an optional `onAgentTasksChange(tasks)` prop to `WebShell`. The callback
receives the same merged agent-task snapshot used by Session Overview: agent
tool calls retained in the transcript are combined with current `/tasks`
records, preserving the existing correlation and deduplication behavior.

The callback is independent of the built-in header and overview-panel
configuration. It reports an empty list when no agent tasks are available, so
hosts can derive visibility with `tasks.length > 0` and clear stale state when
the session changes. The initial snapshot is delivered after mount; subsequent
snapshots with identical task content are suppressed even when streaming or
polling replaces the source arrays. Immutable prompt text and poll-only changes
to runtime, stats, and recent activity telemetry are omitted from the change
fingerprint; changes to the task roster, status, or stable metadata still
produce a new snapshot. It adds no task requests and does not block rendering.
