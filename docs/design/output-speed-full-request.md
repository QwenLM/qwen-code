# Output speed over the full request

[English](output-speed-full-request.md) | [简体中文](output-speed-full-request.zh-CN.md)

## Status and scope

Implemented for #16714. This changes how CLI `/stats` and Web Shell Token Usage compute output speed (TPS). TTFT, generation time and the recorded events stay as they are. It revises the output-speed rules of [Per-model generation timing](model-generation-timing.md) (D2, D5) and the [Token usage trend](token-usage-trend.md) speed view. The live tokens/s estimate next to the spinner and the managed diagnostics panel are out of scope.

## Problem

1. Output speed divides a request's output tokens by its generation window: the time from the first to the last visible chunk. Output tokens include reasoning tokens, but the time before the first visible chunk is not in the denominator. The figure therefore reads higher than what a user waits for. Measured on Model Studio Token Plan, deepseek-v4.1-flash prose read 143 tok/s where output tokens over the time from request to last token give 125. Tool-call turns read 212 instead of 195. The gap grows with the prompt, because TTFT does.
2. A provider can bill reasoning tokens without streaming their text. Those tokens are generated before the first visible chunk, so they land in the numerator and their time does not land in the denominator. Against a mock provider with 8 s of hidden reasoning (800 tokens) followed by 200 answer tokens over 2 s, `/stats` read 511 tok/s; the real rate is about 100.
3. Because a burst of visible output collapses the window towards zero, D2 had to leave windows under 100 ms out of output speed. Those requests still counted towards TTFT. As a result, the TTFT and generation sums covered different requests, and in Token Usage the per-model first token and generation averages did not quite add up.

## Design

### D1 — Output speed includes TTFT

Per request, output speed is `outputTokens / (ttftMs + generationMs)`: the output tokens over the time from sending the request to its last visible output. Per session or model, it is the token-weighted ratio `totalThroughputOutputTokens / (totalTtftMs + totalGenerationDurationMs)`. Tool execution between requests is not in any request's time, so a multi-turn session's speed excludes it.

This matches the public definition that Artificial Analysis adopted in its methodology v3.0.0 (2026-11-03): output tokens, reasoning included, received per second over the request's full duration, including time to first token, and excluding tool time between requests in multi-turn work. The end point is the last visible chunk rather than the stream end. The usage chunk that follows carries no output, and D2 of the generation-timing design already ends the window there to keep consumer time out.

### D2 — Every timed request counts

`UiTelemetryService` adds every timed request's TTFT, generation window and output tokens to the same sums, without the 100 ms floor. With TTFT in the denominator, a burst can no longer shrink it to zero. A response whose visible output arrives in a single chunk (`generation_ms = 0`) now has a rate: its tokens over its TTFT.

### D3 — No rate without output tokens

When a request or a sum has no output tokens, for example because the provider reported no usage, the surfaces show no rate rather than `0 tok/s`. They also show none when no time was recorded.

### D4 — Surfaces

- **CLI `/stats`:** TPS for the latest request and Session TPS, in the Ink tab, the OpenTUI dialog and the text output. One helper computes all three, and the Generation Time line keeps showing the generation window.
- **Web Shell Token Usage:** the overview's session output speed and each model's output speed use D1. Each model's Generation average still divides `totalGenerationDurationMs` by `timedRequests`. Without the floor it now covers the same requests as First token, so the two add up to the timed requests' average time to last visible output.
- **Speed timeline and per-model spread:** each sample's speed uses D1, so short generation windows are plotted in the speed view too. The tooltip's "N output tokens in D" uses the same time, TTFT plus generation.
- **Wire types:** `totalGenerationDurationMs`, `totalThroughputOutputTokens` and `timingSamples[].generationMs` keep their names and shapes. Their documentation describes the new rule.

## Compatibility

- No field is added, removed or renamed. A resumed session replays its events through the new rules.
- A Web Shell reading an older daemon gets sums that still leave out windows under 100 ms. Their TTFT is in `totalTtftMs`, but their tokens and generation time are not in the other two sums, so its output speed reads slightly low until the daemon is updated.
- All output speeds read lower than before. The difference is larger for long prompts and for providers that hide reasoning text.
- TTFT starts when the request is issued, so it already covers SDK retries that happen before the stream opens. Such a retry now also lowers that request's output speed, as it would for a client timing the whole call.

## Out of scope

- The live tokens/s estimate next to the spinner (`ui.showResponseTokensPerSecond`). It is a character-based estimate over the whole turn, tool time included.
- The managed diagnostics panel. Its persisted per-model timing counters are a versioned contract (TypeScript, Java and OpenAPI) and keep the 100 ms floor. Aligning them needs a contract change of its own.
- Percentiles, and splitting speed by turn type (prose against tool calls).

## Validation

- **Core:** generation sums include every timed request, short windows and zero windows included, and stay per model in `statsModels`.
- **CLI:** the helper divides by TTFT plus generation, gives a single-chunk response a rate, and returns no rate without tokens or time. `/stats` text and the Ink tab show the new values.
- **Web Shell:** the model grid and overview use D1. The timeline plots short windows in the speed view, and its tooltip duration includes TTFT. The per-model spread uses the same speeds.
- **Live check:** run a headless session against Token Plan with local telemetry output, then compare `/stats` with output tokens over the time from request to last visible chunk taken from the recorded events.
