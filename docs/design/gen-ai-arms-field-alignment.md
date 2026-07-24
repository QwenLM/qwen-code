# GenAI and ARMS field alignment

## Scope and standards baseline

This design aligns the first set of Qwen Code span attributes whose names,
types, and meanings agree between OpenTelemetry GenAI semantic conventions and
Alibaba Cloud ARMS LLM Trace. It does not change span names, span kinds,
parenting, or retry topology.

The OpenTelemetry GenAI convention is still Development status. This change is
pinned to commit
[`2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b`](https://github.com/open-telemetry/semantic-conventions-genai/tree/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b):

- [Inference spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-spans.md)
- [Agent spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-agent-spans.md)
- [GenAI registry](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/model/gen-ai/registry.yaml)

The ARMS baseline is [LLM Trace field definitions](https://help.aliyun.com/zh/arms/application-monitoring/developer-reference/llm-trace-field-definition-description).
An upgrade to either baseline requires regenerating and reviewing this matrix.

## Field contract

| Span         | Standard attributes emitted in this phase                                                                                                                                                                                | Source and omission rule                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM          | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.request.model`                                                                                                                        | Written at span creation. Conversation ID is the existing session ID.                                                                                                     |
| LLM request  | `gen_ai.request.choice.count`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.request.stop_sequences` | Read from the first provider-final SDK request object. Invalid or unavailable values are omitted; no SDK or server defaults are inferred.                                 |
| LLM input    | `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`                                                                                                                                         | Sensitive compact JSON from the same first provider-final request. Each complete value is independently omitted if invalid or oversized.                                  |
| LLM response | `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`                                                                                                                                          | Provider response data only. Missing response model is omitted rather than replaced with the request model. All candidate finish reasons are ordered by candidate index.  |
| LLM output   | `gen_ai.output.type`, `gen_ai.output.messages`                                                                                                                                                                           | Output type is emitted for supported Gemini/Vertex request settings. Sensitive output messages come from the final physical request attempt and preserve every candidate. |
| LLM usage    | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`                                                                            | Only provider-reported non-negative safe integers. Explicit zero is retained. When only a total is reported, input/output are omitted instead of estimated.               |
| Tool         | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.type=function`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`                         | Description is non-sensitive static registry metadata. Sensitive arguments reflect the executed invocation; result is emitted only for a successful tool call.            |
| Agent        | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id`, optional `gen_ai.request.model`                                                                         | Description uses the existing 1024-UTF-16-code-unit truncation threshold and never splits surrogate pairs. Internal invocation IDs remain private.                        |

Private attributes without an exact standard equivalent remain available for
compatibility. Exact-equivalent private aliases and invalid GenAI aliases are
removed without a dual-write period:

| Removed attribute                                      | Replacement                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| LLM `qwen-code.model`                                  | `gen_ai.request.model`; interaction spans continue using `qwen-code.model` because they are not GenAI inference spans |
| LLM `response_id`                                      | `gen_ai.response.id`; API response/error logs retain their existing `response_id` schema                              |
| LLM `input_tokens`                                     | `gen_ai.usage.input_tokens` when the provider reports an input breakdown                                              |
| LLM `output_tokens`                                    | `gen_ai.usage.output_tokens` when the provider reports an output breakdown                                            |
| LLM `cached_input_tokens`                              | `gen_ai.usage.cache_read.input_tokens` when the provider reports cache reads                                          |
| `qwen-code.tool` Span `tool.name`                      | `gen_ai.tool.name`; blocked-on-user and hook spans continue using `tool.name`                                         |
| `gen_ai.usage.cached_tokens`                           | `gen_ai.usage.cache_read.input_tokens` when the provider reports cache reads                                          |
| `gen_ai.server.time_to_first_token`                    | No common attribute; continue querying private `ttft_ms`                                                              |
| `gen_ai.usage.reasoning_tokens`                        | No ARMS/GenAI common attribute in this baseline; continue querying private `thoughts_token_count`                     |
| LLM `system_prompt*`                                   | `gen_ai.system_instructions`; OpenAI system/developer messages are represented in `gen_ai.input.messages`             |
| LLM `tools`, `tool_schema` events                      | `gen_ai.tool.definitions`                                                                                             |
| LLM `response.model_output*`                           | `gen_ai.output.messages`                                                                                              |
| Tool `tool_input*`                                     | `gen_ai.tool.call.arguments`                                                                                          |
| Tool `tool_result*`                                    | `gen_ai.tool.call.result`                                                                                             |
| `tools_count`, hash/preview/length/truncation metadata | No standard equivalent; removed                                                                                       |

## Provider and operation resolution

Resolution is a pure function over the effective content-generator config. It
never returns a URL, credential, arbitrary proxy hostname, or a value inferred
from the model name.

1. Qwen OAuth and an exact `DASHSCOPE_PROXY_BASE_URL` match resolve to
   `dashscope`.
2. A boundary-safe hostname match recognizes Alibaba Model Studio endpoints and
   internal Alibaba gateways, Azure OpenAI, and the supported third-party
   endpoints (DeepSeek, xAI, Mistral, MiniMax, Z.AI, ModelScope, MiMo,
   OpenRouter, and Requesty).
3. If the host is unknown, a known `apiKeyEnvKey` identifies the configured
   provider. Host identity wins on conflict.
4. Unknown endpoints fall back to the protocol provider: `openai`,
   `anthropic`, `gcp.gemini`, or `gcp.vertex_ai`.

OpenAI-compatible, Anthropic, and Qwen OAuth requests use operation `chat`.
Gemini and Vertex AI requests use `generate_content`.

## Request parameters

Request attributes are collected after provider adapters have applied defaults,
overrides, unsupported-field removal, and output-window clamps, immediately
before calling the provider SDK. This is the final SDK request object visible
to Qwen Code, not the original logical configuration or the serialized HTTP
body. A logical LLM span records only its first such request snapshot.

| Standard attribute                 | OpenAI-compatible and Qwen OAuth                           | Anthropic          | Gemini and Vertex AI      |
| ---------------------------------- | ---------------------------------------------------------- | ------------------ | ------------------------- |
| `gen_ai.request.choice.count`      | `n`                                                        | Not applicable     | `config.candidateCount`   |
| `gen_ai.request.max_tokens`        | `max_tokens`, `max_completion_tokens`, or `max_new_tokens` | `max_tokens`       | `config.maxOutputTokens`  |
| `gen_ai.request.temperature`       | `temperature`                                              | `temperature`      | `config.temperature`      |
| `gen_ai.request.top_p`             | `top_p`                                                    | `top_p`            | `config.topP`             |
| `gen_ai.request.frequency_penalty` | `frequency_penalty`                                        | Not currently sent | `config.frequencyPenalty` |
| `gen_ai.request.presence_penalty`  | `presence_penalty`                                         | Not currently sent | `config.presencePenalty`  |
| `gen_ai.request.stop_sequences`    | `stop`                                                     | `stop_sequences`   | `config.stopSequences`    |

Finite numbers and safe integers are preserved exactly, including zero and
negative values on failed provider requests. Choice count is omitted when it is
one. Stop sequences must be a complete string array; OpenAI's single-string
form is normalized to a one-element array. Empty arrays are retained and mixed
arrays are omitted rather than filtered. Explicit adapter defaults are
recorded, while implicit SDK or server defaults are not inferred.

When multiple OpenAI-compatible output-budget aliases are present, the standard
maximum is emitted only if all present values are valid safe integers and
equal. Conflicting values are omitted because compatible endpoints do not have
a common precedence rule.

## Content and tool payloads

Sensitive GenAI content is collected only when
`telemetry.includeSensitiveSpanAttributes` is enabled. Qwen Code does not read
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, so there is a single
content-capture switch. OpenAI-compatible, Anthropic, Gemini, and Vertex
adapters convert their provider-final SDK request and raw response structures
to the JSON schemas pinned with this design.

The first physical request attempt supplies input messages, system
instructions, and tool definitions. Responses are generation-bound: a provider
fallback or required-thinking retry starts a new response accumulator, and
late chunks from an older attempt are ignored. Streaming accumulators retain
canonical parts rather than raw chunks. Partial failures mark unfinished
candidates with `error`; a successful response with a candidate that lacks an
explicit finish reason omits the complete output-message attribute.

Each JSON attribute is compactly serialized and independently limited by
`telemetry.sensitiveSpanAttributeMaxLength`. Invalid, cyclic, incomplete, or
oversized values are omitted as a whole; JSON is never truncated. Empty arrays
and objects are retained when the provider explicitly sends or returns them.
With the default 1 MiB limit, the application-side theoretical maximum is about
4 MiB of sensitive attributes per LLM span and 2 MiB per Tool span. Collectors
and backends can impose lower limits.

Tool arguments are captured from the final invocation parameters immediately
before execution, after permission and edit hooks. A tool result is captured
only after a successful call and successful post-processing, from the final
`FunctionResponse.response` object returned to the model. Both roots must be
JSON objects. `gen_ai.tool.description` comes from the static registry
description and is not sensitive; it is limited to 4096 UTF-16 code units,
preserves surrogate pairs, and appends `…[truncated]` when shortened. Agent
descriptions and span errors retain their 1024-unit limits.

## Response and usage provenance

Provider converters attach internal provenance to normalized Gemini usage
objects with a `WeakMap`. It records whether a cache-read field was actually
present and Anthropic cache-creation tokens. This preserves the public response
JSON shape and lets garbage collection follow the normalized usage object.

When an OpenAI-compatible provider reports only `total_tokens`, the normalized
total remains available to existing internal consumers, but no input/output
split is synthesized and neither standard usage attribute is emitted.

OpenAI `response.model`/`chunk.model` and Anthropic message model are preserved
as `modelVersion`. A missing provider model remains missing for tracing;
request-model fallback remains limited to existing API logs and UI behavior.
Stream merging carries the last known provider model and usage provenance into
the terminal response. Anthropic `message_start` input and cache usage is
attached to the first subsequent yielded chunk so partial stream failures retain
provider-reported usage without synthesizing an output count.

## ARMS configuration

ARMS automatic GenAI application recognition requires this resource attribute:

```json
{
  "telemetry": {
    "resourceAttributes": {
      "acs.arms.service.feature": "genai_app"
    }
  }
}
```

Qwen Code does not inject that vendor-specific resource attribute or
`gen_ai.span.kind`. ARMS can infer LLM, Tool, and Agent roles from
`gen_ai.operation.name`.

## Deferred work

- `seed` and `top_k` have incompatible ARMS and GenAI types in the baselines.
- Embedding needs a correct requested-model lifecycle before tracing.
- ARMS time-to-first-token and OpenTelemetry time-to-first-chunk differ in name,
  unit, and meaning, so private `ttft_ms` remains authoritative.
- Full GenAI span naming, CLIENT span kind, and logical retry topology are a
  separate compliance project.
