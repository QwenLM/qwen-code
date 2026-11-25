/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { DEFAULT_OPENAI_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '../qwen/oauth-config.js';
import {
  readCachedSubscriptionCatalog,
  synchronizeSubscriptionThinkingStrength,
  type SubscriptionModelMetadata,
  type SubscriptionScene,
  type SubscriptionSceneCatalog,
} from '../qwen/subscription-models.js';
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
 * report a skip. Released Responses provider declarations remain readable.
 */
export function resolveProviderProtocol(
  providerId: string,
  providerProtocol?: ProviderProtocolConfig,
): AuthType | undefined {
  const explicit =
    providerProtocol && Object.hasOwn(providerProtocol, providerId)
      ? providerProtocol[providerId]
      : undefined;
  if (explicit !== undefined) {
    return validateAuthTypeKey(explicit);
  }
  return validateAuthTypeKey(providerId);
}

export function resolveModelProtocol(
  providerId: string,
  model: Pick<ModelConfig, 'wireApi'>,
  providerProtocol?: ProviderProtocolConfig,
): AuthType | undefined {
  const protocol = resolveProviderProtocol(providerId, providerProtocol);
  if (!protocol || model.wireApi === undefined) return protocol;
  if (model.wireApi !== 'chat-completions' && model.wireApi !== 'responses') {
    throw new Error(
      `Invalid wireApi "${model.wireApi}" for provider "${providerId}". Expected "chat-completions" or "responses".`,
    );
  }
  if (
    protocol !== AuthType.USE_OPENAI &&
    protocol !== AuthType.USE_OPENAI_RESPONSES
  ) {
    throw new Error(
      `Provider "${providerId}" uses protocol "${protocol}"; wireApi is only supported for OpenAI-compatible models.`,
    );
  }
  return model.wireApi === 'responses'
    ? AuthType.USE_OPENAI_RESPONSES
    : AuthType.USE_OPENAI;
}

/**
 * {@link resolveModelProtocol} for read paths: returns `undefined` instead of
 * throwing for invalid provider protocols or `wireApi` values, so one entry
 * cannot take down a whole listing or an unrelated install. Write and startup paths
 * keep using the throwing resolver — an invalid value stays a config error
 * there.
 */
export function tryResolveModelProtocol(
  providerId: string,
  model: Pick<ModelConfig, 'wireApi'>,
  providerProtocol?: ProviderProtocolConfig,
): AuthType | undefined {
  try {
    return resolveModelProtocol(providerId, model, providerProtocol);
  } catch {
    return undefined;
  }
}

export function validateModelProvidersConfig(
  modelProviders?: ModelProvidersConfig,
  providerProtocol?: ProviderProtocolConfig,
): void {
  for (const providerId of new Set([
    ...Object.keys(modelProviders ?? {}),
    ...Object.keys(providerProtocol ?? {}),
  ])) {
    resolveProviderProtocol(providerId, providerProtocol);
    const models = modelProviders?.[providerId];
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      resolveModelProtocol(providerId, model, providerProtocol);
    }
  }
}

/** Resolve the startup wire, including checks before persisting a selection. */
export function resolveModelSelectionAuthType(
  authType: AuthType,
  modelId: string | undefined,
  modelProviders?: ModelProvidersConfig,
  providerProtocol?: ProviderProtocolConfig,
  baseUrl?: string | null,
): AuthType {
  if (
    !modelId ||
    (authType !== AuthType.USE_OPENAI &&
      authType !== AuthType.USE_OPENAI_RESPONSES)
  ) {
    return authType;
  }
  const candidates: Array<{ model: ModelConfig; authType: AuthType }> = [];
  for (const [providerId, models] of Object.entries(modelProviders ?? {})) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const protocol = resolveModelProtocol(
        providerId,
        model,
        providerProtocol,
      );
      if (
        model.id === modelId &&
        (protocol === authType ||
          ((model.wireApi !== undefined ||
            resolveProviderProtocol(providerId, providerProtocol) ===
              AuthType.USE_OPENAI_RESPONSES) &&
            (protocol === AuthType.USE_OPENAI ||
              protocol === AuthType.USE_OPENAI_RESPONSES)))
      ) {
        candidates.push({ model, authType: protocol });
      }
    }
  }
  const preferred = (entries: typeof candidates) =>
    entries.find((entry) => entry.authType === authType) ?? entries[0];
  const exact =
    baseUrl === undefined
      ? undefined
      : preferred(
          candidates.filter(
            (entry) => (entry.model.baseUrl || null) === (baseUrl || null),
          ),
        );
  return (exact ?? preferred(candidates))?.authType ?? authType;
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

  /** Raw providers config this registry was last built from. */
  private modelProvidersConfig?: ModelProvidersConfig;
  private subscriptionModels?: string[];
  private subscriptionMetadata?: SubscriptionModelMetadata[];
  private subscriptionScenes?: SubscriptionSceneCatalog;
  private subscriptionModelsUnavailable = false;
  private subscriptionScenesUnavailable = false;

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
    validateModelProvidersConfig(modelProvidersConfig, providerProtocolConfig);
    this.modelsByAuthType = new Map();
    this.providerProtocolConfig = providerProtocolConfig ?? {};
    this.modelProvidersConfig = modelProvidersConfig;
    const cached = readCachedSubscriptionCatalog();
    this.subscriptionModels = cached?.models;
    this.subscriptionMetadata = cached?.modelMetadata;
    this.subscriptionScenes = cached?.scenes;

    // Always register qwen-oauth models (hard-coded, cannot be overridden)
    this.registerAuthTypeModels(AuthType.QWEN_OAUTH, QWEN_OAUTH_MODELS);

    // Register user-configured models for other providers
    this.registerProvidersConfig(modelProvidersConfig);
    this.registerSubscriptionModels();
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
        const knownProtocols = Object.values(AuthType)
          .filter((value) => value !== AuthType.USE_OPENAI_RESPONSES)
          .join(', ');
        const mapped = Object.hasOwn(this.providerProtocolConfig, providerId)
          ? this.providerProtocolConfig[providerId]
          : undefined;
        const message =
          mapped !== undefined
            ? `Provider "${providerId}" maps to "${mapped}" via providerProtocol, ` +
              `which is not a known protocol (${knownProtocols}); skipping.`
            : `Provider "${providerId}" in modelProviders is not a built-in protocol ` +
              `(${knownProtocols}) and has no providerProtocol mapping; skipping. ` +
              `Add providerProtocol["${providerId}"] to route it to an SDK protocol.`;
        debugLogger.warn(message);
        continue;
      }

      // Account routes are registered separately with the trusted gateway.
      if (
        protocol === AuthType.QWEN_OAUTH ||
        protocol === AuthType.QWEN_SUBSCRIPTION
      ) {
        if (Array.isArray(models)) {
          for (const model of models) {
            resolveModelProtocol(
              providerId,
              model,
              this.providerProtocolConfig,
            );
          }
        }
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
    const providerLabel =
      providerId && providerId !== authType
        ? ` (provider "${providerId}")`
        : '';

    for (const config of models) {
      const modelAuthType = resolveModelProtocol(
        providerId ?? authType,
        config,
        providerId ? this.providerProtocolConfig : undefined,
      )!;
      const modelMap =
        this.modelsByAuthType.get(modelAuthType) ??
        new Map<string, ResolvedModelConfig>();
      const key = modelRegistryKey(config.id, config.baseUrl);
      if (modelMap.has(key)) {
        debugLogger.warn(
          `Duplicate model id "${config.id}"${config.baseUrl ? ` with baseUrl "${config.baseUrl}"` : ''} for protocol "${modelAuthType}"${providerLabel}. Using the first registered config.`,
        );
        continue;
      }
      const resolved = this.resolveModelConfig(config, modelAuthType);
      modelMap.set(key, resolved);
      this.modelsByAuthType.set(modelAuthType, modelMap);
    }
  }

  /**
   * Get all models for a specific authType.
   * This is used by /model command to show only relevant models.
   */
  getModelsForAuthType(authType: AuthType): AvailableModel[] {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return [];

    // A realtimeOnly route speaks a speech-to-speech protocol, not chat, and
    // is picked only through the Live Voice setup. Dropping it at the source
    // keeps it out of every selector built from this list; `getModel` still
    // resolves it so naming it as a chat model fails with a clear error.
    return Array.from(models.values())
      .filter((model) => !model.realtimeOnly)
      .map((model) => ({
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
        ...(model.registryBaseUrl !== undefined
          ? { registryBaseUrl: model.registryBaseUrl }
          : {}),
        envKey: model.envKey,
        fastOnly: model.fastOnly,
        voiceOnly: model.voiceOnly,
        visionOnly: model.visionOnly,
        supportsImageGeneration: model.supportsImageGeneration,
        imageOnly: model.imageOnly,
        subscriptionScenes: model.subscriptionScenes,
        thinkingStrength: model.thinkingStrength,
        subscriptionChatModel: model.subscriptionChatModel,
      }));
  }

  /**
   * Get model configuration by authType and modelId.
   * When baseUrl is provided, looks up the exact composite key, then a plain
   * entry whose resolved default baseUrl matches.
   * When baseUrl is omitted, tries the plain id first (backward compatible),
   * then scans all entries for the first match by model id.
   */
  getModel(
    authType: AuthType,
    modelId: string,
    baseUrl?: string | null,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return undefined;

    if (baseUrl !== undefined) {
      const exact = models.get(modelRegistryKey(modelId, baseUrl ?? undefined));
      if (exact) return exact;
      if (baseUrl === null) return undefined;
      const plain = models.get(modelId);
      return plain?.baseUrl === baseUrl ? plain : undefined;
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
   * When baseUrl is provided, checks the exact endpoint or matching default.
   * When baseUrl is omitted, checks plain id and scans by model id.
   */
  hasModel(authType: AuthType, modelId: string, baseUrl?: string): boolean {
    return this.getModel(authType, modelId, baseUrl) !== undefined;
  }

  /**
   * Get default model for an authType.
   * For qwen-oauth, returns the coder model.
   * For others, returns the first configured primary-capable model.
   */
  getDefaultModelForAuthType(
    authType: AuthType,
  ): ResolvedModelConfig | undefined {
    if (authType === AuthType.QWEN_OAUTH) {
      return this.getModel(authType, DEFAULT_QWEN_MODEL);
    }
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return undefined;
    return Array.from(models.values()).find(
      (model) =>
        !model.imageOnly &&
        !model.voiceOnly &&
        !model.realtimeOnly &&
        model.subscriptionChatModel !== false,
    );
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
      (authType !== AuthType.QWEN_SUBSCRIPTION &&
        shouldUseCanonicalModalities(config.id))
    ) {
      generationConfig.modalities = defaultModalities(config.id);
    }

    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(authType),
      ...(config.baseUrl ? { registryBaseUrl: config.baseUrl } : {}),
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
    const selectorOnlyCount = [
      config.fastOnly,
      config.voiceOnly,
      config.visionOnly,
      config.imageOnly,
      config.realtimeOnly,
    ].filter(Boolean).length;
    if (selectorOnlyCount > 1) {
      debugLogger.warn(
        `Model "${config.id}" in authType "${authType}" has multiple selector-only flags. It will be unreachable in at least one model selector.`,
      );
    }
  }

  hasSubscriptionCatalog(scene?: SubscriptionScene): boolean {
    return scene
      ? !this.subscriptionScenesUnavailable &&
          this.subscriptionScenes !== undefined
      : !this.subscriptionModelsUnavailable &&
          this.subscriptionModels !== undefined;
  }

  getSubscriptionModelIds(scene?: SubscriptionScene): string[] {
    if (
      scene
        ? this.subscriptionScenesUnavailable
        : this.subscriptionModelsUnavailable
    )
      return [];
    return scene
      ? (this.subscriptionScenes?.[scene]?.map(({ id }) => id) ?? [])
      : [...(this.subscriptionModels ?? [])];
  }

  invalidateSubscriptionCatalog(scene: boolean): void {
    if (scene) this.subscriptionScenesUnavailable = true;
    else this.subscriptionModelsUnavailable = true;
  }

  setSubscriptionModels(
    ids: string[] | undefined,
    modelMetadata?: SubscriptionModelMetadata[],
  ): void {
    this.subscriptionModelsUnavailable = false;
    this.subscriptionModels = ids;
    this.subscriptionMetadata = modelMetadata;
    this.synchronizeSubscriptionThinking('models');
    this.registerSubscriptionModels();
  }

  setSubscriptionScenes(scenes: SubscriptionSceneCatalog | undefined): void {
    this.subscriptionScenesUnavailable = false;
    this.subscriptionScenes = scenes;
    this.synchronizeSubscriptionThinking('scenes');
    this.registerSubscriptionModels();
  }

  private synchronizeSubscriptionThinking(source: 'models' | 'scenes'): void {
    const catalog = synchronizeSubscriptionThinkingStrength(
      {
        models: this.subscriptionModels ?? [],
        modelMetadata: this.subscriptionMetadata,
        scenes: this.subscriptionScenes,
      },
      source,
    );
    this.subscriptionMetadata = catalog.modelMetadata;
    this.subscriptionScenes = catalog.scenes;
  }

  private registerSubscriptionModels(): void {
    const metadataById = new Map(
      this.subscriptionMetadata?.map((entry) => [entry.id, entry]),
    );
    const configs = new Map<string, ModelConfig>();
    for (const id of this.subscriptionModels ?? []) {
      const metadata = metadataById.get(id);
      configs.set(id, {
        id,
        name: metadata?.name,
        description: metadata?.description,
        thinkingStrength: metadata?.thinkingStrength,
        baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
        subscriptionChatModel: true,
        subscriptionScenes:
          this.subscriptionScenes === undefined ? undefined : [],
        generationConfig: {
          modalities: metadata?.modalities,
          contextWindowSize: metadata?.contextWindowSize ?? tokenLimit(id),
        },
      });
    }
    for (const scene of [
      'fast',
      'compaction',
      'vision',
      'image',
      'voice',
    ] as const) {
      for (const model of this.subscriptionScenes?.[scene] ?? []) {
        let config = configs.get(model.id);
        if (!config) {
          const modalities =
            model.input_modalities === undefined
              ? undefined
              : Object.fromEntries(
                  model.input_modalities
                    .filter((modality) => modality !== 'text')
                    .map((modality) => [modality, true]),
                );
          config = {
            id: model.id,
            name: model.display_name,
            description: model.description,
            thinkingStrength: model.thinking_strength,
            baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
            subscriptionChatModel: false,
            subscriptionScenes: [],
            generationConfig: {
              modalities,
              contextWindowSize:
                model.context_window_tokens ?? tokenLimit(model.id),
            },
          };
          configs.set(model.id, config);
        }
        const scenes: SubscriptionScene[] = config.subscriptionScenes ?? [];
        if (!scenes.includes(scene)) scenes.push(scene);
        config.subscriptionScenes = scenes;
        config.name ??= model.display_name;
        config.description ??= model.description;
        config.thinkingStrength ??= model.thinking_strength;
        if (scene === 'image') config.supportsImageGeneration = true;
      }
    }
    for (const config of configs.values()) {
      if (config.thinkingStrength?.length) {
        const efforts = config.thinkingStrength.map(({ level }) => level);
        config.capabilities = {
          reasoning: {
            thinking: true,
            disableField: 'enable_thinking',
            efforts,
            defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0],
          },
        };
      }
      if (
        !config.subscriptionChatModel &&
        config.subscriptionScenes?.length === 1
      ) {
        const scene = config.subscriptionScenes[0];
        if (scene === 'image') config.imageOnly = true;
        if (scene === 'voice') config.voiceOnly = true;
        if (scene === 'vision') config.visionOnly = true;
        if (scene === 'fast') config.fastOnly = true;
      }
    }
    const saved = this.modelProvidersConfig?.[AuthType.QWEN_SUBSCRIPTION];
    if (Array.isArray(saved)) {
      for (const model of saved) {
        if (model.baseUrl !== QWEN_SUBSCRIPTION_BASE_URL) continue;
        const discovered = configs.get(model.id);
        if (discovered) {
          if (
            this.subscriptionModels === undefined &&
            model.subscriptionChatModel
          )
            discovered.subscriptionChatModel = true;
          if (this.subscriptionScenes === undefined) {
            discovered.subscriptionScenes = model.subscriptionScenes;
            discovered.supportsImageGeneration = model.supportsImageGeneration;
          }
          if (discovered.subscriptionChatModel) {
            discovered.imageOnly = undefined;
            discovered.voiceOnly = undefined;
            discovered.visionOnly = undefined;
            discovered.fastOnly = undefined;
          }
          continue;
        }
        configs.set(model.id, {
          id: model.id,
          name: model.name,
          description: model.description,
          thinkingStrength: model.thinkingStrength,
          subscriptionChatModel: model.subscriptionChatModel,
          subscriptionScenes: model.subscriptionScenes,
          baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
          generationConfig: model.generationConfig,
          capabilities: model.capabilities,
          supportsImageGeneration: model.supportsImageGeneration,
          imageOnly: model.imageOnly,
          voiceOnly: model.voiceOnly,
          visionOnly: model.visionOnly,
          fastOnly: model.fastOnly,
        });
      }
    }
    this.modelsByAuthType.delete(AuthType.QWEN_SUBSCRIPTION);
    this.registerAuthTypeModels(AuthType.QWEN_SUBSCRIPTION, [
      ...configs.values(),
    ]);
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
    const reloaded = new ModelRegistry(
      modelProvidersConfig,
      providerProtocolConfig ?? this.providerProtocolConfig,
    );
    this.modelsByAuthType = reloaded.modelsByAuthType;
    this.providerProtocolConfig = reloaded.providerProtocolConfig;
    this.modelProvidersConfig = reloaded.modelProvidersConfig;
    this.registerSubscriptionModels();
  }

  /** The raw providers config this registry was last built from. */
  getModelProvidersConfig(): ModelProvidersConfig | undefined {
    return this.modelProvidersConfig;
  }

  getProviderProtocolConfig(): ProviderProtocolConfig {
    return this.providerProtocolConfig;
  }
}
