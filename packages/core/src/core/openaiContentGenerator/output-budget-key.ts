/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalize } from '../tokenLimits.js';

/**
 * Model families whose Chat Completions endpoint rejects `max_tokens` with
 * `unsupported_parameter` and only accepts `max_completion_tokens`: OpenAI's
 * GPT-5 and later generations and the o-series. The same ids reach us with a
 * vendor prefix from gateways that namespace models by publisher
 * (`openai.gpt-5.5` on OCI Generative AI, `openai.gpt-oss-120b-1:0` on
 * Bedrock), so the prefix is dropped before the family test. `gpt-oss` and
 * GPT-4.x accept either key and stay on `max_tokens`.
 */
const MAX_COMPLETION_TOKENS_FAMILIES = /^(?:gpt-[5-9]|o\d)(?![a-z])/;

export type OutputBudgetWireKey = 'max_tokens' | 'max_completion_tokens';

/**
 * Keys a `samplingParams` output budget can travel under, in lookup order:
 * the documented `max_tokens`, then the provider-specific stand-ins the
 * installer writes for the families above and the pipeline clamps in place.
 */
export const OUTPUT_BUDGET_KEYS = [
  'max_tokens',
  'max_completion_tokens',
  'max_new_tokens',
] as const;

/**
 * The output ceiling the user configured in `samplingParams`, whichever key
 * it travels under, or `undefined` when none carries a number. A `null`
 * placeholder counts as unset, as it does for the pipeline's
 * `reconcileMaxTokens`. Readers that treat `samplingParams.max_tokens` as
 * "the user chose a ceiling" (first-send clamp, MAX_TOKENS escalation gate,
 * side-query budget) go through here so an installer-written
 * `max_completion_tokens` is honoured the same way.
 */
export function configuredOutputBudget(
  samplingParams: { [key: string]: unknown } | undefined,
): number | undefined {
  if (!samplingParams) return undefined;
  for (const key of OUTPUT_BUDGET_KEYS) {
    const value = samplingParams[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Wire key the output budget travels under for `model` when the user has not
 * named one themselves: `max_completion_tokens` for the families above,
 * `max_tokens` for everything else. Explicit `samplingParams` keys always win
 * over this (they pass through verbatim).
 */
export function outputBudgetWireKey(
  model: string | undefined,
): OutputBudgetWireKey {
  // `normalize()` keeps the right half of a colon (`authType:model`) unless
  // it recognises that half as a tag, and it knows neither OpenRouter's
  // `:batch` nor the Bedrock build tag (`-1:0`), so both are dropped first
  // (the same `:batch` pre-strip reasoning-effort.ts applies). The dotted
  // publisher prefix is dropped after, since `normalize()` keeps it.
  const bare = normalize(
    (model ?? '').replace(/:batch(?=:|$)/gi, '').replace(/:\d+$/, ''),
  ).replace(/^(?:[a-z][a-z-]*\.)+/, '');
  return MAX_COMPLETION_TOKENS_FAMILIES.test(bare)
    ? 'max_completion_tokens'
    : 'max_tokens';
}
