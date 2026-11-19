# TTFT from request dispatch

[English](ttft-from-request-dispatch.md) | [简体中文](ttft-from-request-dispatch.zh-CN.md)

## Status and scope

Implemented. This moves the start of time to first token (TTFT) for streamed requests to the moment the provider sends the built request. D1 of the [LLM request timing design](telemetry-llm-request-timing-design.md) already defines TTFT that way. The definition of output speed in [Output speed over the full request](output-speed-full-request.md) (`outputTokens / (ttftMs + generationMs)`) is unchanged; its time now starts where that design says it does, at sending the request. `duration_ms` and average API latency still cover the whole call, request building included.

## Problem

TTFT is timed from the start of `LoggingContentGenerator.generateContentStream`. That is before the request is logged and before the provider converts and builds it. In the OpenAI-compatible pipeline the build is not free. Probes in a headless session against Token Plan measured these times from the TTFT start:

| Request in the session | Build done | SDK call | Request headers on the socket |
| ---------------------- | ---------- | -------- | ----------------------------- |
| First                  | 188 ms     | 189 ms   | 215 ms                        |
| Second                 | 14 ms      | 14 ms    | 18 ms                         |
| Third                  | 75 ms      | 75 ms    | 77 ms                         |

A pass-through proxy between the CLI and the provider recorded when each request arrived and when each SSE event arrived. On the first request of each of three sessions (deepseek-v4.1-flash, qwen3.6-plus, glm-5.1), TTFT read 214–220 ms more than the proxy's time to the first visible event. Later requests read 8–100 ms more. That request's output speed read up to 10% low (108.1 tok/s against 120.3), and session output speed read 1.0–1.7% low.

The same build time also lands in the span's derived timing: `sampling_ms` and the `RESPONSE_PROCESSING` phase of the API request breakdown metric are `duration - ttft`. If only the TTFT start moved, they would absorb the build time and inflate.

## Design

### D1 — Providers report dispatch

`markRequestDispatched()` reports that a built request is about to be sent. `LoggingContentGenerator` observes it through an `AsyncLocalStorage` callback around the provider's `generateContentStream` call, in the same way it captures the OpenAI request for logging. Each streaming provider calls it right before handing the request to its SDK or fetch:

- the OpenAI-compatible pipeline, after building the request and before `chat.completions.create`;
- the Anthropic generator, before `messages.create`;
- the Gemini generator, before `models.generateContentStream`;
- the OpenAI Responses pipeline, before `fetch`.

A generator that never reports dispatch keeps the old start, the beginning of `generateContentStream`. The mark sits above the HTTP layer: the SDK's own work and opening the connection still count. On the first request of a session these took about 26 ms in the probes, and under 4 ms afterwards.

### D2 — The first dispatch wins

Only the first report within one `generateContentStream` call counts. A request the provider sends again inside that call, for example an SDK retry or a pipeline retry, therefore stays in TTFT, as [Output speed over the full request](output-speed-full-request.md) describes. Each attempt of `retryWithBackoff` is its own `generateContentStream` call and is timed from its own dispatch. A request sent while the stream is being read, such as the Anthropic non-streaming probe after an empty stream, runs outside the observed call and changes nothing.

### D3 — Times derived from TTFT

- `generation_ms` stays the time from the first to the last visible chunk. It is measured from the first visible chunk itself, not as elapsed time minus TTFT, so the build time does not move into it.
- `endLLMRequestSpan` receives the time from the start to dispatch as `requestBuildMs`. `sampling_ms` and the `RESPONSE_PROCESSING` phase subtract it, so they still cover the first visible chunk to stream end. It is not written as a span attribute. `request_setup_ms` keeps its meaning: retry overhead before the attempt.
- `gen_ai.response.time_to_first_chunk` starts at the same dispatch, on its monotonic clock, so first-chunk time cannot exceed TTFT by the build time.
- The managed diagnostics timing counters receive the same `ttftMs`, so every surface uses one definition.

## Compatibility

- No event, span attribute or wire field is added, removed or renamed. `ttft_ms`, `/stats` TTFT, Web Shell first-token averages and the managed timing counters read lower by the build time; output speeds read slightly higher.
- `duration_ms`, average latency and `request_setup_ms` are unchanged. `duration_ms` is no longer `ttft_ms + sampling_ms`: the build time sits between them.
- Recorded sessions keep their stored `ttft_ms`. A resumed session mixes old and new values.
- The Web Shell trajectory waterfall derives a request's start from `duration_ms` and draws the first-token mark at start plus `ttft_ms`. The mark now sits earlier than the first token by the build time, about 200 ms on the first request of a session and up to about 100 ms on later ones. The TTFT value it shows is the new one.

## Out of scope

- Making `buildRequest` faster. Its cost on the first request is a separate finding.
- Non-streaming requests, which have no TTFT.
- The span's `output_tokens_per_second`, which keeps measuring the sampling window.

## Validation

- **Core:** a stream that reports dispatch after 200 ms of building, then sends visible chunks at 1000 and 1500 ms and ends at 1600 ms, logs `ttft_ms` 800, `generation_ms` 500 and `duration_ms` 1600, and forwards `requestBuildMs` 200. A second dispatch at 250 ms does not change it. `sampling_ms` and `RESPONSE_PROCESSING` leave the build time out. The OpenAI-compatible pipeline reports dispatch after building the request and before the SDK call; the Anthropic, Gemini and Responses paths report it before the SDK call or fetch. Existing tests cover the fallback for streams without a dispatch report.
- **Live check:** the same headless task through the pass-through proxy on deepseek-v4.1-flash, qwen3.6-plus and glm-5.1 (Token Plan), run on a build of main from the day before and on this change. Only the OpenAI-compatible path was run live. TTFT minus the proxy's time to the first visible event:

  | Request                    | Before     | After    |
  | -------------------------- | ---------- | -------- |
  | First in the session       | 214–220 ms | 28–45 ms |
  | Later main-session request | 8–55 ms    | 4–18 ms  |
  | Auto-memory extraction     | 81–100 ms  | 6–9 ms   |

  Session output speed in `/stats` differed from the proxy's by 1.0–1.7% before and by 0–0.4% after. The remaining first-request gap is the SDK's work and connection setup, which D1 leaves in. After the change, span `sampling_ms` stayed within 8 ms of the proxy's time from the first visible event to stream end.
