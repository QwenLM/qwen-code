# Per-model generation timing in Web Shell Token Usage

[English](model-generation-timing.md) | [简体中文](model-generation-timing.zh-CN.md)

## Status and scope

Implemented for #14722. Web Shell Token Usage and the daemon session stats route gain per-model first-token latency (TTFT), generation time and output speed. The change also fixes two measurement errors in the generation timing that CLI `/stats` already shows. It builds on [Generation timing metrics in `/stats`](2026-07-24-generation-stats.md) and [LLM request timing decomposition](telemetry-llm-request-timing-design.md). It changes when TTFT fires and how the generation window is measured. It also extends the daemon/Web Shell stats schema, which the `/stats` design left unchanged.

## Problem

1. Token Usage shows each model's request count and average latency: total request time divided by request count, failed requests included. That number cannot tell a slow start from slow generation.
2. For tool-call-only responses, TTFT covers the whole request. The OpenAI-compatible and Anthropic generators emit the `functionCall` part only once the call's arguments are complete. Earlier chunks carry only a tool-call preparation, and the TTFT predicate ignores it.
3. When a response's visible output arrives in one chunk, its output speed depends on how long the consumer takes to process that chunk. The window is `duration_ms - ttft_ms`, and `duration_ms` is taken after the consumer has processed the final chunk.
4. Generation metrics exist only per session, and the daemon stats route does not expose them.

## Design

### D1 — A tool-call preparation is user-visible output

`hasUserVisibleContent` returns true for a chunk that carries a tool-call preparation. ACP already renders a preparation as a `preparing` tool call, so TTFT keeps its meaning: the first output the user can see (timing design D1). Providers that deliver a tool call in one piece are unaffected.

### D2 — The generation window ends at the last visible chunk

`LoggingContentGenerator` records `generation_ms` on `ApiResponseEvent`: the time from the first to the latest chunk with user-visible content. `UiTelemetryService` uses it for generation time and TPS. Events recorded before the field existed fall back to `max(0, duration_ms - ttft_ms)`. When all visible output arrives in one chunk, `generation_ms` is 0. Such a response counts toward TTFT but not toward TPS, which the `/stats` design already intends for zero generation time. The span attributes `ttft_ms` and `sampling_ms` keep their definitions. Through D1, `ttft_ms` arrives earlier for tool calls.

### D3 — Per-model counters live in `statsModels`

Each `statsModels` entry gets an optional `generation` object with `timedRequests`, `totalTtftMs`, `totalGenerationDurationMs` and `totalThroughputOutputTokens`. These accumulate under the same rules as the session-level `generation`, including the exclusion of internal prompts. They are not added to `models`. That map is also written to managed model-usage records, and `CsiNativeActivationProof` validates each model entry against closed key sets.

### D4 — An optional `generation` object on the stats route

When a model has at least one timed request, `GET /session/:id/stats` adds `models[name].generation` with the four counters. `ServeSessionStatsModelMetrics` and `DaemonSessionStatsModelMetrics` declare the field as optional. Consumers that cast the JSON keep working.

### D5 — One latency line per model card

Each model card in Token Usage shows `First-token latency <duration> · Generation <duration> · Output speed <rate> tok/s` below its header:

- **First-token latency:** `totalTtftMs / timedRequests`.
- **Generation:** `totalGenerationDurationMs / timedRequests`. It shares its denominator with first-token latency, so the two add up to the average latency of the timed requests up to their last visible chunk.
- **Output speed:** token-weighted, `totalThroughputOutputTokens / totalGenerationDurationMs`.
- **When parts are missing:** generation and output speed are omitted when no request had a generation window. A model without timing shows no line.
- **Header unchanged:** the header's average latency still covers every request, including failed, internal and non-streamed ones. It can therefore differ from the sum of the line's first two values.

## Compatibility

- All new fields are optional and additive. Old transcripts replay with the fallback window.
- Tool-call-only responses from OpenAI-compatible and Anthropic providers record a shorter TTFT and a longer generation time. TPS in CLI `/stats` changes accordingly.
- A managed session restored through `restoreSessionModelMetrics` does not get its per-model timing back. Session-level generation metrics already behave this way.

## Out of scope

- Percentiles. Only sums and counts are kept.
- Per-model timing in CLI `/stats` and in the Web Shell `/stats` card.
- A separate first-chunk TTFT. `gen_ai.response.time_to_first_chunk` remains a span attribute.
- Panel layout changes beyond the latency line. #14648 redesigns the panel.

## Validation

- **Core:**
  - A chunk that carries only a preparation counts as visible.
  - A tool-call-only stream records TTFT at the preparation and `generation_ms` up to the complete call.
  - A single visible chunk records `generation_ms = 0`.
  - `UiTelemetryService` prefers `generation_ms` and falls back without it. It aggregates per model into `statsModels` only, and excludes internal prompts.
- **CLI:** the stats extension method returns per-model generation without the `last` sample, and omits it for models without timed requests.
- **Web Shell:** the latency line renders in English and Chinese. Generation uses the same denominator as first-token latency. The line omits generation and output speed when there is no generation window, and is absent for models without timing.
- **E2E:** run a real daemon session on an OpenAI-compatible model with thinking disabled. Compare the TTFT recorded for tool-call-only turns before and after the change, and check the panel.
