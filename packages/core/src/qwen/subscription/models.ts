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
import {
  QWEN_SUBSCRIPTION_MODEL,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
} from './oauth-config.js';

interface SubscriptionModelSpec {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly vision?: boolean;
}

/**
 * Gateway models with confirmed metadata. Other ids returned by `/models`
 * stay selectable with conservative text-only defaults.
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

/** Membership models lead the catalog in the order the product presents them. */
export function orderSubscriptionModels(
  models: readonly string[],
): readonly string[] {
  const leading = KNOWN_MODELS.map((model) => model.id).filter((id) =>
    models.includes(id),
  );
  const rest = models.filter((id) => !leading.includes(id));
  return [...leading, ...rest];
}

/** Explicit sign-in picks the flagship model, otherwise the first returned. */
export function selectQwenSubscriptionModel(
  models: readonly string[],
): string | undefined {
  if (models.length === 0) return undefined;
  return models.includes(QWEN_SUBSCRIPTION_MODEL)
    ? QWEN_SUBSCRIPTION_MODEL
    : models[0];
}

export function qwenSubscriptionModelKey(modelId: string): string {
  return `${QWEN_SUBSCRIPTION_PROVIDER_ID}/${modelId}`;
}

/** Project one account catalog id into the neutral model contract. */
export function qwenSubscriptionModel(modelId: string): Model {
  const known = KNOWN_MODELS.find((model) => model.id === modelId);
  const contextWindow =
    known?.contextWindow ?? DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW;
  return {
    source: QWEN_SUBSCRIPTION_PROVIDER_ID,
    key: qwenSubscriptionModelKey(modelId),
    displayName: known?.displayName ?? modelId,
    capabilities: {
      tools: true,
      vision: known?.vision ?? false,
      reasoning: { supported: false, supportedEfforts: [] },
      contextWindows: [{ tokens: contextWindow }],
    },
    limits: {
      maxContextTokens: contextWindow,
      maxOutputTokens: DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
    },
  };
}
