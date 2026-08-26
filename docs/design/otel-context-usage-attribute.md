# OpenTelemetry context usage attribute

## Status and scope

This design adds one private OpenTelemetry attribute to each user-facing
`qwen-code.llm_request` span:

```text
qwen-code.context.usage
```

The attribute value is a compact, versioned JSON string. It reports the model
context window, the estimated input breakdown used by `/context`, the active
compaction reserve, and the remaining input capacity before automatic
compaction.

This change does not add a metric, log event, session attribute, or standard
`gen_ai.*` field. `gen_ai.usage.input_tokens` remains the authoritative total
input-token count reported by the provider. This design extends the private
Qwen Code namespace because the version-pinned GenAI semantic-convention
baseline in `gen-ai-arms-field-alignment.md` has no standard attribute for a
Qwen Code context-category breakdown.

## Attribute contract

OpenTelemetry attributes cannot contain arbitrary objects, so the value is a
JSON string produced with `JSON.stringify`. A representative final value is
shown pretty-printed below; the emitted value contains no insignificant
whitespace:

```json
{
  "version": 1,
  "window_size_tokens": 200000,
  "breakdown": {
    "system_prompt_tokens": 12000,
    "builtin_tools_tokens": 8000,
    "mcp_tools_tokens": 3000,
    "memory_files_tokens": 2000,
    "skills_tokens": 1500,
    "messages_tokens": 83000
  },
  "compaction_reserve_tokens": 33000,
  "available_before_compaction_tokens": 57500,
  "estimated": true
}
```

The corresponding span also contains:

```text
gen_ai.usage.input_tokens = 109500
```

The JSON deliberately does not duplicate that total. Consumers that need a
usage ratio read the standard scalar and parse only the additional context
metadata from `qwen-code.context.usage`.

### Schema version 1

```ts
interface ContextUsageV1 {
  version: 1;
  window_size_tokens: number;
  breakdown: {
    system_prompt_tokens: number;
    builtin_tools_tokens: number;
    mcp_tools_tokens: number;
    memory_files_tokens: number;
    skills_tokens: number;
    messages_tokens: number;
  };
  compaction_reserve_tokens: number;
  available_before_compaction_tokens?: number;
  estimated: true;
}
```

All token values are finite and non-negative. Category estimates are integers.
The compaction reserve is derived from the auto threshold returned by
`computeThresholds`; it is normally an integer but may be fractional when a
custom percentage produces a fractional threshold.

`estimated` applies to the category attribution. The window size and
compaction reserve come from the effective runtime configuration.
`available_before_compaction_tokens`, when present, is based on the
provider-reported standard input-token count rather than on the category
estimator.

`available_before_compaction_tokens` is intentionally not named
`free_space_tokens`. It has the same operational meaning as `/context`'s
current `freeSpace` calculation:

```text
max(
  0,
  window_size_tokens
    - compaction_reserve_tokens
    - gen_ai.usage.input_tokens
)
```

It therefore means input capacity remaining before automatic compaction, not
raw capacity remaining before the model's context-window edge.

`compaction_reserve_tokens` is the distance from the automatic-compaction
threshold to the window edge:

```text
window_size_tokens - computeThresholds(window_size_tokens, configured_pct).auto
```

It includes both the summary-output reserve and any additional headroom
introduced by the proportional auto-compaction threshold. It is not an alias
for the fixed summary-output budget.

Warn, auto, hard, and effective-window thresholds are not serialized as
separate JSON keys. The auto threshold is derivable from the window and
reserve, while the other thresholds were not part of the requested payload.

## Category attribution

The snapshot is built synchronously from the logical request received by
`LoggingContentGenerator`. This is the last provider-neutral request shape
shared by all supported providers and already contains Qwen Code's effective
system instruction, messages, and tool declarations for that attempt.
Provider adapters may still normalize that request before the SDK call, so the
breakdown describes Qwen Code's logical context rather than a provider's wire
serialization or billing tokenizer.

If a direct or custom caller supplies an unresolved `CallableTool`, Qwen Code
omits the complete private attribute for that attempt. Resolving the callable
would add asynchronous provider-adapter work to the synchronous snapshot path,
while treating it as an empty declaration would silently misclassify its token
cost. Normal Qwen Code request construction supplies materialized function
declarations and is unaffected.

| JSON field             | Source and attribution rule                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window_size_tokens`   | The `ContentGeneratorConfig` owned by the wrapped generator, falling back to `DEFAULT_TOKEN_LIMIT`. This avoids accidentally using the main model's window for a fallback or side model.                                                      |
| `system_prompt_tokens` | The effective request system instruction, excluding recognized memory segments. Base prompt, append prompt, git status, and any unclassified system text remain here.                                                                         |
| `builtin_tools_tokens` | Tool declarations present in the logical request, excluding MCP declarations and the Skill tool declaration. Deferred tools that have not been revealed are absent because they are absent from the request.                                  |
| `mcp_tools_tokens`     | Logical request declarations whose matching registry entries are `DiscoveredMCPTool` instances. No server or tool name is serialized.                                                                                                         |
| `memory_files_tokens`  | `Config.getUserMemory()` and `Config.getAutoMemoryPrompt()` only when the corresponding text is present in the effective system instruction. This includes context files, memory, and auto memory without exposing paths or contents.         |
| `skills_tokens`        | The Skill tool declaration plus loaded `SKILL.md` bodies that exactly match immutable LLM-facing outputs retained when the Skill tool inserted them into request history.                                                                     |
| `messages_tokens`      | User, assistant, and tool-result content in the request, excluding loaded skill bodies already attributed to `skills_tokens`. On finalization it becomes the residual after the fixed categories are normalized against provider input usage. |

Memory attribution uses exact segment removal. For each non-empty value from
`getUserMemory()` and `getAutoMemoryPrompt()`, remove its exact trimmed text
from the effective system instruction before estimating
`system_prompt_tokens`, then count the removed text once in
`memory_files_tokens`. A configured block that is absent from the request, or
whose exact match fails, remains part of `system_prompt_tokens` and is not also
added to `memory_files_tokens`.

System instructions, tool definitions, memory, and skill text use the
CJK-aware heuristic already used by `/context`: ASCII characters are estimated
at four characters per token and non-ASCII characters at 1.5 tokens per
character. The implementation extracts that small pure helper into core so the
CLI and telemetry cannot drift.

Structured request messages use the existing `estimateContentTokens` traversal
instead of stringifying the complete request. That traversal handles text,
function calls, function responses, and inline media without counting image
base64 as ordinary prompt text. This reporting change does not alter
`estimateContentTokens` or the safety-critical compaction gate that already
depends on it.

The two estimators are intentionally asymmetric at request start. Fixed text
categories use the CJK-aware context-reporting heuristic, while structured
messages retain the compaction estimator's flat character ratio. CJK-heavy
messages may therefore be under-attributed on failed, cancelled, or
TTL-abandoned spans that never receive provider usage. Completed spans absorb
that difference when `messages_tokens` becomes the provider-total residual.
The extracted helper has a distinct context-reporting name and must not replace
`estimateContentTokens` in the compaction gate.

The telemetry path never calls `SkillManager.listSkills()`. The in-memory Skill
tool retains each exact `buildSkillLlmContent` output when it first inserts that
body into request history, so later edits or cache reloads cannot rewrite
historical attribution. One pass over request parts matches only parts whose
`functionResponse.name === "skill"`, comparing
`functionResponse.response.output` exactly against the retained outputs. It
does not stringify the whole part or match `parts[].text`. A matched output is
counted once in `skills_tokens` and excluded from `messages_tokens`. This avoids
substring matches and per-skill scans of the full request. Subsequent
already-loaded confirmations and microcompacted outputs do not match the
indexed first-load body and remain in `messages_tokens`. When compaction has
removed the exact body, no body tokens are added to `skills_tokens`; any
remaining summary stays in `messages_tokens`. The attribute remains complete
and non-blocking, while `estimated: true` communicates that attribution is
approximate.

### Provider-total normalization

At request start, every category is a local estimate and
`available_before_compaction_tokens` is omitted. If the provider later reports
a valid `gen_ai.usage.input_tokens`, finalization applies the following rules:

1. Preserve the five fixed-category proportions: system prompt, built-in
   tools, MCP tools, memory files, and skills.
2. If their estimated sum exceeds the provider total, scale them down
   proportionally using largest-remainder allocation: multiply each category
   by the common scale, floor all five results, then distribute the remaining
   `provider_total - sum(floors)` tokens by descending fractional remainder.
   Ties use the schema field order above. In this branch, the five fixed
   categories sum to the provider total and `messages_tokens` is zero.
3. Otherwise, leave the five fixed estimates unchanged and set
   `messages_tokens` to `provider_total - fixed_category_sum`.
4. Set `available_before_compaction_tokens` from the window, reserve, and the
   same provider total.

The final invariant is:

```text
sum(breakdown.*_tokens) == gen_ai.usage.input_tokens
```

when the provider reports a valid input total. Cached-input tokens require no
special treatment: do not copy `/context`'s `apiCachedTokens` branch or subtract
cache reads from `messages_tokens`. Cache reads affect billing and latency, not
which context category the tokens belong to, and remain represented only by
`gen_ai.usage.cache_read.input_tokens`.

When no valid provider total is available, the request-start estimates remain
on the span, the breakdown is not forced to an unknown total, and
`available_before_compaction_tokens` remains absent.

## Span lifecycle and ownership

`LoggingContentGenerator.generateContent` and `generateContentStream` build the
snapshot in their synchronous prelude, before the first `await`. This captures
the request's tool-reveal, memory, skill, model-window, and compaction-reserve state for
that attempt and prevents later mutable configuration from changing the span.
The work is gated by `isTelemetrySdkInitialized()` so normal requests pay no
context-scanning cost when tracing is disabled.

`LoggingContentGenerator` is shared by concurrent calls. Only the effective
window size is retained as immutable constructor state; each context snapshot
is a method-local value and is then owned by its `SpanContext`. No mutable
per-request snapshot is stored on the generator instance.

The snapshot is passed through `StartLLMRequestSpanOptions` and retained in the
internal `SpanContext`:

1. `startLLMRequestSpanWithContext` serializes the request-start snapshot onto
   the span immediately. Abandoned spans ended by TTL cleanup therefore still
   carry the basic context metadata.
2. `endLLMRequestSpan` uses valid `metadata.inputTokens` to normalize the
   breakdown and overwrite the same attribute before ending the span.
3. Success, stream completion, cancellation, timeout, and error paths continue
   to use the existing centralized end helper. No new per-path telemetry call
   is introduced.

The retry layer creates one LLM span per physical attempt today. Each attempt
therefore receives its own snapshot. Failed attempts commonly retain the local
estimate, while the successful attempt normally receives the provider-total
normalized value.

Background prompt IDs recognized by `isInternalPromptId` do not emit this
attribute. Their requests are not the user-facing conversation whose
`/context` state and auto-compaction capacity this field represents. Standard
provider usage attributes remain unchanged on those spans. Main-agent,
subagent, and non-internal standalone LLM requests emit the attribute.

## Artifact boundary and offline analysis

The session JSONL and an exported trace are separate diagnostic artifacts. Chat
recording is enabled by default and the local JSONL persists accepted
conversation content, tool calls and results, usage metadata, the context-window
size, and compression checkpoints. It can also be disabled, and collecting it
would disclose raw conversation content that a centralized operator may not
have permission to access. The target offline workflow for this attribute is
therefore analysis of a sanitized exported trace without collecting or joining
the user's local transcript.

The JSONL is also a conversation and resumption record rather than a complete
physical-attempt snapshot. It does not preserve the effective assembled system
instruction, the actual tool declarations revealed for an attempt, the exact
memory/configuration and loaded-skill attribution, or every failed retry
attempt. The concrete query supported here is: for one physical LLM attempt,
did context pressure, latency, an error, cache behavior, or compaction correlate
primarily with system instructions, built-in or MCP tools, memory, loaded
skills, or messages? The trace answers that query without exposing the
underlying text or requiring a cross-artifact join. The non-reconstructable
inputs needed by that query are the effective `system_prompt_tokens`,
`builtin_tools_tokens`, `mcp_tools_tokens`, `memory_files_tokens`, and
`skills_tokens` values for that exact attempt.

Some accepted-turn values, especially message usage and the window size, can be
reconstructed from the local JSONL. Version 1 nevertheless keeps all six
categories so each trace snapshot is self-contained and so the
provider-total invariant does not depend on another artifact with different
retention, permissions, and attempt coverage.

This attribute adds no second opt-in or sampling switch. When tracing is
initialized, every non-internal physical attempt follows the emission rules
above, including retries and subagents. Existing trace and exporter policy
remains the control plane for whether spans are recorded or exported.

## Failure, privacy, and performance rules

- Context telemetry is best effort. Snapshot or serialization failure omits
  the complete attribute and never changes request execution.
- Invalid window sizes omit the complete attribute. Invalid category values
  are not partially serialized.
- The payload contains only a fixed key set, numeric aggregates, a boolean,
  and a schema version. It never contains prompt text, message text, file
  paths, tool names, MCP server names, skill names, model IDs, session IDs, or
  user IDs.
- The attribute is not gated by
  `telemetry.includeSensitiveSpanAttributes`; aggregate token counts have the
  same sensitivity class as the existing standard usage counts.
- No filesystem, network, tokenizer, or asynchronous work is allowed on the
  span-start path. Tool and skill information comes only from the request and
  committed in-memory caches.
- Snapshot construction performs a bounded number of linear passes over the
  logical request. It must not add a nested scan per tool, skill, or message.
- The schema has a fixed key set and a bounded serialized size. JSON is compact
  and is never truncated into invalid JSON. Serialization omits the complete
  attribute if it exceeds a fixed 1024-character safety limit.
- The size bound limits per-span payload, not fleet-wide ingestion or value
  cardinality. Total volume scales with physical attempts, including retries
  and subagents, and the aggregate JSON values are expected to be nearly
  unique. Backends should parse selected keys rather than index the complete
  string.

## Compatibility and query contract

Consumers must parse the JSON and branch on `version`. Unknown keys must be
ignored. Adding an optional key with unchanged semantics is compatible within
version 1. Renaming or removing a key, changing units, or changing the meaning
of a category requires a new version.

Unavailable optional values are omitted rather than serialized as `null` or a
sentinel. Version 1 always includes the six breakdown keys, the compaction
reserve, and `estimated` when the attribute is emitted.

Backend queries use the standard scalar for total usage and JSON extraction
for category analysis. Conceptually:

```text
input utilization = gen_ai.usage.input_tokens
                  / json(window_size_tokens)

MCP share = json(breakdown.mcp_tools_tokens)
          / gen_ai.usage.input_tokens
```

JSON parsing is less index-friendly than separate scalar attributes, and the
near-unique complete string is unsuitable as an indexed dimension. That is the
accepted tradeoff for adding only one field. Version 1 has not been validated
against production fleet volume or a live backend query. Rollout validation
must measure exported bytes per attempt and representative JSON-extraction
query cost. If either is unacceptable, a follow-up can use the existing trace
sampling control or define a narrower versioned contract; version 1 does not
pre-allocate scalar aliases.

## Implementation plan

1. Add the existing `/context` CJK-aware text estimator to the dependency-light
   `services/tokenEstimation.ts` module under a distinct context-reporting name
   and export it through the core package. Make `/context` import that helper.
   Leave the existing `estimateContentTokens` compaction estimator unchanged,
   and keep CLI detail parsing, localization, and rendering in the CLI package.
2. Add a pure `telemetry/context-usage.ts` module defining the V1 type,
   provider-total normalization, validation, the 1024-character limit, and
   compact serialization. It must not import `Config`, tool implementations,
   or `LoggingContentGenerator`, so `session-tracing` cannot create a
   telemetry-to-tools dependency cycle.
3. Keep request-source collection at the request wrapper boundary. Retain the
   owning generator-configuration reference in `LoggingContentGenerator`, read
   its effective context-window size at snapshot time, classify the request
   using `Config` and the tool registry there, and pass only the resulting plain
   numeric snapshot to both streaming and non-streaming span starts.
4. Extend `StartLLMRequestSpanOptions` and the internal `SpanContext` with the
   structured snapshot. Serialize at start and overwrite after valid input
   usage is available in `endLLMRequestSpan`.
5. Do not change the span name, span kind, existing standard usage fields,
   sensitive-content controls, events, metrics, or exporters.

## Verification plan

Unit tests for the context-usage module cover:

- the exact version-1 JSON shape and compact serialization;
- whole-attribute omission above the 1024-character safety limit;
- CJK and ASCII estimation parity with `/context`;
- structured messages with inline media, without base64-size inflation;
- system-prompt versus memory attribution;
- exact-match failure that leaves memory only in the system-prompt category;
- built-in, revealed MCP, hidden deferred, and Skill tool attribution from the
  logical request;
- loaded-skill attribution from the immutable inserted output, including cache
  edits and no stale body attribution after compaction;
- largest-remainder normalization, including deterministic ties, whose
  breakdown sum equals provider input;
- cached provider input remaining in the full category sum while cache reads
  stay on the standard cache-read attribute;
- omission of availability without provider input and its calculation against
  the derived auto threshold when input is present;
- rejection of invalid or non-finite values; and
- absence of names, paths, and content in the serialized payload.

Session-tracing tests cover initial emission, end-time overwrite, invalid
snapshot omission, successful provider usage, error without usage,
cancellation, and idempotent span finalization.

`LoggingContentGenerator` tests cover streaming and non-streaming wiring,
effective fallback-model window ownership, one snapshot per retry attempt, and
omission for internal prompt IDs. They also verify that snapshot construction
or serialization failure cannot prevent the wrapped provider call.

A local OTLP smoke test sends one normal request and verifies that the exported
LLM span contains parseable version-1 JSON, the standard input-token scalar,
the normalized-sum invariant, and the expected auto-compaction availability.
No UI E2E plan is required because this phase does not change `/context`
rendering or other user-visible behavior. Focused core and CLI tests run from
their package directories, followed by the repository build and typecheck.

## Alternatives not selected

- **`qwen-code.context.window_size`**: too narrow for the requested category
  and compaction information and would make a later rename unavoidable.
- **Multiple scalar attributes**: easier to index, but adds a field per
  category and threshold instead of the requested single field.
- **A `gen_ai.context.*` attribute**: would occupy the standard namespace with
  a non-standard contract.
- **An OTel object value**: arbitrary objects are not valid span attribute
  values; JSON serialization is required.
- **Calling `collectContextData` from telemetry**: it is async, contains CLI
  types and localization, may discover skills from the filesystem, and reads
  post-response UI/session counters. It is not safe or correctly timed for the
  provider request path.
- **A separate metric or log event**: loses the one-to-one association with a
  concrete LLM attempt and adds another telemetry surface without being needed
  for this requirement.
