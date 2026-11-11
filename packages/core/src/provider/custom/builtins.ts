/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS,
  type CustomProviderAnthropicConfig,
  type CustomProviderModelRuntime,
  type CustomProviderThinkingCapabilities,
} from './types.js';

export const DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW = 128_000;
/** Conservative catalog capacity for a model with no declared metadata. */
export const DEFAULT_IMPLICIT_CUSTOM_PROVIDER_CONTEXT_WINDOW = 128_000;
/** Alibaba-specific capacity for a model with no declared metadata. */
export const DEFAULT_IMPLICIT_ALIBABA_CONTEXT_WINDOW = 200_000;
export const DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_CUSTOM_PROVIDER_FIRST_PAYLOAD_TIMEOUT_MS = 60_000;
export const ALIBABA_FIRST_PAYLOAD_TIMEOUT_MS = 180_000;

export const DEFAULT_CUSTOM_PROVIDER_ANTHROPIC_CONFIG: CustomProviderAnthropicConfig = {
  version: '2023-06-01',
  betas: [],
  queryParams: {},
  cache: { mode: 'auto', ttl: '5m' },
};

/** Returns an independent copy because model capability arrays are mutable at runtime. */
export function createAlibabaThinkingCapabilities(): CustomProviderThinkingCapabilities {
  return {
    modes: ['enabled'],
    requiresBudgetForEnabled: false,
    // Alibaba exposes native effort controls across its OpenAI, Responses,
    // and Anthropic-compatible protocols. The transport owns the wire
    // projection; the model capability remains protocol-neutral.
    supportedEffortLevels: [...CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS],
    requiredBetasForEffort: [],
  };
}

export const BUILTIN_ALIBABA_MODELS: readonly CustomProviderModelRuntime[] = [
  {
    modelId: 'qwen3.8-max',
    displayName: 'Qwen 3.8 Max',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    capabilities: {
      tools: true,
      vision: true,
      cacheControl: true,
      thinking: createAlibabaThinkingCapabilities(),
    },
    maxTokensField: 'max_completion_tokens',
  },
];
