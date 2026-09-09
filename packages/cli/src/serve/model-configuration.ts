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
import { getWritableScopes } from '../config/modelProvidersScope.js';
import { publicProviderBaseUrl } from '../utils/acpModelUtils.js';

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
  const seenProviders = new Set<string>();
  return [
    SettingScope.System,
    ...getWritableScopes(loaded),
    SettingScope.SystemDefaults,
  ].flatMap((scope) => {
    const providers = loaded.forScope(scope).settings.modelProviders ?? {};
    return Object.entries(providers).flatMap(([provider, models]) => {
      if (seenProviders.has(provider)) return [];
      seenProviders.add(provider);
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
                scope,
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
  });
}

export function findModelConfiguration(loaded: LoadedSettings, key: string) {
  const matches = modelEntries(loaded).filter((entry) => entry.key === key);
  return matches.length === 1 &&
    getWritableScopes(loaded).includes(matches[0]!.scope)
    ? matches[0]
    : undefined;
}

export function getModelConfigurationKey(
  loaded: LoadedSettings,
  authType: string,
  modelId: string,
  baseUrl: string | undefined,
) {
  const matches = modelEntries(loaded).filter(
    (entry) =>
      entry.authType === authType &&
      entry.model.id === modelId &&
      (entry.model.baseUrl ?? '') === (baseUrl ?? ''),
  );
  return matches.length === 1 &&
    getWritableScopes(loaded).includes(matches[0]!.scope)
    ? matches[0]!.key
    : undefined;
}

export function listModelConfigurations(loaded: LoadedSettings) {
  const entries = modelEntries(loaded);
  const routeKey = (entry: (typeof entries)[number]) =>
    JSON.stringify([entry.authType, entry.model.id, entry.model.baseUrl ?? '']);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const route = routeKey(entry);
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  const writableScopes = getWritableScopes(loaded);
  return entries
    .filter((entry) => writableScopes.includes(entry.scope))
    .map((entry) => {
      const { model, authType, key } = entry;
      const uniqueRoute = counts.get(routeKey(entry)) === 1;
      const imageCapable = isImageGenerationCapable(model);
      let imageModel: string | undefined;
      let advisorModel: string | undefined;
      if (
        uniqueRoute &&
        model.imageOnly !== true &&
        model.voiceOnly !== true &&
        model.fastOnly !== true &&
        model.visionOnly !== true
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
        typeof model.envKey === 'string' &&
        model.envKey.trim()
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
          ? publicProviderBaseUrl(model.baseUrl)
          : undefined,
        envKey: typeof model.envKey === 'string' ? model.envKey : undefined,
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
  const match = findModelConfiguration(loaded, key);
  if (!match) return undefined;
  const { scope, provider, index } = match;
  const providers =
    loaded.forScope(scope).originalSettings.modelProviders ?? {};
  const model = providers[provider]![index]!;
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
