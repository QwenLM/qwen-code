/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildModelIdContext,
  resolveModelId,
} from '@qwen-code/qwen-code-core/utils/modelId.js';
import type { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

export interface AdvisorModelContext {
  fastModel?: string;
  currentModel?: string;
  currentAuthType?: AuthType;
}

interface AdvisorModelCandidate {
  fastOnly?: boolean;
  voiceOnly?: boolean;
  visionOnly?: boolean;
  imageOnly?: boolean;
}

function resolvesToSameModel(
  modelName: string | undefined,
  selector: ReturnType<typeof resolveModelId> | undefined,
  context: AdvisorModelContext,
): boolean {
  if (!modelName || !selector) return false;
  try {
    const resolved = resolveModelId(modelName.split('\0')[0], {
      ...context,
      fastModel: undefined,
    });
    return (
      resolved?.modelId === selector.modelId &&
      resolved?.authType === selector.authType
    );
  } catch {
    return false;
  }
}

export function allowsFastOnlyAdvisorModel(
  modelName: string | undefined,
  selector: ReturnType<typeof resolveModelId> | undefined,
  context: AdvisorModelContext,
): boolean {
  return (
    modelName === 'fast' ||
    resolvesToSameModel(context.fastModel, selector, context)
  );
}

export function isAdvisorModelEligible(
  model: AdvisorModelCandidate,
  allowFastOnly = false,
): boolean {
  return (
    (allowFastOnly || !model.fastOnly) &&
    !model.voiceOnly &&
    !model.visionOnly &&
    !model.imageOnly
  );
}

export function checkAdvisorModelAvailability(
  config: Config,
  modelName: string,
  fallbackContext: AdvisorModelContext = {},
): { available: boolean; availableModelIds: string[] } {
  const runtimeContext = buildModelIdContext(config);
  const context = {
    ...runtimeContext,
    fastModel: runtimeContext.fastModel ?? fallbackContext.fastModel,
    currentModel: runtimeContext.currentModel ?? fallbackContext.currentModel,
    currentAuthType:
      runtimeContext.currentAuthType ?? fallbackContext.currentAuthType,
  };
  const endpointIndex = modelName.indexOf('\0');
  const modelSelector =
    endpointIndex < 0 ? modelName : modelName.slice(0, endpointIndex);
  const registryBaseUrl =
    endpointIndex < 0 ? undefined : modelName.slice(endpointIndex + 1) || null;
  let selector: ReturnType<typeof resolveModelId> | undefined;
  try {
    if (modelSelector.trim() === 'inherit') {
      throw new Error('Advisor cannot inherit the executor model.');
    }
    selector = resolveModelId(modelSelector, context);
  } catch {
    selector = undefined;
  }
  const allowFastOnly = allowsFastOnlyAdvisorModel(
    modelSelector,
    selector,
    context,
  );

  const configuredModels = config.getAllConfiguredModels(
    selector?.authType ? [selector.authType] : undefined,
  );
  const availableModels = configuredModels.filter(
    (model) =>
      isAdvisorModelEligible(model, allowFastOnly) &&
      (registryBaseUrl === undefined ||
        (!model.isRuntimeModel &&
          (model.registryBaseUrl ?? null) === registryBaseUrl)),
  );
  const uncapturedRuntimeModelId =
    registryBaseUrl === undefined &&
    selector !== undefined &&
    selector.modelId === context.currentModel &&
    selector.authType === context.currentAuthType &&
    !configuredModels.some(
      (model) =>
        model.id === selector.modelId && model.authType === selector.authType,
    )
      ? selector.modelId
      : undefined;
  const availableModelIds = new Set(availableModels.map((model) => model.id));
  if (uncapturedRuntimeModelId) {
    availableModelIds.add(uncapturedRuntimeModelId);
  }

  return {
    available:
      selector !== undefined &&
      (uncapturedRuntimeModelId !== undefined ||
        availableModels.some((model) => model.id === selector.modelId)),
    availableModelIds: Array.from(availableModelIds),
  };
}
