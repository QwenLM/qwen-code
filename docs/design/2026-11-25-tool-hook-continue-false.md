# Tool hooks end the turn with `continue: false`

[English](2026-11-25-tool-hook-continue-false.md) | [简体中文](2026-11-25-tool-hook-continue-false.zh-CN.md)

- **Status**: implemented on the shared agent loop; validated with unit tests and E2E (2026-11-25).
- **Date**: 2026-11-25.
- **Related**: #18217 (hooks alignment, follow-up of A1 #18229), [Agent loop capability ledger](2026-11-15-loop-capability-ledger.md) rows C14, T11 and T27. This is a prerequisite of the planned removal of the client's loop detection.

## Problem

`continue: false` is a common hook output field: "stop after the hooks run". Since #18229 a Stop hook's `continue: false` ends the turn. On the tool events it does not:

- **PreToolUse**: the call is refused with `stopReason` as its error, and the model goes on.
- **PostToolUse**: the call's real result is replaced by an error carrying `stopReason`, and the model goes on.
- **PostToolUseFailure**: the field is ignored.
- **PostToolBatch**: the last call's result is replaced by an error, and the model goes on.

So a hook cannot stop the agent at a tool boundary. A hook that notices a loop (the same call over and over), a budget overrun or a policy breach can only make one call fail, and the model usually retries. Once loop detection is removed, hooks are the documented way to stop a run, so this has to work first. The 1.0 loop (`v1.0.0-preview`) already ended the turn on these events (ledger C14, T11, T27).

## Current state

- `firePreToolUseHook` returns `blockType: 'stop'` for `continue: false`. The scheduler turns any block other than `ask` into a `not_started` `EXECUTION_DENIED` error.
- `firePostToolUseHook` returns `shouldStop`. The scheduler replaces the result with an `EXECUTION_DENIED` error and marks the span `post_hook_stopped`.
- `firePostToolUseFailureHook` reads only `additionalContext` and artifacts.
- `firePostToolBatchHook` treats `continue: false`, `decision: block`/`deny` and exit code 2 the same way: the last result is replaced by an error.
- `ToolCallResponseInfo.terminateTurn` exists, but in practice it is a Goal signal. Headless honors it only inside a Goal turn, subagents never do, Ink and OpenTUI tie it to the Goal finish, and it carries no reason. It cannot be reused.
- The prompt and function hook runners write `continue: false` together with `decision: "block"` when they block (`ok: false`, a `false` return). #18229 settled the rule "block wins" for Stop. The tool events must keep that rule, or a prompt hook's `ok: false` on PostToolUse would start ending the turn.

## Goals and scope

- On PreToolUse, PostToolUse, PostToolUseFailure and PostToolBatch, `continue: false` without a blocking decision ends the turn after the current batch. Interactive sessions and headless text mode show the reason.
- Main sessions on the shared agent loop: the Ink TUI, the OpenTUI, headless (text, JSON, stream-json), and ACP/daemon sessions (Web Shell, IDEs, SDK).
- Subagents: the run ends with a new terminate mode, and the parent sees the reason.
- Code Mode: a stop from a call nested in an `exec` script ends the turn too.
- Omni media policy calls made during tool execution or result processing carry a hook stop back to the enclosing tool. The batch keeps a successful derivative and ends the turn. Policy errors still follow the configured failure handling. When a policy runs during user `@file` expansion or a provider retry, it has no enclosing tool batch. A PostToolUse or PostToolBatch stop on a successful policy call then fails that policy step.
- Out of scope, and the turn goes on there:
  - The legacy (non-shared) loops, opt-out paths that #17045 removes. They use the same scheduler, so PreToolUse refuses the call, PostToolUse keeps the result and PostToolBatch keeps every result.
  - ACP tool calls that run outside the shared batch: a restored `ask_user_question` call after a daemon restart, and, with the unified loop turned off, every ACP turn. That tool path keeps the old effect (PreToolUse refuses the call, a PostToolUse stop replaces the result with an error). Cron, background-notification and Stop-hook continuation turns use the shared batch by default and are covered.
  - The Hosted Harness, which has its own hook handling.
  - Speculation, which is not a user turn, and a new `decision` meaning on PostToolUse.

## Design

### The rule per event

The hook outputs are merged as today. Then:

| Event              | `continue: false`, no blocking decision                                                                                             | With `decision: block`/`deny` or exit code 2 (unchanged)                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| PreToolUse         | The call does not run. Its result is the error `stopReason`. The other calls of the batch still run. The turn ends after the batch. | The call is denied (permission decision)                                                  |
| PostToolUse        | The real result is kept and sent. The turn ends after the batch.                                                                    | Unchanged: the result is replaced by an error carrying `stopReason`, and the turn goes on |
| PostToolUseFailure | The error result is kept. The turn ends after the batch.                                                                            | Ignored, as today                                                                         |
| PostToolBatch      | All results are kept. The turn ends.                                                                                                | Unchanged: the last result is replaced by an error, and the turn goes on                  |

"After the batch" means every call of the batch settles and every result is written to history, so the next prompt never sends a tool call without its result. The model gets no further request in this turn.

### Signal

- `ToolCallResponseInfo` gains `hookStopReason?: string`. The scheduler sets it on the call whose hook asked to stop, and on the last call for PostToolBatch. `stopReason` is used, or `reason`, or `No reason provided` (`getEffectiveReason`).
- `runToolBatch` reads it from executed results and returns the new stop `hook_stopped` with `hookStopReason` (the first one in request order). It is not gated by `endsOnTerminateTurn`. Its priority comes after `cancelled`, `surface_ended` and `tool_ended_turn`: a Goal tool that ends the turn keeps the Goal finish path.
- Both kernels (the classic loop and the event-bus kernel) already pass a batch stop through, so `runAgentLoop` returns `reason: 'hook_stopped'` and the reason.

### Surfaces

Each surface adds the batch's function responses to history and finishes the turn normally. Inside a Goal turn the Goal runtime settles the turn and decides what comes next. ACP preserves the hook reason even when a tool in the same batch also ends the turn. Goal settlement takes priority, and a channel turn ends at the hook without requesting a final reply.

- Ink and OpenTUI display the localized notice “A hook stopped the turn: <stopReason>”. Headless text mode prints it to stderr. Headless JSON and stream-json finish without a notice. ACP saves the tool responses before sending the `stop_hook_notice` update to the SDK, Web Shell or VS Code. The turn stays finished if the client cannot receive the update.
- **Subagents**: `AgentTerminateMode.HOOK_STOPPED`. The batch's results are added to the subagent's history, so a resumed subagent sees them. Its final text is "A hook stopped the agent: <stopReason>", which the parent's tool result carries. The status line says "Agent stopped by a hook.", and telemetry counts it like the other non-goal modes.
- **Code Mode**: `exec` treats a nested result with `hookStopReason` like `terminateTurn`. The script stops, and the `exec` result carries `hookStopReason` to the outer scheduler.

### Telemetry

The tool span keeps `post_hook_stopped` for the blocking PostToolUse path only. A turn-ending stop is recorded on the hook span (`blockType: 'stop'`) and in the debug log. No new metric.

## Decisions

- **A new field, not `terminateTurn`.** That field is a Goal contract on several surfaces and has no reason. Widening it would change Goal turns.
- **Block wins.** This is the rule of #18229, and it keeps every prompt and function hook that blocks today working unchanged.
- **PostToolUse keeps the result.** The tool already ran, and its effect is real. Hiding the output behind an error would mislead the next turn. Redaction is a separate feature (B4 `updatedToolOutput`).
- **PreToolUse does not cancel the sibling calls.** They were already scheduled, and their results must be written anyway. The turn ends once the batch settles.
- **The legacy loops stay as they are.** They are opt-out paths that #17045 removes. Changing them doubles the change for paths nobody runs by default. The restored `ask_user_question` call is a follow-up for the same reason.

## Compatibility

- A command or HTTP hook that returns `{"continue": false}` on a tool event used to fail one call and let the model continue. It now ends the turn. That is the documented meaning of the field, and the reason for this change. The release note says so.
- PostToolBatch `continue: false` used to replace the last result. It now keeps it and ends the turn. `decision: block` and exit code 2 are unchanged.
- Blocking outputs (`decision: block`/`deny`, exit code 2, prompt hook `ok: false`, function hook `false`) are unchanged.
- No setting, protocol field or SDK type changes, apart from the new optional `hookStopReason` on tool responses and the new subagent terminate mode.
- The managed tool runtime protocol keeps its shape: a PostToolUse `continue: false` is still reported to it as `postHook.shouldStop`, and PostToolUseFailure carries no stop.

## Risks

- **A surface that forgets the history step** would leave a tool call without its result, and the next prompt would fail. Mitigation: an E2E case sends a second prompt in the same session after a hook stop and checks the request.
- **Goal turns**: a hook stop ends the turn, not the goal. The Goal runtime settles the turn as after any turn a tool ends, so an autonomous Goal run may start its next turn. To stop a Goal run, a hook stops every turn, or the user pauses the goal.

## Files affected

- `packages/core/src/core/toolHookTriggers.ts`: the stop decision per event (block wins), and PostToolUseFailure `continue`.
- `packages/core/src/core/coreToolScheduler.ts`: set `hookStopReason`, and keep the PostToolUse result.
- `packages/core/src/core/turn.ts`: `hookStopReason` on `ToolCallResponseInfo`.
- `packages/core/src/core/agent-loop.ts`, `packages/core/src/event-bus/conversation.ts`: the `hook_stopped` stop and its reason.
- `packages/core/src/tools/exec.ts`, `packages/core/src/tools/tools.ts`: Code Mode propagation.
- `packages/core/src/tools/managed-tool-runtime.ts`: keep the managed protocol shape.
- `packages/core/src/agents/runtime/*`, `packages/core/src/tools/agent/agent.ts`: `HOOK_STOPPED`.
- `packages/cli/src/nonInteractiveCli.ts`, `packages/cli/src/ui/hooks/use-llm-stream.ts`, `packages/cli/src/ui/opentui/live-session.ts`, `packages/cli/src/acp-integration/session/*`: the surfaces.
- `docs/users/features/hooks.md`, and ledger rows C14, T11 and T27.

## Validation

- **Unit tests**:
  - The trigger results per event: stop, block-wins, and PostToolUseFailure.
  - The scheduler response per event: the field, the kept result, and the not-run call.
  - `runToolBatch` returns `hook_stopped` with its priority.
  - Each surface's handling of the stop.
  - The subagent terminate mode, and Code Mode.
- **E2E with the built CLI and a mock OpenAI-compatible server**:
  - Each event: in headless text mode the turn ends after the batch, and stderr shows the reason. The mock receives no request after the tool results.
  - In an ACP session: the stop notice arrives, then a second prompt in the same session, whose request carries the tool results, and the mock answers 200.
  - Interactive TUI (tmux): the notice is shown and the prompt is ready again.
  - A prompt hook or a function hook that blocks on PostToolUse: unchanged (the error result, and the turn continues).
- **Baseline** (global `qwen`): the same configs fail only the call, and the model goes on.

## Acceptance

- On the shared loop, a PreToolUse, PostToolUse, PostToolUseFailure or PostToolBatch hook returning `{"continue": false, "stopReason": "…"}` ends the turn and leaves a session that accepts the next prompt. Interactive sessions and headless text mode show the reason.
- A subagent ends with `HOOK_STOPPED`, and the parent sees the reason.
- Blocking outputs behave as before.

## Open questions

None.
