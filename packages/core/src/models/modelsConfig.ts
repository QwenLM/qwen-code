/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

import { AuthType } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { ContentGeneratorConfigSources } from '../core/contentGenerator.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';

import { ModelRegistry } from './modelRegistry.js';
import {
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelSwitchMetadata,
} from './types.js';
import {
  MODEL_GENERATION_CONFIG_FIELDS,
  CREDENTIAL_FIELDS,
  PROVIDER_SOURCED_FIELDS,
} from './constants.js';

export {
  MODEL_GENERATION_CONFIG_FIELDS,
  CREDENTIAL_FIELDS,
  PROVIDER_SOURCED_FIELDS,
};

/**
 * Callback for when the model changes.
 * Used by Config to refresh auth/ContentGenerator when needed.
 */
export type OnModelChangeCallback = (
  authType: AuthType,
  requiresRefresh: boolean,
) => Promise<void>;

/**
 * Options for creating ModelsConfig
 */
export interface ModelsConfigOptions {
  /** Initial authType from settings */
  initialAuthType?: AuthType;
  /** Model providers configuration */
  modelProvidersConfig?: ModelProvidersConfig;
  /** Generation config from CLI/settings */
  generationConfig?: Partial<ContentGeneratorConfig>;
  /** Source tracking for generation config */
  generationConfigSources?: ContentGeneratorConfigSources;
  /** Callback when model changes require refresh */
  onModelChange?: OnModelChangeCallback;
}

/**
 * ModelsConfig manages all model selection logic and state.
 *
 * This class encapsulates:
 * - ModelRegistry for model configuration storage
 * - Current authType and modelId selection
 * - Generation config management
 * - Model switching logic
 *
 * Config uses this as a thin entry point for all model-related operations.
 */
export class ModelsConfig {
  private readonly modelRegistry: ModelRegistry;

  // Current selection state
  private currentAuthType: AuthType | undefined;

  // Generation config state
  private _generationConfig: Partial<ContentGeneratorConfig>;
  private generationConfigSources: ContentGeneratorConfigSources;

  // Flag for strict model provider selection
  private strictModelProviderSelection: boolean = false;

  // One-shot flag for qwen-oauth credential caching
  private requireCachedQwenCredentialsOnce: boolean = false;

  // One-shot flag indicating credentials were manually set via updateCredentials()
  // When true, syncAfterAuthRefresh should NOT override these credentials with
  // modelProviders defaults (even if the model ID matches a registry entry).
  //
  // This must be persistent across auth refreshes, because refreshAuth() can be
  // triggered multiple times after a credential prompt flow. We only clear this
  // flag when we explicitly apply modelProvider defaults (i.e. when the user
  // switches to a registry model via switchModel).
  private hasManualCredentials: boolean = false;

  // Callback for notifying Config of model changes
  private onModelChange?: OnModelChangeCallback;

  // Flag indicating whether authType was explicitly provided (not defaulted)
  private readonly authTypeWasExplicitlyProvided: boolean;

  private static deepClone<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => ModelsConfig.deepClone(v)) as T;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = ModelsConfig.deepClone(
        (value as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }

  private snapshotState(): {
    currentAuthType: AuthType | undefined;
    generationConfig: Partial<ContentGeneratorConfig>;
    generationConfigSources: ContentGeneratorConfigSources;
    strictModelProviderSelection: boolean;
    requireCachedQwenCredentialsOnce: boolean;
    hasManualCredentials: boolean;
  } {
    return {
      currentAuthType: this.currentAuthType,
      generationConfig: ModelsConfig.deepClone(this._generationConfig),
      generationConfigSources: ModelsConfig.deepClone(
        this.generationConfigSources,
      ),
      strictModelProviderSelection: this.strictModelProviderSelection,
      requireCachedQwenCredentialsOnce: this.requireCachedQwenCredentialsOnce,
      hasManualCredentials: this.hasManualCredentials,
    };
  }

  private restoreState(
    snapshot: ReturnType<ModelsConfig['snapshotState']>,
  ): void {
    this.currentAuthType = snapshot.currentAuthType;
    this._generationConfig = snapshot.generationConfig;
    this.generationConfigSources = snapshot.generationConfigSources;
    this.strictModelProviderSelection = snapshot.strictModelProviderSelection;
    this.requireCachedQwenCredentialsOnce =
      snapshot.requireCachedQwenCredentialsOnce;
    this.hasManualCredentials = snapshot.hasManualCredentials;
  }

  constructor(options: ModelsConfigOptions = {}) {
    this.modelRegistry = new ModelRegistry(options.modelProvidersConfig);
    this.onModelChange = options.onModelChange;

    // Initialize generation config
    // Note: generationConfig.model should already be fully resolved by ModelConfigResolver
    // before ModelsConfig is instantiated, so we use it as the single source of truth
    this._generationConfig = {
      ...(options.generationConfig || {}),
    };
    this.generationConfigSources = options.generationConfigSources || {};

    // Track if authType was explicitly provided
    this.authTypeWasExplicitlyProvided = options.initialAuthType !== undefined;

    // Initialize selection state
    this.currentAuthType = options.initialAuthType;
  }

  /**
   * Get current model ID
   */
  getModel(): string {
    return this._generationConfig.model || DEFAULT_QWEN_MODEL;
  }

  /**
   * Get current authType
   */
  getCurrentAuthType(): AuthType | undefined {
    return this.currentAuthType;
  }

  /**
   * Check if authType was explicitly provided (via CLI or settings).
   * If false, no authType was provided yet (fresh user).
   */
  wasAuthTypeExplicitlyProvided(): boolean {
    return this.authTypeWasExplicitlyProvided;
  }

  /**
   * Get available models for current authType
   */
  getAvailableModels(): AvailableModel[] {
    return this.currentAuthType
      ? this.modelRegistry.getModelsForAuthType(this.currentAuthType)
      : [];
  }

  /**
   * Get available models for a specific authType
   */
  getAvailableModelsForAuthType(authType: AuthType): AvailableModel[] {
    return this.modelRegistry.getModelsForAuthType(authType);
  }

  /**
   * Get all available models across all authTypes
   */
  getAllAvailableModels(): AvailableModel[] {
    const allModels: AvailableModel[] = [];
    for (const authType of Object.values(AuthType)) {
      const models = this.modelRegistry.getModelsForAuthType(authType);
      allModels.push(...models);
    }
    return allModels;
  }

  /**
   * Check if a model exists for the given authType
   */
  hasModel(authType: AuthType, modelId: string): boolean {
    return this.modelRegistry.hasModel(authType, modelId);
  }

  /**
   * Set model programmatically (e.g., VLM auto-switch, fallback).
   * Supports both registry models and raw model IDs.
   */
  async setModel(
    newModel: string,
    metadata?: ModelSwitchMetadata,
  ): Promise<void> {
    // Special case: qwen-oauth VLM auto-switch - hot update in place
    if (
      this.currentAuthType === AuthType.QWEN_OAUTH &&
      (newModel === DEFAULT_QWEN_MODEL || newModel === 'vision-model')
    ) {
      this.strictModelProviderSelection = false;
      this._generationConfig.model = newModel;
      this.generationConfigSources['model'] = {
        kind: 'programmatic',
        detail: metadata?.reason || 'setModel',
      };
      return;
    }

    // If model exists in registry, use full switch logic
    if (
      this.currentAuthType &&
      this.modelRegistry.hasModel(this.currentAuthType, newModel)
    ) {
      await this.switchModel(this.currentAuthType, newModel);
      return;
    }

    // Raw model override: update generation config in-place
    this.strictModelProviderSelection = false;
    this._generationConfig.model = newModel;
    this.generationConfigSources['model'] = {
      kind: 'programmatic',
      detail: metadata?.reason || 'setModel',
    };
  }

  /**
   * Switch model (and optionally authType) via registry-backed selection.
   * This is a superset of the previous split APIs for model-only vs authType+model switching.
   */
  async switchModel(
    authType: AuthType,
    modelId: string,
    options?: { requireCachedCredentials?: boolean },
    _metadata?: ModelSwitchMetadata,
  ): Promise<void> {
    const snapshot = this.snapshotState();
    if (authType === AuthType.QWEN_OAUTH && options?.requireCachedCredentials) {
      this.requireCachedQwenCredentialsOnce = true;
    }

    try {
      const isAuthTypeChange = authType !== this.currentAuthType;
      this.currentAuthType = authType;

      const model = this.modelRegistry.getModel(authType, modelId);
      if (!model) {
        throw new Error(
          `Model '${modelId}' not found for authType '${authType}'`,
        );
      }

      // Apply model defaults
      this.applyResolvedModelDefaults(model);

      const requiresRefresh = isAuthTypeChange
        ? true
        : this.checkRequiresRefresh(snapshot.generationConfig.model || '');

      if (this.onModelChange) {
        await this.onModelChange(authType, requiresRefresh);
      }
    } catch (error) {
      // Rollback on error
      this.restoreState(snapshot);
      throw error;
    }
  }

  /**
   * Get generation config for ContentGenerator creation
   */
  getGenerationConfig(): Partial<ContentGeneratorConfig> {
    return this._generationConfig;
  }

  /**
   * Get generation config sources for debugging/UI
   */
  getGenerationConfigSources(): ContentGeneratorConfigSources {
    return this.generationConfigSources;
  }

  /**
   * Merge settings generation config, preserving existing values.
   * Used when provider-sourced config is cleared but settings should still apply.
   */
  mergeSettingsGenerationConfig(
    settingsGenerationConfig?: Partial<ContentGeneratorConfig>,
  ): void {
    if (!settingsGenerationConfig) {
      return;
    }

    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      if (
        !(field in this._generationConfig) &&
        field in settingsGenerationConfig
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._generationConfig as any)[field] =
          settingsGenerationConfig[field];
        this.generationConfigSources[field] = {
          kind: 'settings',
          detail: `model.generationConfig.${field}`,
        };
      }
    }
  }

  /**
   * Update credentials in generation config.
   * Sets a flag to prevent syncAfterAuthRefresh from overriding these credentials.
   *
   * When credentials are manually set, we clear all provider-sourced configuration
   * to maintain provider atomicity (either fully applied or not at all).
   * Other layers (CLI, env, settings, defaults) will participate in resolve.
   *
   * @param settingsGenerationConfig Optional generation config from settings.json
   *                                  to merge after clearing provider-sourced config.
   *                                  This ensures settings.model.generationConfig fields
   *                                  (e.g., samplingParams, timeout) are preserved.
   */
  updateCredentials(
    credentials: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    },
    settingsGenerationConfig?: Partial<ContentGeneratorConfig>,
  ): void {
    /**
     * If any fields are updated here, we treat the resulting config as manually overridden
     * and avoid applying modelProvider defaults during the next auth refresh.
     *
     * Clear all provider-sourced configuration to maintain provider atomicity.
     * This ensures that when user manually sets credentials, the provider config
     * is either fully applied (via switchModel) or not at all.
     */
    if (credentials.apiKey || credentials.baseUrl || credentials.model) {
      this.hasManualCredentials = true;
      this.clearProviderSourcedConfig();
    }

    if (credentials.apiKey) {
      this._generationConfig.apiKey = credentials.apiKey;
      this.generationConfigSources['apiKey'] = {
        kind: 'programmatic',
        detail: 'updateCredentials',
      };
    }
    if (credentials.baseUrl) {
      this._generationConfig.baseUrl = credentials.baseUrl;
      this.generationConfigSources['baseUrl'] = {
        kind: 'programmatic',
        detail: 'updateCredentials',
      };
    }
    if (credentials.model) {
      this._generationConfig.model = credentials.model;
      this.generationConfigSources['model'] = {
        kind: 'programmatic',
        detail: 'updateCredentials',
      };
    }
    // When credentials are manually set, disable strict model provider selection
    // so validation doesn't require envKey-based credentials
    this.strictModelProviderSelection = false;
    // Clear apiKeyEnvKey to prevent validation from requiring environment variable
    this._generationConfig.apiKeyEnvKey = undefined;

    // After clearing provider-sourced config, merge settings.model.generationConfig
    // to ensure fields like samplingParams, timeout, etc. are preserved.
    // This follows the resolution strategy where settings.model.generationConfig
    // has lower priority than programmatic overrides but should still be applied.
    if (settingsGenerationConfig) {
      this.mergeSettingsGenerationConfig(settingsGenerationConfig);
    }
  }

  /**
   * Clear configuration fields that were sourced from modelProviders.
   * This ensures provider config atomicity when user manually sets credentials.
   * Other layers (CLI, env, settings, defaults) will participate in resolve.
   */
  private clearProviderSourcedConfig(): void {
    for (const field of PROVIDER_SOURCED_FIELDS) {
      const source = this.generationConfigSources[field];
      if (source?.kind === 'modelProviders') {
        // Clear the value - let other layers resolve it
        delete (this._generationConfig as Record<string, unknown>)[field];
        delete this.generationConfigSources[field];
      }
    }
  }

  /**
   * Get whether strict model provider selection is enabled
   */
  isStrictModelProviderSelection(): boolean {
    return this.strictModelProviderSelection;
  }

  /**
   * Reset strict model provider selection flag
   */
  resetStrictModelProviderSelection(): void {
    this.strictModelProviderSelection = false;
  }

  /**
   * Check and consume the one-shot cached credentials flag
   */
  consumeRequireCachedCredentialsFlag(): boolean {
    const value = this.requireCachedQwenCredentialsOnce;
    this.requireCachedQwenCredentialsOnce = false;
    return value;
  }

  /**
   * Apply resolved model config to generation config
   */
  private applyResolvedModelDefaults(model: ResolvedModelConfig): void {
    this.strictModelProviderSelection = true;
    // We're explicitly applying modelProvider defaults now, so manual overrides
    // should no longer block syncAfterAuthRefresh from applying provider defaults.
    this.hasManualCredentials = false;

    this._generationConfig.model = model.id;
    this.generationConfigSources['model'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'model.id',
    };

    // Clear credentials to avoid reusing previous model's API key

    // For Qwen OAuth, apiKey must always be a placeholder. It will be dynamically
    // replaced when building requests. Do not preserve any previous key or read
    // from envKey.
    //
    // (OpenAI client instantiation requires an apiKey even though it will be
    // replaced later.)
    if (this.currentAuthType === AuthType.QWEN_OAUTH) {
      this._generationConfig.apiKey = 'QWEN_OAUTH_DYNAMIC_TOKEN';
      this.generationConfigSources['apiKey'] = {
        kind: 'computed',
        detail: 'Qwen OAuth placeholder token',
      };
      this._generationConfig.apiKeyEnvKey = undefined;
      delete this.generationConfigSources['apiKeyEnvKey'];
    } else {
      this._generationConfig.apiKey = undefined;
      this._generationConfig.apiKeyEnvKey = undefined;
    }

    // Read API key from environment variable if envKey is specified
    if (model.envKey !== undefined) {
      const apiKey = process.env[model.envKey];
      if (apiKey) {
        this._generationConfig.apiKey = apiKey;
        this.generationConfigSources['apiKey'] = {
          kind: 'env',
          envKey: model.envKey,
          via: {
            kind: 'modelProviders',
            authType: model.authType,
            modelId: model.id,
            detail: 'envKey',
          },
        };
      }
      this._generationConfig.apiKeyEnvKey = model.envKey;
      this.generationConfigSources['apiKeyEnvKey'] = {
        kind: 'modelProviders',
        authType: model.authType,
        modelId: model.id,
        detail: 'envKey',
      };
    }

    // Base URL
    this._generationConfig.baseUrl = model.baseUrl;
    this.generationConfigSources['baseUrl'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'baseUrl',
    };

    // Generation config
    const gc = model.generationConfig;
    this._generationConfig.samplingParams = { ...(gc.samplingParams || {}) };
    this.generationConfigSources['samplingParams'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.samplingParams',
    };

    this._generationConfig.timeout = gc.timeout;
    this.generationConfigSources['timeout'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.timeout',
    };

    this._generationConfig.maxRetries = gc.maxRetries;
    this.generationConfigSources['maxRetries'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.maxRetries',
    };

    this._generationConfig.disableCacheControl = gc.disableCacheControl;
    this.generationConfigSources['disableCacheControl'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.disableCacheControl',
    };

    this._generationConfig.schemaCompliance = gc.schemaCompliance;
    this.generationConfigSources['schemaCompliance'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.schemaCompliance',
    };

    this._generationConfig.reasoning = gc.reasoning;
    this.generationConfigSources['reasoning'] = {
      kind: 'modelProviders',
      authType: model.authType,
      modelId: model.id,
      detail: 'generationConfig.reasoning',
    };
  }

  /**
   * Check if model switch requires ContentGenerator refresh.
   *
   * Note: This method is ONLY called by switchModel() for same-authType model switches.
   * Cross-authType switches use switchModel(authType, modelId), which always requires full refresh.
   *
   * When this method is called:
   * - this.currentAuthType is already the target authType
   * - We're checking if switching between two models within the SAME authType needs refresh
   *
   * Examples:
   * - Qwen OAuth: coder-model -> vision-model (same authType, hot-update safe)
   * - OpenAI: model-a -> model-b with same envKey (same authType, hot-update safe)
   * - OpenAI: gpt-4 -> deepseek-chat with different envKey (same authType, needs refresh)
   *
   * Cross-authType scenarios:
   * - OpenAI -> Qwen OAuth: handled by switchModel(authType, modelId), always refreshes
   * - Qwen OAuth -> OpenAI: handled by switchModel(authType, modelId), always refreshes
   */
  private checkRequiresRefresh(previousModelId: string): boolean {
    // Defensive: this method is only called after switchModel() sets currentAuthType,
    // but keep type safety for any future callsites.
    const authType = this.currentAuthType;
    if (!authType) {
      return true;
    }

    // For Qwen OAuth, model switches within the same authType can always be hot-updated
    // (coder-model <-> vision-model don't require ContentGenerator recreation)
    if (authType === AuthType.QWEN_OAUTH) {
      return false;
    }

    // Get previous and current model configs
    const previousModel = this.modelRegistry.getModel(
      authType,
      previousModelId,
    );
    const currentModel = this.modelRegistry.getModel(
      authType,
      this._generationConfig.model || '',
    );

    // If either model is not in registry, require refresh to be safe
    if (!previousModel || !currentModel) {
      return true;
    }

    // Check if critical fields changed that require ContentGenerator recreation
    const criticalFieldsChanged =
      previousModel.envKey !== currentModel.envKey ||
      previousModel.baseUrl !== currentModel.baseUrl;

    if (criticalFieldsChanged) {
      return true;
    }

    // For other auth types with strict model provider selection,
    // if no critical fields changed, we can still hot-update
    // (e.g., switching between two OpenAI models with same envKey and baseUrl)
    return false;
  }

  /**
   * Sync state after auth refresh with fallback strategy:
   * 1. If modelId can be found in modelRegistry, use the config from modelRegistry.
   * 2. Otherwise, if existing credentials exist in resolved generationConfig from other sources
   *    (not modelProviders), preserve them and update authType/modelId only.
   * 3. Otherwise, fall back to default model for the authType.
   * 4. If no default is available, leave the generationConfig incomplete and let
   *    resolveContentGeneratorConfigWithSources throw exceptions as expected.
   */
  syncAfterAuthRefresh(authType: AuthType, modelId?: string): void {
    this.strictModelProviderSelection = false;
    const previousAuthType = this.currentAuthType;
    this.currentAuthType = authType;

    // Step 1: If modelId exists in registry, always use config from modelRegistry
    // Manual credentials won't have a modelId that matches a provider model (handleAuthSelect prevents it),
    // so if modelId exists in registry, we should always use provider config.
    // This handles provider switching even within the same authType.
    if (modelId && this.modelRegistry.hasModel(authType, modelId)) {
      const resolved = this.modelRegistry.getModel(authType, modelId);
      if (resolved) {
        this.applyResolvedModelDefaults(resolved);
        this.strictModelProviderSelection = true;
        return;
      }
    }

    // Step 2: Check if there are existing credentials from other sources (not modelProviders)
    const apiKeySource = this.generationConfigSources['apiKey'];
    const baseUrlSource = this.generationConfigSources['baseUrl'];
    const hasExistingCredentials =
      (this._generationConfig.apiKey &&
        apiKeySource?.kind !== 'modelProviders') ||
      (this._generationConfig.baseUrl &&
        baseUrlSource?.kind !== 'modelProviders');

    // Only preserve credentials if:
    // 1. AuthType hasn't changed (credentials are authType-specific), AND
    // 2. The modelId doesn't exist in the registry (if it did, we would have used provider config in Step 1), AND
    // 3. Either:
    //    a. We have manual credentials (set via updateCredentials), OR
    //    b. We have existing credentials
    // Note: Even if authType hasn't changed, switching to a different provider model (that exists in registry)
    // will use provider config (Step 1), not preserve old credentials. This ensures credentials change when
    // switching providers, independent of authType changes.
    const isAuthTypeChange = previousAuthType !== authType;
    const shouldPreserveCredentials =
      !isAuthTypeChange &&
      (modelId === undefined ||
        !this.modelRegistry.hasModel(authType, modelId)) &&
      (this.hasManualCredentials || hasExistingCredentials);

    if (shouldPreserveCredentials) {
      // Preserve existing credentials, just update authType and modelId if provided
      if (modelId) {
        this._generationConfig.model = modelId;
        if (!this.generationConfigSources['model']) {
          this.generationConfigSources['model'] = {
            kind: 'programmatic',
            detail: 'auth refresh (preserved credentials)',
          };
        }
      }
      return;
    }

    // Step 3: Fall back to default model for the authType
    const defaultModel =
      this.modelRegistry.getDefaultModelForAuthType(authType);
    if (defaultModel) {
      this.applyResolvedModelDefaults(defaultModel);
      return;
    }

    // Step 4: No default available - leave generationConfig incomplete
    // resolveContentGeneratorConfigWithSources will throw exceptions as expected
    if (modelId) {
      this._generationConfig.model = modelId;
      if (!this.generationConfigSources['model']) {
        this.generationConfigSources['model'] = {
          kind: 'programmatic',
          detail: 'auth refresh (no default model)',
        };
      }
    }
  }

  /**
   * Update callback for model changes
   */
  setOnModelChange(callback: OnModelChangeCallback): void {
    this.onModelChange = callback;
  }
}
