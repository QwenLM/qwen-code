# Output Token Limit and Escalation Design

> Defaults to the model's declared output limit unless the user or environment configures `max_tokens`, then uses escalation and multi-turn recovery only when a response still hits `MAX_TOKENS`.

## Problem

Every API request reserves a fixed GPU slot proportional to `max_tokens`. A low default can reduce slot reservation, but it also makes normal large responses more likely to truncate. For file-writing workflows, that can produce incomplete tool-call arguments and force the scheduler to reject the partial write.

## Solution

Use the model's declared output limit by default. When a response is truncated (the model hits `max_tokens`):

1. **Escalate** to the model's full output limit (with 64K as a floor when the current limit is lower)
2. If still truncated, **recover** by keeping the partial response in history and injecting a continuation message, up to 3 times
3. If recovery is exhausted, fall back to the tool scheduler's truncation guidance

This favors correctness for large generation and file-edit tasks. Operators that need a lower reservation can still set `QWEN_CODE_MAX_OUTPUT_TOKENS`, and that explicit value is respected.

## Architecture

```
Request (max_tokens = user/env value or model output limit)
│
▼
┌─────────────────────────┐
│  Response truncated?     │──── No ──▶ Done ✓
│  (MAX_TOKENS)            │
└───────────┬──────────────┘
            │ Yes
            ▼
┌──────────────────────────────────────────────────┐
│  Layer 1: Escalate to model output limit         │
│  ┌────────────────────────────────────────────┐  │
│  │ Pop partial response from history          │  │
│  │ RETRY (isContinuation: false → reset UI)   │  │
│  │ Re-send at max(64K, model output limit)    │  │
│  └────────────────────────────────────────────┘  │
└───────────┬──────────────────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│  Still truncated?        │──── No ──▶ Done ✓
│  (MAX_TOKENS)            │
└───────────┬──────────────┘
            │ Yes
            ▼
┌──────────────────────────────────────────────────┐
│  Layer 2: Multi-turn recovery (up to 3×)         │
│  ┌────────────────────────────────────────────┐  │
│  │ Keep partial response in history           │  │
│  │ Push user message: "Resume directly..."    │  │
│  │ RETRY (isContinuation: true → keep UI buf) │  │
│  │ Re-send with updated history               │  │
│  │ Model continues from where it left off     │  │
│  └──────────────┬─────────────────────────────┘  │
│                 │                                 │
│          ┌──────┴──────┐                          │
│          │ Succeeded?  │── Yes ──▶ Done ✓         │
│          └──────┬──────┘                          │
│                 │ No (still truncated)            │
│                 ▼                                 │
│          attempt < 3? ── Yes ──▶ loop back ↑      │
└───────────┬──────────────────────────────────────┘
            │ No (exhausted)
            ▼
┌──────────────────────────────────────────────────┐
│  Layer 3: Tool scheduler fallback                │
│  ┌────────────────────────────────────────────┐  │
│  │ Reject truncated Edit/Write tool calls     │  │
│  │ Return guidance: "You MUST split into      │  │
│  │ smaller parts — write skeleton first,      │  │
│  │ then edit incrementally."                  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Token limit determination

The effective `max_tokens` is resolved in the following priority order:

| Priority    | Source                                               | Value (known model)          | Value (unknown model)              | Escalation behavior                             |
| ----------- | ---------------------------------------------------- | ---------------------------- | ---------------------------------- | ----------------------------------------------- |
| 1 (highest) | User config (`samplingParams.max_tokens`)            | `min(userValue, modelLimit)` | `userValue`                        | No escalation                                   |
| 2           | Environment variable (`QWEN_CODE_MAX_OUTPUT_TOKENS`) | `min(envValue, modelLimit)`  | `envValue`                         | No escalation                                   |
| 3 (lowest)  | Model/default output limit                           | `modelLimit`                 | `DEFAULT_OUTPUT_TOKEN_LIMIT` = 32K | Escalates to model limit (64K floor) + recovery |

A "known model" is one that has an explicit entry in `OUTPUT_PATTERNS` (checked via `hasExplicitOutputLimit()`). For known models, the effective value is always capped at the model's declared output limit to avoid API errors. Unknown models (custom deployments, self-hosted endpoints) pass the user's value through directly, since the backend may support larger limits.

This logic is implemented in three content generators:

- `DefaultOpenAICompatibleProvider.applyOutputTokenLimit()` — OpenAI-compatible providers
- `DashScopeProvider` — inherits `applyOutputTokenLimit()` from the default provider
- `AnthropicContentGenerator.buildSamplingParameters()` — Anthropic provider

## Escalation mechanism

The escalation logic lives in `geminiChat.ts`, placed **outside** the main retry loop. This is intentional:

1. The retry loop handles transient errors (rate limits, invalid streams, content validation)
2. Truncation is not an error — it's a successful response that was cut short
3. Errors from the escalated stream should propagate directly to the caller, not be caught by retry logic

### Escalation steps (geminiChat.ts)

```
1. Stream completes successfully (lastError === null)
2. Last chunk has finishReason === MAX_TOKENS
3. Guard checks pass:
   - maxTokensEscalated === false (prevent infinite escalation)
   - hasUserMaxTokensOverride === false (respect user intent)
4. Compute escalated limit: max(ESCALATED_MAX_TOKENS, tokenLimit(model, 'output'))
5. Pop the partial model response from chat history
6. Yield RETRY event (isContinuation: false) → UI discards partial output and resets buffers
7. Re-send the same request with maxOutputTokens: escalatedLimit
```

### Recovery steps (geminiChat.ts)

If the escalated response is also truncated (finishReason === MAX_TOKENS), the recovery loop runs up to `MAX_OUTPUT_RECOVERY_ATTEMPTS` (3) times:

```
1. Partial model response is already in history (pushed by processStreamResponse)
2. Push a recovery user message: OUTPUT_RECOVERY_MESSAGE
3. Yield RETRY event (isContinuation: true) → UI keeps text buffer for continuation
4. Re-send with updated history (model sees its partial output + recovery instruction)
5. If still truncated and attempts remain, loop back to step 1
6. If recovery attempt throws (empty response, network error):
   - Pop the dangling recovery message from history
   - Break out of recovery loop
```

### State cleanup on RETRY (turn.ts)

When the `Turn` class receives a RETRY event, it clears accumulated state to prevent inconsistencies:

- `pendingToolCalls` — cleared to avoid duplicate tool calls if the first truncated response contained completed tool calls that are repeated in the escalated response
- `pendingCitations` — cleared to avoid duplicate citations
- `finishReason` — reset to `undefined` so the new response's finish reason is used

The `isContinuation` flag is passed through to the UI so it can decide whether to reset text buffers (escalation) or keep them (recovery).

## Constants

Defined in `geminiChat.ts` and `tokenLimits.ts`:

| Constant                       | Value  | Purpose                                           |
| ------------------------------ | ------ | ------------------------------------------------- |
| `ESCALATED_MAX_TOKENS`         | 64,000 | Floor for escalation when the model limit is low  |
| `MAX_OUTPUT_RECOVERY_ATTEMPTS` | 3      | Max multi-turn recovery attempts after escalation |

The effective escalated limit is `max(ESCALATED_MAX_TOKENS, tokenLimit(model, 'output'))`:

| Model            | Escalated limit |
| ---------------- | --------------- |
| Claude Opus 4.6  | 131,072 (128K)  |
| GPT-5 / o-series | 131,072 (128K)  |
| Qwen3.x          | 65,536 (64K)    |
| Unknown models   | 64,000 (floor)  |

## Design decisions

### Why not use an 8K default?

- An 8K default is a slot-reservation/capacity optimization, not a correctness requirement. It trades correctness (large responses truncate) for backend throughput (a request reserves a GPU slot proportional to `max_tokens`, so a lower value over-reserves less).
- Large file generation and edit tool calls can legitimately exceed 8K, so an 8K default turns a normal request into a truncate → escalate round-trip (and, in the worst case, a retry loop).
- Claude Code keeps the same 8K cap but gates it behind a feature flag (`tengu_otk_slot_v1`) that **defaults to off for third-party providers** ("not validated on Bedrock/Vertex") — i.e. its default behavior for non-first-party serving is exactly "use the model's declared limit." qwen-code's providers are all third-party / OpenAI-compatible / self-hosted, so matching that default-off behavior is the safe choice; assuming the low default is safe for every backend is not.
- The capacity tradeoff is not lost, only made opt-in: operators on a capacity-constrained self-hosted backend can set `QWEN_CODE_MAX_OUTPUT_TOKENS` (e.g. `8000`) to restore the lower per-request reservation. A GrowthBook-style feature flag is intentionally not reintroduced — qwen-code has no such infrastructure, and the env var already covers the need.

### Why escalate to model limit instead of fixed 64K?

- Models with higher output limits (Claude Opus 128K, GPT-5 128K) were constrained to 64K unnecessarily
- Using the model's actual limit captures the vast majority of long outputs without a second retry
- `ESCALATED_MAX_TOKENS` (64K) serves as a floor for unknown models where `tokenLimit()` returns the default 32K

### Why multi-turn recovery instead of progressive escalation?

- Progressive escalation (for example 16K -> 32K -> 64K) requires regenerating the full response each time
- Multi-turn recovery keeps the partial response and lets the model continue, saving tokens and latency
- Recovery messages are cheap (~40 tokens each) compared to regenerating large responses
- The 3-attempt limit prevents infinite loops while covering most practical cases

### Why is escalation outside the retry loop?

- Truncation is a success case, not an error
- Errors from the escalated stream (rate limits, network failures) should propagate directly rather than being silently retried with incorrect parameters
- Keeps the retry loop focused on its original purpose (transient error recovery)
- Recovery errors are caught separately to avoid aborting the entire conversation
