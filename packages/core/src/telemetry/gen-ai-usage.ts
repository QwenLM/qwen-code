/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { AuthType } from '../utils/auth-type.js';

export interface GenAiUsageProvenance {
  cachedInputTokensReported?: boolean;
  cacheCreationInputTokens?: number;
}

const usageProvenance = new WeakMap<
  GenerateContentResponseUsageMetadata,
  GenAiUsageProvenance
>();

export function setGenAiUsageProvenance(
  usage: GenerateContentResponseUsageMetadata,
  provenance: GenAiUsageProvenance,
): void {
  usageProvenance.set(usage, provenance);
}

export function getGenAiUsageProvenance(
  usage: GenerateContentResponseUsageMetadata | undefined,
): GenAiUsageProvenance | undefined {
  return usage ? usageProvenance.get(usage) : undefined;
}

/**
 * Whether the provider's output count already includes its reasoning, so
 * `thoughtsTokenCount` is part of `candidatesTokenCount` rather than added to
 * it: chat completions report `completion_tokens` and the Responses API
 * `output_tokens` that way, while Gemini reports thoughts apart.
 */
export function outputIncludesThoughts(authType: string | undefined): boolean {
  return (
    authType === AuthType.USE_OPENAI ||
    authType === AuthType.USE_OPENAI_RESPONSES ||
    authType === AuthType.QWEN_OAUTH
  );
}

/**
 * The output tokens of one response, reasoning counted once. A total that
 * lies in the band both conventions allow decides; otherwise the provider's
 * convention does.
 */
export function outputTokenCount(
  counts: { input: number; output: number; thoughts: number; total: number },
  authType: string | undefined,
): number {
  const derived = counts.total - counts.input;
  if (
    counts.total > 0 &&
    derived >= counts.output &&
    derived <= counts.output + counts.thoughts
  )
    return derived;
  return outputIncludesThoughts(authType)
    ? counts.output
    : counts.output + counts.thoughts;
}
