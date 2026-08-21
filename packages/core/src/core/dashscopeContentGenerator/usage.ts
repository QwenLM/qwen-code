/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { setGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import type { DashScopeUsage } from './types.js';

/**
 * Normalizes DashScope-side token counts into Gemini's `usageMetadata` shape.
 *
 * Unlike Anthropic, DashScope's `input_tokens` ALREADY INCLUDES
 * `cached_tokens` (OpenAI-style accounting) — summing them here would
 * roughly double the reported prompt size. See api-contract.md §6.
 */
export function buildDashScopeUsageMetadata(
  usage: DashScopeUsage | undefined,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokenCount = usage.input_tokens ?? 0;
  const cachedContentTokenCount =
    usage.prompt_tokens_details?.cached_tokens ?? 0;
  const candidatesTokenCount = usage.output_tokens ?? 0;
  const thoughtsTokenCount = usage.output_tokens_details?.reasoning_tokens ?? 0;
  const totalTokenCount =
    usage.total_tokens ?? promptTokenCount + candidatesTokenCount;

  const metadata: GenerateContentResponseUsageMetadata = {
    promptTokenCount,
    cachedContentTokenCount,
    candidatesTokenCount,
    thoughtsTokenCount,
    totalTokenCount,
  };

  setGenAiUsageProvenance(metadata, {
    cachedInputTokensReported:
      usage.prompt_tokens_details?.cached_tokens !== undefined,
    cacheCreationInputTokens:
      usage.prompt_tokens_details?.cache_creation_input_tokens,
  });

  return metadata;
}
