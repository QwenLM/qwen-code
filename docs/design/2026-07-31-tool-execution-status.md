# Tool Execution Status

## Motivation

The terminal tool-call status describes whether the overall call succeeded,
failed, or was cancelled. It does not say whether the dispatcher actually
entered `invocation.execute()`. Validation failures, permission rejection,
execution failures, and post-execution failures therefore need a separate
execution outcome before they can be measured accurately.

## Contract

`ToolCallResponseInfo` carries an optional `executionStatus` for source and
recording compatibility:

```ts
type ToolExecutionStatus = 'not_started' | 'success' | 'error' | 'cancelled';
```

The Core scheduler (`CoreToolScheduler`) and ACP `Session.runTool` always set
the field. Missing values from older recordings, third-party producers, and
subagent result projections (the non-interactive `buildResponse` path, which
replays another agent's reported outcome) become `unknown` only at the
telemetry boundary and are never inferred from the terminal call status.

The terminal and execution axes are intentionally independent:

| Terminal status | Execution status | Example                                                                              |
| --------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `success`       | `success`        | Normal tool completion                                                               |
| `success`       | `not_started`    | Protocol-level synthetic sibling response                                            |
| `error`         | any value        | Pre-execution denial, execution error, post-processing error, or batch-hook override |
| `cancelled`     | any value        | Cancellation before, during, or after execution                                      |

Reading each row as a (terminal, execution) pair, the only invalid combinations are `success/error` and `success/cancelled`: a call that terminates `success` can only carry execution status `success` or `not_started`.
Execution status freezes when `invocation.execute()` settles; hooks, result
bridging, persistence, and batch processing cannot overwrite it.
PostToolBatch enablement and its parent tool span are snapshotted when a
scheduler batch starts, so runtime hook reconfiguration affects the next
batch rather than changing completion behavior for an in-flight batch.

## Telemetry

The normalized `tool_call` event adds `call_id` and `execution_status`.
Normalization occurs once before all sinks:

- empty tool names become `unknown_tool`;
- `success` is recomputed from terminal `status`;
- terminal errors without an error type use `unknown`;
- success and cancellation omit call-level error fields;
- missing execution status becomes `unknown`.

The terminal `status` dimension on `qwen-code.tool.call.count`, established by
the terminal telemetry contract, is unchanged by this design. A new
`qwen-code.tool.execution.count` counter uses only `execution_status` and
`tool_type` event-specific dimensions. Globally configured common metric
attributes, such as the opt-in `session.id`, may also be present. The execution
failure rate is:

```text
execution_status = error
────────────────────────────────────────
execution_status in {success, error}
```

Cancellation, `not_started`, and `unknown` are excluded. Error type, function
name, call ID, messages, and MCP server names remain in logs or spans rather
than metric labels. The counter deliberately omits `function_name`, so an
execution-failure rate cannot be attributed to a specific tool from the metric
alone; drill down through the `tool_call` logs, which carry both `call_id` and
`function_name`.

An execution span exists only after the dispatcher attempts `execute()`.
It records the tool identity, frozen execution status, and execution error
type. Parent tool spans continue to represent the terminal call status, and
cancelled spans remain unset rather than error. Core opens the parent span
after tool resolution and invocation validation; earlier terminal paths are
covered by the normalized event and execution counter and do not synthesize a
span from an unresolved request name.

QwenLogger receives the normalized terminal status, execution status, call ID,
and tool type, but not MCP server names or function arguments. MCP server names
remain outside QwenLogger and are available to configured telemetry log and
span exporters.

## Compatibility and Scope

The public response and event fields stay optional. Built-in producers use an
internal required shape, while old JSONL recordings are not migrated or
backfilled. New JSONL recordings include `executionStatus` on recorded tool
results; the field is additive, so replay readers that ignore unknown fields
are unaffected. Manual recording projections in Core, ACP, TUI, and
non-interactive modes copy the new scalar without exposing it in user-facing
JSON output. A call cancelled before tool resolution can omit `tool` and
`invocation` from the public `CancelledToolCall` variant, so consumers of that
variant must guard those fields before use.
When such a pre-resolution cancel is emitted through telemetry, `tool_type`
defaults to `"native"` because the tool identity is not yet resolved; this
is a known skew in the `tool_type` dimension for pre-validation cancels.

Per-call execution errors no longer reject `CoreToolScheduler.schedule()`;
the outcome is delivered through the existing update and completion callbacks
as a terminal `error` call, so one tool's failure does not abort its siblings.
The method still returns `Promise<void>` and can reject for scheduler-level
setup or queue failures. `handleConfirmationResponse()` terminalizes
confirmation-flow errors before rethrowing them, preserving its existing
failure signal without leaving a call in `awaiting_approval`. Embedders should
read terminal `status` and `executionStatus` from callback-delivered calls,
not expect either public entry point to return completed calls.

The first release covers `CoreToolScheduler` and ACP `Session.runTool`.
Speculation, direct `/fork` execution, MCP-internal retries, provisional
subagent result reconciliation, shell exit metadata, retryability, ownership,
and generic failure phases remain out of scope.

Core and ACP must ship together. Dashboards should cut over by deployment time
or `service.version`, monitor `unknown` separately, and never use the legacy
`success` metric as the execution-failure SLI.

## Known Maintenance Hazards

The pre-execution cancellation invariant ("every `await` in the pre-execution
path is followed by an abort check") is enforced by hand-placed checks at each
call site in `CoreToolScheduler` and `Session.runTool` rather than by a
structural mechanism. Adding a new `await` to either path without a following
check silently reintroduces the stale-execution bug this design fixes. A
future refactor should wrap the awaits in a guarded helper; until then,
reviewers of those paths should verify the invariant manually.
