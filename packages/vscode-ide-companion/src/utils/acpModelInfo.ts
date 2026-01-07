/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpMeta, ModelInfo } from '../types/acpTypes.js';

const asMeta = (value: unknown): AcpMeta | null | undefined => {
  if (value === null) {
    return null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as AcpMeta;
  }
  return undefined;
};

const normalizeModelInfo = (value: unknown): ModelInfo | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const nameRaw = obj['name'];
  const modelIdRaw = obj['modelId'];
  const descriptionRaw = obj['description'];

  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  const modelId =
    typeof modelIdRaw === 'string' && modelIdRaw.trim().length > 0
      ? modelIdRaw.trim()
      : name;

  if (!modelId || modelId.trim().length === 0 || !name) {
    return null;
  }

  const description =
    typeof descriptionRaw === 'string' || descriptionRaw === null
      ? descriptionRaw
      : undefined;

  const metaFromWire = asMeta(obj['_meta']);

  // Back-compat: older implementations used `contextLimit` at the top-level.
  const legacyContextLimit = obj['contextLimit'];
  const contextLimit =
    typeof legacyContextLimit === 'number' || legacyContextLimit === null
      ? legacyContextLimit
      : undefined;

  let mergedMeta: AcpMeta | null | undefined = metaFromWire;
  if (typeof contextLimit !== 'undefined') {
    if (mergedMeta === null) {
      mergedMeta = { contextLimit };
    } else if (typeof mergedMeta === 'undefined') {
      mergedMeta = { contextLimit };
    } else {
      mergedMeta = { ...mergedMeta, contextLimit };
    }
  }

  return {
    modelId,
    name,
    ...(typeof description !== 'undefined' ? { description } : {}),
    ...(typeof mergedMeta !== 'undefined' ? { _meta: mergedMeta } : {}),
  };
};

/**
 * Extract model info from ACP `session/new` result.
 *
 * Per Agent Client Protocol draft schema, NewSessionResponse includes `models`.
 * We also accept legacy shapes for compatibility.
 */
export const extractModelInfoFromNewSessionResult = (
  result: unknown,
): ModelInfo | null => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const obj = result as Record<string, unknown>;

  const models = obj['models'];

  // ACP draft: NewSessionResponse.models is a SessionModelState object.
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    const state = models as Record<string, unknown>;
    const availableModels = state['availableModels'];
    const currentModelId = state['currentModelId'];
    if (Array.isArray(availableModels)) {
      const normalizedModels = availableModels
        .map(normalizeModelInfo)
        .filter((m): m is ModelInfo => Boolean(m));
      if (normalizedModels.length > 0) {
        if (typeof currentModelId === 'string' && currentModelId.length > 0) {
          const selected = normalizedModels.find(
            (m) => m.modelId === currentModelId,
          );
          if (selected) {
            return selected;
          }
        }
        return normalizedModels[0];
      }
    }
  }

  // Legacy: some implementations returned `models` as a raw array.
  if (Array.isArray(models)) {
    for (const entry of models) {
      const normalized = normalizeModelInfo(entry);
      if (normalized) {
        return normalized;
      }
    }
  }

  // Some implementations may return a single model object.
  const model = normalizeModelInfo(obj['model']);
  if (model) {
    return model;
  }

  // Legacy: modelInfo on initialize; allow as a fallback.
  const legacy = normalizeModelInfo(obj['modelInfo']);
  if (legacy) {
    return legacy;
  }

  return null;
};
