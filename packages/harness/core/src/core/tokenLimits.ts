/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../provider/model/model.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../qoder/models/output-tokens.js';
import { isCustomProviderModel } from '../qoder/models/qoder-model-fields.js';

type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT = 1_048_576;
export const DEFAULT_OUTPUT_TOKEN_LIMIT = DEFAULT_MAX_OUTPUT_TOKENS;

/**
 * Returns the provider-declared context window size for a given model.
 *
 * Resolution order:
 * 1. The session's listed model `limits.maxContextTokens` (the model's actual upstream limit)
 * 2. Fallback → DEFAULT_TOKEN_LIMIT
 *
 * Note: `capabilities.contextWindows` (the user-selectable tier list) is
 * intentionally NOT consulted here. Picking a larger tier is opt-in via the
 * `context_window_selection` feature gate; consult `Config.getEffectiveContextWindow`
 * when you want the user's selection applied.
 */
export function tokenLimit(model: Model | undefined): TokenCount {
  const limit = model?.limits.maxContextTokens;
  return limit !== undefined && Number.isFinite(limit) && limit > 0
    ? limit
    : DEFAULT_TOKEN_LIMIT;
}

/** Custom provider models declare output tokens as a default config, not a limit. */
export function declaredOutputTokens(model: Model): TokenCount | undefined {
  return (
    model.limits.maxOutputTokens ??
    (isCustomProviderModel(model)
      ? model.defaultModelConfig?.context?.maxOutputTokens
      : undefined)
  );
}

export function outputTokenLimit(model: Model | undefined): TokenCount {
  const limit = model ? declaredOutputTokens(model) : undefined;
  return limit !== undefined && Number.isFinite(limit) && limit > 0
    ? limit
    : DEFAULT_OUTPUT_TOKEN_LIMIT;
}
