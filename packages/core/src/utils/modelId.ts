/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';

export interface ResolvedModelId {
  authType?: AuthType;
  modelId: string;
}

export interface ModelIdResolutionContext {
  currentModel?: string;
  currentAuthType?: AuthType;
  fastModel?: string;
  getAvailableModels?: (
    authTypes?: AuthType[],
  ) => readonly ModelIdAvailableModel[];
}

export interface ModelIdAvailableModel {
  id: string;
  authType: AuthType;
}

type ModelIdSelector =
  | {
      kind: 'inherit';
    }
  | {
      kind: 'fast';
    }
  | {
      kind: 'model';
      authType?: AuthType;
      modelId: string;
    };

const AUTH_TYPES = new Set<AuthType>(Object.values(AuthType));

/**
 * Resolve a model selector to the concrete model ID a caller should use.
 *
 * Supported forms:
 * - omitted / inherit -> use parent conversation model
 * - fast -> use the configured fastModel
 * - modelId -> use current authType when available, otherwise the first
 *   configured authType that contains the model
 * - authType:modelId -> use explicit authType and modelId
 */
export function resolveModelId(
  model: string | undefined,
  context: ModelIdResolutionContext = {},
): ResolvedModelId | undefined {
  return resolveModelIdSelector(parseModelIdSelector(model), context);
}

/**
 * Build a {@link ModelIdResolutionContext} from a {@link Config}, wiring the
 * standard adapter calls (current model, current auth type, configured fast
 * model, configured models per auth type) used by every runtime caller.
 */
export function buildModelIdContext(config: Config): ModelIdResolutionContext {
  return {
    currentModel: config.getModel?.(),
    currentAuthType: config.getContentGeneratorConfig?.()?.authType,
    fastModel: config.getFastModel?.(),
    getAvailableModels: (authTypes) =>
      config.getAllConfiguredModels?.(authTypes) ?? [],
  };
}

function parseModelIdSelector(model: string | undefined): ModelIdSelector {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === 'inherit') {
    return { kind: 'inherit' };
  }
  if (trimmed === 'fast') {
    return { kind: 'fast' };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return { kind: 'model', modelId: trimmed };
  }

  const maybeAuthType = trimmed.slice(0, colonIndex).trim();
  const modelId = trimmed.slice(colonIndex + 1).trim();

  // If the prefix isn't a known AuthType, treat the whole string as a bare
  // model ID. Model IDs can legitimately contain colons (e.g. gpt-4o:online).
  if (!AUTH_TYPES.has(maybeAuthType as AuthType)) {
    return { kind: 'model', modelId: trimmed };
  }

  if (!modelId) {
    throw new Error(
      'Model selector must include a model ID after the authType',
    );
  }

  return {
    kind: 'model',
    authType: maybeAuthType as AuthType,
    modelId,
  };
}

function resolveAuthTypeForBareModel(
  modelId: string,
  context: ModelIdResolutionContext,
): AuthType | undefined {
  if (context.currentAuthType && context.getAvailableModels) {
    const currentModels = context.getAvailableModels([context.currentAuthType]);
    if (currentModels.some((model) => model.id === modelId)) {
      return context.currentAuthType;
    }
  }

  const configuredModel = context.getAvailableModels
    ? context.getAvailableModels().find((model) => model.id === modelId)
    : undefined;
  return configuredModel?.authType ?? context.currentAuthType;
}

function resolveModelIdSelector(
  selector: ModelIdSelector,
  context: ModelIdResolutionContext,
): ResolvedModelId | undefined {
  if (selector.kind === 'model') {
    const authType =
      selector.authType ??
      resolveAuthTypeForBareModel(selector.modelId, context);
    return {
      ...(authType ? { authType } : {}),
      modelId: selector.modelId,
    };
  }

  if (selector.kind === 'inherit') {
    return context.currentModel
      ? {
          ...(context.currentAuthType
            ? { authType: context.currentAuthType }
            : {}),
          modelId: context.currentModel,
        }
      : undefined;
  }

  if (!context.fastModel) {
    return undefined;
  }

  const fastSelector = parseModelIdSelector(context.fastModel);
  if (fastSelector.kind === 'fast') {
    return undefined;
  }

  return resolveModelIdSelector(fastSelector, {
    ...context,
    fastModel: undefined,
  });
}
