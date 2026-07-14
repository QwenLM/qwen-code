# Silent Command Heartbeat

Date: 2026-07-14
Status: implemented

## Problem

A foreground shell command that produces no output emits no events between spawn and settle. In interactive TUI use this is fine — the spinner keeps moving — but for headless consumers (ACP gateways such as DataAgent, `--output-format stream-json` pipelines) the session goes completely quiet for the full duration of the command. A gateway watching the event stream cannot distinguish "a 165-second SQL probe is still running" from "the execution chain died", so long-running silent commands are reported by users as the agent hanging.

Production diagnosis of such a session (DataAgent session `77255d98`, 41-minute task, ~32 minutes spent inside tool waits) identified the missing liveness signal as one of three P0 reliability fixes, alongside shell timeout semantics (PR 1, separate change) and a todo stop-guard (PR 3).

Reference implementation: Claude Code polls the output file every second and invokes its progress callback even when the content is empty, then surfaces throttled, minimal-payload `tool_progress` events to SDK consumers. Progress never enters model context.

## Goals

- While a foreground shell command is silent, periodically emit a structured liveness signal to consumers that need it (ACP clients, stream-json).
- Carry stats only — elapsed time, output age, line/byte counts, effective timeout. Never command output.
- Never enter model context; never disturb the live-output display of interactive consumers.

## Non-goals

- Timeout auto-backgrounding (tracked separately as a P1 item).
- Streaming live command output to ACP clients (`content` frames).
- Forwarding MCP `mcp_tool_progress` over ACP, propagating subagent heartbeats into `AgentResultDisplay`, or TUI display enhancements — all follow-ups.

## Design

### Event shape

`ShellProgressData` joins the `ToolResultDisplay` union in `packages/core/src/tools/tools.ts`, mirroring the existing `McpToolProgressData` precedent, with a shared exported guard `isShellProgressData`:

```ts
interface ShellProgressData {
  type: 'shell_progress';
  elapsedMs: number; // monotonic, since post-PTY-init spawn
  lastOutputAgeMs?: number; // monotonic age of last output; absent = none yet
  totalLines?: number; // PTY/AnsiOutput path only
  totalBytes?: number; // PTY/AnsiOutput path only
  timeoutMs?: number; // effective timeout incl. 120s default; absent when disabled
}
```

Durations are monotonic (`performance.now()` deltas) so NTP corrections cannot skew them; `lastOutputAgeMs` is an age rather than an epoch timestamp for the same reason.

### Producer

`ShellToolInvocation.execute()` starts a `setInterval` after the execution handle is obtained (so PTY dynamic-import time cannot produce a heartbeat for a process that does not exist) and only when an `updateOutput` callback is present. Each tick emits a heartbeat iff no display update has fired for a full interval — the check reuses the existing `lastUpdateTime` throttle state, so commands with flowing output never heartbeat. The timer is cleared in the same three places as the existing trailing-flush/timeout-warning timers: the service-throw catch, the result `finally`, and `onAbort` (after abort, a "still running" signal during the kill-to-settle window would be a lie).

The interval comes from `tools.shell.heartbeatIntervalMs` (settings → CLI config → core `ConfigParameters` → `getShellHeartbeatIntervalMs()`, the same chain as `defaultTimeoutMs`), defaulting to 10 000 ms; `0` disables.

### Consumers

| Consumer                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CoreToolScheduler` liveOutputCallback | Forwards heartbeats to `outputUpdateHandler` but skips the liveOutput replacement and update notification — a stats object must not blank the accumulated live view.                                                                                                                                                                                                                                                                                                                                                                       |
| `useReactToolScheduler` (TUI)          | Ignores heartbeats; the TUI already shows a spinner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `agent-core` (subagent runtime)        | Ignores heartbeats; broadcasting one would overwrite the subagent view's `liveOutputs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ACP `Session.runTool`                  | Passes an update callback into `invocation.execute()`. Heartbeats become fire-and-forget, meta-only `tool_call_update { status: 'in_progress', _meta: { toolName, shellProgress } }` frames. A `toolSettled` gate set the moment `execute()` returns (including throw) drops a tick racing the settle path, so the client can never observe `in_progress` after `completed`. Heartbeat count and last output age are recorded as `shell.heartbeat_count` / `shell.last_output_age_ms` span attributes on the existing tool-execution span. |
| stream-json                            | `createToolProgressHandler` forwards heartbeats through the existing `emitToolProgress` pipeline (`tool_progress` stream events, gated by `--include-partial-messages`). `ToolProgressStreamEvent.content` widens to `McpToolProgressData \| ShellProgressData`.                                                                                                                                                                                                                                                                           |

Because ACP's `ToolCallUpdate` defines every field except the id as optional and `_meta` as the extensibility point, older clients ignore the new frames per protocol contract. On the permission-request path (which today emits no start notification), a heartbeat may be the first update a client sees for a tool call — same sequencing contract as the existing completed-only updates.

### Why not ShellExecutionService

The service would give marginally more accurate `lastOutputAt`, but the tool layer already observes every output event, and putting the timer there would have meant managing it across the PTY/child_process/promote lifecycles while PR 1 concurrently reworks the same file's pre-abort semantics. The user-facing `!` shell does not need heartbeats, so nothing is lost.

## Verification

- Unit: producer cadence/shape/cleanup (fake timers incl. `performance`), scheduler forwarding without liveOutput replacement, TUI hook retention, ACP meta-only frames + late-heartbeat gate, stream-json event shape and partial-messages gate.
- E2E stream-json: `sleep 15` produced `tool_progress` with `{type:'shell_progress', elapsedMs:10001, timeoutMs:30000}` and no output-stat fields.
- E2E ACP (stdio JSON-RPC): `tool_call` → heartbeat `tool_call_update` (meta-only, 10 s) → `completed`, with no trailing `in_progress`.
- TUI (tmux): silent command shows the normal spinner/elapsed row; no JSON leakage mid-run or in the final transcript.
