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
 * Wire key the output budget travels under for `model` when the user has not
 * named one themselves: `max_completion_tokens` for the families above,
 * `max_tokens` for everything else. Explicit `samplingParams` keys always win
 * over this (they pass through verbatim).
 */
export function outputBudgetWireKey(
  model: string | undefined,
): OutputBudgetWireKey {
  const bare = normalize(model ?? '').replace(/^(?:[a-z][a-z-]*\.)+/, '');
  return MAX_COMPLETION_TOKENS_FAMILIES.test(bare)
    ? 'max_completion_tokens'
    : 'max_tokens';
}
