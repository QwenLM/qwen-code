/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createImplicitCustomProviderModel,
  parseCustomProviderSettings,
  withoutReservedProviderSettings,
} from './parser.js';
import {
  customProviderModelKey,
  type CustomProviderModelDescriptor,
  type CustomProviderModelRuntime,
  type CustomProviderParseResult,
  type CustomProviderPublicDescriptor,
  type CustomProviderRuntime,
} from './types.js';

export class CustomProviderRegistry {
  private providers = new Map<string, CustomProviderRuntime>();
  private modelToProvider = new Map<string, string>();

  replace(
    settings: unknown,
    referencedModelKeys: readonly string[] = [],
  ): CustomProviderParseResult {
    const parsed = parseCustomProviderSettings(
      withoutReservedProviderSettings(settings),
    );
    const nextProviders = new Map<string, CustomProviderRuntime>();
    const nextModelToProvider = new Map<string, string>();
    for (const provider of parsed.providers) {
      const models = new Map(provider.models);
      for (const modelKey of referencedModelKeys) {
        const modelId = modelIdForProvider(modelKey, provider.providerId);
        if (modelId && !models.has(modelId)) {
          models.set(
            modelId,
            createImplicitCustomProviderModel(modelId, provider.type),
          );
        }
      }
      nextProviders.set(provider.providerId, { ...provider, models });
      for (const modelId of models.keys()) {
        nextModelToProvider.set(
          customProviderModelKey(provider.providerId, modelId),
          provider.providerId,
        );
      }
    }
    this.providers = nextProviders;
    this.modelToProvider = nextModelToProvider;
    return { ...parsed, providers: [...nextProviders.values()] };
  }

  clear(): void {
    this.providers = new Map();
    this.modelToProvider = new Map();
  }

  /** Revoke transport credentials while retaining secret-free model ownership. */
  clearCredentials(): void {
    this.providers = new Map(
      [...this.providers].map(([id, provider]) => [
        id,
        {
          ...provider,
          apiKey: '',
          baseUrl: '',
          anthropic: undefined,
        },
      ]),
    );
  }

  isCustomProviderModel(modelKey: string | undefined): boolean {
    return modelKey !== undefined && this.modelToProvider.has(modelKey);
  }

  getProviderForModel(modelKey: string): CustomProviderRuntime | undefined {
    const providerId = this.modelToProvider.get(modelKey);
    return providerId ? this.providers.get(providerId) : undefined;
  }

  /** 单个模型的无密钥描述；取不到归属 provider 或模型时返回 undefined。 */
  getModelDescriptor(
    modelKey: string,
  ): CustomProviderModelDescriptor | undefined {
    const provider = this.getProviderForModel(modelKey);
    if (!provider) return undefined;
    const model = provider.models.get(
      modelKey.slice(modelKey.indexOf('/') + 1),
    );
    return model ? toModelDescriptor(provider, model) : undefined;
  }

  getPublicProviders(): readonly CustomProviderPublicDescriptor[] {
    return [...this.providers.values()].map((provider) => {
      const models = [...provider.models.values()].map((model) =>
        toModelDescriptor(provider, model),
      );
      return {
        providerId: provider.providerId,
        displayName: provider.displayName,
        defaultModelKey: customProviderModelKey(
          provider.providerId,
          provider.defaultModel,
        ),
        models,
      };
    });
  }

  getPublicModels(): readonly CustomProviderModelDescriptor[] {
    return this.getPublicProviders().flatMap((provider) => provider.models);
  }
}

function toModelDescriptor(
  provider: CustomProviderRuntime,
  model: CustomProviderModelRuntime,
): CustomProviderModelDescriptor {
  return {
    key: customProviderModelKey(provider.providerId, model.modelId),
    providerId: provider.providerId,
    providerDisplayName: provider.displayName,
    adapter: provider.adapter,
    format:
      provider.adapter === 'anthropic-compatible'
        ? 'anthropic'
        : provider.adapter === 'gemini'
          ? 'gemini'
          : 'openai',
    modelId: model.modelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    ...(model.contextWindowEstimated
      ? { contextWindowEstimated: true as const }
      : {}),
    maxOutputTokens: model.maxOutputTokens,
    ...(model.implicit ? { implicit: true as const } : {}),
    capabilities: structuredClone(model.capabilities),
    defaultThinkingEnabled: model.generationDefaults?.reasoning?.enabled,
  };
}

function modelIdForProvider(
  modelKey: string,
  providerId: string,
): string | undefined {
  const prefix = `${providerId}/`;
  if (!modelKey.startsWith(prefix)) return undefined;
  const modelId = modelKey.slice(prefix.length);
  return modelId || undefined;
}
