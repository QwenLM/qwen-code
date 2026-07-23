# GenAI and ARMS field alignment

## Scope and standards baseline

This design aligns the first set of Qwen Code span attributes whose names,
types, and meanings agree between OpenTelemetry GenAI semantic conventions and
Alibaba Cloud ARMS LLM Trace. It does not change span names, span kinds,
parenting, retry topology, or sensitive payload collection.

The OpenTelemetry GenAI convention is still Development status. This change is
pinned to commit
[`2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b`](https://github.com/open-telemetry/semantic-conventions-genai/tree/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b):

- [Inference spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-spans.md)
- [Agent spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-agent-spans.md)
- [GenAI registry](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/model/gen-ai/registry.yaml)

The ARMS baseline is [LLM Trace field definitions](https://help.aliyun.com/zh/arms/application-monitoring/developer-reference/llm-trace-field-definition-description).
An upgrade to either baseline requires regenerating and reviewing this matrix.

## Field contract

| Span         | Standard attributes emitted in this phase                                                                                                        | Source and omission rule                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM          | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.request.model`                                                | Written at span creation. Conversation ID is the existing session ID.                                                                                                    |
| LLM response | `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`                                                                  | Provider response data only. Missing response model is omitted rather than replaced with the request model. All candidate finish reasons are ordered by candidate index. |
| LLM output   | `gen_ai.output.type`                                                                                                                             | Gemini and Vertex AI only, and only when an explicit response MIME type or one unambiguous response modality is sent on the wire.                                        |
| LLM usage    | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`    | Only provider-reported non-negative safe integers. Explicit zero is retained. When only a total is reported, input/output are omitted instead of estimated.              |
| Tool         | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type=function`, `gen_ai.tool.call.id`                                     | Tool call ID prefers the provider/model ID and falls back to Qwen Code's internal ID.                                                                                    |
| Agent        | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id`, optional `gen_ai.request.model` | Description uses the existing 1024-UTF-16-code-unit truncation threshold and never splits surrogate pairs. Internal invocation IDs remain private.                       |

Private attributes without an exact standard equivalent remain available for
compatibility. Exact-equivalent private aliases and invalid GenAI aliases are
removed without a dual-write period:

| Removed attribute                   | Replacement                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| LLM `qwen-code.model`               | `gen_ai.request.model`; interaction spans continue using `qwen-code.model` because they are not GenAI inference spans |
| LLM `response_id`                   | `gen_ai.response.id`; API response/error logs retain their existing `response_id` schema                              |
| LLM `input_tokens`                  | `gen_ai.usage.input_tokens` when the provider reports an input breakdown                                              |
| LLM `output_tokens`                 | `gen_ai.usage.output_tokens` when the provider reports an output breakdown                                            |
| LLM `cached_input_tokens`           | `gen_ai.usage.cache_read.input_tokens` when the provider reports cache reads                                          |
| `qwen-code.tool` Span `tool.name`   | `gen_ai.tool.name`; blocked-on-user and hook spans continue using `tool.name`                                         |
| `gen_ai.usage.cached_tokens`        | `gen_ai.usage.cache_read.input_tokens` when the provider reports cache reads                                          |
| `gen_ai.server.time_to_first_token` | No common attribute; continue querying private `ttft_ms`                                                              |
| `gen_ai.usage.reasoning_tokens`     | No ARMS/GenAI common attribute in this baseline; continue querying private `thoughts_token_count`                     |

## Provider and operation resolution

Resolution is a pure function over the effective content-generator config. It
never returns a URL, credential, arbitrary proxy hostname, or a value inferred
from the model name.

1. Qwen OAuth and an exact `DASHSCOPE_PROXY_BASE_URL` match resolve to
   `dashscope`.
2. A boundary-safe hostname match recognizes Alibaba Model Studio endpoints and
   the supported third-party endpoints (DeepSeek, xAI, Mistral, MiniMax, Z.AI,
   ModelScope, MiMo, OpenRouter, and Requesty).
3. If the host is unknown, a known `apiKeyEnvKey` identifies the configured
   provider. Host identity wins on conflict.
4. Unknown endpoints fall back to the protocol provider: `openai`,
   `anthropic`, `gcp.gemini`, or `gcp.vertex_ai`.

OpenAI-compatible, Anthropic, and Qwen OAuth requests use operation `chat`.
Gemini and Vertex AI requests use `generate_content`.

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
the terminal response.

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

- Request sampling, choice, maximum-output, and stop fields need hooks after
  provider adapters finalize the wire request.
- `seed` and `top_k` have incompatible ARMS and GenAI types in the baselines.
- Messages, instructions, tool definitions, arguments, and results require a
  standard JSON schema, privacy controls, and payload caps.
- Embedding needs a correct requested-model lifecycle before tracing.
- ARMS time-to-first-token and OpenTelemetry time-to-first-chunk differ in name,
  unit, and meaning, so private `ttft_ms` remains authoritative.
- Full GenAI span naming, CLIENT span kind, and logical retry topology are a
  separate compliance project.
