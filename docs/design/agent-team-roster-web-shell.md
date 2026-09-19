# Agent Team roster in CLI and WebShell

## Goal

Give a team leader one compact answer to “who is active, and what are they working on?” in both interactive CLI and WebShell, while preserving the existing teammate conversations, shared task list, and daemon session APIs.

## Existing pieces to reuse

- `TeamManager` owns teammate lifecycle, direct messaging, approvals, and the shared task list.
- CLI `AgentView` already owns teammate tabs and conversation navigation.
- CLI `LiveAgentPanel` already owns the compact, bounded live roster and keyboard focus behavior.
- `GET /session/:id/agents` already projects daemon-session agents into WebShell.
- WebShell `EnvironmentPanel` and `AgentWorkflow` already render agent state.

## Design

### CLI

`BackgroundTaskViewProvider` derives a second, display-only roster from the active in-process `TeamManager`. Each teammate is adapted to the existing agent-row shape and merged with ordinary live subagents only for `LiveAgentPanel`; it is not inserted into the background-task dialog or cancellation registry.

The adapter subscribes to team lifecycle events and shared-task updates. A row shows the teammate name, the current in-progress task when one is assigned, the distinct running/idle/completed/failed/cancelled state, and elapsed time. Enter on a teammate row opens its existing `AgentView` tab; Enter on an ordinary subagent keeps opening the existing background-task detail.

### WebShell

The existing session-agent snapshot adds active TeamManager members. No new HTTP route, SSE event, or client store is introduced. Team rows carry optional team name, color, and current shared-task metadata. WebShell's existing polling, environment sidebar, and workflow graph therefore receive team state automatically.

Idle is represented explicitly rather than collapsed into paused or completed. Team rows show the assigned task inline. Because WebShell does not yet expose an in-process teammate transcript endpoint, team rows are status-only there; ordinary subagent rows retain their existing detail action.

ACP sessions bind the same TeamManager leader callback used by the interactive and non-interactive clients. Teammate reports enter the existing serialized background-notification turn queue, so an idle WebShell leader resumes to reconcile results instead of ending after dispatch. Teammate tool approvals use the existing ACP permission request channel. Replacing or deleting a team detaches both callbacks and drops queued messages from the old team.

When a teammate is launched from an Agent definition, its declared MCP servers are passed into the existing in-process agent boundary. That boundary merges them over the session MCP map, discovers only the definition-owned servers in the teammate's isolated tool registry, and releases their transports with the registry when the teammate stops. This keeps the same more-specific-wins behavior and cleanup lifecycle as ordinary subagents.

## Interaction sources

- Claude Code Agent Teams: compact lead-side roster, explicit idle state, shared task ownership, and direct navigation to an existing teammate conversation.
- Multica: durable work-item ownership is visible independently of chat messages.
- Harness: execution state is projected into an existing workspace surface rather than creating a second execution engine.

## Scope

Included: current-session in-process teammates, shared task ownership, CLI navigation, WebShell status projection, teammate-to-leader continuation, teammate approvals, Agent-definition MCP inheritance, and terminal-state visibility.

Excluded: remote agent provisioning, durable workspace scheduling, cross-machine control, a new team chat UI, and WebShell teammate transcript browsing.

## Verification

- Focused unit tests for team snapshot serialization, CLI roster adaptation/rendering, keyboard routing, and WebShell idle/task rendering.
- Package builds and type checks for core consumers, CLI, SDK, ACP bridge, and WebShell.
- Executable WebShell smoke coverage with a mocked `/session/:id/agents` team response.
- Manual CLI E2E using `team_create`, named `agent` launches, `task_create`/`task_update`, roster navigation, and shutdown states.
- Real Chrome + tmux E2E against `qwen serve`, covering running/idle/cleaned roster transitions, automatic leader continuation, team shutdown/deletion, and rejection of a teammate `write_file` request through WebShell's permission dialog.
- Real stdio MCP E2E through an Agent definition used as a named teammate, proving the teammate can call its definition-only tool and report the result to the leader.

## Acceptance result

- Core Agent Team regression suite: 66 tests passed, including Agent-definition MCP merge and discovery.
- CLI focused suite: 96 tests passed for the changed roster and background-task surfaces; the broader feature suite previously passed 267 tests.
- ACP Session suite: 820 tests passed, including leader continuation, teammate approvals, and pending-approval cancellation when a team is detached.
- WebShell focused suite: 930 tests passed across App, panel, and transcript adaptation; App coverage verifies idle polling and teammate launch/inventory deduplication.
- Chromium WebShell smoke: passed against the mocked daemon route.
- Repository build and typecheck: passed.
- CLI, WebShell, ACP bridge, and all changed files: lint passed. The SDK package-wide lint command is blocked by its existing mixed ESLint 8/9 installation; the changed SDK type file passes lint directly.
- Live-model WebShell execution passed against a local tmux-hosted daemon. The leader resumed from real teammate reports, reconciled them, shut down teammates, deleted the team, and respected a rejected teammate write without creating the file. A final fresh-Chrome run confirmed that a named launch and its live inventory entry render as one running row before cleanup.
- A second live tmux + Chrome run launched a named teammate from an Agent definition, called its definition-only stdio MCP tool, returned `MCP_TEAM_PROOF:REAL_TEAM_MEMBER` to the leader, automatically resumed the leader, deleted the team, and left no MCP child process running.
