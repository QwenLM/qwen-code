# Tool Call Terminal Telemetry Contract

## Problem

Tool-call terminal events are produced by both the Core scheduler and ACP.
They already expose `status`, `success`, `error`, and `error_type`, but those
fields can disagree or be absent. In particular, a tool can return a soft
error without an error type, and ACP can call the telemetry logger without
constructing a `ToolCallEvent`.

This leaves logs, usage statistics, metrics, hooks, and chat recording with
different views of the same terminal result.

## PR1 scope

PR1 establishes a runtime contract at two boundaries:

1. The Core scheduler converts an unclassified `ToolResult.error` to
   `ToolErrorType.UNKNOWN` before building a completed call.
2. `logToolCall` normalizes every event before sending it to any telemetry
   consumer.

The terminal contract is:

| `status`    | `success` | `error`   | `error_type`                |
| ----------- | --------- | --------- | --------------------------- |
| `success`   | `true`    | absent    | absent                      |
| `error`     | `false`   | preserved | explicit value or `unknown` |
| `cancelled` | `false`   | absent    | absent                      |

`status` is authoritative. A blank `function_name` becomes `unknown_tool`.
Non-empty tool names and non-empty error types are preserved verbatim. The
normalizer returns a copy and is idempotent.

The Core boundary is intentionally private. Public tool implementations may
continue to omit `ToolResult.error.type`, and `ToolCallResponseInfo.errorType`
remains optional because successful and cancelled calls do not have an error
classification.

## Consumers

The normalized event is used by UI telemetry, the chat-recorded UI event,
QwenLogger, OpenTelemetry logs, and tool-call metrics. OpenTelemetry
`error.message` and `error.type` aliases are populated independently.

The tool-call counter adds the low-cardinality `status` attribute while
retaining `success`. The public `recordToolCallMetrics` input accepts an
optional status for source compatibility; callers that omit it are mapped from
the legacy success boolean. The latency histogram remains keyed only by
`function_name`, and `error_type` is not added to metrics.

QwenLogger receives `status` and `tool_type`. It does not receive
`mcp_server_name`, function arguments, results, or stack traces as part of this
change.

## Compatibility and follow-ups

This change is additive for logs and metrics, but it changes an unclassified
Core error from a missing value to `unknown` in PostToolBatch and Core chat
recording. Historical queries should coalesce missing error types to `unknown`;
no data backfill is required.

The following remain outside PR1:

- correcting ACP permission cancellation and other producer-side terminal
  status bugs;
- normalizing ACP's separate raw `tool_result` recording;
- adding `error_type` to the PostToolUseFailure hook contract;
- adding error classification to primary tool spans;
- classifying individual built-in and MCP error sites;
- changing legacy UI `totalFail` semantics.

The new `status` metric must not become the stability SLO source until the ACP
terminal-status fixes land.

## Rollout checks

For the new service version, operators should verify that:

- error tool-call logs never have a blank `error_type`;
- tool-call logs never have a blank `function_name`;
- success and cancelled events do not carry error fields;
- explicitly classified errors retain their previous type;
- the tool-call counter total remains aligned with tool-call log volume; and
- the increase in `unknown` corresponds to the previous missing bucket.
