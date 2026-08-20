# Tool-call preparation events

## Context

Qwen Code currently emits a tool call only after the provider has finished
streaming its arguments. For tools with large or complex inputs, generating
those arguments can take much longer than executing the tool itself. ACP
clients therefore show no activity during the expensive part and users can
mistake the turn for a stalled request.

The provider streams already expose stable tool identity before the arguments
are complete:

- Anthropic sends `id` and `name` in `content_block_start` for a `tool_use`
  block, then sends argument fragments as `input_json_delta`.
- OpenAI-compatible providers normally send `id` and `function.name` in the
  first `choice.delta.tool_calls` item, then append argument fragments.

Qwen Code deliberately waits for `content_block_stop` or `finish_reason`
before constructing a Gemini-compatible `functionCall`. That execution safety
property must remain unchanged.

## Goal

Let ACP clients render a tool card while the model is still preparing tool
arguments, with this lifecycle:

```text
preparing -> in_progress -> completed | failed
```

The early event contains only the stable tool-call ID and tool name. It never
contains partial arguments and never starts tool execution.

## Scope

This change supports the two provider paths used by the integrating client:

- Anthropic and Anthropic-compatible streaming responses.
- OpenAI and OpenAI-compatible streaming responses.

Other providers keep their current behavior. Because preparation metadata is
optional, they naturally degrade to the existing
`in_progress -> completed | failed` lifecycle.

The change does not alter:

- tool permission checks;
- hook ordering;
- tool scheduling or execution;
- model conversation history;
- `functionCall` or `functionResponse` construction;
- non-ACP output formats.

## Design

### 1. Internal response metadata

Associate transient tool preparation metadata with each
`GenerateContentResponse` through a module-local `WeakMap`:

```ts
interface ToolCallPreparation {
  callId: string;
  toolName: string;
}
```

Provider adapters store this metadata against the top-level response chunk.
It is neither an enumerable response property nor a Gemini `Part`, so it is
not serialized and Gemini history assembly continues to see only text,
thought, and complete `functionCall` parts. Shared helpers provide typed store
and read operations, avoiding provider-specific casts in ACP.

### 2. Anthropic producer

In `AnthropicContentGenerator.processStream()`, when
`content_block_start(tool_use)` contains a non-empty `id` and `name`, yield an
otherwise empty Gemini response chunk carrying one preparation entry.

Continue accumulating `input_json_delta` unchanged. At `content_block_stop`,
emit the existing complete `functionCall` with parsed arguments. No argument
data is exposed before that point.

### 3. OpenAI-compatible producer

In `convertOpenAIChunkToGemini()`, observe each
`choice.delta.tool_calls` item after passing it to the existing stream-local
tool-call parser. When a stable non-empty ID and name are available for the
first time, attach one preparation entry to the current response chunk.

Deduplicate by tool-call ID within the request context. Continue emitting the
complete `functionCall` only when `finish_reason` is present. Providers that do
not expose both identity fields early simply keep the existing behavior.

### 4. ACP consumer and state transitions

ACP `Session` reads preparation metadata before collecting complete
`functionCalls`. For each new preparation it emits the standard ACP
`tool_call` frame with:

```ts
{
  status: 'pending',
  rawInput: {},
  _meta: {
    phase: 'preparing',
    toolName,
    // existing provenance metadata remains present
  },
}
```

The existing execution path later emits the same `toolCallId` with
`status: 'in_progress'` and the complete arguments. Existing result emission
then finishes the card as `completed` or `failed`.

`TodoWrite` keeps its current special handling and does not emit a tool card.
Preparation emission uses the same filtering rule, so it cannot create a card
that the execution path intentionally suppresses.

### 5. Retry, fallback, cancellation, and stream failure

Each active ACP model stream tracks preparations until the stream completes and
hands its parsed calls to tool execution. When an attempt is abandoned by
retry, model fallback, user cancellation, or stream error, ACP emits a terminal
`tool_call_update` for each remaining entry:

```ts
{
  status: 'failed',
  content: [],
  _meta: {
    phase: 'preparing',
    preparationDiscarded: true,
    toolName,
  },
}
```

`preparationDiscarded` means the model attempt was abandoned before a parsed
tool request reached execution. It is not a tool execution failure. The integrating
client should remove this transient card rather than render a failed tool.
Using a protocol-valid terminal status ensures older clients do not retain an
indefinitely pending card.

`RETRY` now clears complete `functionCalls` collected from the abandoned
attempt, matching the existing `MODEL_FALLBACK` behavior across all four ACP
stream paths. This prevents a parsed call from the failed attempt from being
executed together with calls from the replacement attempt.

When a complete `functionCall` with the same ID arrives and the stream finishes
normally, ACP hands it to the existing execution path without a discarded
update. If the stream fails after parsing the call but before execution, the
preparation is still discarded. Normal tool errors therefore continue through
the existing result path and are never marked as discarded.

## Downstream impact

- `GeminiChat` and history builders ignore the optional top-level metadata and
  continue persisting only candidate content.
- A response containing only preparation metadata is not counted as
  user-visible output, so transport retry and model fallback keep their
  existing pre-output behavior.
- Preparation IDs use the same cross-turn normalization as complete
  `functionCall` IDs, preserving ACP update correlation when a provider reuses
  an ID from history.
- Core `Turn`, TUI, and non-interactive JSON consumers keep their current
  behavior because no new Gemini `Part` or server event is introduced.
- ACP is the only consumer that opts into the metadata and emits the early UI
  state.
- The same metadata contract is shared by Anthropic and OpenAI-compatible
  adapters, so ACP has no provider-specific branches.

## Test plan

### Core provider tests

- Anthropic: a `content_block_start(tool_use)` yields preparation metadata
  before any `input_json_delta` and before the final `functionCall`.
- Anthropic: missing ID or name does not emit preparation metadata.
- OpenAI-compatible: the first delta with stable ID and name emits one
  preparation entry; later argument deltas do not duplicate it.
- OpenAI-compatible: complete calls still appear only at `finish_reason`, with
  unchanged parsed arguments.
- OpenAI-compatible: missing early identity fields fall back to current
  behavior without an invalid preparation event.
- GeminiChat: preparation-only chunks do not suppress transport retry, primary
  model fallback, or continuation through a multi-model fallback chain.
- GeminiChat: cross-turn duplicate provider IDs are normalized consistently in
  preparation metadata and complete calls.

### ACP tests

- Preparation metadata emits `pending` with `_meta.phase = 'preparing'` and
  no partial input.
- The complete call reuses the same ID and transitions to `in_progress` with
  complete arguments.
- Retry, fallback, cancellation, and stream error discard preparations that
  have not reached tool execution with `_meta.preparationDiscarded = true`.
- Retry and model fallback clear complete calls collected from the abandoned
  attempt before accepting replacement chunks.
- A preparation that became a complete call is not discarded after a normally
  completed stream, but is discarded if that stream fails before execution.
- `TodoWrite` remains suppressed.

### Regression verification

Run the focused provider and ACP suites from their package directories, then
run repository build, typecheck, and lint before completion. The implementation
rebased on v0.19.9 has been verified with:

- Core provider and stream suites: 649 passed.
- ACP lifecycle suites: 316 passed.
- Repository build, workspace typecheck, and full lint: passed.
- Changed-file Prettier and diff checks: passed.

## Acceptance criteria

1. Anthropic and OpenAI-compatible ACP turns emit a pending tool card as soon
   as stable tool identity is available.
2. No tool starts before complete arguments and the existing permission and
   execution paths run.
3. Complete calls and results retain their current IDs, arguments, ordering,
   and history representation.
4. Abandoned attempts leave no indefinitely pending preparation card.
5. Providers without preparation metadata behave exactly as before.
