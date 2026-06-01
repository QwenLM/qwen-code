/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';

export interface ParsedSubagentModelSelection {
  authType?: AuthType;
  modelId?: string;
  inherits: boolean;
  /**
   * True when the selector was `fast` — the runtime resolves this to
   * `Config.getFastModel()` if a valid fast model is configured, and
   * falls back to inheriting the parent model otherwise.
   */
  usesFastModel?: boolean;
}

const AUTH_TYPES = new Set<AuthType>(Object.values(AuthType));

/**
 * Parse a subagent model selector.
 *
 * Supported forms:
 * - omitted / inherit -> use parent conversation model
 * - fast -> use Config.getFastModel() if available, else inherit parent model
 * - modelId -> use parent authType with the provided modelId
 * - authType:modelId -> use explicit authType and modelId
 */
export function parseSubagentModelSelection(
  model: string | undefined,
): ParsedSubagentModelSelection {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === 'inherit') {
    return { inherits: true };
  }

  if (trimmed === 'fast') {
    return { inherits: false, usesFastModel: true };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return { modelId: trimmed, inherits: false };
  }

  const maybeAuthType = trimmed.slice(0, colonIndex).trim();
  const modelId = trimmed.slice(colonIndex + 1).trim();

  // If the prefix isn't a known AuthType, treat the whole string as a bare
  // model ID. Model IDs can legitimately contain colons (e.g. gpt-4o:online).
  if (!AUTH_TYPES.has(maybeAuthType as AuthType)) {
    return { modelId: trimmed, inherits: false };
  }

  if (!modelId) {
    throw new Error(
      'Model selector must include a model ID after the authType',
    );
  }

  return {
    authType: maybeAuthType as AuthType,
    modelId,
    inherits: false,
  };
}
