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
 * Guard for non-conforming providers: some third-party APIs expose the
 * Anthropic protocol but follow OpenAI-style accounting, where
 * `input_tokens` is already the full prompt and the cache fields are
 * informational subsets. Summing in that case double-counts. If
 * `inputTokens` is at least as large as both cache fields (and cache
 * fields are non-zero), trust it alone.
 */
export function buildAnthropicUsageMetadata(
  parts: AnthropicTokenParts,
): GenerateContentResponseUsageMetadata {
  const { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens } =
    parts;
  const hasCache = cacheReadTokens > 0 || cacheCreationTokens > 0;
  const inputCoversCache =
    inputTokens >= cacheReadTokens && inputTokens >= cacheCreationTokens;
  const promptTotal =
    hasCache && inputCoversCache
      ? inputTokens
      : inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    promptTokenCount: promptTotal,
    candidatesTokenCount: outputTokens,
    totalTokenCount: promptTotal + outputTokens,
    cachedContentTokenCount: cacheReadTokens,
  };
}
