/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelInfo } from '@agentclientprotocol/sdk';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';

type AcpMeta = Record<string, unknown>;

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
 * SessionModelState as returned from ACP session/new.
 */
export interface SessionModelState {
  availableModels: ModelInfo[];
  currentModelId: string;
}

export interface SessionModeState {
  currentModeId?: ApprovalModeValue;
  availableModes?: Array<{
    id: ApprovalModeValue;
    name: string;
    description: string;
  }>;
}

const APPROVAL_MODE_VALUES: ApprovalModeValue[] = [
  'plan',
  'default',
  'auto-edit',
  'yolo',
];

const isApprovalModeValue = (value: unknown): value is ApprovalModeValue =>
  typeof value === 'string' &&
  APPROVAL_MODE_VALUES.includes(value as ApprovalModeValue);

/**
 * Extract complete model state from ACP `session/new` result.
 *
 * Returns both the list of available models and the current model ID.
 */
export const extractSessionModelState = (
  result: unknown,
): SessionModelState | null => {
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

      const modelId =
        typeof currentModelId === 'string' && currentModelId.length > 0
          ? currentModelId
          : normalizedModels[0]?.modelId || '';

      return {
        availableModels: normalizedModels,
        currentModelId: modelId,
      };
    }
  }

  // Legacy: some implementations returned `models` as a raw array.
  if (Array.isArray(models)) {
    const normalizedModels = models
      .map(normalizeModelInfo)
      .filter((m): m is ModelInfo => Boolean(m));

    if (normalizedModels.length > 0) {
      return {
        availableModels: normalizedModels,
        currentModelId: normalizedModels[0].modelId,
      };
    }
  }

  return null;
};

export const extractSessionModeState = (
  result: unknown,
): SessionModeState | null => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const obj = result as Record<string, unknown>;
  const modes = obj['modes'];
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) {
    return null;
  }

  const state = modes as Record<string, unknown>;
  const currentModeRaw = state['currentModeId'];
  const availableModesRaw = state['availableModes'];

  const currentModeId = isApprovalModeValue(currentModeRaw)
    ? currentModeRaw
    : undefined;

  let availableModes:
    | Array<{
        id: ApprovalModeValue;
        name: string;
        description: string;
      }>
    | undefined;
  if (Array.isArray(availableModesRaw)) {
    availableModes = availableModesRaw
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const idRaw = item['id'];
        if (!isApprovalModeValue(idRaw)) {
          return null;
        }
        return {
          id: idRaw,
          name: typeof item['name'] === 'string' ? item['name'] : idRaw,
          description:
            typeof item['description'] === 'string' ? item['description'] : '',
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: ApprovalModeValue;
          name: string;
          description: string;
        } => Boolean(item),
      );
  }

  if (!currentModeId && (!availableModes || availableModes.length === 0)) {
    return null;
  }

  return {
    ...(currentModeId ? { currentModeId } : {}),
    ...(availableModes ? { availableModes } : {}),
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
