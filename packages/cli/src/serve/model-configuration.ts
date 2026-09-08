/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  isImageGenerationCapable,
  resolveProviderProtocol,
} from '@qwen-code/qwen-code-core';
import type { ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { SettingScope } from '../config/settings.js';
import { getModelProvidersOwnerScope } from '../config/modelProvidersScope.js';
import { sanitizeProviderBaseUrl } from '../utils/acpModelUtils.js';

function modelKey(
  scope: SettingScope,
  provider: string,
  model: ProviderModelConfig,
) {
  return createHash('sha256')
    .update(JSON.stringify([scope, provider, model.id, model.baseUrl ?? '']))
    .digest('hex');
}

function modelEntries(loaded: LoadedSettings) {
  const scope = getModelProvidersOwnerScope(loaded) ?? SettingScope.User;
  const providers = loaded.forScope(scope).settings.modelProviders ?? {};
  const entries = Object.entries(providers).flatMap(([provider, models]) => {
    const authType = resolveProviderProtocol(
      provider,
      loaded.merged.providerProtocol,
    );
    if (!authType || authType === 'qwen-oauth' || !Array.isArray(models))
      return [];
    return models.flatMap((model: ProviderModelConfig, index) =>
      model &&
      typeof model === 'object' &&
      typeof model.id === 'string' &&
      model.id &&
      (model.baseUrl === undefined || typeof model.baseUrl === 'string')
        ? [
            {
              provider,
              authType,
              model,
              index,
              key: modelKey(scope, provider, model),
            },
          ]
        : [],
    );
  });
  return { scope, providers, entries };
}

export function findModelConfiguration(loaded: LoadedSettings, key: string) {
  const matches = modelEntries(loaded).entries.filter(
    (entry) => entry.key === key,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function getModelConfigurationKey(
  loaded: LoadedSettings,
  authType: string,
  modelId: string,
  baseUrl: string | undefined,
) {
  const matches = modelEntries(loaded).entries.filter(
    (entry) =>
      entry.authType === authType &&
      entry.model.id === modelId &&
      (entry.model.baseUrl ?? '') === (baseUrl ?? ''),
  );
  return matches.length === 1 ? matches[0]!.key : undefined;
}

export function listModelConfigurations(loaded: LoadedSettings) {
  return modelEntries(loaded).entries.map(({ model, authType, key }) => {
    const uniqueRoute =
      getModelConfigurationKey(loaded, authType, model.id, model.baseUrl) ===
      key;
    const imageCapable = isImageGenerationCapable(model);
    let imageModel: string | undefined;
    let advisorModel: string | undefined;
    if (
      uniqueRoute &&
      model.imageOnly !== true &&
      model.voiceOnly !== true &&
      model.fastOnly !== true
    ) {
      if (!model.baseUrl) advisorModel = `${authType}:${model.id}\0`;
      else {
        try {
          const url = new URL(model.baseUrl);
          if (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          )
            advisorModel = `${authType}:${model.id}\0${model.baseUrl}`;
        } catch {
          /* Invalid endpoints cannot be selected. */
        }
      }
    }
    if (
      uniqueRoute &&
      imageCapable &&
      !model.fastOnly &&
      !model.voiceOnly &&
      model.baseUrl &&
      model.envKey
    ) {
      try {
        const url = new URL(model.baseUrl);
        if (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        ) {
          imageModel = `${authType}:${model.id}\0${model.baseUrl}`;
        }
      } catch {
        /* Invalid endpoints are not selectable image routes. */
      }
    }
    return {
      key,
      authType,
      modelId: model.id,
      name: model.name,
      baseUrl: model.baseUrl
        ? sanitizeProviderBaseUrl(model.baseUrl).split(/[?#]/)[0]
        : undefined,
      envKey: model.envKey,
      contextWindowSize: model.generationConfig?.contextWindowSize,
      purpose:
        model.imageOnly === true
          ? ('image' as const)
          : model.voiceOnly === true
            ? ('voice' as const)
            : ('chat' as const),
      ...(imageModel ? { imageModel } : {}),
      ...(advisorModel ? { advisorModel } : {}),
    };
  });
}

export function updateModelContextWindow(
  loaded: LoadedSettings,
  key: string,
  contextWindowSize: number | null,
  assertGenerationOpen?: () => void,
): 'user' | 'workspace' | undefined {
  const { scope, providers } = modelEntries(loaded);
  const match = findModelConfiguration(loaded, key);
  if (!match) return undefined;
  const { provider, model, index } = match;
  const generationConfig = { ...model.generationConfig };
  if (contextWindowSize === null) delete generationConfig.contextWindowSize;
  else generationConfig.contextWindowSize = contextWindowSize;
  const updated: ProviderModelConfig = { ...model, generationConfig };
  if (Object.keys(generationConfig).length === 0)
    delete updated.generationConfig;
  loaded.setValue(
    scope,
    'modelProviders',
    {
      ...providers,
      [provider]: providers[provider]!.map((entry, i) =>
        i === index ? updated : entry,
      ),
    },
    assertGenerationOpen,
    { throwOnWriteFailure: true },
  );
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}
