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

`LoggingContentGenerator` records `generation_ms` on `ApiResponseEvent`: the time from the first to the latest chunk with user-visible content. `UiTelemetryService` uses it for generation time and TPS. Events recorded before the field existed are left out of timing entirely: they also predate D1, so a tool-call-only request recorded its whole duration as TTFT, and `duration_ms - ttft_ms` shrank to a few milliseconds while the response's full output still counted, reading as tens of thousands of tokens per second after a resume replayed them. A response whose `generation_ms` is below 100 ms counts toward TTFT but not toward TPS. That includes a single visible chunk (`generation_ms = 0`), which the `/stats` design already excludes, and output that arrives in a short burst, whose window is too short to measure a rate. The span attributes `ttft_ms` and `sampling_ms` keep their definitions. Through D1, `ttft_ms` arrives earlier for tool calls.

### D3 — Per-model counters live in `statsModels`

Each `statsModels` entry gets an optional `generation` object with `timedRequests`, `totalTtftMs`, `totalGenerationDurationMs` and `totalThroughputOutputTokens`. These accumulate under the same rules as the session-level `generation`, including the exclusion of internal prompts. They are not added to `models`. That map is also written to managed model-usage records, and `CsiNativeActivationProof` validates each model entry against closed key sets.

### D4 — An optional `generation` object on the stats route

When a model has at least one timed request, `GET /session/:id/stats` adds `models[name].generation` with the four counters. `ServeSessionStatsModelMetrics` and `DaemonSessionStatsModelMetrics` declare the field as optional. Consumers that cast the JSON keep working.

### D5 — Inline timing metrics per model card

Each model card in Token Usage shows an always-visible grid below its header. Available first-token latency, output speed and average generation time precede request count and average latency. The [Token usage hierarchy](token-usage-hierarchy.md) governs the card layout and overflow behavior:

- **First-token latency:** `totalTtftMs / timedRequests`.
- **Generation:** `totalGenerationDurationMs / timedRequests`. It shares its denominator with first-token latency, so the two add up to the average latency of the timed requests up to their last visible chunk, less the sub-100 ms windows that D2 keeps out of TPS.
- **Output speed:** token-weighted, `totalThroughputOutputTokens / totalGenerationDurationMs`.
- **When parts are missing:** generation and output speed are omitted when no request had a generation window. A model without timing shows only request count and average latency.
- **Average latency:** average latency still covers every request, including failed, internal and non-streamed ones. It can therefore differ from the sum of first-token latency and generation time.

## Compatibility

- All new fields are optional and additive. Requests recorded without `generation_ms` replay their token usage but no timing, so a resumed session's timing covers only requests recorded by versions that write the field.
- Tool-call-only responses from OpenAI-compatible and Anthropic providers record a shorter TTFT and a longer generation time. TPS in CLI `/stats` changes accordingly.
- A managed session restored through `restoreSessionModelMetrics` does not get its per-model timing back. Session-level generation metrics already behave this way.

## Out of scope

- Percentiles. Only sums and counts are kept.
- Per-model timing in CLI `/stats` and in the Web Shell `/stats` card.
- A separate first-chunk TTFT. `gen_ai.response.time_to_first_chunk` remains a span attribute.
- Other panel layout changes. The [Token usage hierarchy](token-usage-hierarchy.md) records the current presentation.

## Validation

- **Core:**
  - A chunk that carries only a preparation counts as visible.
  - A tool-call-only stream records TTFT at the preparation and `generation_ms` up to the complete call.
  - A single visible chunk records `generation_ms = 0`.
  - `UiTelemetryService` ignores timing for events without `generation_ms`, and counts windows below 100 ms toward TTFT but not TPS. It aggregates per model into `statsModels` only, and excludes internal prompts.
- **CLI:** the stats extension method returns per-model generation without the `last` sample, and omits it for models without timed requests.
- **Web Shell:** the timing grid renders in English and Chinese. Generation uses the same denominator as first-token latency. The grid omits generation and output speed when there is no generation window. Models without timing retain request count and average latency.
- **E2E:** run a real daemon session on an OpenAI-compatible model with thinking disabled. Compare the TTFT recorded for tool-call-only turns before and after the change, and check the panel.
