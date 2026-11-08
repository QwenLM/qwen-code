# Background Agent Roster Restore

## Context

Background-agent sidecars and JSONL transcripts persist logical identity and
history, while `BackgroundTaskRegistry` indexes the current session's
addressable tasks. The resume loader currently restores only sidecars left in
`running` state. Completed agents therefore disappear from the registry after
their parent session is restored, even though their transcripts remain
available. The model also has no tool for querying the registry.

## Goals

- Restore recent completed background agents with their original task IDs.
- Add a model-callable `list_agents` tool for on-demand discovery.
- Keep `send_message(task_id)` as the continuation operation.
- Give the model one short, one-shot reminder after restoration.
- Apply the same restoration behavior to TUI, headless, and ACP entry points.

## Non-goals

- Persisting a live JavaScript runtime across process teardown.
- Replacing the Agent Teams `task_list` tool.
- Restoring failed or cancelled agents.
- Reconstructing temporary worktree isolation.

## Design

The session-directory scan accepts both `running` and `completed` sidecars.
Running entries become paused, preserving the existing interrupted-work
behavior. Completed entries remain completed, are marked already notified, and
retain the transcript and metadata paths needed by `send_message` revival.

New sidecars persist whether the original launch was backgrounded. Completed
entries are restored only when this marker is explicitly true, so foreground
and legacy unmarked completed sidecars are not exposed as reusable background
agents. Legacy running sidecars retain the existing recovery behavior.

The loader verifies the sidecar filename and parent-session owner before
registration. A retained row with a missing transcript, mismatched transcript
identity, incompatible isolation, or conflicting working directory remains
visible but is marked non-continuable. Worktree-isolated rows are treated the
same way because their temporary ownership context cannot be reconstructed
safely. Only the newest retained completed entries are restored; running
entries are not subject to that limit.

`list_agents` reads the live registry and returns background agents with a
stable `task_id`, description, type, status, continuation capability, and any
blocking reason. It does not scan disk. The tool is caller-owned and excluded
from subagents and teammates.

After restoration, the next ordinary top-level user prompt receives a single
system reminder to call `list_agents` and then `send_message`. Slash commands
and interrupted-turn continuations do not consume this reminder. Bare mode
does not receive it.

Session switches clear the in-memory registry before loading a new roster.
Failed resume rollback clears partially restored entries before restoring the
old session, and branching is blocked while background work is still active.

## Validation

- Running and completed sidecars restore with stable IDs and correct states.
- Foreground and wrong-owner sidecars are excluded.
- Unsafe retained state is visible but cannot be continued.
- Restored completed entries do not emit duplicate completion notifications.
- `send_message` can revive a compatible restored completed entry.
- TUI, headless, and ACP restore the roster and deliver the reminder once.
- New, clear, branch, and failed resume paths do not leak a prior roster.
