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

An `AcpToolBatchHost` input carries the session's three trusted live tool
instances (identity, not name). The batch's `beforeToolLaunch` bypasses the
read-only refusal and invocation guard for exactly those instances; the
scheduler's L1 enablement check and permission ask already honor the tools'
declared trust, so no batch-side bypass of enablement is needed. Their
execution channel is the session's daemon `extMethod`, already constrained by
lifecycle (`setLiveConversationActive`), so no genuine approval prompt can
come from the model calling them. The trust is by tool-instance reference,
so a same-named MCP tool does not inherit it.

### Agent Host read-only and invocation guard

Two host behaviors, still scoped to `sourceType === 'agent-host'`:

1. Every call that reaches the batch's `beforeToolLaunch` without live-tool
   trust is refused with the session's read-only message instead of sending
   `session/request_permission` (`#requestPermissionQueued` is bypassed).
2. The invocation-time guard `createAgentHostToolInvocationGuard` is passed
   into the batch as a host input and evaluated in `beforeToolLaunch`, before
   the scheduler's build. A build-failed call keeps the scheduler's existing
   retry path, as ACP's own executor does today.

The integration test checks that no outbound `session/request_permission`
leaves the session. It does not matter for acceptance whether the planner
refuses the call upfront or the executor deflects it at build/skill time;
refusing before launch is preferred.

### Removing the flag

Both session kinds moved onto the shared batch, so `#runsToolsOnSharedBatch()`
is removed outright (its two call sites collapse to the shared path).
`toolLoopGuardsByHost` is removed from `SendMessageOptions` and the core
client runs its loop guards, todo reminder and duplicate recording for every
ACP turn. `checkAlwaysOnSafeties` (the per-turn cap, the
consecutive-identical guard including background-task allowance) then covers
the turn; the duplicate stop the TUI relies on (#14590, including YOLO
background tasks) has parity under the unified loop through
`keepCancelledResults: true` on the batch.

### Test plan

Tests are driven by value, not coverage. This design extends the two single
sources rather than adding a parallel case list:

- Unit: `Session.test.ts` uses the existing harness. Cases that previously
  asserted `toolLoopGuardsByHost: true` and that `runAcpToolBatch` was not
  called invert under the new branches; each is driven by a behavior
  assertion — permission bypass for live tools, agent-host refusal before
  launch, guards revived — not by which flag reached core. The shared-batch
  harness marks the truncated response's request with `wasOutputTruncated`
  explicitly, matching what the real client stamps on the turn.
- Core side is value-gated: `checkAlwaysOnSafeties` / `tool-result` recording
  is not re-mocked; enhancement goes into the single source that owns the
  invariant, with a sentinel long-poll pattern for live task tools if the
  existing harness cannot express it.

## Risks and boundaries

- **Duplicate stop regression (#14590).** The TUI's background-task duplicate
  stop lives in `checkAlwaysOnSafeties` today. Under the unified loop, the
  executor returned salvaged responses and, for cancelled batches, synthesized
  missing responses into cancellations. `keepCancelledResults: true` gives
  the same coverage shape for the stop. A parity case on the daemon's
  cancelled-batch path holds this before merge.
- **Live-task polling.** The always-on consecutive-identical guard counts
  identical live calls even when their results changed (#9450's
  result-aware exemption starts in core's duplicate recording). If a genuine
  regression shows, the live task tool identities are recorded by name in the
  batch's duplicate handling rather than broadening core's exemptions.
- **Agent Host glo/grep.** The executor deflects file searches the Agent Host
  guard refuses; the trust only applies to the tool's execution channel.
- **#17181 dependency.** The branch bases on #17181's `SharedLoopRound` /
  `beforeToolLaunch` shape. If #17181 lands with a different surface, this
  design follows its final shape; no separate loop contract change.

## Acceptance

- `#runsToolsOnSharedBatch()` is gone; `toolLoopGuardsByHost` is gone from
  `SendMessageOptions` and its read sites.
- Live-tool sessions and Agent Host sessions both take the shared batch; the
  unit harness drives a truncated edit through it, drives the trusted live
  tool without a permission prompt, and keeps an ordinary tool on the
  permission round-trip.
- The duplicate-stop parity case on the daemon's cancelled batch holds (the
  batch's `keepCancelledResults` keeps the coverage shape of the stop).

Follow-up: a full-stack integration scenario per session kind (fake ACP
client + fake daemon `extMethod` for live tools; refused edit with zero
outbound `request_permission` for Agent Host) lands with the row's next
slice.
