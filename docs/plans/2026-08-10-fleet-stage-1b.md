# Fleet Stage 1B implementation plan

## Goal

Upgrade the Stage 1A in-process Fleet preview to a usable subprocess MVP. A
leader coordinates at least two independent Qwen teammate processes through
the existing task and message tools, while a wide terminal shows the leader
and teammate transcripts at the same time.

Stage 1B keeps the semantic channel authoritative. The simultaneous views are
bounded transcript panes, not raw terminal attach. Raw PTY takeover, external
attach, multi-client leases, and crash reattachment remain Stage 3 work.

## User-visible acceptance

With `experimental.fleet: true` and `experimental.agentTeam: false`:

1. `/coordinate` creates two or more teammate OS processes with PIDs different
   from the leader.
2. On a sufficiently large virtual viewport, one frame simultaneously shows
   the leader and at least two named teammate panes.
3. Each pane updates live with status, messages, tool activity, and final text.
4. Existing left/right tab navigation selects the active pane; the single
   composer sends only to that selected session.
5. Small terminals, screen readers, dialogs, and native-scrollback mode fall
   back to the existing single-view tabs.
6. A clean leader exit stops every supervised teammate.
7. A subprocess teammate cannot create a nested team and cannot expose a
   supervisor credential to shell, MCP, or hook children.
8. Disabling Fleet still hides `/coordinate`; legacy `agentTeam` keeps its
   in-process behavior.

## Product boundary

### Included

- supervisor bootstrap and the MVP semantic operations
- authenticated worker sideband with ordered control delivery
- one hidden teammate worker entrypoint
- `SupervisedRuntime` and `RemoteSession`
- transcript projection into `AgentSessionView`
- Fleet runtime injection through the existing `Config` factory
- subprocess teammate identity and shared-mailbox routing
- bounded Leader + teammate transcript grid
- clean shutdown, spawn failure, worker failure, and narrow-screen fallback

### Deferred

- raw PTY bytes in a pane or full-screen terminal takeover
- external attach/detach commands and attach leases
- scrollback search and arbitrary shell/TUI hosting
- crash survival, supervisor restart recovery, reattach, and respawn
- cross-process plan-required teammate approval
- single-leader lock and socket fan-out
- Arena migration, tmux/iTerm surfaces, and `Backend` deletion

## Architecture

The leader injects a CLI-owned `SupervisedRuntime` into core's existing
`AgentRuntimeFactory`. `TeamManager` continues to depend only on
`AgentRuntime` and `AgentSession`.

```text
Leader TeamManager
        |
        v
SupervisedRuntime ---- authenticated supervisor socket ---- Supervisor
        |                                                    |
        | RemoteSession                                      | spawn/control
        v                                                    v
AgentSession events <--------- worker sideband ---------- teammate process
        |
        v
session projection -> AgentSessionView -> FleetGrid / existing tabs
```

The worker loads the normal CLI configuration, starts one existing
`InProcessRuntime` session inside its own OS process, and forwards structured
session events. It never infers state by parsing terminal output.

## Protocol changes

The supervisor protocol gains Fleet-specific serializable payloads:

- a dispatch request carrying a session identifier and the path to a private
  `0600` spec file; prompts, tokens, and the inherited environment do not go in
  process arguments or persisted launch metadata
- worker events for `ready`, correlated status, turn text, tool activity,
  approval request, view snapshot/delta, heartbeat, and exit
- worker controls for correlated send, cancel, structured approval answer,
  stop, and shutdown
- an acknowledgement cursor so polling cannot replay a control silently

Supervisor authentication remains process-global. Each worker additionally
uses a one-session token, consumes it during bootstrap, removes it from
`process.env`, and is authorized only for its own session.

## Implementation batches

### Batch 1: process and protocol

- Handle supervisor and teammate hidden routes before ordinary yargs/config UI
  startup.
- Implement the missing supervisor MVP operations and worker authorization.
- Keep an in-memory worker process table while persisting only non-secret
  session metadata through the existing store.
- Spawn workers with the current CLI argv helper and a sanitized environment.
- Make clean shutdown terminate all managed workers; make per-worker failure
  update only that session.

### Batch 2: runtime and identity

- Implement `SupervisedRuntime` and `RemoteSession` in CLI without importing
  CLI concepts into core.
- Start exactly one in-process agent host inside each worker and forward its
  structured events and view data.
- Resolve teammate identity from a consumed internal environment payload in a
  subprocess, while retaining AsyncLocalStorage precedence in-process.
- Reject `team_create` whenever a teammate identity exists.
- Let subprocess teammates send through the existing shared mailbox even
  though their process has no leader `TeamManager` object.
- Reuse the Stage 1A read-only declaration and execution allowlists.

### Batch 3: simultaneous transcript workspace

- Add a `FleetGrid` that uses fixed-size, dynamic virtual lists and never
  mounts Ink `Static` inside a pane.
- Render the leader on the left and up to three teammates on the right, with
  at least two teammates visible together for the acceptance demo.
- Reuse `activeView` as the highlighted pane and composer target.
- Keep the existing `AgentTabBar` for focus/navigation and the existing full
  transcript tab for detailed inspection.
- Require a minimum useful pane size; otherwise use the current tab layout.
- Dialogs and accessibility modes always win over the grid.

## Edge cases

| Case | Required result |
| --- | --- |
| supervisor already running | authenticate and reuse it |
| stale socket or startup lock | bounded retry and safe stale-lock cleanup |
| worker exits before ready | start fails with one actionable error; no roster ghost |
| one worker crashes | its pane becomes failed; leader and siblings continue |
| duplicate/replayed control | acknowledged cursor prevents a second execution |
| duplicate approval answer | existing one-shot call-ID behavior remains a no-op |
| read-only worker is prompted to write | declaration and execution layers both deny it |
| worker invokes `team_create` | fail closed under teammate identity |
| worker launches a shell/MCP/hook | no supervisor or worker token is inherited |
| leader exits normally or via SIGINT | every managed worker is stopped |
| supervisor cannot be reached | Fleet team creation fails; never silently uses in-process |
| legacy `agentTeam` only | existing in-process runtime and tab UI remain unchanged |
| Fleet off | `/coordinate` remains hidden and no supervisor starts |
| terminal too narrow/short | existing single-view tabs render without clipped panes |
| dialog opens | grid yields to the dialog and input focus is not stolen |
| teammate completes | transcript remains inspectable and status is terminal |
| second Fleet run in one leader | no stale listeners, controls, or worker records |
| Windows | named-pipe token auth and process-tree cleanup are preserved |

## Verification

Implementation is followed by one concentrated verification pass:

1. focused supervisor, runtime, identity, and Fleet grid unit tests
2. existing Stage 1A team/fleet/config regression tests
3. core and CLI typechecks, with core built first only if CLI resolution needs it
4. one real subprocess integration test proving distinct PIDs, messaging,
   read-only enforcement, and clean shutdown
5. one TUI dogfood recording at a fixed wide terminal size proving Leader plus
   two teammate panes in the same frame
6. `git diff --check` and one full diff audit

Full-suite tests, repository-wide formatting, repeated builds, PTY attach, and
Stage 2 recovery fault injection are intentionally not part of the inner
implementation loop.
