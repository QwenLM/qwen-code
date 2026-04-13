# Adaptive Output Token Escalation Design

> Reduces GPU slot over-reservation by ~4x through a "low default + escalate on truncation" strategy for output tokens.

## Problem

Every API request reserves a fixed GPU slot proportional to `max_tokens`. The previous default of 32K tokens means each request reserves a 32K output slot, but 99% of responses are under 5K tokens. This over-reserves GPU capacity by 4-6x, limiting server concurrency and increasing cost.

## Solution

Use a capped default of **8K** output tokens. When a response is truncated (the model hits `max_tokens`), automatically retry once with an escalated limit of **64K**. Since <1% of requests are actually truncated, this reduces average slot reservation significantly while preserving output quality for long responses.

## Architecture

```
                      ┌─────────────────────────┐
                      │   Request starts        │
                      │   max_tokens = 8K       │
                      └───────────┬─────────────┘
                                  │
                                  ▼
                      ┌─────────────────────────┐
                      │   Stream response       │
                      └───────────┬─────────────┘
                                  │
                        ┌─────────┴─────────┐
                        │                   │
                   finish_reason        finish_reason
                   != MAX_TOKENS        == MAX_TOKENS
                        │                   │
                        ▼                   ▼
                  ┌───────────┐   ┌─────────────────────┐
                  │   Done    │   │  Check conditions:   │
                  └───────────┘   │  - No user override? │
                                  │  - No env override?  │
                                  │  - Not already       │
                                  │    escalated?        │
                                  └─────────┬───────────┘
                                     YES    │    NO
                                  ┌─────────┴────┐
                                  │              │
                                  ▼              ▼
                          ┌─────────────┐  ┌──────────┐
                          │ Pop partial │  │  Done    │
                          │ model resp  │  │ (truncd) │
                          │ from history│  └──────────┘
                          │             │
                          │ Yield RETRY │
                          │ event       │
                          │             │
                          │ Re-send     │
                          │ max_tokens  │
                          │   = 64K     │
                          └─────────────┘
```

## Token limit determination

The effective `max_tokens` is resolved in the following priority order:

| Priority    | Source                                               | Value (known model)          | Value (unknown model) | Escalation behavior            |
| ----------- | ---------------------------------------------------- | ---------------------------- | --------------------- | ------------------------------ |
| 1 (highest) | User config (`samplingParams.max_tokens`)            | `min(userValue, modelLimit)` | `userValue`           | No escalation                  |
| 2           | Environment variable (`QWEN_CODE_MAX_OUTPUT_TOKENS`) | `min(envValue, modelLimit)`  | `envValue`            | No escalation                  |
| 3 (lowest)  | Capped default                                       | `min(modelLimit, 8K)`        | `min(32K, 8K)` = 8K   | Escalates to 64K on truncation |

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
4. Pop the partial model response from chat history
5. Yield RETRY event → UI discards partial output
6. Re-send the same request with maxOutputTokens: 64K
```

### State cleanup on RETRY (turn.ts)

When the `Turn` class receives a RETRY event, it clears accumulated state to prevent inconsistencies:

- `pendingToolCalls` — cleared to avoid duplicate tool calls if the first truncated response contained completed tool calls that are repeated in the escalated response
- `pendingCitations` — cleared to avoid duplicate citations
- `debugResponses` — cleared to avoid stale debug data
- `finishReason` — reset to `undefined` so the new response's finish reason is used

## Constants

Defined in `tokenLimits.ts`:

| Constant                    | Value  | Purpose                                                 |
| --------------------------- | ------ | ------------------------------------------------------- |
| `CAPPED_DEFAULT_MAX_TOKENS` | 8,000  | Default output token limit when no user override is set |
| `ESCALATED_MAX_TOKENS`      | 64,000 | Output token limit used on truncation retry             |

## Design decisions

### Why 8K default?

- 99% of responses are under 5K tokens
- 8K provides reasonable headroom for slightly longer responses without triggering unnecessary retries
- Reduces average slot reservation from 32K to 8K (4x improvement)

### Why 64K escalated limit?

- Covers the vast majority of long outputs that were truncated at 8K
- Matches the output limit of many modern models (Claude Sonnet, Gemini 3.x, Qwen3.x)
- Higher values (e.g., 128K) would negate slot optimization benefits for the <1% of requests that escalate

### Why not progressive escalation (8K → 16K → 32K → 64K)?

- Each retry adds latency (the full response must be regenerated)
- A single retry is the simplest approach that captures almost all cases
- The <1% truncation rate at 8K means almost no requests need escalation; those that do are likely to need significantly more than 16K

### Why is escalation outside the retry loop?

- Truncation is a success case, not an error
- Errors from the escalated stream (rate limits, network failures) should propagate directly rather than being silently retried with incorrect parameters
- Keeps the retry loop focused on its original purpose (transient error recovery)
