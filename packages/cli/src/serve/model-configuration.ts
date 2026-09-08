/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { resolveProviderProtocol } from '@qwen-code/qwen-code-core';
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

export function listModelConfigurations(loaded: LoadedSettings) {
  const scope = getModelProvidersOwnerScope(loaded) ?? SettingScope.User;
  const providers = loaded.forScope(scope).settings.modelProviders ?? {};
  return Object.entries(providers).flatMap(([provider, models]) => {
    const authType = resolveProviderProtocol(
      provider,
      loaded.merged.providerProtocol,
    );
    if (!authType || authType === 'qwen-oauth') return [];
    return models.map((model) => {
      const imageCapable =
        (model.supportsImageGeneration || model.imageOnly) &&
        !model.voiceOnly &&
        !model.fastOnly;
      let imageModel: string | undefined;
      if (imageCapable && model.baseUrl && model.envKey) {
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
        key: modelKey(scope, provider, model),
        authType,
        modelId: model.id,
        name: model.name,
        baseUrl: model.baseUrl
          ? sanitizeProviderBaseUrl(model.baseUrl).split(/[?#]/)[0]
          : undefined,
        envKey: model.envKey,
        contextWindowSize: model.generationConfig?.contextWindowSize,
        purpose: model.imageOnly
          ? ('image' as const)
          : model.voiceOnly
            ? ('voice' as const)
            : ('chat' as const),
        ...(imageModel ? { imageModel } : {}),
      };
    });
  });
}

export function updateModelContextWindow(
  loaded: LoadedSettings,
  key: string,
  contextWindowSize: number | null,
  assertGenerationOpen?: () => void,
): 'user' | 'workspace' | undefined {
  const scope = getModelProvidersOwnerScope(loaded) ?? SettingScope.User;
  const providers = loaded.forScope(scope).settings.modelProviders ?? {};
  const matches = Object.entries(providers).flatMap(([provider, models]) =>
    models.flatMap((model, index) =>
      modelKey(scope, provider, model) === key &&
      resolveProviderProtocol(provider, loaded.merged.providerProtocol) !==
        'qwen-oauth'
        ? [{ provider, model, index }]
        : [],
    ),
  );
  if (matches.length !== 1) return undefined;
  const { provider, model, index } = matches[0]!;
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
  );
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}
