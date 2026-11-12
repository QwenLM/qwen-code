/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
} from '../../provider/custom/builtins.js';
import type { Model } from '../../provider/model/model.js';
import { QWEN_SUBSCRIPTION_PROVIDER_ID } from './oauth-config.js';

export const QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE =
  'Could not load Qwen Subscription models. Your account is still signed in. Please try again.';

export interface QwenSubscriptionModelMetadata {
  readonly id: string;
  readonly modalities?: {
    readonly image?: boolean;
    readonly video?: boolean;
    readonly audio?: boolean;
    readonly pdf?: boolean;
  };
  readonly contextWindowSize?: number;
}

export interface QwenSubscriptionModelCatalog {
  readonly models: string[];
  readonly modelMetadata?: QwenSubscriptionModelMetadata[];
}

interface SubscriptionModelSpec {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly vision?: boolean;
}

/**
 * Gateway models with fallback display names and metadata when `/models`
 * does not supply explicit `input_modalities` or `context_window_tokens`.
 */
const KNOWN_MODELS: readonly SubscriptionModelSpec[] = [
  {
    id: 'qwen3.8-max',
    displayName: 'Qwen 3.8 Max',
    contextWindow: 1_000_000,
    vision: true,
  },
  {
    id: 'qwen3.8-flash',
    displayName: 'Qwen 3.8 Flash',
    contextWindow: 1_000_000,
    vision: true,
  },
];

/** Preserve the order returned by the subscription `/models` gateway. */
export function orderSubscriptionModels(
  models: readonly string[],
): readonly string[] {
  return [...models];
}

/** Explicit sign-in selects the first model returned by the gateway. */
export function selectQwenSubscriptionModel(
  models: readonly string[],
): string | undefined {
  return models[0];
}

export function qwenSubscriptionModelKey(modelId: string): string {
  return `${QWEN_SUBSCRIPTION_PROVIDER_ID}/${modelId}`;
}

/** Project one account catalog id into the neutral model contract. */
export function qwenSubscriptionModel(
  modelId: string,
  metadata?: QwenSubscriptionModelMetadata,
): Model {
  const known = KNOWN_MODELS.find((model) => model.id === modelId);
  const contextWindow =
    metadata?.contextWindowSize ??
    known?.contextWindow ??
    DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW;
  const vision =
    metadata?.modalities !== undefined
      ? Boolean(metadata.modalities.image)
      : (known?.vision ?? false);
  return {
    source: QWEN_SUBSCRIPTION_PROVIDER_ID,
    key: qwenSubscriptionModelKey(modelId),
    displayName: known?.displayName ?? modelId,
    capabilities: {
      tools: true,
      vision,
      reasoning: {
        supported: true,
        supportedEfforts: ['none', 'low', 'medium', 'high'],
      },
      contextWindows: [{ tokens: contextWindow }],
    },
    limits: {
      maxContextTokens: contextWindow,
      maxOutputTokens: DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
    },
    defaultModelConfig: {
      reasoning: { effort: 'medium' },
      context: { contextWindow },
    },
  };
}
