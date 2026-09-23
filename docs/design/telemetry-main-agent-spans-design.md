# Main agent invocation tracing

## Goal

Represent one logical Qwen Code main-agent invocation with the existing `qwen-code.interaction` span. The span covers every LLM request, tool approval and execution, and model continuation that belongs to the same prompt. This avoids a second wrapper span while making the trace compliant with the OpenTelemetry GenAI Agent span convention.

## Semantic contract

The interaction span keeps its framework-defined name, `SpanKind.INTERNAL`, and existing compatibility attributes. At creation it adds:

- `gen_ai.operation.name=invoke_agent`
- `gen_ai.agent.name=qwen-code`
- `gen_ai.conversation.id=<session id>`
- `gen_ai.output.type=json` only when a JSON Schema constrains the model output

`qwen-code.model` remains available for compatibility. `gen_ai.request.model` is omitted because the main agent can use model overrides, fallback, and dynamic selection. The main span also omits `gen_ai.provider.name` and `gen_ai.agent.id`, `gen_ai.agent.version`, and `gen_ai.agent.description`: Qwen Code has no hosted-agent identity or canonical runtime description for those fields.

LLM spans do not receive `gen_ai.agent.name`. Execute-tool spans copy `gen_ai.agent.name` from their actual parent context, so main-agent tools use `qwen-code`, subagent tools use the subagent name, and standalone tools omit the field.

When `telemetry.includeSensitiveSpanAttributes` is enabled, a user-origin invocation may also record `gen_ai.input.messages` as one user text message containing the original prompt before `@file`, IDE, hook, system-reminder, or tool-result expansion. Automatic Retry, Continue, Notification, Teammate, Cron, and runtime Goal invocations do not synthesize user input. ACP prefers its validated display text over its internal model prompt.

A successful invocation may record `gen_ai.output.messages` as one assistant text message containing only the final user-visible answer. The capture excludes thought parts, alternate candidates, tool prefaces and calls, tool results, Stop-hook instructions, and obsolete retry or continuation attempts. `MAX_TOKENS` maps to `length`, filtered output maps to `content_filter`, and structured JSON success is compact JSON text with `finish_reason=tool_call`. Failed, cancelled, incomplete, tool-pending, loop-detected, and structured-output-missing invocations omit partial output. These two attributes are independently omitted rather than truncated when their complete compact JSON exceeds `telemetry.sensitiveSpanAttributeMaxLength`.

## Lifecycle

Active main-agent interactions are stored in a strong `promptId -> SpanContext` registry. Explicit prompt IDs resolve only an exact owner; they never fall back to a process-global "last interaction". Calls without a prompt ID may use only the current AsyncLocalStorage interaction.

`UserQuery`, `Retry`, `Cron`, `Notification`, `Teammate`, and `Goal` start a new invocation. `ToolResult`, `Hook`, and `Steer` continue an existing invocation only when their prompt ID resolves to an active owner. Starting another invocation with the same prompt ID first cancels the unfinished span instead of silently replacing it.

An interaction remains open while the model has pending tool calls. The TUI and headless runners explicitly close it when they will not submit the tool result, including cancellation, Goal termination, structured output, model-switch termination, background-capacity exhaustion, continuation admission failure, and invocation handoff. Shutdown closes every registered interaction. The existing 30-minute TTL remains a final leak safety net and removes the corresponding registry entry.

The lifecycle deliberately uses terminal state plus idempotent finalization rather than reference counting. Hook and steer continuations are synchronously nested, while tool-result continuations are correlated by prompt ID.

## Status and errors

Successful and cancelled GenAI spans leave OpenTelemetry status `UNSET`. Failed spans set status `ERROR`, write a bounded and sanitized status description, and include a low-cardinality `error.type`. This applies to interaction, LLM, tool, tool-execution, hook, and subagent spans.

For headless JSON Schema runs, the missing-output contract belongs to the user-origin `UserQuery` or `Retry` invocation and follows that owner across tool continuations. Automatic Cron, Notification, Teammate, and runtime Goal drain invocations may complete with plain text without being individually mislabeled `structured_output_missing`; the headless runner remains the authority for the session-level final verdict.

## Compatibility

The longer lifecycle changes `interaction.duration_ms`: it now includes tool execution and approval wait time. Retry and Goal messages create additional interaction spans. CLI interactions remain trace roots, while ACP and daemon interactions continue to honor an explicit inbound parent context.

This phase does not aggregate token usage on agent spans, capture system instructions or tool definitions on the agent span, add configuration switches, or trace workflow invocations and workflow dispatches.

## Verification

Unit tests cover both interaction creation APIs, exact attributes and omissions, JSON Schema output type, status/error behavior, prompt isolation, duplicate prompt handling, TTL and shutdown cleanup, external parents, tool agent-name inheritance, original-input provenance, bounded final-output capture, retries, tool loops, Stop/Steer continuations, and exact span ownership. The GenAI integration test verifies that one interaction parents two LLM requests and one tool span in the same trace while recording only the original user prompt and final answer on the interaction.
