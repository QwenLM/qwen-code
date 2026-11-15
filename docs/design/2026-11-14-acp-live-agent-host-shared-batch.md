# ACP live-tool and Agent Host sessions on the shared tool batch

[简体中文](./2026-11-14-acp-live-agent-host-shared-batch.zh-CN.md)

## Background

This is the ACP row of #17045 at `packages/cli/src/acp-integration/session/`:
sessions with live tools and read-only Agent Host sessions move onto the
shared tool batch, and `toolLoopGuardsByHost` is removed. Before this change,
`#runsToolsOnSharedBatch()` (`Session.ts`) returned `false` for a session
that enabled live tools or whose `getSessionSourceType()` is `agent-host`;
those turns ran ACP's own tool step and passed `toolLoopGuardsByHost: true`
to core, which suppressed the client's loop guards, todo reminder and
result-aware duplicate recording so the host's step could run them instead.

The row follows #17070 (`interactionSpanByHost` and `userTurnRecordedByHost`
became inputs) and builds on #17181 (ACP's step 3), without changing any
default switch.

## Baseline

Checked against #17181's head (`447a0abe26`), #17181 changes the shape of the
integration point:

- A round on the shared loop starts with `startSharedLoopRound`, which returns
  `{ model, runBatch, close }`. The batch (replays included) waits inside the
  `runAgentLoop` call until the turn hands it over through `runBatch`; its
  tools run in the async context of that call, not the round's. A turn that
  leaves before the handoff closes the loop.
- ACP starts rounds with `deferRecording: false`, keeps cancelled results, and
  drives the batch through `createSchedulerExecutor`. `runAcpToolBatch` takes
  the round's loop (`loop.runBatch`) and performs its stale-plan launch check
  through `beforeToolLaunch`; `Session.ts`'s `#runSharedToolBatch` receives
  the `SharedLoopRound` from the turn via `SharedRound.onLoop`.
- This design does not touch the handoff itself: approvals still become
  `session/request_permission` requests, updates still become ACP
  `tool_call` updates, and the kernel-event-bus question belongs to #17181.

## Approach

### Live-tools trust

An `AcpToolBatchHost` input (`isTrustedLiveTool`, forwarded to
`CoreToolSchedulerOptions.isTrustedTool`) carries the session's trusted live
tool instances (by identity, not name): `capture_screen_context` and the five
live-task tools (`list_threads`, `read_thread`, `wait_threads`,
`send_message_to_thread`, `create_thread`) — the same set ACP's own executor
bypassed. `speak_to_user` is not in it: it stays on the permission flow, as it
did there, so a user's `permissions.deny` / `permissions.ask` rule for it still
applies. Inside `CoreToolScheduler`, a trusted tool instance bypasses the L1
`PermissionManager.isToolEnabled` / legacy deny check and the L3→L4
`evaluatePermissionFlow` check so it schedules directly without interactive
approval. A PreToolUse hook's `ask` is the user's own request for confirmation
and is not bypassed. Their execution channel is the session's daemon
`extMethod`, already constrained by lifecycle (`setLiveConversationActive`), so no
genuine approval prompt can come from the model calling them. The trust is by
tool-instance reference, so a same-named MCP tool or ordinary tool in the
same live session still goes through the normal permission flow.

### Agent Host read-only behavior

Workspace confinement and read-only tool policy stay on the session `Config`:
its `getToolInvocationGuard()` (`createAgentHostToolInvocationGuard`) is
evaluated by `CoreToolScheduler` at the execution boundary, so an
out-of-workspace or disallowed call settles as `EXECUTION_DENIED`
(`not_started`) with the guard's reason. The batch does not build or forward a
second guard.

`readOnlyRefusalMessage` is the one host behavior forwarded through
`AcpToolBatchHost` to `CoreToolSchedulerOptions`, and it is checked only when
a call actually reaches the interactive approval gate (right before
`awaiting_approval`, after auto-allowed read checks and permission hooks).
Auto-allowed in-workspace reads — `read_file`, `grep_search` without a `glob`
filter, `list_directory`, the session's whole registered set
(`AGENT_HOST_TOOL_NAMES`) — execute normally. `glob`, `grep_search` with a
`glob` filter, `zoom_image` and `display_image` are refused outright by the
guard, in or out of the workspace: glob expansion happens after the guard and
can traverse a symlink or a brace branch. Any call that still requires
interactive approval settles as `EXECUTION_DENIED` (`not_started`) with `Tool "<name>" requires approval, which
is unavailable on this read-only Agent Host.` without emitting
`session/request_permission` or aborting the rest of the turn.

### Removing the flag

Both session kinds moved onto the shared batch, so `#runsToolsOnSharedBatch()`
is removed outright (its two call sites collapse to the shared path).
`toolLoopGuardsByHost` is removed from `SendMessageOptions`, and on the shared
loop the client runs its loop guards, todo reminder and duplicate recording for
every ACP turn. `checkAlwaysOnSafeties` (the per-turn cap, the
consecutive-identical guard, argument-keyed with only the result-aware
`task_list` exemption) then covers the turn; the duplicate stop the TUI relies
on (#14590, including YOLO background tasks) has parity under the unified loop
through `keepCancelledResults: true` on the batch.

Removing it cannot double anything on the shipping default
(`UNIFIED_SURFACE_DEFAULTS.acp === false`) either, because that path does not
reach `LlmClient` at all: a turn with the switch off sends through the session's
own chat (`#sendMessageStreamWithAutoCompression` → `chat.sendMessageStream`),
builds its own tool-result message and runs only ACP's guards. The client's
reminder and guard branches are reachable only through a round the session
starts with `startSharedLoopRound` / `runModelRound`, which is exactly the
`sharedModelRound` branch — and there every session kind now takes the shared
batch. So the option's last reader was already unreachable before this change
removed it; guard ownership follows the round, not the session kind.

### Test plan

Tests are driven by value, not coverage. This design extends the existing
suites with end-to-end shared-batch integration scenarios:

- `Session.test.ts` inverts the former `toolLoopGuardsByHost: true` assertions
  and runs two shared-batch integration scenarios through the real
  `runAcpToolBatch` and `CoreToolScheduler` (under both `kernel=false` and
  `kernel=true`):
  1. A live-tool session that invokes both `capture_screen_context` and an
     ordinary confirming `read_file` tool in one shared batch, proving the
     trusted live tool bypasses `isToolEnabled` and `requestPermission` while
     the ordinary tool still requests ACP permission.
  2. A read-only Agent Host session in `ApprovalMode.DEFAULT` that runs an
     auto-allowed in-workspace `list_directory` call, denies an
     out-of-workspace `read_file` through the session Config's
     `getToolInvocationGuard`, and refuses an
     approval-needing in-workspace `read_file` via `readOnlyRefusalMessage`
     with zero `requestPermission` calls before continuing to the next model
     round.
  3. A second instance registered under `capture_screen_context`'s name, which
     must reach `isToolEnabled` while the live instance does not — the case
     goes red if the predicate ever compares names instead of instances.
  4. A `speak_to_user` call in a live session under a matching deny rule, which
     must be refused by the permission flow rather than trusted.
- `acp-tool-batch.test.ts` verifies that `runAcpToolBatch` forwards
  `isTrustedLiveTool` and `readOnlyRefusalMessage` to
  `createSchedulerExecutor`.

## Risks and boundaries

- **Duplicate stop regression (#14590).** The TUI's background-task duplicate
  stop lives in `checkAlwaysOnSafeties` today. Under the unified loop, the
  executor returned salvaged responses and, for cancelled batches, synthesized
  missing responses into cancellations. `keepCancelledResults: true` gives
  the same coverage shape for the stop.
- **Live-task polling.** The always-on consecutive-identical guard counts
  identical live calls even when their results changed (#9450's
  result-aware exemption starts in core's duplicate recording). If a genuine
  regression shows, the live task tool identities are recorded by
  tool-instance reference in the batch's duplicate handling rather than
  broadening core's exemptions: trust is by instance identity, so a
  same-named tool inherits none of it.
- **Agent Host reads.** The session `Config.getToolInvocationGuard()` is
  applied by `CoreToolScheduler` at the execution boundary, so out-of-workspace
  paths in `read_file`, `grep_search` and `list_directory` are denied before
  execution, and `glob`, `grep_search` with a `glob` filter, `zoom_image` and
  `display_image` are refused wherever they point.
- **#17181 dependency.** The branch bases on #17181's `SharedLoopRound`
  handoff shape and merges cleanly with `main`.

## Acceptance

- `#runsToolsOnSharedBatch()` is gone; `toolLoopGuardsByHost` is gone from
  `SendMessageOptions` and its read sites. The default path keeps ACP's guards
  because it never enters the client, not because a round asks for them.
- Live-tool sessions and Agent Host sessions both take the shared batch, with
  shared-batch integration scenarios covering trusted live-tool execution,
  ordinary-tool permission prompts, auto-allowed Agent Host reads,
  out-of-workspace `getToolInvocationGuard()` denials, and approval-needing
  read-only refusals with zero outbound `requestPermission` calls.
