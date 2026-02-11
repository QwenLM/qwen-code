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
import { tokenLimit } from '../core/tokenLimits.js';

import { ModelRegistry } from './modelRegistry.js';
import {
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelSwitchMetadata,
  type RuntimeModelSnapshot,
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

  /**
   * Runtime model snapshot storage.
   *
   * These snapshots store runtime-resolved model configurations that are NOT from
   * modelProviders registry (e.g., models with manually set credentials).
   *
   * Key: snapshotId (format: `$runtime|${authType}|${modelId}`)
   *   Uses `$runtime|` prefix since `$` and `|` are unlikely to appear in real model IDs.
   *   This prevents conflicts with model IDs containing `-` or `:` characters.
   * Value: RuntimeModelSnapshot containing the model's configuration
   *
   * Note: This is different from state snapshots used for rollback during model switching.
   * RuntimeModelSnapshot stores persistent model configurations, while state snapshots
   * are temporary and used only for error recovery.
   */
  private runtimeModelSnapshots: Map<string, RuntimeModelSnapshot> = new Map();

  /**
   * Currently active RuntimeModelSnapshot ID.
   *
   * When set, indicates that the current model is a runtime model (not from registry).
   * This ID is included in state snapshots for rollback purposes.
   */
  private activeRuntimeModelSnapshotId: string | undefined;

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
   * Create a snapshot of the current ModelsConfig state for rollback purposes.
   * Used before model switching operations to enable recovery on errors.
   *
   * Note: This is different from RuntimeModelSnapshot which stores runtime model configs.
   */
  private createStateSnapshotForRollback(): {
    currentAuthType: AuthType | undefined;
    generationConfig: Partial<ContentGeneratorConfig>;
    generationConfigSources: ContentGeneratorConfigSources;
    strictModelProviderSelection: boolean;
    requireCachedQwenCredentialsOnce: boolean;
    hasManualCredentials: boolean;
    activeRuntimeModelSnapshotId: string | undefined;
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
      activeRuntimeModelSnapshotId: this.activeRuntimeModelSnapshotId,
    };
  }

  /**
   * Restore ModelsConfig state from a previously created state snapshot.
   * Used for rollback when model switching operations fail.
   *
   * @param snapshot - The state snapshot to restore
   */
  private rollbackToStateSnapshot(
    snapshot: ReturnType<ModelsConfig['createStateSnapshotForRollback']>,
  ): void {
    this.currentAuthType = snapshot.currentAuthType;
    this._generationConfig = snapshot.generationConfig;
    this.generationConfigSources = snapshot.generationConfigSources;
    this.strictModelProviderSelection = snapshot.strictModelProviderSelection;
    this.requireCachedQwenCredentialsOnce =
      snapshot.requireCachedQwenCredentialsOnce;
    this.hasManualCredentials = snapshot.hasManualCredentials;
    this.activeRuntimeModelSnapshotId = snapshot.activeRuntimeModelSnapshotId;
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
   * Get all configured models across authTypes.
   *
   * Notes:
   * - By default, returns models across all authTypes.
   * - qwen-oauth models are always ordered first.
   * - Runtime model option (if active) is included before registry models of the same authType.
   */
  getAllConfiguredModels(authTypes?: AuthType[]): AvailableModel[] {
    const inputAuthTypes =
      authTypes && authTypes.length > 0 ? authTypes : Object.values(AuthType);

    // De-duplicate while preserving the original order.
    const seen = new Set<AuthType>();
    const uniqueAuthTypes: AuthType[] = [];
    for (const authType of inputAuthTypes) {
      if (!seen.has(authType)) {
        seen.add(authType);
        uniqueAuthTypes.push(authType);
      }
    }

    // Force qwen-oauth to the front (if requested / defaulted in).
    const orderedAuthTypes: AuthType[] = [];
    if (uniqueAuthTypes.includes(AuthType.QWEN_OAUTH)) {
      orderedAuthTypes.push(AuthType.QWEN_OAUTH);
    }
    for (const authType of uniqueAuthTypes) {
      if (authType !== AuthType.QWEN_OAUTH) {
        orderedAuthTypes.push(authType);
      }
    }

    // Get runtime model option
    const runtimeOption = this.getRuntimeModelOption();

    const allModels: AvailableModel[] = [];
    for (const authType of orderedAuthTypes) {
      // Add runtime option first if it matches this authType
      if (runtimeOption && runtimeOption.authType === authType) {
        allModels.push(runtimeOption);
      }
      // Add registry models
      allModels.push(...this.modelRegistry.getModelsForAuthType(authType));
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

      // Notify Config to update contentGeneratorConfig
      if (this.onModelChange) {
        await this.onModelChange(AuthType.QWEN_OAUTH, false);
      }
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
   * Switch model (and optionally authType).
   * Supports both registry-backed models and RuntimeModelSnapshots.
   *
   * For runtime models, the modelId can be:
   * - A RuntimeModelSnapshot ID (format: `$runtime|${authType}|${modelId}`)
   * - With explicit `$runtime|` prefix (format: `$runtime|${authType}|${modelId}`)
   *
   * When called from ACP integration, the modelId has already been parsed
   * by parseAcpModelOption, which strips any (${authType}) suffix.
   */
  async switchModel(
    authType: AuthType,
    modelId: string,
    options?: { requireCachedCredentials?: boolean },
  ): Promise<void> {
    // Check if this is a RuntimeModelSnapshot reference
    const runtimeModelSnapshotId = this.extractRuntimeModelSnapshotId(modelId);
    if (runtimeModelSnapshotId) {
      await this.switchToRuntimeModel(runtimeModelSnapshotId);
      return;
    }

    const rollbackSnapshot = this.createStateSnapshotForRollback();
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

      // Clear active runtime model snapshot since we're now using a registry model
      this.activeRuntimeModelSnapshotId = undefined;

      const requiresRefresh = isAuthTypeChange
        ? true
        : this.checkRequiresRefresh(
            rollbackSnapshot.generationConfig.model || '',
          );

      if (this.onModelChange) {
        await this.onModelChange(authType, requiresRefresh);
      }
    } catch (error) {
      // Rollback on error
      this.rollbackToStateSnapshot(rollbackSnapshot);
      throw error;
    }
  }

  /**
   * Prefix used to identify RuntimeModelSnapshot IDs.
   * Chosen to avoid conflicts with real model IDs which may contain `-` or `:`.
   */
  private static readonly RUNTIME_SNAPSHOT_PREFIX = '$runtime|';

  /**
   * Build a RuntimeModelSnapshot ID from authType and modelId.
   * The format is: `$runtime|${authType}|${modelId}`
   *
   * This is the canonical way to construct snapshot IDs, ensuring
   * consistency across creation and lookup.
   *
   * @param authType - The authentication type
   * @param modelId - The model ID
   * @returns The snapshot ID in format `$runtime|${authType}|${modelId}`
   */
  private buildRuntimeModelSnapshotId(
    authType: AuthType,
    modelId: string,
  ): string {
    return `${ModelsConfig.RUNTIME_SNAPSHOT_PREFIX}${authType}|${modelId}`;
  }

  /**
   * Extract RuntimeModelSnapshot ID from modelId if it's a runtime model reference.
   *
   * Supports the following formats:
   * - Direct snapshot ID: `$runtime|${authType}|${modelId}` → returns as-is if exists in Map
   * - Direct snapshot ID match: returns if exists in Map
   *
   * Note: When called from ACP integration via setModel, the modelId has already
   * been parsed by parseAcpModelOption which strips any (${authType}) suffix.
   * So we don't need to handle ACP format here - the ACP layer handles that.
   *
   * @param modelId - The model ID to parse
   * @returns The RuntimeModelSnapshot ID if found, undefined otherwise
   */
  private extractRuntimeModelSnapshotId(modelId: string): string | undefined {
    // Check if modelId starts with the runtime snapshot prefix
    if (modelId.startsWith(ModelsConfig.RUNTIME_SNAPSHOT_PREFIX)) {
      // Verify the snapshot exists
      if (this.runtimeModelSnapshots.has(modelId)) {
        return modelId;
      }
      // Even with prefix, if it doesn't exist, don't return it
      return undefined;
    }

    // Check if modelId itself is a valid snapshot ID (exists in Map)
    if (this.runtimeModelSnapshots.has(modelId)) {
      return modelId;
    }

    return undefined;
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
   * Also updates or creates a RuntimeModelSnapshot when credentials form a complete config
   * for a model not in the registry. This allows the runtime model to be reused later.
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

    // Sync with runtime model snapshot if we have a complete configuration
    this.syncRuntimeModelSnapshotWithCredentials();
  }

  /**
   * Sync RuntimeModelSnapshot with current credentials.
   *
   * Creates or updates a RuntimeModelSnapshot when current credentials form a complete
   * configuration for a model not in the registry. This enables:
   * - Reusing the runtime model configuration later
   * - Showing the runtime model as an available option in model lists
   *
   * Only creates snapshots for models NOT in the registry (to avoid duplication).
   */
  private syncRuntimeModelSnapshotWithCredentials(): void {
    const currentAuthType = this.currentAuthType;
    const { model, apiKey, baseUrl } = this._generationConfig;

    // Early return if missing required fields
    if (!model || !currentAuthType || !apiKey || !baseUrl) {
      return;
    }

    // Check if model exists in registry - if so, don't create RuntimeModelSnapshot
    if (this.modelRegistry.hasModel(currentAuthType, model)) {
      return;
    }

    // If we have an active snapshot, update it
    if (
      this.activeRuntimeModelSnapshotId &&
      this.runtimeModelSnapshots.has(this.activeRuntimeModelSnapshotId)
    ) {
      const snapshot = this.runtimeModelSnapshots.get(
        this.activeRuntimeModelSnapshotId,
      )!;

      // Update snapshot with current values (already verified to exist above)
      snapshot.apiKey = apiKey;
      snapshot.baseUrl = baseUrl;
      snapshot.modelId = model;

      // Update ID if model changed
      const newSnapshotId = this.buildRuntimeModelSnapshotId(
        snapshot.authType,
        snapshot.modelId,
      );
      if (newSnapshotId !== snapshot.id) {
        this.runtimeModelSnapshots.delete(snapshot.id);
        snapshot.id = newSnapshotId;
        this.runtimeModelSnapshots.set(newSnapshotId, snapshot);
        this.activeRuntimeModelSnapshotId = newSnapshotId;
      }

      snapshot.createdAt = Date.now();
    } else {
      // Create new snapshot
      this.detectAndCaptureRuntimeModel();
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

    // Generation config: apply all fields from MODEL_GENERATION_CONFIG_FIELDS
    const gc = model.generationConfig;
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._generationConfig as any)[field] = gc[field];
      this.generationConfigSources[field] = {
        kind: 'modelProviders',
        authType: model.authType,
        modelId: model.id,
        detail: `generationConfig.${field}`,
      };
    }

    // contextWindowSize fallback: auto-detect from model when not set by provider
    if (gc.contextWindowSize === undefined) {
      this._generationConfig.contextWindowSize = tokenLimit(model.id, 'input');
      this.generationConfigSources['contextWindowSize'] = {
        kind: 'computed',
        detail: 'auto-detected from model',
      };
    }
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
        // Clear active runtime model snapshot since we're now using a registry model
        this.activeRuntimeModelSnapshotId = undefined;
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
      // Clear active runtime model snapshot since we're now using a registry model
      this.activeRuntimeModelSnapshotId = undefined;
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

  /**
   * Detect and capture RuntimeModelSnapshot during initialization.
   *
   * Checks if the current configuration represents a runtime model (not from
   * modelProviders registry) and captures it as a RuntimeModelSnapshot.
   *
   * This enables runtime models to persist across sessions and appear in model lists.
   *
   * @returns Created snapshot ID, or undefined if current config is a registry model
   */
  detectAndCaptureRuntimeModel(): string | undefined {
    const {
      model: currentModel,
      apiKey,
      baseUrl,
      apiKeyEnvKey,
      ...generationConfig
    } = this._generationConfig;
    const currentAuthType = this.currentAuthType;

    if (!currentModel || !currentAuthType) {
      return undefined;
    }

    // Check if model exists in registry - if so, it's not a runtime model
    if (this.modelRegistry.hasModel(currentAuthType, currentModel)) {
      // Current is a registry model, clear any previous RuntimeModelSnapshot for this authType
      this.clearRuntimeModelSnapshotForAuthType(currentAuthType);
      return undefined;
    }

    // Check if we have valid credentials (apiKey + baseUrl)
    const hasValidCredentials =
      this._generationConfig.apiKey && this._generationConfig.baseUrl;

    if (!hasValidCredentials) {
      return undefined;
    }

    // Create or update RuntimeModelSnapshot
    const snapshotId = this.buildRuntimeModelSnapshotId(
      currentAuthType,
      currentModel,
    );
    const snapshot: RuntimeModelSnapshot = {
      id: snapshotId,
      authType: currentAuthType,
      modelId: currentModel,
      apiKey,
      baseUrl,
      apiKeyEnvKey,
      generationConfig,
      sources: { ...this.generationConfigSources },
      createdAt: Date.now(),
    };

    this.runtimeModelSnapshots.set(snapshotId, snapshot);
    this.activeRuntimeModelSnapshotId = snapshotId;

    // Enforce per-authType limit
    this.cleanupOldRuntimeModelSnapshots();

    return snapshotId;
  }

  /**
   * Get the currently active RuntimeModelSnapshot.
   *
   * @returns The active RuntimeModelSnapshot, or undefined if no runtime model is active
   */
  getActiveRuntimeModelSnapshot(): RuntimeModelSnapshot | undefined {
    if (!this.activeRuntimeModelSnapshotId) {
      return undefined;
    }
    return this.runtimeModelSnapshots.get(this.activeRuntimeModelSnapshotId);
  }

  /**
   * Get the ID of the currently active RuntimeModelSnapshot.
   *
   * @returns The active snapshot ID, or undefined if no runtime model is active
   */
  getActiveRuntimeModelSnapshotId(): string | undefined {
    return this.activeRuntimeModelSnapshotId;
  }

  /**
   * Switch to a RuntimeModelSnapshot.
   *
   * Applies the configuration from a previously captured RuntimeModelSnapshot.
   * Uses state rollback pattern: creates a state snapshot before switching and
   * restores it on error.
   *
   * @param snapshotId - The ID of the RuntimeModelSnapshot to switch to
   */
  async switchToRuntimeModel(snapshotId: string): Promise<void> {
    const runtimeModelSnapshot = this.runtimeModelSnapshots.get(snapshotId);
    if (!runtimeModelSnapshot) {
      throw new Error(`Runtime model snapshot '${snapshotId}' not found`);
    }

    const rollbackSnapshot = this.createStateSnapshotForRollback();

    try {
      const isAuthTypeChange =
        runtimeModelSnapshot.authType !== this.currentAuthType;
      this.currentAuthType = runtimeModelSnapshot.authType;
      this.activeRuntimeModelSnapshotId = snapshotId;

      // Apply runtime configuration
      this.strictModelProviderSelection = false;
      this.hasManualCredentials = true; // Mark as manual to prevent provider override

      this._generationConfig.model = runtimeModelSnapshot.modelId;
      this.generationConfigSources['model'] = {
        kind: 'programmatic',
        detail: 'runtimeModelSwitch',
      };

      if (runtimeModelSnapshot.apiKey) {
        this._generationConfig.apiKey = runtimeModelSnapshot.apiKey;
        this.generationConfigSources['apiKey'] = runtimeModelSnapshot.sources[
          'apiKey'
        ] || {
          kind: 'programmatic',
          detail: 'runtimeModelSwitch',
        };
      }

      if (runtimeModelSnapshot.baseUrl) {
        this._generationConfig.baseUrl = runtimeModelSnapshot.baseUrl;
        this.generationConfigSources['baseUrl'] = runtimeModelSnapshot.sources[
          'baseUrl'
        ] || {
          kind: 'programmatic',
          detail: 'runtimeModelSwitch',
        };
      }

      if (runtimeModelSnapshot.apiKeyEnvKey) {
        this._generationConfig.apiKeyEnvKey = runtimeModelSnapshot.apiKeyEnvKey;
      }

      // Apply generation config
      if (runtimeModelSnapshot.generationConfig) {
        Object.assign(
          this._generationConfig,
          runtimeModelSnapshot.generationConfig,
        );
      }

      const requiresRefresh = isAuthTypeChange;

      if (this.onModelChange) {
        await this.onModelChange(
          runtimeModelSnapshot.authType,
          requiresRefresh,
        );
      }
    } catch (error) {
      this.rollbackToStateSnapshot(rollbackSnapshot);
      throw error;
    }
  }

  /**
   * Get the active RuntimeModelSnapshot as an AvailableModel option.
   *
   * Converts the active RuntimeModelSnapshot to an AvailableModel format for display
   * in model lists. Returns undefined if no runtime model is active.
   *
   * @returns The runtime model as an AvailableModel option, or undefined
   */
  private getRuntimeModelOption(): AvailableModel | undefined {
    const snapshot = this.getActiveRuntimeModelSnapshot();
    if (!snapshot) {
      return undefined;
    }

    return {
      id: snapshot.modelId,
      label: snapshot.modelId,
      authType: snapshot.authType,
      /**
       * `isVision` is for automatic switching of qwen-oauth vision model.
       * Runtime models are basically specified via CLI arguments, env variables,
       * or settings for other auth types.
       */
      isVision: false,
      contextWindowSize: snapshot.generationConfig?.contextWindowSize,
      isRuntimeModel: true,
      runtimeSnapshotId: snapshot.id,
    };
  }

  /**
   * Clear all RuntimeModelSnapshots for a specific authType.
   *
   * Removes all RuntimeModelSnapshots associated with the given authType.
   * Called when switching to a registry model to avoid stale RuntimeModelSnapshots.
   *
   * @param authType - The authType whose snapshots should be cleared
   */
  private clearRuntimeModelSnapshotForAuthType(authType: AuthType): void {
    for (const [id, snapshot] of this.runtimeModelSnapshots.entries()) {
      if (snapshot.authType === authType) {
        this.runtimeModelSnapshots.delete(id);
        if (this.activeRuntimeModelSnapshotId === id) {
          this.activeRuntimeModelSnapshotId = undefined;
        }
      }
    }
  }

  /**
   * Cleanup old RuntimeModelSnapshots to enforce per-authType limit.
   *
   * Keeps only the latest RuntimeModelSnapshot for each authType.
   * Older snapshots are removed to prevent unbounded growth.
   */
  private cleanupOldRuntimeModelSnapshots(): void {
    const snapshotsByAuthType = new Map<AuthType, RuntimeModelSnapshot>();

    for (const snapshot of this.runtimeModelSnapshots.values()) {
      const existing = snapshotsByAuthType.get(snapshot.authType);
      if (!existing || snapshot.createdAt > existing.createdAt) {
        snapshotsByAuthType.set(snapshot.authType, snapshot);
      }
    }

    this.runtimeModelSnapshots.clear();
    for (const snapshot of snapshotsByAuthType.values()) {
      this.runtimeModelSnapshots.set(snapshot.id, snapshot);
    }

    // Update active snapshot ID if it was removed
    if (
      this.activeRuntimeModelSnapshotId &&
      !this.runtimeModelSnapshots.has(this.activeRuntimeModelSnapshotId)
    ) {
      this.activeRuntimeModelSnapshotId = undefined;
    }
  }

  /**
   * Reload model providers configuration at runtime.
   * This enables hot-reloading of modelProviders settings without restarting the CLI.
   *
   * @param modelProvidersConfig - The updated model providers configuration
   */
  reloadModelProvidersConfig(
    modelProvidersConfig?: ModelProvidersConfig,
  ): void {
    this.modelRegistry.reloadModels(modelProvidersConfig);
  }
}
