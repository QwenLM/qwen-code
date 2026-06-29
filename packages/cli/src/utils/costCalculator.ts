/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ModelPricing {
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
}

export function calculateCost(args: {
  inputTokens: number;
  outputTokens: number;
  pricing?: ModelPricing;
}): number | null {
  const { inputTokens, outputTokens, pricing } = args;

  if (!pricing) return null;

  const inputCost =
    pricing.inputPerMillionTokens != null
      ? (inputTokens / 1_000_000) * pricing.inputPerMillionTokens
      : 0;

  const outputCost =
    pricing.outputPerMillionTokens != null
      ? (outputTokens / 1_000_000) * pricing.outputPerMillionTokens
      : 0;

  const total = inputCost + outputCost;
  return total > 0 ? total : null;
}
