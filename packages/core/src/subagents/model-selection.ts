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
}

const AUTH_TYPES = new Set<AuthType>(Object.values(AuthType));

/**
 * Parse a subagent model selector.
 *
 * Supported forms:
 * - omitted / inherit -> use parent conversation model
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

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return { modelId: trimmed, inherits: false };
  }

  const maybeAuthType = trimmed.slice(0, colonIndex).trim();
  const modelId = trimmed.slice(colonIndex + 1).trim();

  if (!AUTH_TYPES.has(maybeAuthType as AuthType)) {
    throw new Error(
      `Invalid authType prefix "${maybeAuthType}". Expected one of: ${Object.values(AuthType).join(', ')}`,
    );
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
