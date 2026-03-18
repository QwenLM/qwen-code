/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { DEFAULT_OPENAI_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import {
  type ModelConfig,
  type ProviderModelConfig,
  type ModelProvidersConfig,
  type ProviderConfig,
  type ResolvedModelConfig,
  type AvailableModel,
} from './types.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import { QWEN_OAUTH_MODELS } from './constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODEL_REGISTRY');

export { QWEN_OAUTH_MODELS } from './constants.js';

/**
 * Validates if a string key is a valid AuthType enum value.
 * @param key - The key to validate
 * @returns The validated AuthType or undefined if invalid
 */
function validateAuthTypeKey(key: string): AuthType | undefined {
  if (Object.values(AuthType).includes(key as AuthType)) {
    return key as AuthType;
  }
  return undefined;
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'models' in (value as Record<string, unknown>) &&
    'authType' in (value as Record<string, unknown>)
  );
}

/**
 * Central registry for managing model configurations.
 * Expects provider-keyed format (providerId -> ProviderConfig).
 */
export class ModelRegistry {
  private modelsByAuthType: Map<AuthType, Map<string, ResolvedModelConfig>>;
  private modelsByProviderId: Map<string, Map<string, ResolvedModelConfig>>;
  private providerAuthTypes: Map<string, AuthType>;

  private getDefaultBaseUrl(authType: AuthType): string {
    switch (authType) {
      case AuthType.QWEN_OAUTH:
        return 'DYNAMIC_QWEN_OAUTH_BASE_URL';
      case AuthType.USE_OPENAI:
        return DEFAULT_OPENAI_BASE_URL;
      default:
        return '';
    }
  }

  constructor(modelProvidersConfig?: ModelProvidersConfig) {
    this.modelsByAuthType = new Map();
    this.modelsByProviderId = new Map();
    this.providerAuthTypes = new Map();

    this.registerBuiltinModels(AuthType.QWEN_OAUTH, QWEN_OAUTH_MODELS);

    if (modelProvidersConfig) {
      this.loadConfig(modelProvidersConfig);
    }
  }

  private loadConfig(config: ModelProvidersConfig): void {
    for (const [providerId, provider] of Object.entries(config)) {
      if (!isProviderConfig(provider)) continue;

      const authType = validateAuthTypeKey(provider.authType);
      if (!authType) {
        debugLogger.warn(
          `Invalid authType "${provider.authType}" in provider "${providerId}". Skipping.`,
        );
        continue;
      }
      if (authType === AuthType.QWEN_OAUTH) continue;

      this.providerAuthTypes.set(providerId, authType);

      const providerModelMap = new Map<string, ResolvedModelConfig>();
      for (const model of provider.models) {
        if (model.id === undefined || model.id === null) continue;

        const modelConfig: ProviderModelConfig = {
          id: model.id,
          name: model.name,
          description: model.description,
          envKey: provider.envKey,
          baseUrl: provider.baseUrl,
          generationConfig: model.generationConfig,
          capabilities: model.capabilities,
        };
        const resolved = this.resolveModelConfig(
          modelConfig,
          authType,
          providerId,
        );
        providerModelMap.set(model.id, resolved);

        if (!this.modelsByAuthType.has(authType)) {
          this.modelsByAuthType.set(authType, new Map());
        }
        const authTypeMap = this.modelsByAuthType.get(authType)!;
        if (!authTypeMap.has(model.id)) {
          authTypeMap.set(model.id, resolved);
        }
      }
      this.modelsByProviderId.set(providerId, providerModelMap);
    }
  }

  /**
   * Register built-in models for an authType (e.g., QWEN_OAUTH).
   * These models are not associated with any provider and serve as system defaults.
   */
  private registerBuiltinModels(
    authType: AuthType,
    models: ModelConfig[],
  ): void {
    const modelMap = new Map<string, ResolvedModelConfig>();

    for (const config of models) {
      if (modelMap.has(config.id)) {
        debugLogger.warn(
          `Duplicate model id "${config.id}" for authType "${authType}". Using the first registered config.`,
        );
        continue;
      }
      const resolved = this.resolveModelConfig(config, authType);
      modelMap.set(config.id, resolved);
    }

    this.modelsByAuthType.set(authType, modelMap);
  }

  getModelsForAuthType(authType: AuthType): AvailableModel[] {
    const toAvailableModel = (model: ResolvedModelConfig): AvailableModel => ({
      id: model.id,
      label: model.name,
      description: model.description,
      capabilities: model.capabilities,
      authType: model.authType,
      isVision: model.capabilities?.vision ?? false,
      contextWindowSize:
        model.generationConfig.contextWindowSize ?? tokenLimit(model.id),
      modalities:
        model.generationConfig.modalities ?? defaultModalities(model.id),
      baseUrl: model.baseUrl,
      envKey: model.envKey,
      providerId: model.providerId,
    });

    const result: AvailableModel[] = [];
    const seen = new Set<string>();

    // Collect from providers matching this authType (preserves all
    // models even when multiple providers share the same authType + modelId).
    for (const [pid, providerModels] of this.modelsByProviderId) {
      if (this.providerAuthTypes.get(pid) !== authType) continue;
      for (const model of providerModels.values()) {
        const key = `${pid}|${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(toAvailableModel(model));
        }
      }
    }

    // Collect built-in models (no providerId, e.g. QWEN_OAUTH) from authType map,
    // skipping any that were already covered by the provider scan above.
    const builtinModels = this.modelsByAuthType.get(authType);
    if (builtinModels) {
      for (const model of builtinModels.values()) {
        if (model.providerId) continue;
        const key = `_builtin|${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(toAvailableModel(model));
        }
      }
    }

    return result;
  }

  getModel(
    authType: AuthType,
    modelId: string,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    return models?.get(modelId);
  }

  /**
   * Get model by providerId and modelId (provider-aware lookup).
   */
  getModelByProviderId(
    providerId: string,
    modelId: string,
  ): ResolvedModelConfig | undefined {
    return this.modelsByProviderId.get(providerId)?.get(modelId);
  }

  /**
   * Get the authType for a given providerId.
   */
  getProviderAuthType(providerId: string): AuthType | undefined {
    return this.providerAuthTypes.get(providerId);
  }

  /**
   * Resolve a model using provider-aware fallback:
   * 1. Exact providerId + modelId
   * 2. authType + modelId (first match by providerId lexicographic order)
   * 3. undefined (caller should try runtime model / authType default)
   *
   * Returns the resolved model config and the effective authType.
   */
  resolveModelWithFallback(
    providerId: string | undefined,
    modelId: string,
    fallbackAuthType?: AuthType,
  ): { model: ResolvedModelConfig; authType: AuthType } | undefined {
    // Step 1: exact providerId + modelId
    if (providerId) {
      const model = this.getModelByProviderId(providerId, modelId);
      if (model) {
        const authType =
          this.providerAuthTypes.get(providerId) ?? model.authType;
        return { model, authType };
      }
    }

    // Step 2: fallbackAuthType + modelId with lexicographic tie-breaking
    const authType = fallbackAuthType;
    if (authType) {
      const candidates: Array<{
        providerId: string;
        model: ResolvedModelConfig;
      }> = [];

      for (const [pid, models] of this.modelsByProviderId) {
        if (this.providerAuthTypes.get(pid) !== authType) continue;
        const model = models.get(modelId);
        if (model) {
          candidates.push({ providerId: pid, model });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.providerId.localeCompare(b.providerId));
        return { model: candidates[0]!.model, authType };
      }

      // Also check authType-based map (built-in models without providerId)
      const builtinModel = this.modelsByAuthType.get(authType)?.get(modelId);
      if (builtinModel) {
        return { model: builtinModel, authType };
      }
    }

    return undefined;
  }

  hasModel(authType: AuthType, modelId: string): boolean {
    const models = this.modelsByAuthType.get(authType);
    return models?.has(modelId) ?? false;
  }

  getDefaultModelForAuthType(
    authType: AuthType,
  ): ResolvedModelConfig | undefined {
    if (authType === AuthType.QWEN_OAUTH) {
      return this.getModel(authType, DEFAULT_QWEN_MODEL);
    }
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return undefined;
    return Array.from(models.values())[0];
  }

  private resolveModelConfig(
    config: ProviderModelConfig,
    authType: AuthType,
    providerId?: string,
  ): ResolvedModelConfig {
    this.validateModelConfig(config, authType);

    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(authType),
      generationConfig: config.generationConfig ?? {},
      capabilities: config.capabilities || {},
      providerId,
    };
  }

  private validateModelConfig(
    config: ProviderModelConfig,
    authType: AuthType,
  ): void {
    if (!config.id) {
      throw new Error(
        `Model config in authType '${authType}' missing required field: id`,
      );
    }
  }

  /**
   * Reload models from updated configuration.
   */
  reloadModels(modelProvidersConfig?: ModelProvidersConfig): void {
    for (const authType of this.modelsByAuthType.keys()) {
      if (authType !== AuthType.QWEN_OAUTH) {
        this.modelsByAuthType.delete(authType);
      }
    }
    this.modelsByProviderId.clear();
    this.providerAuthTypes.clear();

    if (modelProvidersConfig) {
      this.loadConfig(modelProvidersConfig);
    }
  }
}
