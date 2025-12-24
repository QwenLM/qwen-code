/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import {
  type ModelConfig,
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelGenerationConfig,
  DEFAULT_GENERATION_CONFIG,
  DEFAULT_BASE_URLS,
} from './types.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';

/**
 * Hard-coded Qwen OAuth models that are always available.
 * These cannot be overridden by user configuration.
 */
export const QWEN_OAUTH_MODELS: ModelConfig[] = [
  {
    id: 'coder-model',
    name: 'Qwen Coder',
    description:
      'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)',
    capabilities: { vision: false },
    generationConfig: {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 8192,
      timeout: 60000,
      maxRetries: 3,
    },
  },
  {
    id: 'vision-model',
    name: 'Qwen Vision',
    description:
      'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)',
    capabilities: { vision: true },
    generationConfig: {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 8192,
      timeout: 60000,
      maxRetries: 3,
    },
  },
];

/**
 * Central registry for managing model configurations.
 * Models are organized by authType.
 */
export class ModelRegistry {
  private modelsByAuthType: Map<AuthType, Map<string, ResolvedModelConfig>>;
  // Reverse index for O(1) model lookups: modelId -> authTypes[]
  private modelIdToAuthTypes: Map<string, AuthType[]>;

  constructor(modelProvidersConfig?: ModelProvidersConfig) {
    this.modelsByAuthType = new Map();
    this.modelIdToAuthTypes = new Map();

    // Always register qwen-oauth models (hard-coded, cannot be overridden)
    this.registerAuthTypeModels(AuthType.QWEN_OAUTH, QWEN_OAUTH_MODELS);

    // Register user-configured models for other authTypes
    if (modelProvidersConfig) {
      for (const [authType, models] of Object.entries(modelProvidersConfig)) {
        // Skip qwen-oauth as it uses hard-coded models
        if (authType === AuthType.QWEN_OAUTH) {
          continue;
        }

        const authTypeEnum = authType as AuthType;
        this.registerAuthTypeModels(authTypeEnum, models);
      }
    }
  }

  /**
   * Register models for an authType
   */
  private registerAuthTypeModels(
    authType: AuthType,
    models: ModelConfig[],
  ): void {
    const modelMap = new Map<string, ResolvedModelConfig>();

    for (const config of models) {
      const resolved = this.resolveModelConfig(config, authType);
      modelMap.set(config.id, resolved);

      // Update reverse index
      const existingAuthTypes = this.modelIdToAuthTypes.get(config.id) || [];
      existingAuthTypes.push(authType);
      this.modelIdToAuthTypes.set(config.id, existingAuthTypes);
    }

    this.modelsByAuthType.set(authType, modelMap);
  }

  /**
   * Get all models for a specific authType.
   * This is used by /model command to show only relevant models.
   */
  getModelsForAuthType(authType: AuthType): AvailableModel[] {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return [];

    return Array.from(models.values()).map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      capabilities: model.capabilities,
      authType: model.authType,
      isVision: model.capabilities?.vision ?? false,
    }));
  }

  /**
   * Get all available authTypes that have models configured
   */
  getAvailableAuthTypes(): AuthType[] {
    return Array.from(this.modelsByAuthType.keys());
  }

  /**
   * Get model configuration by authType and modelId
   */
  getModel(
    authType: AuthType,
    modelId: string,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    return models?.get(modelId);
  }

  /**
   * Check if model exists for given authType
   */
  hasModel(authType: AuthType, modelId: string): boolean {
    const models = this.modelsByAuthType.get(authType);
    return models?.has(modelId) ?? false;
  }

  /**
   * Get first model for an authType (used as default)
   */
  getFirstModelForAuthType(
    authType: AuthType,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return undefined;
    return Array.from(models.values())[0];
  }

  /**
   * Get default model for an authType.
   * For qwen-oauth, returns the coder model.
   * For others, returns the first configured model.
   */
  getDefaultModelForAuthType(
    authType: AuthType,
  ): ResolvedModelConfig | undefined {
    if (authType === AuthType.QWEN_OAUTH) {
      return this.getModel(authType, DEFAULT_QWEN_MODEL);
    }
    return this.getFirstModelForAuthType(authType);
  }

  /**
   * Resolve model config by applying defaults
   */
  private resolveModelConfig(
    config: ModelConfig,
    authType: AuthType,
  ): ResolvedModelConfig {
    this.validateModelConfig(config, authType);

    const defaultBaseUrl = DEFAULT_BASE_URLS[authType] || '';

    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || defaultBaseUrl,
      generationConfig: this.mergeGenerationConfig(config.generationConfig),
      capabilities: config.capabilities || {},
    };
  }

  /**
   * Merge generation config with defaults
   */
  private mergeGenerationConfig(
    config?: ModelGenerationConfig,
  ): ModelGenerationConfig {
    if (!config) {
      return { ...DEFAULT_GENERATION_CONFIG };
    }

    return {
      ...DEFAULT_GENERATION_CONFIG,
      ...config,
    };
  }

  /**
   * Validate model configuration
   */
  private validateModelConfig(config: ModelConfig, authType: AuthType): void {
    if (!config.id) {
      throw new Error(
        `Model config in authType '${authType}' missing required field: id`,
      );
    }
  }

  /**
   * Check if the registry has any models for a given authType
   */
  hasAuthType(authType: AuthType): boolean {
    const models = this.modelsByAuthType.get(authType);
    return models !== undefined && models.size > 0;
  }

  /**
   * Get total number of models across all authTypes
   */
  getTotalModelCount(): number {
    let count = 0;
    for (const models of this.modelsByAuthType.values()) {
      count += models.size;
    }
    return count;
  }

  /**
   * Find all authTypes that have a model with the given modelId.
   * Uses reverse index for O(1) lookup.
   * Returns empty array if model doesn't exist.
   *
   * @param modelId - The model ID to search for
   * @param preferredAuthType - Optional authType to prioritize in results
   * @returns Array of authTypes that have this model (preferred authType first if found)
   */
  findAuthTypesForModel(
    modelId: string,
    preferredAuthType?: AuthType,
  ): AuthType[] {
    const authTypes = this.modelIdToAuthTypes.get(modelId) || [];

    // If no preferred authType or it's not in the list, return as-is
    if (!preferredAuthType || !authTypes.includes(preferredAuthType)) {
      return authTypes;
    }

    // Move preferred authType to front
    return [
      preferredAuthType,
      ...authTypes.filter((at) => at !== preferredAuthType),
    ];
  }
}
