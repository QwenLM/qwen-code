/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { AvailableModel, Config } from '@qwen-code/qwen-code-core';
import type { ModelConfig } from '@qwen-code/qwen-code-core/models/types.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { resolveModelId } from '@qwen-code/qwen-code-core/utils/modelId.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { type LoadedSettings, SettingScope } from './settings.js';
import { createLoadedSettingsAdapter } from './loadedSettingsAdapter.js';
import { preserveModelProviderPlaceholders } from '@qwen-code/qwen-code-core/providers/model-config-serialization.js';

export function persistSubscriptionModel(
  settings: LoadedSettings,
  config: Config,
  selector: string,
  scope: SettingScope,
): void {
  const models = prepareSubscriptionModelPersistence(
    settings,
    config,
    selector,
    scope,
  );
  if (!models) return;
  createLoadedSettingsAdapter(settings, scope).setValue(
    `modelProviders.${AuthType.QWEN_SUBSCRIPTION}`,
    models,
  );
}

export function prepareSubscriptionModelPersistence(
  settings: LoadedSettings,
  config: Config,
  selector: string,
  scope: SettingScope,
): ModelConfig[] | undefined {
  const [modelSelector, baseUrl] = selector.split('\0');
  const selection = resolveModelId(modelSelector);
  if (
    !selection ||
    (selection.authType && selection.authType !== AuthType.QWEN_SUBSCRIPTION)
  )
    return;
  const candidates = config
    .getAllConfiguredModels()
    .filter(
      (model) =>
        !model.isRuntimeModel &&
        model.id === selection.modelId &&
        (!selection.authType || model.authType === selection.authType) &&
        (!baseUrl || model.baseUrl === baseUrl),
    );
  if (
    candidates.length !== 1 ||
    candidates[0].authType !== AuthType.QWEN_SUBSCRIPTION
  )
    return;
  const model = candidates[0];
  const selected = getSubscriptionModelConfig(model)!;
  return buildSubscriptionModelProviders(settings, selected, scope);
}

export function buildSubscriptionModelProviders(
  settings: LoadedSettings,
  selected: ModelConfig,
  scope: SettingScope,
): ModelConfig[] {
  const provider = AuthType.QWEN_SUBSCRIPTION;
  const higherScopes =
    scope === SettingScope.Workspace
      ? [SettingScope.System]
      : [
          SettingScope.System,
          ...(settings.isTrusted ? [SettingScope.Workspace] : []),
        ];
  const higherOwner = higherScopes.find((source) =>
    Object.hasOwn(
      settings.forScope(source).settings.modelProviders ?? {},
      provider,
    ),
  );
  const higherFile =
    higherOwner === undefined ? undefined : settings.forScope(higherOwner);
  const higherModels = higherFile?.settings.modelProviders?.[provider] ?? [];
  const winnerIndex = higherModels.findIndex(
    (model) => model.id === selected.id && model.baseUrl === selected.baseUrl,
  );
  const winner = higherModels[winnerIndex];
  if (
    higherFile &&
    (!winner ||
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify({ ...winner, wireApi: undefined })),
        JSON.parse(JSON.stringify({ ...selected, wireApi: undefined })),
      ))
  )
    throw new Error(
      'A higher-precedence settings scope overrides this provider. Update the scope that owns this provider.',
    );
  const writeScopes =
    scope === SettingScope.Workspace
      ? [SettingScope.Workspace, SettingScope.User, SettingScope.SystemDefaults]
      : [SettingScope.User, SettingScope.SystemDefaults];
  const sourceScope = writeScopes.find((source) =>
    Object.hasOwn(
      settings.forScope(source).settings.modelProviders ?? {},
      provider,
    ),
  );
  const sourceFile =
    sourceScope === undefined ? undefined : settings.forScope(sourceScope);
  const previous = sourceFile?.settings.modelProviders?.[provider] ?? [];
  const original =
    sourceFile?.originalSettings.modelProviders?.[provider] ?? previous;
  const inheritWinner =
    winner &&
    !previous.some(
      (model) => model.id === selected.id && model.baseUrl === selected.baseUrl,
    );
  return preserveModelProviderPlaceholders(
    [...previous.filter((model) => model.id !== selected.id), selected],
    provider,
    { [provider]: [...previous, ...(inheritWinner ? [winner] : [])] },
    {
      [provider]: [
        ...original,
        ...(inheritWinner
          ? [
              higherFile?.originalSettings.modelProviders?.[provider]?.[
                winnerIndex
              ] ?? winner,
            ]
          : []),
      ],
    },
    settings.merged.providerProtocol,
  );
}

export function getSubscriptionModelConfig(
  model: AvailableModel,
): ModelConfig | undefined {
  if (model.authType !== AuthType.QWEN_SUBSCRIPTION) return undefined;
  return {
    id: model.id,
    name: model.label,
    baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
    thinkingStrength: model.thinkingStrength,
    subscriptionScenes: model.subscriptionScenes,
    subscriptionChatModel: model.subscriptionChatModel,
    capabilities: model.capabilities,
    fastOnly: model.fastOnly,
    voiceOnly: model.voiceOnly,
    visionOnly: model.visionOnly,
    imageOnly: model.imageOnly,
    supportsImageGeneration: model.supportsImageGeneration,
    generationConfig: {
      modalities: model.modalities,
      contextWindowSize: model.contextWindowSize,
    },
  };
}
