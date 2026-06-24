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
  type ModelProvidersConfig,
  type ProviderProtocolConfig,
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
  // Check if the key is a valid AuthType enum value
  if (Object.values(AuthType).includes(key as AuthType)) {
    return key as AuthType;
  }

  // Invalid key
  return undefined;
}

/**
 * Resolve the SDK protocol (an {@link AuthType}) that should route a
 * `modelProviders` provider id.
 *
 * Precedence:
 *  1. An explicit {@link ProviderProtocolConfig} entry for the provider id.
 *  2. The provider id itself when it is already a built-in protocol
 *     (e.g. `openai`, `gemini`) — preserves the pre-existing behavior.
 *
 * Returns `undefined` for an unknown provider id with no mapping, or an explicit
 * mapping whose value is not a known protocol, so the caller skips it (keeping
 * the typo guard for hand-edited settings). Pure: callers decide how loudly to
 * report a skip. Additive — configs without `providerProtocol` behave as before.
 */
export function resolveProviderProtocol(
  providerId: string,
  providerProtocol?: ProviderProtocolConfig,
): AuthType | undefined {
  const explicit = providerProtocol?.[providerId];
  if (explicit !== undefined) {
    return validateAuthTypeKey(explicit);
  }
  return validateAuthTypeKey(providerId);
}

function shouldUseCanonicalModalities(modelId: string): boolean {
  return /^minimax-m3/i.test(modelId.trim().toLowerCase());
}

/**
 * Build a composite registry key from model id and optional baseUrl.
 * Two models with the same id but different baseUrls are distinct entries.
 * When baseUrl is omitted/empty the key is just the id (backward compatible).
 */
export function modelRegistryKey(id: string, baseUrl?: string): string {
  return baseUrl ? `${id}\0${baseUrl}` : id;
}

/**
 * Central registry for managing model configurations.
 * Models are organized by authType.
 */
export class ModelRegistry {
  private modelsByAuthType: Map<AuthType, Map<string, ResolvedModelConfig>>;

  /** providerId -> SDK protocol mapping; persists across reloads. */
  private providerProtocolConfig: ProviderProtocolConfig;

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

  constructor(
    modelProvidersConfig?: ModelProvidersConfig,
    providerProtocolConfig?: ProviderProtocolConfig,
  ) {
    this.modelsByAuthType = new Map();
    this.providerProtocolConfig = providerProtocolConfig ?? {};

    // Always register qwen-oauth models (hard-coded, cannot be overridden)
    this.registerAuthTypeModels(AuthType.QWEN_OAUTH, QWEN_OAUTH_MODELS);

    // Register user-configured models for other providers
    this.registerProvidersConfig(modelProvidersConfig);
  }

  /**
   * Register every user-configured provider under its resolved SDK protocol.
   * A provider id maps to a protocol via {@link resolveProviderProtocol}
   * (explicit `providerProtocol` entry, or the id itself when it is a built-in
   * protocol). Unmapped unknown ids are skipped with a warning.
   */
  private registerProvidersConfig(
    modelProvidersConfig?: ModelProvidersConfig,
  ): void {
    if (!modelProvidersConfig) return;

    for (const [providerId, models] of Object.entries(modelProvidersConfig)) {
      const protocol = resolveProviderProtocol(
        providerId,
        this.providerProtocolConfig,
      );

      if (!protocol) {
        debugLogger.warn(
          `Provider "${providerId}" in modelProviders is not a built-in protocol ` +
            `(${Object.values(AuthType).join(', ')}) and has no providerProtocol mapping; skipping. ` +
            `Add providerProtocol["${providerId}"] to route it to an SDK protocol.`,
        );
        continue;
      }

      // qwen-oauth uses hard-coded models and cannot be overridden
      if (protocol === AuthType.QWEN_OAUTH) {
        continue;
      }

      this.registerAuthTypeModels(protocol, models, providerId);
    }
  }

  /**
   * Register models for an authType.
   * Uniqueness is determined by the composite key (id + baseUrl).
   * Two models with the same id but different baseUrls are treated as distinct.
   * If multiple models share both id and baseUrl, the first one takes precedence.
   */
  private registerAuthTypeModels(
    authType: AuthType,
    models: ModelConfig[],
    providerId?: string,
  ): void {
    // Defensive: runtime data from settings.json can violate the static type —
    // e.g. a hand-edited file, or one still in the reverted #5089 V5 shape
    // ({ protocol, models }) that the CLI v5->v4 migration has not yet
    // rewritten. Skip such entries with a clear warning instead of throwing an
    // opaque "models is not iterable" from the loop below.
    if (!Array.isArray(models)) {
      debugLogger.warn(
        `modelProviders for provider "${providerId ?? authType}" is not an array; ` +
          `skipping. Expected ModelConfig[]; legacy { protocol, models } entries ` +
          `are normally rewritten by the v5->v4 settings migration.`,
      );
      return;
    }

    // Merge into any existing map for this protocol: multiple provider ids can
    // resolve to the same protocol (e.g. `openai` and a custom `idealab` both
    // routing to the openai protocol). First registration of a composite
    // (id + baseUrl) key wins.
    const modelMap =
      this.modelsByAuthType.get(authType) ??
      new Map<string, ResolvedModelConfig>();
    const providerLabel =
      providerId && providerId !== authType
        ? ` (provider "${providerId}")`
        : '';

    for (const config of models) {
      const key = modelRegistryKey(config.id, config.baseUrl);
      if (modelMap.has(key)) {
        debugLogger.warn(
          `Duplicate model id "${config.id}"${config.baseUrl ? ` with baseUrl "${config.baseUrl}"` : ''} for protocol "${authType}"${providerLabel}. Using the first registered config.`,
        );
        continue;
      }
      const resolved = this.resolveModelConfig(config, authType);
      modelMap.set(key, resolved);
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
      contextWindowSize:
        model.generationConfig.contextWindowSize ?? tokenLimit(model.id),
      // `modalities` is auto-filled in `resolveModelConfig`, so it is
      // always defined on `ResolvedModelConfig` — no fallback needed here.
      modalities: model.generationConfig.modalities,
      baseUrl: model.baseUrl,
      envKey: model.envKey,
      fastOnly: model.fastOnly,
      voiceOnly: model.voiceOnly,
    }));
  }

  /**
   * Get model configuration by authType and modelId.
   * When baseUrl is provided, looks up by the exact composite key (id+baseUrl).
   * When baseUrl is omitted, tries the plain id first (backward compatible),
   * then scans all entries for the first match by model id.
   */
  getModel(
    authType: AuthType,
    modelId: string,
    baseUrl?: string,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return undefined;

    if (baseUrl) {
      return models.get(modelRegistryKey(modelId, baseUrl));
    }

    // Try plain id key first (models registered without explicit baseUrl)
    const plain = models.get(modelId);
    if (plain) return plain;

    // Scan for the first entry with matching model id
    for (const model of models.values()) {
      if (model.id === modelId) return model;
    }
    return undefined;
  }

  /**
   * Check if model exists for given authType.
   * When baseUrl is provided, checks the exact composite key.
   * When baseUrl is omitted, checks plain id and scans by model id.
   */
  hasModel(authType: AuthType, modelId: string, baseUrl?: string): boolean {
    return this.getModel(authType, modelId, baseUrl) !== undefined;
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
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return undefined;
    return Array.from(models.values())[0];
  }

  /**
   * Resolve model config by applying defaults
   */
  private resolveModelConfig(
    config: ModelConfig,
    authType: AuthType,
  ): ResolvedModelConfig {
    this.validateModelConfig(config, authType);

    const generationConfig = { ...(config.generationConfig ?? {}) };
    // Auto-fill modalities from the model name when the provider didn't set
    // them explicitly. Without this, downstream consumers that read straight
    // from the registry (e.g. sub-agents via getResolvedModel) would inherit
    // the parent session's modalities instead of the agent's own.
    if (
      generationConfig.modalities === undefined ||
      shouldUseCanonicalModalities(config.id)
    ) {
      generationConfig.modalities = defaultModalities(config.id);
    }

    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(authType),
      generationConfig,
      capabilities: config.capabilities || {},
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
    if (config.fastOnly && config.voiceOnly) {
      debugLogger.warn(
        `Model "${config.id}" in authType "${authType}" has both fastOnly and voiceOnly set. It will be unreachable in all model selectors.`,
      );
    }
  }

  /**
   * Reload models from updated configuration.
   * Clears existing user-configured models and re-registers from new config.
   * Preserves hard-coded qwen-oauth models.
   *
   * @param providerProtocolConfig - Updated provider->protocol map. `undefined`
   *   PRESERVES the existing map (so a reload carrying only modelProviders does
   *   not lose the mapping); any object value REPLACES it, so passing `{}`
   *   clears the mapping. Callers that want to preserve must omit the argument,
   *   not pass `settings.providerProtocol ?? {}`.
   */
  reloadModels(
    modelProvidersConfig?: ModelProvidersConfig,
    providerProtocolConfig?: ProviderProtocolConfig,
  ): void {
    if (providerProtocolConfig !== undefined) {
      this.providerProtocolConfig = providerProtocolConfig;
    }

    // Clear existing user-configured models (preserve qwen-oauth)
    for (const authType of this.modelsByAuthType.keys()) {
      if (authType !== AuthType.QWEN_OAUTH) {
        this.modelsByAuthType.delete(authType);
      }
    }

    // Re-register user-configured models under their resolved protocol
    this.registerProvidersConfig(modelProvidersConfig);
  }
}
