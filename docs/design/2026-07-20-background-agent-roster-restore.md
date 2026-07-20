# Background Agent Roster Restore

## Context

Background agents have three distinct layers:

- sidecar metadata and JSONL transcripts persist logical identity and history;
- `BackgroundTaskRegistry` indexes the current session's addressable tasks;
- `AgentHeadless` executes a task and is reconstructed from the transcript when
  a completed task is continued.

The current resume loader restores only sidecars left in `running` state. A
completed agent therefore disappears from the registry after its parent session
is restored, even though its transcript is still available. The model also has
no tool for querying the background-agent registry: `/tasks` is a user-facing
command and `task_list` is the Agent Teams work board.

## Goals

- Restore recent completed background agents into the session registry with
  their original IDs.
- Add a model-callable `list_agents` tool for on-demand discovery.
- Keep `send_message(task_id)` as the single continuation operation.
- Give the model one short, one-shot reminder after a restore instead of
  attaching a full roster to every request.

## Non-goals

- Persisting JavaScript runtime objects across session or process teardown.
- Replacing the Agent Teams `task_list` tool.
- Listing shells, monitors, workflow runs, or Agent Teams teammates.
- Adding a separate `followup_task` tool.
- Keeping a completed agent runtime alive between instructions. That lifecycle
  change is intentionally handled by a separate design and PR.

## Design

### Restore

The existing session-directory scan accepts both `running` and `completed`
sidecars:

- `running` becomes `paused`, preserving the existing interrupted-work
  behavior;
- `completed` remains `completed`, is marked already notified, and carries the
  transcript and metadata paths needed by `send_message` revival.

New sidecars persist whether the original launch was backgrounded. Entries are
restored only when that marker is explicitly true; foreground and legacy
unmarked sidecars are skipped because their launch mode and working-directory
requirements cannot be inferred safely.

Only the newest retained completed entries are restored. Running entries are
never removed by this limit.

### Discovery

`list_agents` is a read-only parent control-plane tool on the normal tool
surface. Bare mode intentionally keeps its minimal tool set, so it neither
registers this tool nor injects a recovered-agent model reminder. The tool reads
the live `BackgroundTaskRegistry` and returns only backgrounded agents:

- `task_id`
- `subagent_type`
- `description`
- `status`
- `can_message`
- `resume_blocked_reason`, when present

The tool does not inspect disk or expose resident runtime handles. Restoring
disk state into the registry remains a separate lifecycle operation.

### Continuation

The existing `send_message` behavior remains authoritative:

- running agents queue the message;
- paused agents resume with it;
- completed agents revive from their transcript.

Worktree-isolated agents are restored for visibility but marked
non-continuable. Their temporary worktree is finalized after the original turn
and cannot be reconstructed safely from the transcript alone.

The isolation and background markers are new metadata. A legacy interrupted
sidecar cannot be distinguished safely from a foreground or caller-owned
working-directory run, so it is not restored. Newly written background
sidecars always persist both markers.

The restore boundary necessarily loses the old runtime. The preserved task ID
and transcript provide logical continuity. This PR deliberately keeps the
existing one-shot runtime lifecycle: each completed follow-up reconstructs an
agent from the retained transcript.

### Model reminder

After at least one agent is restored, the next ordinary top-level user prompt
receives a single system reminder telling the model to call `list_agents` and
then `send_message`. Slash commands do not consume the reminder. The roster
itself is never injected automatically.

## Validation

- `list_agents` returns only addressable background agents and correct
  continuation capability.
- tool registration and subagent/teammate exclusions are enforced;
- interrupted and completed sidecars restore with stable IDs and history paths;
- completed entries do not emit duplicate completion notifications;
- restored compatible completed entries remain continuable through
  `send_message`;
- the reminder appears on the first post-restore model request only;
- existing same-session transcript continuation remains green.
