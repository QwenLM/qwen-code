# Daemon permission-response timeout default

## Goal

Let daemon interactions that require a human response wait indefinitely by default. Operators that require a wall-clock cap continue to use the existing `permissionResponseTimeoutMs` option or `qwen serve --permission-response-timeout-ms` flag.

## Current boundary

`BridgeClient` sends ordinary permissions and ACP tool calls marked with `_meta.qwenInteractionKind = "user_question"` through the same permission mediator. The mediator owns the single per-request timer, so the shared bridge option remains the correct configuration boundary.

## Behavior

- When `permissionResponseTimeoutMs` is omitted or `0`, neither ordinary permissions nor `ask_user_question` requests install a wall-clock timer.
- A positive `permissionResponseTimeoutMs`, including one supplied by the existing CLI flag, applies to both interaction kinds.
- No environment variable, wire field, or question-specific option is added.
- Voter cancellation, session cancellation, prompt cancellation, disconnect cleanup, idle reaping, daemon shutdown, and pending-interaction caps are unchanged.

## Non-goals

This change does not alter permission policy, pending interaction snapshots, daemon restart restoration, or the optional prompt-wide deadline.

## Verification

Focused bridge tests cover both interaction kinds with the default disabled timer and with an explicit finite timeout. Existing CLI tests cover option parsing and validation; package build and type checks cover the shared option wiring.
