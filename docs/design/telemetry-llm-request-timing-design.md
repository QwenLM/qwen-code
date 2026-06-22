# LLM Request Timing Decomposition Design (P3 Phase 4)

> Issue #3731 — Phase 4 of hierarchical session tracing. Adds time-to-first-token, request-setup duration, sampling duration, and per-attempt retry telemetry to the `qwen-code.llm_request` span so operators can answer "why was this LLM call slow?" without guessing.
>
> Builds on Phase 1 (#4126), Phase 1.5 (#4302), Phase 2 (#4321). Independent of Phase 3 (#4410, in review) — recommended to land Phase 3 first so Phase 4's per-attempt fields aggregate cleanly under subagent subtrees.

## Problem

`qwen-code.llm_request` spans today carry only `model`, `prompt_id`, `input_tokens`, `output_tokens`, `success`, `error`, `duration_ms`. Operators reading a single trace cannot tell:

1. **How much of `duration_ms` was the model thinking vs the network setup.** A 12-second `duration_ms` could be 11s of retries followed by 1s of fast generation, or 100ms of setup followed by 12s of slow streaming — the trace doesn't say.
2. **When the user saw the first token.** TTFT (time-to-first-token) is the standard latency SLO for chat UIs. We can't compute it; we don't capture it.
3. **What happened during retries.** `retryWithBackoff` (`utils/retry.ts:285`) only calls `debugLogger.warn` — no OTel event, no span attribute. The 4 LLM call sites that go through it (`client.ts:1540`, `baseLlmClient.ts:193,282`, `geminiChat.ts:1039`) have zero retry visibility in traces or metrics. `ContentRetryEvent` exists for content-recovery retries inside `geminiChat.ts:806,830` but not for the more common rate-limit / 5xx retries.
4. **That `api.request.breakdown` is dead code.** The metric is defined at `metrics.ts:242-251` with 4 `ApiRequestPhase` values, exported from `index.ts:117`, tested in `metrics.test.ts:646-675` — but `recordApiRequestBreakdown()` has zero callers in production code. The metric infrastructure is paid for; the data flow was never connected.

These gaps make `qwen-code.llm_request` the least informative span in the trace tree. Tool spans (#4126/#4321) and subagent spans (#4410) both surface lifecycle phases; LLM spans collapse the entire request into one opaque duration.

## Existing surface (no change)

| Component                                                    | Location                                                         | Why we don't touch it                                                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM request span lifecycle                                   | `session-tracing.ts` `startLLMRequestSpan` / `endLLMRequestSpan` | Phase 1 (#4126) established the helpers. We extend the metadata interface, don't restructure                                                                                                                |
| Active span propagation into provider generators             | `loggingContentGenerator.ts:213,287`                             | Phase 1 (#4126) replaced `withSpan('api.*')` with native helpers; the active context already reaches the stream wrapper                                                                                     |
| `ContentRetryEvent` schema + consumers                       | `types.ts:626`, `qwen-logger.ts:947`, `loggers.ts:717`           | Existing event keeps its shape and downstreams; we add a sibling event class for the `retryWithBackoff` path                                                                                                |
| `LogToSpanProcessor` log-bridge spans                        | `log-to-span-processor.ts`                                       | ContentRetryEvent's existing bridge continues to nest under the active LLM span. Phase 4 does not change this                                                                                               |
| `ApiRequestPhase` enum                                       | `metrics.ts:330-334`                                             | Public surface (4 values). We populate 3 of the 4 from production code; leave the enum unchanged for backward compatibility                                                                                 |
| Per-provider chunk normalization → `GenerateContentResponse` | `loggingContentGenerator.ts:286-393`                             | Each provider already normalizes to Google's `GenerateContentResponse` shape before LoggingContentGenerator sees the stream. TTFT detection runs centrally over this normalized shape; no per-provider code |
| `retryWithBackoff` general-purpose retry                     | `utils/retry.ts:140`                                             | Used by both LLM callers and non-LLM (`channels/weixin/src/api.ts`). We extend with an opt-in `onRetry` callback rather than hard-coupling to LLM telemetry                                                 |
| Non-streaming `generateContent`                              | `loggingContentGenerator.ts:212`                                 | TTFT is not meaningful for non-streaming; the new fields stay `undefined`. Span lifecycle and existing attrs unchanged                                                                                      |

## Out-of-scope (deferred)

- **SDK-level retries** (openai SDK `maxRetries=3`, google-genai SDK internal retries). These happen entirely inside the third-party SDK; observing them requires disabling SDK retries and reimplementing in `retryWithBackoff`. Separate decision, not Phase 4.
- **Per-token streaming metrics** (inter-token latency, per-chunk size). Useful for inference-engine perf debugging, not for the user-perceived latency questions Phase 4 targets.
- **Separate TTFT for reasoning/thinking blocks.** "First token" includes thinking content (see D1). A future enhancement could split `ttft_to_reasoning_ms` vs `ttft_to_answer_ms`, but only after we know there's demand.
- **Sampling phase as a dedicated child span.** Computable from `duration_ms - ttft_ms - request_setup_ms`; child span adds nothing for OTel-only backends (claude-code uses one for Perfetto only). Stored as a span attribute instead — see D6.
- **Persistent retry mode (`QWEN_CODE_UNATTENDED_RETRY`) event-level rate limiting.** A single LLM request can produce 50+ `ContentRetryEvent` / `ApiRetryEvent` records under persistent retry. Capping emission is a follow-up — Phase 4 emits all events; if production volumes prove unbearable, add a per-span emission cap with a "+N more attempts (truncated)" summary event in a follow-up PR.
- **`TOKEN_PROCESSING` breakdown phase.** Enum value exists but qwen-code has no real post-stream local processing worth measuring (<10ms typical). Skipped in production callers; enum value retained for future use or for callers we don't control.
- **Migrating `ContentRetryEvent` onto LLM span as span events.** Same reasoning as Phase 3's `subagent_execution` LogRecord: existing consumers (qwen-logger RUM, future metrics) are tightly coupled to the LogRecord. Bridge-span coverage is good enough.

## References (decision evidence)

| Source                                                                                                                      | Key takeaway                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code (Anthropic) `claude.ts:1762, 1789, 1982, 2882`                                                                  | TTFT captured as `Date.now() - start` on `message_start` SSE event; `start` reset per retry attempt. `requestSetupMs = start - startIncludingRetries`. `attemptStartTimes` array preserved per attempt. Confirms feasibility of the approach; their TTFT semantic is "first stream event" (we diverge to "first content" — see D1) |
| claude-code `perfettoTracing.ts:549-671`                                                                                    | Renders Request Setup → Attempt N (retry) → First Token → Sampling as nested B/E pairs. Demonstrates the visual decomposition; qwen-code does the same decomposition with OTel attributes since we have no Perfetto                                                                                                                |
| claude-code `sessionTracing.ts:447`                                                                                         | Only `ttft_ms` makes it onto the OTel span (not `requestSetupMs`, not `samplingMs`, not per-attempt timing). We deliberately put more on the span — claude-code has Perfetto for visualization; we don't                                                                                                                           |
| opencode (sst/opencode) `session/llm.ts`, `route/client.ts`                                                                 | No TTFT measurement. Single `LLM.run` Effect span covers everything. Validates that the gap exists across competing tools; not a reference for what to do                                                                                                                                                                          |
| [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (status: Development / Experimental) | `gen_ai.usage.input_tokens` (Stable), `gen_ai.usage.output_tokens` (Stable), `gen_ai.usage.cached_tokens` (Experimental), `gen_ai.request.model` (Stable), `gen_ai.server.time_to_first_token` (Experimental, seconds as double). Dual-emit pattern follows #4410 precedent                                                        |
| [OTel Trace Spec — Span Events](https://opentelemetry.io/docs/specs/otel/trace/api/#add-events)                             | "Events SHOULD NOT be used to record information that's better captured as Span Attributes." Confirms per-attempt info belongs on the LLM span attributes + log-bridge spans, not as Span Events on the parent                                                                                                                     |
| Phase 3 design doc (`telemetry-subagent-spans-design.md`)                                                                   | Established the dual-emit pattern (`qwen-code.subagent.id` + `gen_ai.agent.id`) and the "private name is authoritative" rule. Phase 4 follows the same convention for TTFT and token fields                                                                                                                                        |

## Design — seven decisions, each justified

### D1 — TTFT semantic: "first chunk containing user-visible content"

TTFT measures wall-clock from the **successful attempt's** request dispatch to the **first stream chunk that contains user-visible output**. A chunk is "user-visible" if any normalized `Part` in `candidates[0].content.parts` is one of:

- `text` with non-empty string
- `functionCall` (tool use)
- `inlineData` (image, binary)
- `executableCode`
- `thought` / reasoning content (whatever the provider surfaces — Gemini's `thought`, Anthropic's `<thinking>` block, OpenAI o1 reasoning chunk)

Chunks containing only `role` metadata or only `usageMetadata` (final usage-summary chunk) do not trigger TTFT.

**Why not "first stream event of any kind" (claude-code's choice)**: claude-code measures TTFT at `message_start`, an Anthropic-specific metadata event that fires 50–300ms before any actual content. Their internal `headlessProfiler.ts` already separates `time_to_first_response_ms` for the "user saw something" semantic, acknowledging the distinction. qwen-code spans multiple providers (Anthropic, OpenAI, Gemini, Qwen) — picking the metadata-event semantic means TTFT for Anthropic is fundamentally different from TTFT for OpenAI (which has no analogous metadata-only first event). The user-visible-content semantic is uniform across all 4 providers and matches "time-to-first-token" literally.

**Why include `thought` / reasoning**: from the operator's perspective, reasoning chunks are still "the model produced output." Excluding them would understate TTFT for reasoning-heavy models (o1, Qwen thinking variants). Future split into `ttft_to_reasoning_ms` vs `ttft_to_answer_ms` is possible; not Phase 4.

**Why include tool-call-only chunks**: agent tool-decision LLM calls (one `tool_use`, no text) are common in qwen-code's workflow. Excluding them means TTFT is undefined for these requests. The `functionCall` Part is meaningful output.

**Cross-product comparison note**: design doc explicitly states `qwen-code.ttft_ms ≈ claude-code.time_to_first_response_ms ≠ claude-code.ttft_ms`. Operators comparing across products should align on the user-visible-content semantic.

### D2 — TTFT measurement site: method-local variables in `LoggingContentGenerator.generateContentStream`

The first-chunk detection runs inside the existing stream wrapper at `loggingContentGenerator.ts:393` (`async function* processStreamGenerator`). Per-call variables (`start`, `ttftMs`) live in the method's closure; **never as instance fields**.

**Why never instance fields**: `LoggingContentGenerator` is instantiated **once per `ContentGenerator`** (`contentGenerator.ts:377`) and shared across all concurrent `generateContentStream` calls — subagent fan-out, warmup queries, side-queries from `geminiChat`. An instance field would be overwritten across concurrent calls, producing nonsense TTFT for one of every two interleaved requests.

**Why not AsyncLocalStorage**: ALS would work but adds a context-management layer for a piece of state that doesn't need to escape the method. Method-local is simpler, zero overhead, zero risk of leakage.

```ts
// loggingContentGenerator.ts — inside generateContentStream
const attemptStart = Date.now(); // per-call local
const requestEntryTime = Date.now(); // also per-call local — see D3
let ttftMs: number | undefined;
const attemptStartTimes: number[] = [attemptStart];
let retryTotalDelayMs = 0;
let finalAttempt = 1;
// stream wrapper inspects each chunk; first one matching hasUserVisibleContent:
//   ttftMs = Date.now() - attemptStart;
```

`hasUserVisibleContent(chunk)` is a small standalone helper colocated with the wrapper, exported for tests:

```ts
function hasUserVisibleContent(chunk: GenerateContentResponse): boolean {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!parts?.length) return false;
  return parts.some(
    (p) =>
      (typeof p.text === 'string' && p.text.length > 0) ||
      p.functionCall !== undefined ||
      p.inlineData !== undefined ||
      p.executableCode !== undefined ||
      // @ts-expect-error — `thought` is not on all SDK versions but providers emit it
      p.thought !== undefined,
  );
}
```

### D3 — `request_setup_ms` computation: entry-time vs successful-attempt-start

`request_setup_ms` measures wall-clock from `generateContentStream`/`generateContent` entry to the **start of the successful attempt** — including all failed retries, backoff sleeps, and any pre-retry preparation work.

```ts
request_setup_ms = attemptStart_of_successful_attempt - requestEntryTime;
```

When `attempt === 1` and no retries happened, `request_setup_ms` is small (just SDK setup). When retries occurred, it captures the entire retry-budget overhead.

**Putting it on the OTel span (diverges from claude-code, which puts it only on Perfetto)**: rationale at three levels:

1. **No Perfetto** — qwen-code has no out-of-band visualization layer. OTel attributes are the only channel.
2. **Single-trace debug** — operator sees `duration_ms=12000, request_setup_ms=11500, ttft_ms=200, sampling_ms=300` → instantly diagnoses "retries ate 11.5s, model itself was fast." Computing `request_setup_ms` from other fields requires also exposing `sampling_ms`, which we do anyway (D6).
3. **Negligible cost** — 1 INT64 attribute. Same order of magnitude as the existing `input_tokens`, `output_tokens` attributes. Backend ingest cost is not material.

### D4 — Retry telemetry: `onRetry` callback option on `retryWithBackoff` + `ApiRetryEvent` + AsyncLocalStorage propagation

> **Phase 4b update (post-design discovery)**: this section was originally written assuming claude-code's "one LLM span owns the retry loop" pattern. While implementing Phase 4b, we discovered that qwen-code's 4 `retryWithBackoff` call sites (`client.ts:2109`, `baseLlmClient.ts:235,333`, `geminiChat.ts:2035` — line numbers as of merge) all wrap `apiCall = () => contentGenerator.generateContent(...)`. The retry layer sits **above** LoggingContentGenerator. Each retry attempt invokes `apiCall()` fresh → fresh `qwen-code.llm_request` span. There is no single shared span across attempts. An in-`LoggingContentGenerator` accumulator wouldn't work.
>
> **Resolution**: propagate retry state via `AsyncLocalStorage` (`retryContext` in `packages/core/src/utils/retryContext.ts`). `retryWithBackoff` wraps each `await fn()` in `retryContext.run({ attempt, requestSetupMs, retryTotalDelayMs }, fn)`. `LoggingContentGenerator` reads the ALS in its synchronous prelude and forwards the values to `endLLMRequestSpan`. This actually gives **richer** observability than the original plan — each per-attempt span has its own `duration_ms` / `ttft_ms` / error details AND knows where in the retry budget it sits via the per-attempt `attempt` / `requestSetupMs` / `retryTotalDelayMs` attributes.
>
> The ALS approach matches existing patterns in the codebase (`promptIdContext`, `subagentNameContext`, `agent-context`) — minimal new surface, well-understood semantics. Plan-mode review process captured this revision through 3 review rounds finding 22 issues, all addressed before merge.

`retryWithBackoff` currently calls `logRetryAttempt` (`retry.ts:343`) which only writes to `debugLogger.warn`. We extend the `RetryOptions` interface with an opt-in callback:

```ts
// utils/retry.ts
interface RetryOptions<T> {
  // ... existing fields ...
  /**
   * Optional. Called once per failed attempt, before the backoff sleep.
   * Receives the attempt number (1-based), the error, and the delay before
   * the next attempt. Use this to emit telemetry events for LLM call sites;
   * leave undefined for non-LLM callers (e.g., channels/weixin) so they
   * stay silent in LLM-specific telemetry channels.
   */
  onRetry?: (info: RetryAttemptInfo) => void;
}

interface RetryAttemptInfo {
  attempt: number; // 1-based, matches debugLogger output
  error: unknown;
  errorStatus?: number;
  delayMs: number; // backoff delay before next attempt
}
```

The 4 LLM call sites (`client.ts:1540`, `baseLlmClient.ts:193,282`, `geminiChat.ts:1039`) register a callback that emits a new `ApiRetryEvent`:

```ts
// types.ts — new event class, sibling to ContentRetryEvent
export class ApiRetryEvent implements BaseTelemetryEvent {
  'event.name': typeof EVENT_API_RETRY;
  'event.timestamp': string;
  model: string;
  prompt_id?: string;
  attempt_number: number; // 1-based
  error_type: string;
  error_message: string; // truncated to 256 chars
  status_code?: number;
  retry_delay_ms: number;
  // ... duration_ms set to retry_delay_ms so LogToSpanProcessor renders
  // a bridge span of meaningful width
  duration_ms: number;
}
```

**Why a new event class, not extending `ContentRetryEvent`**:

- `ContentRetryEvent` has 2 downstream consumers (qwen-logger, log-record export). Changing its payload risks breaking them.
- The naming "content retry" semantically refers to content-recovery retries (invalid stream, schema repair) — extending it to cover rate-limit retries would muddy the schema.
- New event is additive; no consumer surprise.

**Why not embed callback IN `retry.ts`**: `retry.ts` is called by `channels/weixin/src/api.ts` too (microsoft messaging API retries). Hard-coupling LLM telemetry inside retry.ts would emit `ApiRetryEvent` for non-LLM retries. The `onRetry` callback is opt-in per caller — LLM callers opt in, weixin caller doesn't.

**ContentRetryEvent coexistence**: ContentRetryEvent stays as-is for content-recovery retries inside `geminiChat.ts:806,830`. ApiRetryEvent covers the rate-limit / 5xx retries from `retryWithBackoff`. The two events fire from different layers and never duplicate. Existing log-bridge behavior for both events is preserved via `LogToSpanProcessor` — both events nest under the active LLM span automatically (Phase 1 wiring ensures the LLM span is active during retries).

**Persistent retry mode (`QWEN_CODE_UNATTENDED_RETRY`)**: a single 429-loop request may emit 50+ events. Out of scope to rate-limit emission in Phase 4 — if production volumes prove unbearable, add a per-span cap with summary event in a follow-up PR. The aggregated `attempt` and `retry_total_delay_ms` on the parent LLM span (D5) remain accurate regardless of event cap.

### D5 — Parent LLM span aggregation: scalar attributes only (no map-typed attrs)

OTel span attributes are scalars (`string | number | boolean | array of these`). Map-typed attributes (like `retry_count_by_status: {429:2, 503:1}`) require JSON serialization and are awkward to query. Skip them.

| Attribute                  | Type   | Semantic                                                                                                                                 |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt`                  | int    | 1-based monotonic counter from `retryContext.attempt` (this attempt's iteration). Always populated (defaults to 1 when no retry context) |
| `retry_total_delay_ms`     | int    | Cumulative backoff sleep BEFORE this attempt started. Undefined for direct calls; 0 for attempt 1; > 0 for subsequent retried attempts   |
| `ttft_ms`                  | int    | TTFT per D1; undefined for non-streaming or aborted-before-first-chunk requests                                                          |
| `request_setup_ms`         | int    | Per D3                                                                                                                                   |
| `sampling_ms`              | int    | Per D6                                                                                                                                   |
| `output_tokens_per_second` | double | Derived; `output_tokens / (sampling_ms / 1000)`; undefined when `sampling_ms === 0`                                                      |

Per-attempt status-code distribution (e.g., "2 of the 3 attempts were 429s") is queryable from log-bridge spans of `ApiRetryEvent` records. No need to duplicate it as a flattened attribute on the parent.

**Why `sampling_ms` and `output_tokens_per_second` on the span**: derivable but cumbersome to compute in backend queries when summing across many spans. Same cost-benefit as `request_setup_ms` (D3).

### D6 — Activate `recordApiRequestBreakdown()` for 3 of 4 phases

In `endLLMRequestSpan` (or the wrapper that calls it), after computing TTFT/setup/sampling, emit:

```ts
recordApiRequestBreakdown(config, model, [
  { phase: ApiRequestPhase.REQUEST_PREPARATION, durationMs: requestSetupMs },
  { phase: ApiRequestPhase.NETWORK_LATENCY, durationMs: ttftMs }, // ttftMs = network + first-token-generation
  { phase: ApiRequestPhase.RESPONSE_PROCESSING, durationMs: samplingMs },
]);
```

**Why skip `TOKEN_PROCESSING`**: qwen-code does stream chunk processing inline (consolidation happens in the wrapper at `loggingContentGenerator.ts:644`); the post-stream wrap-up phase is <10ms and not architecturally distinct. Filling it with a meaningless value pollutes the histogram. Leaving the enum value unused is safe — `apiRequestBreakdownHistogram.record(value, {model, phase})` is just a histogram with `phase` as a label; missing labels are simply absent in queries.

**Why not redefine `NETWORK_LATENCY`**: the spec name is slightly misleading (it's network + first-token-generation, not pure network latency), but:

- The enum is part of `metrics.ts:330-334` which is exported from `index.ts:117` and tested.
- Backend dashboards may already reference these phase names.
- Renaming or adding a new phase would be a breaking change for trivially marginal accuracy improvement.

Document the semantic in the design doc; leave the enum unchanged.

**Why on the span path, not parallel**: keeps `recordApiRequestBreakdown` colocated with span attribute writes — single gated emission point (see D7 idempotency), single ordering invariant.

### D7 — `endLLMRequestSpan` idempotency: metric recording gated on existing double-end guard

Phase 1.5 (#4302) established that `endLLMRequestSpan` may be called twice (abort path + error path collision). The existing guard at `session-tracing.ts:~470` (`if (!activeSpans.has(...)) return;`) prevents double `span.end()`. Phase 4 metric recording (D6) **must sit inside the same guarded block**, before `span.end()`:

```ts
// session-tracing.ts — endLLMRequestSpan
const llmCtx = activeSpans.get(spanRef);
if (!llmCtx) return;            // already ended — double-end guard
activeSpans.delete(spanRef);    // claim the end

// ... compute duration, set attributes ...
if (metadata) {
  recordApiRequestBreakdown(config, llmCtx.attributes.model, [...]);   // NEW — gated
  recordTokenUsageMetrics(...); // existing
}

span.end();
```

This guarantees metric is recorded **exactly once** per LLM request, matching the span lifecycle.

**Why not record in `loggingContentGenerator`**: it doesn't see the abort path. Recording at the span lifecycle layer ensures every LLM request that opens a span produces exactly one breakdown sample, regardless of success/failure/abort.

### D8 — GenAI semantic conventions dual-emit (private name authoritative)

Each Phase 4 attribute that corresponds to an OTel GenAI semconv attribute is written twice on the span:

| qwen-code private (authoritative)          | GenAI semconv (compat layer)                    | Unit conversion | Spec status  |
| ------------------------------------------ | ----------------------------------------------- | --------------- | ------------ |
| `ttft_ms` (ms, int)                        | `gen_ai.server.time_to_first_token` (s, double) | `ttftMs / 1000` | Experimental |
| `input_tokens` (int)                       | `gen_ai.usage.input_tokens` (int)               | identical       | Stable       |
| `output_tokens` (int)                      | `gen_ai.usage.output_tokens` (int)              | identical       | Stable       |
| `cached_input_tokens` (int) (when present) | `gen_ai.usage.cached_tokens` (int)              | identical       | Experimental |
| `qwen-code.model` (string)                 | `gen_ai.request.model` (string)                 | identical       | Stable       |

**Existing token attribute names** on the LLM span (set in `endLLMRequestSpan` before Phase 4): qwen-code uses bare `input_tokens` and `output_tokens` already. Phase 4 adds the `gen_ai.usage.*` siblings to match #4410's pattern. The bare names stay; **don't rename**.

Fields with no GenAI semconv equivalent — `request_setup_ms`, `sampling_ms`, `retry_total_delay_ms`, `attempt`, `output_tokens_per_second` — are emitted only under the qwen-code namespace.

**Why "private authoritative, semconv as compat"**:

- Internal dashboards, SLOs, debugLogger output, qwen-logger RUM, ARMS queries — all reference `ttft_ms` etc. Treating those as canonical avoids a flag-day migration.
- The Experimental GenAI semconv may rename `gen_ai.server.time_to_first_token` before reaching Stable. If/when it does, we update the semconv emission; the qwen-code names don't move.
- Future spec-aware backends (Datadog AI views, Honeycomb AI, ARMS GenAI dashboards) auto-pick up the `gen_ai.*` attributes without our involvement.

**Why dual-emit unit conversion** (ms ↔ seconds): GenAI semconv chose seconds-as-double for latency; qwen-code chose ms-as-int (matches `duration_ms` already on the span). Both representations have value; the conversion is cheap.

## Helper API (additive to `session-tracing.ts`)

```ts
// session-tracing.ts — LLMRequestMetadata interface extended (additive)
export interface LLMRequestMetadata {
  // ... existing fields: inputTokens, outputTokens, cachedInputTokens, success, error, ...

  /** Time from successful attempt start to first user-visible content chunk (ms). Undefined for non-streaming or aborted-before-first-chunk requests. */
  ttftMs?: number;

  /** Time from generateContent entry to start of successful attempt (ms). Includes all failed retries + backoff. */
  requestSetupMs?: number;

  /** Final attempt number (1-based). 1 = no retries. */
  attempt?: number;

  /** Sum of all backoff delays before the successful attempt (ms). */
  retryTotalDelayMs?: number;
}

// No new exported helpers — Phase 4 reuses startLLMRequestSpan / endLLMRequestSpan with extended metadata.
```

```ts
// types.ts — new event class
export class ApiRetryEvent implements BaseTelemetryEvent {
  'event.name': typeof EVENT_API_RETRY = EVENT_API_RETRY;
  'event.timestamp': string;
  model: string;
  prompt_id?: string;
  attempt_number: number;
  error_type: string;
  error_message: string;
  status_code?: number;
  retry_delay_ms: number;
  duration_ms: number;  // = retry_delay_ms, drives LogToSpanProcessor bridge span width

  constructor(opts: { model: string; promptId?: string; attemptNumber: number; error: unknown; statusCode?: number; retryDelayMs: number }) { ... }
}

// constants.ts
export const EVENT_API_RETRY = 'qwen-code.api_retry';

// loggers.ts
export function logApiRetry(config: Config, event: ApiRetryEvent): void { ... }
```

```ts
// utils/retry.ts — RetryOptions extension
interface RetryOptions<T> {
  // ... existing ...
  onRetry?: (info: RetryAttemptInfo) => void;
}

interface RetryAttemptInfo {
  attempt: number;
  error: unknown;
  errorStatus?: number;
  delayMs: number;
}

// Inside retryWithBackoff, where logRetryAttempt is called today:
options.onRetry?.({ attempt, error, errorStatus, delayMs: actualDelay });
logRetryAttempt(attempt, error, errorStatus); // existing debugLogger call unchanged
```

## Lifecycle wiring

### Streaming path (the common case)

```ts
// loggingContentGenerator.ts:283 — generateContentStream
async generateContentStream(req, userPromptId): Promise<AsyncGenerator<GenerateContentResponse>> {
  const requestEntryTime = Date.now();
  let attemptStart = requestEntryTime;
  const attemptStartTimes: number[] = [attemptStart];
  let retryTotalDelayMs = 0;
  let finalAttempt = 1;

  // Use existing startLLMRequestSpan (Phase 1)
  // Pass onRetry callback to whatever retry layer is in use:
  const onRetry: RetryAttemptInfo & { invoke: ... } = (info) => {
    finalAttempt = info.attempt + 1;        // we're about to start attempt N+1
    retryTotalDelayMs += info.delayMs;
    attemptStart = Date.now() + info.delayMs; // approximate; actual reset is at top of next attempt
    attemptStartTimes.push(attemptStart);
    // emit ApiRetryEvent
    logApiRetry(this.config, new ApiRetryEvent({
      model: req.model,
      promptId: userPromptId,
      attemptNumber: info.attempt,
      error: info.error,
      statusCode: info.errorStatus,
      retryDelayMs: info.delayMs,
    }));
  };

  // stream wrapper detects first user-visible chunk:
  return this.processStreamGenerator(stream, ..., {
    onFirstUserVisibleChunk: (now) => {
      ttftMs = now - attemptStart;
    },
  });
}
```

At span end (already in Phase 1's `endLLMRequestSpan` flow), include the new fields in `LLMRequestMetadata`:

```ts
endLLMRequestSpan(llmSpan, {
  success: true,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  ttftMs,
  requestSetupMs: attemptStart - requestEntryTime,
  attempt: finalAttempt,
  retryTotalDelayMs,
});
```

### Non-streaming path

`generateContent` (`loggingContentGenerator.ts:212`) does not produce streaming chunks. TTFT is `undefined`; `request_setup_ms` is still meaningful (captures retry overhead). The breakdown metric records 2 phases (REQUEST_PREPARATION + RESPONSE_PROCESSING where `RESPONSE_PROCESSING = duration_ms - request_setup_ms`), not 3.

### Retry layer integration (4 sites)

Each of the 4 LLM `retryWithBackoff` call sites adds `onRetry`:

```ts
// client.ts:1540 (similar at baseLlmClient.ts:193, 282, geminiChat.ts:1039)
const result = await retryWithBackoff(apiCall, {
  ...existingOptions,
  onRetry: (info) => {
    logApiRetry(
      this.config,
      new ApiRetryEvent({
        model,
        promptId: userPromptId,
        attemptNumber: info.attempt,
        error: info.error,
        statusCode: info.errorStatus,
        retryDelayMs: info.delayMs,
      }),
    );
    // also feed back into LoggingContentGenerator's local retry accumulator
    // (when in scope — for callers that don't go through LoggingContentGenerator,
    // the LLM span still gets `attempt` and `retry_total_delay_ms` via the
    // metadata path because endLLMRequestSpan is called at the LLM layer)
  },
});
```

The non-LLM caller (`channels/weixin/src/api.ts`) **does not register `onRetry`** — no `ApiRetryEvent` is emitted for its retries, matching today's behavior.

## Concurrent safety — the headline guarantee

`LoggingContentGenerator` instance is shared (one per `ContentGenerator`, `contentGenerator.ts:377`). Three concurrent `generateContentStream` calls (e.g., 3 subagents fan out via `coreToolScheduler.runConcurrently`) execute three independent closures of `generateContentStream`:

```
call_A: attemptStart_A, ttftMs_A, ... (closure)
call_B: attemptStart_B, ttftMs_B, ... (closure)
call_C: attemptStart_C, ttftMs_C, ... (closure)
```

Per-call locals never overlap. Stream chunks are detected against the local `attemptStart` of each call. Span attributes are set at each call's own `endLLMRequestSpan`.

`AsyncLocalStorageContextManager` (registered by NodeSDK at `sdk.ts:273`) already ensures the active OTel context — and thus the parent span passed to `startLLMRequestSpan` — is correct per fiber.

## Files to change

| File                                                                             | Change                                                                                                                                                                                                                                    | LOC est |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/core/src/telemetry/constants.ts`                                       | Add `EVENT_API_RETRY` constant                                                                                                                                                                                                            | +2      |
| `packages/core/src/telemetry/types.ts`                                           | Add `ApiRetryEvent` class + union member                                                                                                                                                                                                  | +40     |
| `packages/core/src/telemetry/loggers.ts`                                         | Add `logApiRetry()` function                                                                                                                                                                                                              | +20     |
| `packages/core/src/telemetry/qwen-logger/qwen-logger.ts`                         | Add `logApiRetryEvent()` for RUM downstream consistency                                                                                                                                                                                   | +20     |
| `packages/core/src/telemetry/session-tracing.ts`                                 | Extend `LLMRequestMetadata` (ttftMs, requestSetupMs, attempt, retryTotalDelayMs); extend `endLLMRequestSpan` to set new attrs + breakdown metric + dual-emit gen_ai.\*                                                                    | +60     |
| `packages/core/src/telemetry/metrics.ts`                                         | Wire `recordApiRequestBreakdown` callsite inside `endLLMRequestSpan` (no change to the existing recorder)                                                                                                                                 | 0       |
| `packages/core/src/utils/retry.ts`                                               | Add `onRetry?: (info: RetryAttemptInfo) => void` to RetryOptions; export `RetryAttemptInfo`; invoke callback in the existing logRetryAttempt site                                                                                         | +25     |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts`      | TTFT capture: method-local accumulators + `hasUserVisibleContent` helper + first-chunk detection in stream wrapper; pass new metadata to `endLLMRequestSpan`                                                                              | +80     |
| `packages/core/src/core/client.ts`                                               | Wire `onRetry` callback at `retryWithBackoff` call site (`client.ts:1540`)                                                                                                                                                                | +15     |
| `packages/core/src/core/baseLlmClient.ts`                                        | Wire `onRetry` callback at 2 `retryWithBackoff` call sites                                                                                                                                                                                | +25     |
| `packages/core/src/core/geminiChat.ts`                                           | Wire `onRetry` callback at `retryWithBackoff` call site (`geminiChat.ts:1039`)                                                                                                                                                            | +15     |
| `packages/core/src/telemetry/session-tracing.test.ts`                            | `endLLMRequestSpan` sets ttft_ms / request_setup_ms / attempt / retry_total_delay_ms / sampling_ms / output_tokens_per_second + gen_ai dual-emit + breakdown metric (each phase) + idempotent end                                         | +120    |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.test.ts` | `hasUserVisibleContent` (text / functionCall / inlineData / executableCode / thought / role-only / usage-only); concurrent calls don't cross-contaminate; TTFT undefined when aborted before first chunk; TTFT undefined on non-streaming | +100    |
| `packages/core/src/utils/retry.test.ts`                                          | `onRetry` invoked per failed attempt with correct `attempt`, `delayMs`, `error`, `errorStatus`; absence of `onRetry` is silent (no telemetry emitted)                                                                                     | +50     |
| `packages/core/src/telemetry/loggers.test.ts`                                    | `logApiRetry` emits LogRecord with expected payload; bridges through LogToSpanProcessor to nested span under active LLM span                                                                                                              | +40     |

Total: 14 files, ~610 LOC. Larger than Phase 2 (#4321) but comparable to Phase 3 (#4410) and justified by the breadth of integration (4 retry sites + telemetry plumbing + streaming wrapper).

If review pushes back on size: split into **Phase 4a + 4b + 4c**:

- **4a** (~200 LOC): TTFT capture + extended `LLMRequestMetadata` + dual-emit. Self-contained value (TTFT visibility from day one).
- **4b** (~250 LOC): `onRetry` callback + `ApiRetryEvent` + 4 caller wiring. **Independently a bug fix** for the `retryWithBackoff` telemetry gap.
- **4c** (~160 LOC): `recordApiRequestBreakdown` activation + parent span aggregation attrs (`attempt`, `retry_total_delay_ms`, `sampling_ms`, `output_tokens_per_second`). Depends on 4a + 4b.

## Testing strategy

| Test                                                                                                                                         | What it proves                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `hasUserVisibleContent` returns true for text/functionCall/inlineData/executableCode/thought                                                 | D1 semantics across part types        |
| `hasUserVisibleContent` returns false for role-only and usage-only chunks                                                                    | D1 negative cases                     |
| streaming: TTFT measured from attempt start to first user-visible chunk                                                                      | End-to-end TTFT detection             |
| streaming: TTFT undefined if stream aborts before any user-visible chunk                                                                     | Edge case                             |
| streaming: TTFT computed from final attempt's start (not first attempt)                                                                      | D3 — TTFT reset on retry              |
| non-streaming: TTFT remains undefined                                                                                                        | S3 decision                           |
| concurrent `generateContentStream` calls don't cross-contaminate TTFT                                                                        | D2 — method-local guarantee           |
| `endLLMRequestSpan` sets all Phase 4 attrs (ttft_ms, request_setup_ms, sampling_ms, attempt, retry_total_delay_ms, output_tokens_per_second) | Attribute presence                    |
| `endLLMRequestSpan` dual-emits gen_ai.server.time_to_first_token + gen_ai.usage.\* + gen_ai.request.model                                    | D8 dual-emit                          |
| `endLLMRequestSpan` records breakdown metric with 3 phases for streaming, 2 for non-streaming                                                | D6                                    |
| `endLLMRequestSpan` called twice: metric recorded exactly once, attrs not re-set                                                             | D7 idempotency                        |
| `retryWithBackoff` with `onRetry`: callback invoked per failed attempt with correct args                                                     | D4 callback contract                  |
| `retryWithBackoff` without `onRetry`: no telemetry emitted (silent for non-LLM callers)                                                      | P2 — channels/weixin scope protection |
| `client.ts` / `baseLlmClient.ts` / `geminiChat.ts` retry callsites emit `ApiRetryEvent` on retry                                             | Integration of D4 at 4 sites          |
| `ApiRetryEvent` LogRecord bridges via LogToSpanProcessor to a child span under active LLM span                                               | Trace tree correctness                |
| LLM span `attempt` field correctly reflects final attempt number under retries                                                               | D5 aggregation                        |
| LLM span `retry_total_delay_ms` correctly sums onRetry delays                                                                                | D5 aggregation                        |
| `output_tokens_per_second` undefined when `sampling_ms === 0` (no streaming)                                                                 | Avoid divide-by-zero                  |

## Edge cases

| Case                                                                    | Handling                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stream aborts before any chunk arrives                                  | `ttftMs = undefined`, `sampling_ms = undefined`, `output_tokens_per_second = undefined`. `attempt`, `request_setup_ms` still set. `success = false`                                                                      |
| Stream aborts after first chunk                                         | `ttftMs` set; `sampling_ms` = `duration_ms - ttftMs - request_setup_ms`; reflects partial response time. `success = false`                                                                                               |
| Retry succeeds on attempt 1 (no retries)                                | `attempt = 1`, `retry_total_delay_ms = 0`, no `ApiRetryEvent` emitted, breakdown metric records `request_setup_ms` close to 0                                                                                            |
| Persistent retry mode 50+ attempts                                      | 50+ `ApiRetryEvent` records emitted (out-of-scope cap deferred); LLM span `attempt = 51`, `retry_total_delay_ms = sum of all delays`. Operator sees aggregated view on span; full per-attempt detail in log-bridge spans |
| Non-LLM `retryWithBackoff` caller (channels/weixin)                     | No `onRetry` registered; only existing `debugLogger.warn` fires. No `ApiRetryEvent`; no breakdown metric (caller isn't an LLM site)                                                                                      |
| `endLLMRequestSpan` called twice (abort + error race)                   | Phase 1.5 guard at `activeSpans.delete()` returns early on second call; `recordApiRequestBreakdown` is inside the guard, recorded exactly once                                                                           |
| Anthropic `message_start` chunk arrives before content                  | `hasUserVisibleContent` returns false for it (no parts with text/functionCall/etc.); TTFT not triggered until subsequent `content_block_delta` chunk                                                                     |
| OpenAI first chunk with empty `delta.content` but `role` only           | `hasUserVisibleContent` returns false; TTFT not triggered until first chunk with non-empty delta                                                                                                                         |
| Tool-call-only response (no text)                                       | First chunk with `functionCall` Part triggers TTFT; `output_tokens_per_second` computed against tool-call token count                                                                                                    |
| Concurrent subagents (3 calls in flight)                                | Each call's closure has its own `attemptStart`, `ttftMs`, `attemptStartTimes`. Per-call span receives its own metadata at `endLLMRequestSpan`. No interleaving (D2)                                                      |
| SDK-level retries inside openai-sdk (`maxRetries=3`)                    | Invisible to qwen-code telemetry — happens entirely inside SDK before retryWithBackoff sees the request. `attempt` reflects retryWithBackoff attempts only. Out of scope (see Out-of-scope)                              |
| `gen_ai.server.time_to_first_token` spec renames before reaching Stable | Single-file update: `session-tracing.ts:endLLMRequestSpan`. The qwen-code-native `ttft_ms` stays authoritative — no downstream impact                                                                                    |
| Subagent's LLM request                                                  | Parent is the subagent span (Phase 3). Phase 4 fields nest correctly. Aggregations grouped by `qwen-code.subagent.id` give per-subagent LLM perf — design-doc-future, easy follow-up                                     |
| Reasoning model with long thought blocks                                | First `thought` Part triggers TTFT; `sampling_ms` includes both thinking + answer phases. Split into separate metrics deferred                                                                                           |

## Rollback

The change is additive at the OTel and metric level — every new attribute is optional, every new event is a new class. Existing dashboards that don't filter on the new fields keep working unchanged.

Behavior-affecting changes:

- New `ApiRetryEvent` LogRecord starts flowing → log volume increases proportional to retry rate (typically <1% of requests retry). Mitigate by sampling LogRecord at the SDK layer if needed.
- New breakdown metric `qwen-code.api.request.breakdown` starts producing time series → mild Prometheus cardinality bump (`{model, phase}` — bounded).
- `output_tokens_per_second` derived attribute may appear unusual on dashboards filtering "all attributes" — document.

Rollback path: revert the single PR (or each of 4a/4b/4c independently). All new fields use defensive defaults (undefined / 0) and don't change span structure.

## Sequencing

- **After Phase 3 (#4410, in review)**: not a hard dependency. Phase 4 attributes attach to `qwen-code.llm_request` spans regardless of whether they're under a `qwen-code.subagent` (Phase 3) or `qwen-code.interaction` (Phase 1) parent. Recommend Phase 3 land first so per-attempt aggregation under subagent subtrees works naturally.
- **Independent of #4384** (`traceparent` + `X-Qwen-Code-Session-Id` outbound propagation). They touch the HTTP layer; Phase 4 touches the stream/retry/metric layer.
- **Independent of `clearDetailedSpanState` chat-compression follow-up** (#4097 follow-up). Different surface.

## Open questions

1. **`onRetry` callback firing semantics**: invoked **before** backoff sleep (current proposal) or **after** (when the next attempt is about to start)? Before is simpler — callback has all the info immediately; after would require capturing the just-completed delay separately. Pre-sleep is the recommendation; document in callback contract.
2. **Per-attempt timing on the LLM span**: should we add `attempt_durations_ms: number[]` array? OTel supports array-of-primitive attributes. Useful for "which attempt of N was slow" diagnostics. Defer until production data shows demand — log-bridge spans already carry the equivalent.
3. **Persistent retry mode emission cap**: at what `attempt > N` threshold should we start sampling? `N = 5` then 1-in-10? `N = 10` then summary-only? Defer until we have production volume data.
4. **`TOKEN_PROCESSING` phase**: keep enum value dormant or wire it to something (e.g., consolidation time)? Defer — wait for a real use case.
5. **Subagent-level LLM rollups**: trivial follow-up once Phase 4 lands — sum `ttft_ms`/`output_tokens`/`input_tokens` per subagent subtree. Not Phase 4 scope but the data flow enables it.
