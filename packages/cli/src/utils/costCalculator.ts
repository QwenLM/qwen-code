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

  // `null` means "no cost to report", which is how callers read it: the stats
  // table renders it as `N/A` and hides the whole Cost section when no model
  // produces a number. Two things can make a cost unreportable -- no price is
  // configured, or the model recorded no usage -- and both are decided here,
  // before any arithmetic.
  if (
    pricing.inputPerMillionTokens == null &&
    pricing.outputPerMillionTokens == null
  ) {
    return null;
  }
  if (inputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  // Past this point the cost is knowable, so it is returned even when it comes
  // out as exactly zero. Testing the total instead conflated a zero cost with
  // an unknown one: a model the user had deliberately priced at 0 -- a free
  // OpenRouter variant, a local Ollama or LM Studio model -- reported `N/A`
  // despite $0.0000 being the correct and known answer, and the Cost section
  // disappeared entirely when that was the only model in the session.
  const inputCost =
    pricing.inputPerMillionTokens != null
      ? (inputTokens / 1_000_000) * pricing.inputPerMillionTokens
      : 0;

  const outputCost =
    pricing.outputPerMillionTokens != null
      ? (outputTokens / 1_000_000) * pricing.outputPerMillionTokens
      : 0;

  return inputCost + outputCost;
}
