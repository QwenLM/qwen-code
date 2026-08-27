/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildModelIdContext,
  resolveModelId,
  type AuthType,
  type Config,
} from '@qwen-code/qwen-code-core';

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
    const resolved = resolveModelId(modelName, {
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
  let selector: ReturnType<typeof resolveModelId> | undefined;
  try {
    selector = resolveModelId(modelName, context);
  } catch {
    selector = undefined;
  }
  const allowFastOnly = allowsFastOnlyAdvisorModel(
    modelName,
    selector,
    context,
  );

  const availableModels = config
    .getAllConfiguredModels(
      selector?.authType ? [selector.authType] : undefined,
    )
    .filter((model) => isAdvisorModelEligible(model, allowFastOnly));

  return {
    available:
      selector !== undefined &&
      availableModels.some((model) => model.id === selector.modelId),
    availableModelIds: Array.from(
      new Set(availableModels.map((model) => model.id)),
    ),
  };
}
