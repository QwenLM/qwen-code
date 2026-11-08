# Shell timeout error semantics

## Problem

Foreground Shell commands currently describe a timeout in text but return a successful `ToolResult`. Downstream code therefore records the call as successful, sends a function response with an `output` field, and can render a success indicator even though the command did not finish. A cancellation that arrives after the timeout can also overwrite the original reason. During PTY discovery, an already-aborted call can still spawn a process because the execution service does not observe the signal until after startup.

## Result contract

A Shell-owned foreground timeout returns `ToolErrorType.EXECUTION_TIMEOUT`. The result uses three intentionally separate channels:

| Channel         | Audience                                | Timeout content                                                                                |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `error.message` | Hooks, telemetry, spans, logs, alerting | Short timeout summary only                                                                     |
| `llmContent`    | Model function response                 | Timeout summary, partial output or an explicit no-output statement, and any truncation pointer |
| `returnDisplay` | Interactive history and ACP clients     | Timeout summary, partial output or no-output statement, and any truncation pointer             |

The scheduler converts timeout `llmContent` to a function response whose `response` has an `error` field and no `output` field. Failure-hook additional context is appended to that model-facing error once. The top-level `ToolCallResponseInfo.error` remains the short operational summary so command output is not copied into telemetry or hook error arguments.

Other soft tool errors retain their existing Core scheduler behavior. ACP and speculative execution consistently encode all soft errors with an error envelope because those paths invoke tools directly and otherwise have no scheduler classification step.

## First-cause rules

`AbortSignal.any()` preserves the reason from the first signal that aborts. Shell classification reads only the combined signal reason after execution:

- `TimeoutError` plus an aborted execution is a timeout.
- A background-promote reason plus an aborted, non-promoted execution is the existing promote-refused race.
- Any other aborted execution is cancellation.
- A timeout that occurs first is not changed by a later user cancellation or promote request.
- A cancellation or promote request that occurs first is not changed by a later timeout.

The Core scheduler has a second, optional global execution timer. A structured timeout returned by a tool remains a timeout even if the parent signal is aborted before the scheduler consumes the result. When the scheduler's own timer supplies the timeout result, it wins only if the parent signal was not already aborted when the timer fired. A parent cancellation followed by the timer firing against an uncooperative tool remains cancelled.

ACP applies the same rule for structured tool timeouts: the timeout is an error rather than an interrupt even if its parent signal is observed as aborted afterward. Thrown exceptions continue to use the live abort state.

## Startup behavior

`ShellExecutionService.execute()` returns an aborted, no-process handle immediately when its signal is already aborted. PTY discovery races the signal with `getPty()` and removes its temporary listener after the race. If abort wins, a later PTY resolution or rejection is consumed without spawning a PTY or falling back to `child_process`. The returned result uses `executionMethod: 'none'` and has no pid.

This behavior affects all in-repository consumers of the service: foreground and background Shell plumbing, user `!` Shell, prompt command injection, ACP bridge shell handling, and git attribution probes. The only behavioral change is that an already-aborted request no longer starts a process.

## Consumer behavior

| Consumer                            | Timeout behavior                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Core scheduler                      | `status: error`, short top-level error, detailed `response.error`, timeout failure kind                            |
| ACP session                         | failed tool update, detailed error envelope in model history and recording, short operational metadata             |
| Speculative execution               | detailed error envelope; accepted speculative history renders Error                                                |
| Anthropic adapter                   | `tool_result.is_error: true`                                                                                       |
| OpenAI-compatible adapters          | explicit detailed error text; no protocol-level error bit exists                                                   |
| JSON and stream-json                | `is_error: true` with detailed nested error content preferred over the short summary                               |
| Context estimation and batch budget | both `response.output` and `response.error` text are counted; oversized errors retain the error key when offloaded |

Microcompaction continues to leave failed tool results untouched. Full chat compression now sees the detailed error size and can trigger at the correct budget.

## Claude Code comparison

Claude Code treats a command timeout as a failed tool result, retains output produced before termination for the model and user, and marks the tool result as an error in the Anthropic protocol. This design adopts those observable properties while keeping qwen-code's existing `ToolResult` shape and telemetry conventions. It does not copy command output into the short operational error channel.

## Compatibility and observability

This is an intentional wire-level correction. ACP and speculative soft failures change from `{ output }` to `{ error }`; Core changes that shape only for `EXECUTION_TIMEOUT`. Timeout counts move from success metrics to error/timeout metrics and failure hooks replace success hooks. No schema, error enum, timeout default, migration, or rollout flag changes.

Partial command output can contain sensitive data. It remains available to the model, the interactive result, chat recording, and explicit JSON output, as it was before the classification correction. It is not added to hook error arguments, top-level errors, span result attributes, or operational log summaries. Existing truncation and spill-to-disk limits apply to the detailed model channel.

## Out of scope

- Heartbeats or periodic progress reporting
- Todo stop guards or prompt changes
- Non-zero exit-code semantics
- External signal termination semantics
- Background Shell timeouts
- Waiting for partial output after the global scheduler timer wins
- New timeout settings or protocol fields

## Verification

Unit coverage exercises pre-aborted and PTY-discovery races, Shell timeout/cancel/promote ordering, sed simulation, short-versus-detailed scheduler channels, Core global timeout ordering, ACP and speculative direct invocation, Anthropic conversion, JSON content selection, error-size estimation, and batch offload. The E2E plan is recorded in `.qwen/e2e-tests/shell-timeout-semantics.md`.
