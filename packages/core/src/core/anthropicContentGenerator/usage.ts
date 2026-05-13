/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';

export interface AnthropicTokenParts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/**
 * Normalize Anthropic-side token counts into Gemini's `usageMetadata` shape.
 *
 * Anthropic reports the prompt across three mutually-exclusive fields:
 * `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
 * The full prompt is the sum.
 *
 * `cache_creation_input_tokens` is unique to Anthropic's protocol — OpenAI
 * has no equivalent — so its presence is a strong signal the response
 * follows real Anthropic semantics. Use that as the primary discriminator:
 *
 *   - cache_creation > 0  → Anthropic semantics, sum all three
 *   - else if cache_read > 0 and input ≥ cache_read → OpenAI-style on the
 *     Anthropic protocol (input already covers the cached portion), trust
 *     input alone
 *   - else                → sum (when no cache activity, sum equals input)
 *
 * An earlier version of this guard compared `inputTokens` to *both* cache
 * fields and fell back to "input alone" whenever input was the larger
 * value. That mis-fired on long real Anthropic conversations: once enough
 * history accumulates, `inputTokens` naturally grows past
 * `cache_creation_input_tokens`, which would silently drop the cache
 * portion from the displayed prompt size and produce a one-shot Footer
 * "drop" at the crossover point.
 */
export function buildAnthropicUsageMetadata(
  parts: AnthropicTokenParts,
): GenerateContentResponseUsageMetadata {
  const { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens } =
    parts;
  const looksLikeOpenAi =
    cacheCreationTokens === 0 &&
    cacheReadTokens > 0 &&
    inputTokens >= cacheReadTokens;
  const promptTotal = looksLikeOpenAi
    ? inputTokens
    : inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    promptTokenCount: promptTotal,
    candidatesTokenCount: outputTokens,
    totalTokenCount: promptTotal + outputTokens,
    cachedContentTokenCount: cacheReadTokens,
  };
}
