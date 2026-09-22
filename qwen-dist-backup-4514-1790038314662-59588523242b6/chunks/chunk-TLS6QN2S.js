// Force strict mode and setup for ESM
"use strict";
import {
  MODEL_GENERATION_CONFIG_FIELDS,
  PROVIDER_SOURCED_FIELDS,
  QWEN_OAUTH_MODELS,
  REASONING_EFFORT_TIERS,
  clampReasoningEffort,
  defaultModalities,
  getGptReasoningCapabilities,
  normalize,
  parseModelReasoningCapabilities,
  tokenLimit
} from "./chunk-KUON6Z6R.js";
import {
  DEFAULT_QWEN_MODEL
} from "./chunk-XZA32HII.js";
import {
  AuthType
} from "./chunk-SBP43AO6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/openaiContentGenerator/constants.ts
init_esbuild_shims();
var DEFAULT_TIMEOUT = 12e4;
var DISABLED_REQUEST_TIMEOUT_MS = 2147483647;
function resolveRequestTimeout(timeout) {
  if (timeout === void 0 || timeout === null) {
    return DEFAULT_TIMEOUT;
  }
  return timeout <= 0 ? DISABLED_REQUEST_TIMEOUT_MS : timeout;
}
__name(resolveRequestTimeout, "resolveRequestTimeout");
var DEFAULT_STREAM_IDLE_TIMEOUT_MS = 24e4;
var QWEN_STREAM_IDLE_TIMEOUT_MS_ENV = "QWEN_STREAM_IDLE_TIMEOUT_MS";
var MAX_STREAM_GUARD_TIMEOUT_MS = 2147483647;
var DEFAULT_STREAM_MAX_LIFETIME_MS = 9e5;
var QWEN_STREAM_MAX_LIFETIME_MS_ENV = "QWEN_STREAM_MAX_LIFETIME_MS";
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
var DASHSCOPE_PROXY_BASE_URL = process.env["DASHSCOPE_PROXY_BASE_URL"];
function normalizeOpenAiWireBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/v1\/?$/, "").replace(/\/$/, "");
}
__name(normalizeOpenAiWireBaseUrl, "normalizeOpenAiWireBaseUrl");

// packages/core/src/models/image-generation-capability.ts
init_esbuild_shims();
function isImageGenerationCapable(model) {
  return model.supportsImageGeneration === true || model.imageOnly === true;
}
__name(isImageGenerationCapable, "isImageGenerationCapable");

// packages/core/src/utils/runtimeModelPrefix.ts
init_esbuild_shims();
var RUNTIME_SNAPSHOT_PREFIX = "$runtime|";
function buildRuntimeSnapshotId(authType, modelId) {
  return `${RUNTIME_SNAPSHOT_PREFIX}${authType}|${modelId}`;
}
__name(buildRuntimeSnapshotId, "buildRuntimeSnapshotId");
function stripRuntimeSnapshotPrefix(modelId) {
  let id = modelId;
  while (id.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
    const stripped = id.split("|").slice(2).join("|");
    if (!stripped) break;
    id = stripped;
  }
  return id;
}
__name(stripRuntimeSnapshotPrefix, "stripRuntimeSnapshotPrefix");

// packages/core/src/models/modelsConfig.ts
init_esbuild_shims();
import process2 from "node:process";

// packages/core/src/models/modelRegistry.ts
init_esbuild_shims();

// packages/core/src/models/types.ts
init_esbuild_shims();

// packages/core/src/models/modelRegistry.ts
var debugLogger = createDebugLogger("MODEL_REGISTRY");
function validateAuthTypeKey(key) {
  if (Object.values(AuthType).includes(key)) {
    return key;
  }
  return void 0;
}
__name(validateAuthTypeKey, "validateAuthTypeKey");
function resolveProviderProtocol(providerId, providerProtocol) {
  const explicit = providerProtocol && Object.hasOwn(providerProtocol, providerId) ? providerProtocol[providerId] : void 0;
  if (explicit !== void 0) {
    return validateAuthTypeKey(explicit);
  }
  return validateAuthTypeKey(providerId);
}
__name(resolveProviderProtocol, "resolveProviderProtocol");
function resolveModelProtocol(providerId, model, providerProtocol) {
  const protocol = resolveProviderProtocol(providerId, providerProtocol);
  if (!protocol || model.wireApi === void 0) return protocol;
  if (model.wireApi !== "chat-completions" && model.wireApi !== "responses") {
    throw new Error(
      `Invalid wireApi "${model.wireApi}" for provider "${providerId}". Expected "chat-completions" or "responses".`
    );
  }
  if (protocol !== "openai" /* USE_OPENAI */ && protocol !== "openai-responses" /* USE_OPENAI_RESPONSES */) {
    throw new Error(
      `Provider "${providerId}" uses protocol "${protocol}"; wireApi is only supported for OpenAI-compatible models.`
    );
  }
  return model.wireApi === "responses" ? "openai-responses" /* USE_OPENAI_RESPONSES */ : "openai" /* USE_OPENAI */;
}
__name(resolveModelProtocol, "resolveModelProtocol");
function tryResolveModelProtocol(providerId, model, providerProtocol) {
  try {
    return resolveModelProtocol(providerId, model, providerProtocol);
  } catch {
    return void 0;
  }
}
__name(tryResolveModelProtocol, "tryResolveModelProtocol");
function validateModelProvidersConfig(modelProviders, providerProtocol) {
  for (const providerId of /* @__PURE__ */ new Set([
    ...Object.keys(modelProviders ?? {}),
    ...Object.keys(providerProtocol ?? {})
  ])) {
    resolveProviderProtocol(providerId, providerProtocol);
    const models = modelProviders?.[providerId];
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      resolveModelProtocol(providerId, model, providerProtocol);
    }
  }
}
__name(validateModelProvidersConfig, "validateModelProvidersConfig");
function resolveModelSelectionAuthType(authType, modelId, modelProviders, providerProtocol, baseUrl) {
  if (!modelId || authType !== "openai" /* USE_OPENAI */ && authType !== "openai-responses" /* USE_OPENAI_RESPONSES */) {
    return authType;
  }
  const candidates = [];
  for (const [providerId, models] of Object.entries(modelProviders ?? {})) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const protocol = resolveModelProtocol(
        providerId,
        model,
        providerProtocol
      );
      if (model.id === modelId && (protocol === authType || (model.wireApi !== void 0 || resolveProviderProtocol(providerId, providerProtocol) === "openai-responses" /* USE_OPENAI_RESPONSES */) && (protocol === "openai" /* USE_OPENAI */ || protocol === "openai-responses" /* USE_OPENAI_RESPONSES */))) {
        candidates.push({ model, authType: protocol });
      }
    }
  }
  const preferred = /* @__PURE__ */ __name((entries) => entries.find((entry) => entry.authType === authType) ?? entries[0], "preferred");
  const exact = baseUrl === void 0 ? void 0 : preferred(
    candidates.filter(
      (entry) => (entry.model.baseUrl || null) === (baseUrl || null)
    )
  );
  return (exact ?? preferred(candidates))?.authType ?? authType;
}
__name(resolveModelSelectionAuthType, "resolveModelSelectionAuthType");
function shouldUseCanonicalModalities(modelId) {
  return /^minimax-m3/i.test(modelId.trim().toLowerCase());
}
__name(shouldUseCanonicalModalities, "shouldUseCanonicalModalities");
function modelRegistryKey(id, baseUrl) {
  return baseUrl ? `${id}\0${baseUrl}` : id;
}
__name(modelRegistryKey, "modelRegistryKey");
var ModelRegistry = class _ModelRegistry {
  static {
    __name(this, "ModelRegistry");
  }
  modelsByAuthType;
  /** providerId -> SDK protocol mapping; persists across reloads. */
  providerProtocolConfig;
  /** Raw providers config this registry was last built from. */
  modelProvidersConfig;
  getDefaultBaseUrl(authType) {
    switch (authType) {
      case "qwen-oauth" /* QWEN_OAUTH */:
        return "DYNAMIC_QWEN_OAUTH_BASE_URL";
      case "openai" /* USE_OPENAI */:
        return DEFAULT_OPENAI_BASE_URL;
      default:
        return "";
    }
  }
  constructor(modelProvidersConfig, providerProtocolConfig) {
    validateModelProvidersConfig(modelProvidersConfig, providerProtocolConfig);
    this.modelsByAuthType = /* @__PURE__ */ new Map();
    this.providerProtocolConfig = providerProtocolConfig ?? {};
    this.modelProvidersConfig = modelProvidersConfig;
    this.registerAuthTypeModels("qwen-oauth" /* QWEN_OAUTH */, QWEN_OAUTH_MODELS);
    this.registerProvidersConfig(modelProvidersConfig);
  }
  /**
   * Register every user-configured provider under its resolved SDK protocol.
   * A provider id maps to a protocol via {@link resolveProviderProtocol}
   * (explicit `providerProtocol` entry, or the id itself when it is a built-in
   * protocol). Unmapped unknown ids are skipped with a warning.
   */
  registerProvidersConfig(modelProvidersConfig) {
    if (!modelProvidersConfig) return;
    for (const [providerId, models] of Object.entries(modelProvidersConfig)) {
      const protocol = resolveProviderProtocol(
        providerId,
        this.providerProtocolConfig
      );
      if (!protocol) {
        const knownProtocols = Object.values(AuthType).filter((value) => value !== "openai-responses" /* USE_OPENAI_RESPONSES */).join(", ");
        const mapped = Object.hasOwn(this.providerProtocolConfig, providerId) ? this.providerProtocolConfig[providerId] : void 0;
        const message = mapped !== void 0 ? `Provider "${providerId}" maps to "${mapped}" via providerProtocol, which is not a known protocol (${knownProtocols}); skipping.` : `Provider "${providerId}" in modelProviders is not a built-in protocol (${knownProtocols}) and has no providerProtocol mapping; skipping. Add providerProtocol["${providerId}"] to route it to an SDK protocol.`;
        debugLogger.warn(message);
        continue;
      }
      if (protocol === "qwen-oauth" /* QWEN_OAUTH */) {
        if (Array.isArray(models)) {
          for (const model of models) {
            resolveModelProtocol(
              providerId,
              model,
              this.providerProtocolConfig
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
  registerAuthTypeModels(authType, models, providerId) {
    if (!Array.isArray(models)) {
      debugLogger.warn(
        `modelProviders for provider "${providerId ?? authType}" is not an array; skipping. Expected ModelConfig[]; legacy { protocol, models } entries are normally rewritten by the v5->v4 settings migration.`
      );
      return;
    }
    const providerLabel = providerId && providerId !== authType ? ` (provider "${providerId}")` : "";
    for (const config of models) {
      const modelAuthType = resolveModelProtocol(
        providerId ?? authType,
        config,
        providerId ? this.providerProtocolConfig : void 0
      );
      const modelMap = this.modelsByAuthType.get(modelAuthType) ?? /* @__PURE__ */ new Map();
      const key = modelRegistryKey(config.id, config.baseUrl);
      if (modelMap.has(key)) {
        debugLogger.warn(
          `Duplicate model id "${config.id}"${config.baseUrl ? ` with baseUrl "${config.baseUrl}"` : ""} for protocol "${modelAuthType}"${providerLabel}. Using the first registered config.`
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
  getModelsForAuthType(authType) {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return [];
    return Array.from(models.values()).map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      capabilities: model.capabilities,
      authType: model.authType,
      isVision: model.capabilities?.vision ?? false,
      contextWindowSize: model.generationConfig.contextWindowSize ?? tokenLimit(model.id),
      // `modalities` is auto-filled in `resolveModelConfig`, so it is
      // always defined on `ResolvedModelConfig` — no fallback needed here.
      modalities: model.generationConfig.modalities,
      baseUrl: model.baseUrl,
      ...model.registryBaseUrl !== void 0 ? { registryBaseUrl: model.registryBaseUrl } : {},
      envKey: model.envKey,
      fastOnly: model.fastOnly,
      voiceOnly: model.voiceOnly,
      visionOnly: model.visionOnly,
      supportsImageGeneration: model.supportsImageGeneration,
      imageOnly: model.imageOnly
    }));
  }
  /**
   * Get model configuration by authType and modelId.
   * When baseUrl is provided, looks up the exact composite key, then a plain
   * entry whose resolved default baseUrl matches.
   * When baseUrl is omitted, tries the plain id first (backward compatible),
   * then scans all entries for the first match by model id.
   */
  getModel(authType, modelId, baseUrl) {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return void 0;
    if (baseUrl !== void 0) {
      const exact = models.get(modelRegistryKey(modelId, baseUrl ?? void 0));
      if (exact) return exact;
      if (baseUrl === null) return void 0;
      const plain2 = models.get(modelId);
      return plain2?.baseUrl === baseUrl ? plain2 : void 0;
    }
    const plain = models.get(modelId);
    if (plain) return plain;
    for (const model of models.values()) {
      if (model.id === modelId) return model;
    }
    return void 0;
  }
  /**
   * Check if model exists for given authType.
   * When baseUrl is provided, checks the exact endpoint or matching default.
   * When baseUrl is omitted, checks plain id and scans by model id.
   */
  hasModel(authType, modelId, baseUrl) {
    return this.getModel(authType, modelId, baseUrl) !== void 0;
  }
  /**
   * Get default model for an authType.
   * For qwen-oauth, returns the coder model.
   * For others, returns the first configured primary-capable model.
   */
  getDefaultModelForAuthType(authType) {
    if (authType === "qwen-oauth" /* QWEN_OAUTH */) {
      return this.getModel(authType, DEFAULT_QWEN_MODEL);
    }
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return void 0;
    return Array.from(models.values()).find(
      (model) => !model.imageOnly && !model.voiceOnly
    );
  }
  /**
   * Resolve model config by applying defaults
   */
  resolveModelConfig(config, authType) {
    this.validateModelConfig(config, authType);
    const generationConfig = { ...config.generationConfig ?? {} };
    if (generationConfig.modalities === void 0 || shouldUseCanonicalModalities(config.id)) {
      generationConfig.modalities = defaultModalities(config.id);
    }
    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(authType),
      ...config.baseUrl ? { registryBaseUrl: config.baseUrl } : {},
      generationConfig,
      capabilities: config.capabilities || {}
    };
  }
  /**
   * Validate model configuration
   */
  validateModelConfig(config, authType) {
    if (!config.id) {
      throw new Error(
        `Model config in authType '${authType}' missing required field: id`
      );
    }
    const selectorOnlyCount = [
      config.fastOnly,
      config.voiceOnly,
      config.visionOnly,
      config.imageOnly
    ].filter(Boolean).length;
    if (selectorOnlyCount > 1) {
      debugLogger.warn(
        `Model "${config.id}" in authType "${authType}" has multiple selector-only flags. It will be unreachable in at least one model selector.`
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
  reloadModels(modelProvidersConfig, providerProtocolConfig) {
    const reloaded = new _ModelRegistry(
      modelProvidersConfig,
      providerProtocolConfig ?? this.providerProtocolConfig
    );
    this.modelsByAuthType = reloaded.modelsByAuthType;
    this.providerProtocolConfig = reloaded.providerProtocolConfig;
    this.modelProvidersConfig = reloaded.modelProvidersConfig;
  }
  /** The raw providers config this registry was last built from. */
  getModelProvidersConfig() {
    return this.modelProvidersConfig;
  }
  getProviderProtocolConfig() {
    return this.providerProtocolConfig;
  }
};

// packages/core/src/models/modelsConfig.ts
var debugLogger2 = createDebugLogger("ModelsConfig");
var ModelsConfig = class _ModelsConfig {
  static {
    __name(this, "ModelsConfig");
  }
  modelRegistry;
  // Current selection state
  currentAuthType;
  currentRegistryBaseUrl;
  // Generation config state
  _generationConfig;
  generationConfigSources;
  // Flag for strict model provider selection
  strictModelProviderSelection = false;
  // One-shot flag for qwen-oauth credential caching
  requireCachedQwenCredentialsOnce = false;
  // One-shot flag indicating credentials were manually set via updateCredentials()
  // When true, syncAfterAuthRefresh should NOT override these credentials with
  // modelProviders defaults (even if the model ID matches a registry entry).
  //
  // This must be persistent across auth refreshes, because refreshAuth() can be
  // triggered multiple times after a credential prompt flow. We only clear this
  // flag when we explicitly apply modelProvider defaults (i.e. when the user
  // switches to a registry model via switchModel).
  hasManualCredentials = false;
  // Callback for notifying Config of model changes
  onModelChange;
  // Flag indicating whether authType was explicitly provided (not defaulted)
  authTypeWasExplicitlyProvided;
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
  runtimeModelSnapshots = /* @__PURE__ */ new Map();
  /**
   * Currently active RuntimeModelSnapshot ID.
   *
   * When set, indicates that the current model is a runtime model (not from registry).
   * This ID is included in state snapshots for rollback purposes.
   */
  activeRuntimeModelSnapshotId;
  static deepClone(value) {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => _ModelsConfig.deepClone(v));
    }
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = _ModelsConfig.deepClone(
        value[key]
      );
    }
    return out;
  }
  constructor(options = {}) {
    this.modelRegistry = new ModelRegistry(
      options.modelProvidersConfig,
      options.providerProtocolConfig
    );
    this.onModelChange = options.onModelChange;
    this._generationConfig = {
      ...options.generationConfig || {}
    };
    this.generationConfigSources = options.generationConfigSources || {};
    this.authTypeWasExplicitlyProvided = options.initialAuthType !== void 0;
    const initialModelId = this._generationConfig.model;
    this.currentAuthType = options.initialAuthType ? resolveModelSelectionAuthType(
      options.initialAuthType,
      this.generationConfigSources["model"]?.kind === "default" ? void 0 : initialModelId,
      options.modelProvidersConfig,
      options.providerProtocolConfig,
      options.initialRegistryBaseUrl
    ) : void 0;
    if (this.currentAuthType && initialModelId) {
      const initialModel = this.modelRegistry.getModel(
        this.currentAuthType,
        initialModelId,
        options.initialRegistryBaseUrl
      );
      if (initialModel) {
        this.currentRegistryBaseUrl = initialModel.registryBaseUrl ?? null;
      }
    }
  }
  /**
   * Create a snapshot of the current ModelsConfig state for rollback purposes.
   * Used before model switching operations to enable recovery on errors.
   *
   * Note: This is different from RuntimeModelSnapshot which stores runtime model configs.
   */
  createStateSnapshotForRollback() {
    return {
      currentAuthType: this.currentAuthType,
      generationConfig: _ModelsConfig.deepClone(this._generationConfig),
      generationConfigSources: _ModelsConfig.deepClone(
        this.generationConfigSources
      ),
      strictModelProviderSelection: this.strictModelProviderSelection,
      requireCachedQwenCredentialsOnce: this.requireCachedQwenCredentialsOnce,
      hasManualCredentials: this.hasManualCredentials,
      activeRuntimeModelSnapshotId: this.activeRuntimeModelSnapshotId,
      currentRegistryBaseUrl: this.currentRegistryBaseUrl
    };
  }
  /**
   * Restore ModelsConfig state from a previously created state snapshot.
   * Used for rollback when model switching operations fail.
   *
   * @param snapshot - The state snapshot to restore
   */
  rollbackToStateSnapshot(snapshot) {
    this.currentAuthType = snapshot.currentAuthType;
    this._generationConfig = snapshot.generationConfig;
    this.generationConfigSources = snapshot.generationConfigSources;
    this.strictModelProviderSelection = snapshot.strictModelProviderSelection;
    this.requireCachedQwenCredentialsOnce = snapshot.requireCachedQwenCredentialsOnce;
    this.hasManualCredentials = snapshot.hasManualCredentials;
    this.activeRuntimeModelSnapshotId = snapshot.activeRuntimeModelSnapshotId;
    this.currentRegistryBaseUrl = snapshot.currentRegistryBaseUrl;
  }
  /**
   * Get current model ID
   */
  getModel() {
    return this._generationConfig.model || DEFAULT_QWEN_MODEL;
  }
  /**
   * Get current authType
   */
  getCurrentAuthType() {
    return this.currentAuthType;
  }
  getCurrentRegistryBaseUrl() {
    return this.currentRegistryBaseUrl;
  }
  /**
   * Check if authType was explicitly provided (via CLI or settings).
   * If false, no authType was provided yet (fresh user).
   */
  wasAuthTypeExplicitlyProvided() {
    return this.authTypeWasExplicitlyProvided;
  }
  /**
   * Get available models for current authType
   */
  getAvailableModels() {
    return this.currentAuthType ? this.modelRegistry.getModelsForAuthType(this.currentAuthType) : [];
  }
  /**
   * Get available models for a specific authType
   */
  getAvailableModelsForAuthType(authType) {
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
  getAllConfiguredModels(authTypes) {
    const inputAuthTypes = authTypes && authTypes.length > 0 ? authTypes : Object.values(AuthType);
    const seen = /* @__PURE__ */ new Set();
    const uniqueAuthTypes = [];
    for (const authType of inputAuthTypes) {
      if (!seen.has(authType)) {
        seen.add(authType);
        uniqueAuthTypes.push(authType);
      }
    }
    const orderedAuthTypes = [];
    if (uniqueAuthTypes.includes("qwen-oauth" /* QWEN_OAUTH */)) {
      orderedAuthTypes.push("qwen-oauth" /* QWEN_OAUTH */);
    }
    for (const authType of uniqueAuthTypes) {
      if (authType !== "qwen-oauth" /* QWEN_OAUTH */) {
        orderedAuthTypes.push(authType);
      }
    }
    const runtimeOption = this.getRuntimeModelOption();
    const allModels = [];
    for (const authType of orderedAuthTypes) {
      if (runtimeOption && runtimeOption.authType === authType) {
        allModels.push(runtimeOption);
      }
      allModels.push(...this.modelRegistry.getModelsForAuthType(authType));
    }
    return allModels;
  }
  /**
   * Check if a model exists for the given authType
   */
  hasModel(authType, modelId) {
    return this.modelRegistry.hasModel(authType, modelId);
  }
  /**
   * Get a fully resolved provider model config for the given authType/modelId.
   * Returns undefined for raw runtime models that are not present in the registry.
   */
  getResolvedModel(authType, modelId, baseUrl) {
    return this.modelRegistry.getModel(authType, modelId, baseUrl);
  }
  /**
   * Get the display name for a model by its id.
   * Looks up the model in the registry using the current authType and returns
   * its resolved name. Falls back to the raw model id when the model is not
   * found in the registry (e.g. runtime models or unknown models).
   */
  getModelDisplayName(modelId) {
    if (!this.currentAuthType) return modelId;
    const resolved = (this.currentRegistryBaseUrl !== void 0 ? this.modelRegistry.getModel(
      this.currentAuthType,
      modelId,
      this.currentRegistryBaseUrl
    ) : void 0) ?? this.modelRegistry.getModel(this.currentAuthType, modelId);
    return resolved?.name ?? modelId;
  }
  /**
   * Set model programmatically (e.g., VLM auto-switch, fallback).
   * Supports both registry models and raw model IDs.
   */
  async setModel(newModel, metadata) {
    if (this.currentAuthType === "qwen-oauth" /* QWEN_OAUTH */ && newModel === DEFAULT_QWEN_MODEL) {
      this.strictModelProviderSelection = false;
      this.currentRegistryBaseUrl = void 0;
      this._generationConfig.model = newModel;
      this.generationConfigSources["model"] = {
        kind: "programmatic",
        detail: metadata?.reason || "setModel"
      };
      this.applyRawModelDerivedDefaults(newModel);
      if (this.onModelChange) {
        await this.onModelChange("qwen-oauth" /* QWEN_OAUTH */, false);
      }
      return;
    }
    if (this.currentAuthType && this.modelRegistry.hasModel(this.currentAuthType, newModel)) {
      await this.switchModel(this.currentAuthType, newModel);
      return;
    }
    const siblingWire = this.currentAuthType === "openai" /* USE_OPENAI */ ? "openai-responses" /* USE_OPENAI_RESPONSES */ : this.currentAuthType === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "openai" /* USE_OPENAI */ : void 0;
    if (siblingWire && this.modelRegistry.hasModel(siblingWire, newModel)) {
      await this.switchModel(siblingWire, newModel);
      return;
    }
    const rollbackSnapshot = this.createStateSnapshotForRollback();
    try {
      this.strictModelProviderSelection = false;
      this.currentRegistryBaseUrl = void 0;
      this._generationConfig.model = newModel;
      this.generationConfigSources["model"] = {
        kind: "programmatic",
        detail: metadata?.reason || "setModel"
      };
      this.applyRawModelDerivedDefaults(newModel);
      if (this.onModelChange && this.currentAuthType) {
        await this.onModelChange(this.currentAuthType, true);
      }
    } catch (error) {
      this.rollbackToStateSnapshot(rollbackSnapshot);
      throw error;
    }
  }
  /**
   * Raw model switches keep the current credentials, but model-derived
   * generation defaults must follow the new model. Otherwise a switch from a
   * multimodal registry model to a text-only raw model can keep stale image
   * support and send unsupported inline media.
   */
  applyRawModelDerivedDefaults(modelId) {
    if (this.shouldUpdateModelDerivedDefault("modalities")) {
      this._generationConfig.modalities = defaultModalities(modelId);
      this.generationConfigSources["modalities"] = {
        kind: "computed",
        detail: "auto-detected from model"
      };
    }
    if (this.shouldUpdateModelDerivedDefault("contextWindowSize")) {
      this._generationConfig.contextWindowSize = tokenLimit(modelId, "input");
      this.generationConfigSources["contextWindowSize"] = {
        kind: "computed",
        detail: "auto-detected from model"
      };
    }
  }
  shouldUpdateModelDerivedDefault(field) {
    const source = this.generationConfigSources[field];
    return source === void 0 || source.kind === "computed" || source.kind === "default" || source.kind === "modelProviders" || source.kind === "programmatic" || source.kind === "unknown";
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
  async switchModel(authType, modelId, options) {
    const runtimeModelSnapshotId = this.extractRuntimeModelSnapshotId(modelId);
    if (runtimeModelSnapshotId) {
      await this.switchToRuntimeModel(runtimeModelSnapshotId);
      return;
    }
    const rollbackSnapshot = this.createStateSnapshotForRollback();
    if (authType === "qwen-oauth" /* QWEN_OAUTH */ && options?.requireCachedCredentials) {
      this.requireCachedQwenCredentialsOnce = true;
    }
    try {
      const isAuthTypeChange = authType !== this.currentAuthType;
      this.currentAuthType = authType;
      const model = this.modelRegistry.getModel(
        authType,
        modelId,
        options?.baseUrl
      );
      if (!model) {
        throw new Error(
          `Model '${modelId}' not found for authType '${authType}'`
        );
      }
      if (model.imageOnly || model.voiceOnly) {
        throw new Error(
          `${model.imageOnly ? "Image" : "Voice"}-only model '${modelId}' cannot be used as the primary model`
        );
      }
      const previousModelId = rollbackSnapshot.generationConfig.model || "";
      const previousAuthType = rollbackSnapshot.currentAuthType;
      const previousModel = previousAuthType && previousModelId ? this.modelRegistry.getModel(
        previousAuthType,
        previousModelId,
        rollbackSnapshot.currentRegistryBaseUrl
      ) ?? this.modelRegistry.getModel(previousAuthType, previousModelId) : void 0;
      const sharesOpenAICredentials = (authType === "openai" /* USE_OPENAI */ || authType === "openai-responses" /* USE_OPENAI_RESPONSES */) && (previousAuthType === "openai" /* USE_OPENAI */ || previousAuthType === "openai-responses" /* USE_OPENAI_RESPONSES */);
      const sameEndpoint = /* @__PURE__ */ __name((a, b) => a === b || isAuthTypeChange && sharesOpenAICredentials && normalizeOpenAiWireBaseUrl(a) === normalizeOpenAiWireBaseUrl(b), "sameEndpoint");
      const canReusePreviousApiKey = authType !== "qwen-oauth" /* QWEN_OAUTH */ && (!isAuthTypeChange || sharesOpenAICredentials && sameEndpoint(
        rollbackSnapshot.generationConfig.baseUrl,
        model.baseUrl
      )) && !!rollbackSnapshot.generationConfig.apiKey && !!model.envKey && previousModel !== void 0 && previousModel.envKey === model.envKey && sameEndpoint(previousModel.baseUrl, model.baseUrl);
      const previousApiKey = canReusePreviousApiKey ? rollbackSnapshot.generationConfig.apiKey : void 0;
      const previousApiKeySource = canReusePreviousApiKey ? rollbackSnapshot.generationConfigSources["apiKey"] : void 0;
      this.applyResolvedModelDefaults(model);
      if (!this._generationConfig.apiKey && previousApiKey) {
        this._generationConfig.apiKey = previousApiKey;
        if (previousApiKeySource) {
          this.generationConfigSources["apiKey"] = _ModelsConfig.deepClone(previousApiKeySource);
        }
      }
      this.activeRuntimeModelSnapshotId = void 0;
      const requiresRefresh = isAuthTypeChange ? true : this.checkRequiresRefresh(previousModelId);
      if (this.onModelChange) {
        await this.onModelChange(authType, requiresRefresh);
      }
    } catch (error) {
      this.rollbackToStateSnapshot(rollbackSnapshot);
      throw error;
    }
  }
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
  buildRuntimeModelSnapshotId(authType, modelId) {
    return buildRuntimeSnapshotId(authType, modelId);
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
  extractRuntimeModelSnapshotId(modelId) {
    if (modelId.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
      if (this.runtimeModelSnapshots.has(modelId)) {
        return modelId;
      }
      return void 0;
    }
    if (this.runtimeModelSnapshots.has(modelId)) {
      return modelId;
    }
    return void 0;
  }
  /**
   * Get generation config for ContentGenerator creation
   */
  getGenerationConfig() {
    return this._generationConfig;
  }
  /**
   * Get generation config sources for debugging/UI
   */
  getGenerationConfigSources() {
    return this.generationConfigSources;
  }
  /**
   * Merge settings generation config, preserving existing values.
   * Used when provider-sourced config is cleared but settings should still apply.
   */
  mergeSettingsGenerationConfig(settingsGenerationConfig) {
    if (!settingsGenerationConfig) {
      return;
    }
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      if (!(field in this._generationConfig) && field in settingsGenerationConfig) {
        this._generationConfig[field] = settingsGenerationConfig[field];
        this.generationConfigSources[field] = {
          kind: "settings",
          detail: `model.generationConfig.${field}`
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
  updateCredentials(credentials, settingsGenerationConfig) {
    if (credentials.apiKey || credentials.baseUrl || credentials.model) {
      this.hasManualCredentials = true;
      this.currentRegistryBaseUrl = void 0;
      this.clearProviderSourcedConfig();
    }
    if (credentials.apiKey) {
      this._generationConfig.apiKey = credentials.apiKey;
      this.generationConfigSources["apiKey"] = {
        kind: "programmatic",
        detail: "updateCredentials"
      };
    }
    if (credentials.baseUrl) {
      this._generationConfig.baseUrl = credentials.baseUrl;
      this.generationConfigSources["baseUrl"] = {
        kind: "programmatic",
        detail: "updateCredentials"
      };
    }
    if (credentials.model) {
      this._generationConfig.model = credentials.model;
      this.generationConfigSources["model"] = {
        kind: "programmatic",
        detail: "updateCredentials"
      };
    }
    this.strictModelProviderSelection = false;
    this._generationConfig.apiKeyEnvKey = void 0;
    if (settingsGenerationConfig) {
      this.mergeSettingsGenerationConfig(settingsGenerationConfig);
    }
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
  syncRuntimeModelSnapshotWithCredentials() {
    const currentAuthType = this.currentAuthType;
    const { model, apiKey, baseUrl } = this._generationConfig;
    if (!model || !currentAuthType || !apiKey || !baseUrl) {
      return;
    }
    if (this.modelRegistry.hasModel(currentAuthType, model, baseUrl)) {
      return;
    }
    if (this.activeRuntimeModelSnapshotId && this.runtimeModelSnapshots.has(this.activeRuntimeModelSnapshotId)) {
      const snapshot = this.runtimeModelSnapshots.get(
        this.activeRuntimeModelSnapshotId
      );
      snapshot.apiKey = apiKey;
      snapshot.baseUrl = baseUrl;
      snapshot.modelId = model;
      const newSnapshotId = this.buildRuntimeModelSnapshotId(
        snapshot.authType,
        snapshot.modelId
      );
      if (newSnapshotId !== snapshot.id) {
        this.runtimeModelSnapshots.delete(snapshot.id);
        snapshot.id = newSnapshotId;
        this.runtimeModelSnapshots.set(newSnapshotId, snapshot);
        this.activeRuntimeModelSnapshotId = newSnapshotId;
      }
      snapshot.createdAt = Date.now();
    } else {
      this.detectAndCaptureRuntimeModel();
    }
  }
  /**
   * Clear configuration fields that were sourced from modelProviders.
   * This ensures provider config atomicity when user manually sets credentials.
   * Other layers (CLI, env, settings, defaults) will participate in resolve.
   */
  clearProviderSourcedConfig() {
    for (const field of PROVIDER_SOURCED_FIELDS) {
      const source = this.generationConfigSources[field];
      if (source?.kind === "modelProviders") {
        delete this._generationConfig[field];
        delete this.generationConfigSources[field];
      }
    }
  }
  /**
   * Get whether strict model provider selection is enabled
   */
  isStrictModelProviderSelection() {
    return this.strictModelProviderSelection;
  }
  /**
   * Reset strict model provider selection flag
   */
  resetStrictModelProviderSelection() {
    this.strictModelProviderSelection = false;
  }
  /**
   * Check and consume the one-shot cached credentials flag
   */
  consumeRequireCachedCredentialsFlag() {
    const value = this.requireCachedQwenCredentialsOnce;
    this.requireCachedQwenCredentialsOnce = false;
    return value;
  }
  /**
   * Apply resolved model config to generation config
   */
  applyResolvedModelDefaults(model) {
    this.strictModelProviderSelection = true;
    this.currentRegistryBaseUrl = model.registryBaseUrl ?? null;
    this.hasManualCredentials = false;
    this._generationConfig.model = model.id;
    this.generationConfigSources["model"] = {
      kind: "modelProviders",
      authType: model.authType,
      modelId: model.id,
      detail: "model.id"
    };
    if (this.currentAuthType === "qwen-oauth" /* QWEN_OAUTH */) {
      this._generationConfig.apiKey = "QWEN_OAUTH_DYNAMIC_TOKEN";
      this.generationConfigSources["apiKey"] = {
        kind: "computed",
        detail: "Qwen OAuth placeholder token"
      };
      this._generationConfig.apiKeyEnvKey = void 0;
      delete this.generationConfigSources["apiKeyEnvKey"];
    } else {
      this._generationConfig.apiKey = void 0;
      this._generationConfig.apiKeyEnvKey = void 0;
    }
    if (model.envKey !== void 0) {
      const apiKey = process2.env[model.envKey];
      if (apiKey) {
        this._generationConfig.apiKey = apiKey;
        this.generationConfigSources["apiKey"] = {
          kind: "env",
          envKey: model.envKey,
          via: {
            kind: "modelProviders",
            authType: model.authType,
            modelId: model.id,
            detail: "envKey"
          }
        };
      } else {
        debugLogger2.debug(
          `No API key found for model "${model.id}": process.env["${model.envKey}"] is ${apiKey === "" ? "empty string" : "not set"}. Run /auth or set ${model.envKey} in your environment.`
        );
      }
      this._generationConfig.apiKeyEnvKey = model.envKey;
      this.generationConfigSources["apiKeyEnvKey"] = {
        kind: "modelProviders",
        authType: model.authType,
        modelId: model.id,
        detail: "envKey"
      };
    }
    this._generationConfig.baseUrl = model.baseUrl;
    this.generationConfigSources["baseUrl"] = {
      kind: "modelProviders",
      authType: model.authType,
      modelId: model.id,
      detail: "baseUrl"
    };
    const gc = model.generationConfig;
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      this._generationConfig[field] = gc[field];
      this.generationConfigSources[field] = {
        kind: "modelProviders",
        authType: model.authType,
        modelId: model.id,
        detail: `generationConfig.${field}`
      };
    }
    if (gc.contextWindowSize === void 0) {
      this._generationConfig.contextWindowSize = tokenLimit(model.id, "input");
      this.generationConfigSources["contextWindowSize"] = {
        kind: "computed",
        detail: "auto-detected from model"
      };
    }
    if (gc.modalities === void 0) {
      this._generationConfig.modalities = defaultModalities(model.id);
      this.generationConfigSources["modalities"] = {
        kind: "computed",
        detail: "auto-detected from model"
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
   * - Qwen OAuth: coder-model switches (same authType, hot-update safe)
   * - OpenAI: model-a -> model-b with same envKey (same authType, hot-update safe)
   * - OpenAI: gpt-4 -> deepseek-chat with different envKey (same authType, needs refresh)
   *
   * Cross-authType scenarios:
   * - OpenAI -> Qwen OAuth: handled by switchModel(authType, modelId), always refreshes
   * - Qwen OAuth -> OpenAI: handled by switchModel(authType, modelId), always refreshes
   */
  checkRequiresRefresh(previousModelId) {
    const authType = this.currentAuthType;
    if (!authType) {
      return true;
    }
    if (authType === "qwen-oauth" /* QWEN_OAUTH */) {
      return false;
    }
    const currentModel = this.modelRegistry.getModel(
      authType,
      this._generationConfig.model || "",
      this._generationConfig.baseUrl || void 0
    );
    const previousModel = this.modelRegistry.getModel(
      authType,
      previousModelId
    );
    if (!previousModel || !currentModel) {
      return true;
    }
    const criticalFieldsChanged = previousModel.envKey !== currentModel.envKey || previousModel.baseUrl !== currentModel.baseUrl;
    if (criticalFieldsChanged) {
      return true;
    }
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
  syncAfterAuthRefresh(authType, modelId, providerBaseUrlOverride) {
    const previousAuthType = this.currentAuthType;
    const providerBaseUrl = providerBaseUrlOverride ?? (previousAuthType === authType && this.currentRegistryBaseUrl !== void 0 ? this.currentRegistryBaseUrl : this.generationConfigSources["baseUrl"]?.kind === "modelProviders" ? this._generationConfig.baseUrl : void 0);
    const wasRegistered = (authType === "openai" /* USE_OPENAI */ || authType === "openai-responses" /* USE_OPENAI_RESPONSES */) && previousAuthType === authType && this.currentRegistryBaseUrl !== void 0 && modelId === this._generationConfig.model;
    const resolved = modelId ? this.modelRegistry.getModel(authType, modelId, providerBaseUrl) ?? this.modelRegistry.getModel(authType, modelId) : void 0;
    if (wasRegistered && !resolved) {
      throw new Error(
        `Model '${modelId}' is no longer configured for authType '${authType}'. Select an available model.`
      );
    }
    if (resolved?.imageOnly || resolved?.voiceOnly) {
      throw new Error(
        `${resolved.imageOnly ? "Image" : "Voice"}-only model '${modelId}' cannot be used as the primary model`
      );
    }
    this.strictModelProviderSelection = false;
    this.currentAuthType = authType;
    if (resolved) {
      const hasBeenApplied = this.generationConfigSources["baseUrl"]?.kind === "modelProviders";
      const isProviderChanged = hasBeenApplied && (this._generationConfig.apiKeyEnvKey !== resolved.envKey || this._generationConfig.baseUrl !== resolved.baseUrl);
      const isUnchanged = previousAuthType === authType && this._generationConfig.model === modelId && !isProviderChanged;
      const savedApiKey = isUnchanged ? this._generationConfig.apiKey : void 0;
      const savedApiKeySource = isUnchanged ? this.generationConfigSources["apiKey"] ? { ...this.generationConfigSources["apiKey"] } : void 0 : void 0;
      const baseUrlSource2 = this.generationConfigSources["baseUrl"];
      const shouldPreserveResolvedBaseUrl = isUnchanged && !!this._generationConfig.baseUrl && (baseUrlSource2?.kind === "cli" || baseUrlSource2?.kind === "env" || baseUrlSource2?.kind === "settings");
      const savedBaseUrl = shouldPreserveResolvedBaseUrl ? this._generationConfig.baseUrl : void 0;
      const savedBaseUrlSource = shouldPreserveResolvedBaseUrl ? baseUrlSource2 ? { ...baseUrlSource2 } : void 0 : void 0;
      this.applyResolvedModelDefaults(resolved);
      if (isUnchanged && !this._generationConfig.apiKey && savedApiKey) {
        this._generationConfig.apiKey = savedApiKey;
        if (savedApiKeySource) {
          this.generationConfigSources["apiKey"] = savedApiKeySource;
        }
      }
      if (savedBaseUrl) {
        this._generationConfig.baseUrl = savedBaseUrl;
        if (savedBaseUrlSource) {
          this.generationConfigSources["baseUrl"] = savedBaseUrlSource;
        }
      }
      this.strictModelProviderSelection = true;
      this.activeRuntimeModelSnapshotId = void 0;
      return;
    }
    const apiKeySource = this.generationConfigSources["apiKey"];
    const baseUrlSource = this.generationConfigSources["baseUrl"];
    const hasExistingCredentials = this._generationConfig.apiKey && apiKeySource?.kind !== "modelProviders" || this._generationConfig.baseUrl && baseUrlSource?.kind !== "modelProviders";
    const isAuthTypeChange = previousAuthType !== authType;
    const shouldPreserveCredentials = !isAuthTypeChange && (modelId === void 0 || !this.modelRegistry.hasModel(authType, modelId)) && (this.hasManualCredentials || hasExistingCredentials);
    if (shouldPreserveCredentials) {
      this.currentRegistryBaseUrl = void 0;
      if (modelId) {
        this._generationConfig.model = modelId;
        if (!this.generationConfigSources["model"]) {
          this.generationConfigSources["model"] = {
            kind: "programmatic",
            detail: "auth refresh (preserved credentials)"
          };
        }
      }
      return;
    }
    const defaultModel = this.modelRegistry.getDefaultModelForAuthType(authType);
    if (defaultModel) {
      this.applyResolvedModelDefaults(defaultModel);
      this.activeRuntimeModelSnapshotId = void 0;
      return;
    }
    if (modelId) {
      this.currentRegistryBaseUrl = void 0;
      this._generationConfig.model = modelId;
      if (!this.generationConfigSources["model"]) {
        this.generationConfigSources["model"] = {
          kind: "programmatic",
          detail: "auth refresh (no default model)"
        };
      }
    }
  }
  /**
   * Update callback for model changes
   */
  setOnModelChange(callback) {
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
  detectAndCaptureRuntimeModel() {
    const {
      model: currentModel,
      apiKey,
      baseUrl,
      apiKeyEnvKey,
      ...generationConfig
    } = this._generationConfig;
    const currentAuthType = this.currentAuthType;
    if (!currentModel || !currentAuthType) {
      return void 0;
    }
    if (this.modelRegistry.hasModel(currentAuthType, currentModel, baseUrl)) {
      this.clearRuntimeModelSnapshotForAuthType(currentAuthType);
      return void 0;
    }
    const hasValidCredentials = this._generationConfig.apiKey && this._generationConfig.baseUrl;
    if (!hasValidCredentials) {
      return void 0;
    }
    const snapshotId = this.buildRuntimeModelSnapshotId(
      currentAuthType,
      currentModel
    );
    const snapshot = {
      id: snapshotId,
      authType: currentAuthType,
      modelId: currentModel,
      apiKey,
      baseUrl,
      apiKeyEnvKey,
      generationConfig,
      sources: { ...this.generationConfigSources },
      createdAt: Date.now()
    };
    this.runtimeModelSnapshots.set(snapshotId, snapshot);
    this.activeRuntimeModelSnapshotId = snapshotId;
    this.currentRegistryBaseUrl = void 0;
    this.cleanupOldRuntimeModelSnapshots();
    return snapshotId;
  }
  /**
   * Get the currently active RuntimeModelSnapshot.
   *
   * @returns The active RuntimeModelSnapshot, or undefined if no runtime model is active
   */
  getActiveRuntimeModelSnapshot() {
    if (!this.activeRuntimeModelSnapshotId) {
      return void 0;
    }
    return this.runtimeModelSnapshots.get(this.activeRuntimeModelSnapshotId);
  }
  /**
   * Get the ID of the currently active RuntimeModelSnapshot.
   *
   * @returns The active snapshot ID, or undefined if no runtime model is active
   */
  getActiveRuntimeModelSnapshotId() {
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
  async switchToRuntimeModel(snapshotId) {
    const runtimeModelSnapshot = this.runtimeModelSnapshots.get(snapshotId);
    if (!runtimeModelSnapshot) {
      throw new Error(`Runtime model snapshot '${snapshotId}' not found`);
    }
    const rollbackSnapshot = this.createStateSnapshotForRollback();
    try {
      const isAuthTypeChange = runtimeModelSnapshot.authType !== this.currentAuthType;
      this.currentAuthType = runtimeModelSnapshot.authType;
      this.activeRuntimeModelSnapshotId = snapshotId;
      this.currentRegistryBaseUrl = void 0;
      this.strictModelProviderSelection = false;
      this.hasManualCredentials = true;
      this._generationConfig.model = runtimeModelSnapshot.modelId;
      this.generationConfigSources["model"] = {
        kind: "programmatic",
        detail: "runtimeModelSwitch"
      };
      if (runtimeModelSnapshot.apiKey) {
        this._generationConfig.apiKey = runtimeModelSnapshot.apiKey;
        this.generationConfigSources["apiKey"] = runtimeModelSnapshot.sources["apiKey"] || {
          kind: "programmatic",
          detail: "runtimeModelSwitch"
        };
      }
      if (runtimeModelSnapshot.baseUrl) {
        this._generationConfig.baseUrl = runtimeModelSnapshot.baseUrl;
        this.generationConfigSources["baseUrl"] = runtimeModelSnapshot.sources["baseUrl"] || {
          kind: "programmatic",
          detail: "runtimeModelSwitch"
        };
      }
      if (runtimeModelSnapshot.apiKeyEnvKey) {
        this._generationConfig.apiKeyEnvKey = runtimeModelSnapshot.apiKeyEnvKey;
      }
      if (runtimeModelSnapshot.generationConfig) {
        Object.assign(
          this._generationConfig,
          runtimeModelSnapshot.generationConfig
        );
      }
      const requiresRefresh = isAuthTypeChange;
      if (this.onModelChange) {
        await this.onModelChange(
          runtimeModelSnapshot.authType,
          requiresRefresh
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
  getRuntimeModelOption() {
    const snapshot = this.getActiveRuntimeModelSnapshot();
    if (!snapshot) {
      return void 0;
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
      runtimeSnapshotId: snapshot.id
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
  clearRuntimeModelSnapshotForAuthType(authType) {
    for (const [id, snapshot] of this.runtimeModelSnapshots.entries()) {
      if (snapshot.authType === authType) {
        this.runtimeModelSnapshots.delete(id);
        if (this.activeRuntimeModelSnapshotId === id) {
          this.activeRuntimeModelSnapshotId = void 0;
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
  cleanupOldRuntimeModelSnapshots() {
    const snapshotsByAuthType = /* @__PURE__ */ new Map();
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
    if (this.activeRuntimeModelSnapshotId && !this.runtimeModelSnapshots.has(this.activeRuntimeModelSnapshotId)) {
      this.activeRuntimeModelSnapshotId = void 0;
    }
  }
  /**
   * Reload model providers configuration at runtime.
   * This enables hot-reloading of modelProviders settings without restarting the CLI.
   *
   * @param modelProvidersConfig - The updated model providers configuration
   * @param providerProtocolConfig - Updated provider->protocol map; `undefined`
   *   preserves the existing map (see {@link ModelRegistry.reloadModels}).
   */
  reloadModelProvidersConfig(modelProvidersConfig, providerProtocolConfig) {
    this.modelRegistry.reloadModels(
      modelProvidersConfig,
      providerProtocolConfig
    );
  }
  /** The raw providers config the registry was last built from. */
  getModelProvidersConfig() {
    return this.modelRegistry.getModelProvidersConfig();
  }
  getProviderProtocolConfig() {
    return this.modelRegistry.getProviderProtocolConfig();
  }
};

// packages/core/src/providers/install.ts
init_esbuild_shims();
import { isDeepStrictEqual } from "node:util";

// packages/core/src/providers/provider-config.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
function resolveEnvKey(config, inputs) {
  const protocol = inputs.protocol ?? config.protocol;
  const key = typeof config.envKey === "function" ? config.envKey(protocol, inputs.baseUrl) : config.envKey;
  return config.id === "custom-openai-compatible" && inputs.advancedConfig?.purpose ? `${key}_${inputs.advancedConfig.purpose.toUpperCase()}` : key;
}
__name(resolveEnvKey, "resolveEnvKey");
function resolveModelNamePrefix(config, baseUrl) {
  return typeof config.modelNamePrefix === "function" ? config.modelNamePrefix(baseUrl) : config.modelNamePrefix;
}
__name(resolveModelNamePrefix, "resolveModelNamePrefix");
function resolveOwnsModel(config) {
  if (config.ownsModel) return config.ownsModel;
  if (typeof config.envKey !== "string" || typeof config.modelNamePrefix !== "string") {
    return void 0;
  }
  const envKey = config.envKey;
  const prefix = config.modelNamePrefix;
  if (!prefix) return (model) => model.envKey === envKey;
  const namePrefix = `[${prefix}] `;
  return (model) => model.envKey === envKey && typeof model.name === "string" && model.name.startsWith(namePrefix);
}
__name(resolveOwnsModel, "resolveOwnsModel");
function buildGenerationConfig(spec, protocol) {
  const parts = {};
  let hasAny = false;
  if (spec.enableThinking) {
    if (protocol === "openai-responses" /* USE_OPENAI_RESPONSES */) {
      parts.reasoning = { effort: "medium" };
    } else {
      parts.extra_body = { enable_thinking: true };
    }
    hasAny = true;
  }
  if (spec.thinkingMandatory) {
    parts.thinkingMandatory = true;
    hasAny = true;
  }
  if (spec.contextWindowSize) {
    parts.contextWindowSize = spec.contextWindowSize;
    hasAny = true;
  }
  if (spec.modalities && Object.values(spec.modalities).some(Boolean)) {
    parts.modalities = spec.modalities;
    hasAny = true;
  }
  return hasAny ? parts : void 0;
}
__name(buildGenerationConfig, "buildGenerationConfig");
function buildAdvancedGenerationConfig(advCfg, protocol) {
  const cfg = {};
  let hasAny = false;
  if (advCfg?.enableThinking) {
    if (protocol === "openai-responses" /* USE_OPENAI_RESPONSES */) {
      cfg.reasoning = { effort: "medium" };
    } else {
      cfg.extra_body = { enable_thinking: true };
    }
    hasAny = true;
  }
  if (advCfg?.multimodal && Object.values(advCfg.multimodal).some(Boolean)) {
    cfg.modalities = advCfg.multimodal;
    hasAny = true;
  }
  if (advCfg?.contextWindowSize && advCfg.contextWindowSize > 0) {
    cfg.contextWindowSize = advCfg.contextWindowSize;
    hasAny = true;
  }
  if (advCfg?.maxTokens && advCfg.maxTokens > 0) {
    cfg.samplingParams = { max_tokens: advCfg.maxTokens };
    hasAny = true;
  }
  return hasAny ? cfg : void 0;
}
__name(buildAdvancedGenerationConfig, "buildAdvancedGenerationConfig");
function specToModelConfig(spec, prefix, baseUrl, envKey, protocol) {
  const genConfig = buildGenerationConfig(spec, protocol);
  return {
    id: spec.id,
    name: prefix ? `[${prefix}] ${spec.id}` : spec.id,
    ...spec.description ? { description: spec.description } : {},
    ...spec.capabilities ? { capabilities: spec.capabilities } : {},
    baseUrl,
    envKey,
    ...spec.supportsImageGeneration ? { supportsImageGeneration: true } : {},
    ...spec.imageOnly ? { imageOnly: true } : {},
    ...genConfig ? { generationConfig: genConfig } : {}
  };
}
__name(specToModelConfig, "specToModelConfig");
function applyProviderCustomHeaders(models, config) {
  if (!config.customHeaders) return models;
  return models.map((model) => {
    const existing = model.generationConfig ?? {};
    return {
      ...model,
      generationConfig: {
        ...existing,
        customHeaders: {
          ...config.customHeaders,
          ...existing.customHeaders
        }
      }
    };
  });
}
__name(applyProviderCustomHeaders, "applyProviderCustomHeaders");
function buildModelConfigs(config, inputs) {
  const envKey = resolveEnvKey(config, inputs);
  const prefix = resolveModelNamePrefix(config, inputs.baseUrl);
  const protocol = resolveModelProtocol(
    inputs.protocol ?? config.protocol,
    inputs
  );
  let models;
  if (config.models && !config.modelsEditable) {
    models = config.models.map(
      (spec) => specToModelConfig(spec, prefix, inputs.baseUrl, envKey, protocol)
    );
  } else if (config.models && config.modelsEditable) {
    const specMap = new Map(config.models.map((s) => [s.id.toLowerCase(), s]));
    models = inputs.modelIds.map((id) => {
      const spec = specMap.get(id.toLowerCase());
      if (spec) {
        return specToModelConfig(
          { ...spec, id },
          prefix,
          inputs.baseUrl,
          envKey,
          protocol
        );
      }
      const genConfig = buildAdvancedGenerationConfig(
        inputs.advancedConfig,
        protocol
      );
      return {
        id,
        name: prefix ? `[${prefix}] ${id}` : id,
        baseUrl: inputs.baseUrl,
        envKey,
        ...genConfig ? { generationConfig: genConfig } : {}
      };
    });
  } else {
    const advCfg = inputs.advancedConfig;
    const displayName = /* @__PURE__ */ __name((id) => prefix ? `[${prefix}] ${id}` : id, "displayName");
    models = inputs.modelIds.map((id) => {
      const genConfig = buildAdvancedGenerationConfig(advCfg, protocol);
      return {
        id,
        name: displayName(id),
        baseUrl: inputs.baseUrl,
        envKey,
        ...advCfg?.purpose === "image" ? { supportsImageGeneration: true, imageOnly: true } : advCfg?.purpose === "voice" ? { voiceOnly: true } : {},
        ...genConfig ? { generationConfig: genConfig } : {}
      };
    });
  }
  return applyProviderCustomHeaders(models, config);
}
__name(buildModelConfigs, "buildModelConfigs");
function resolveMetadataKey(config) {
  if (!config.models) return void 0;
  if (config.id.includes(".")) {
    throw new Error(
      `Provider id must not contain '.' (would corrupt providerMetadata.${config.id} dotted writes): ${config.id}`
    );
  }
  return config.id;
}
__name(resolveMetadataKey, "resolveMetadataKey");
var PROVIDER_METADATA_NS = "providerMetadata";
function resolveProviderState(config, baseUrl, models) {
  const key = resolveMetadataKey(config);
  if (key) {
    return {
      [`${PROVIDER_METADATA_NS}.${key}`]: {
        version: computeModelListVersion(models),
        baseUrl
      }
    };
  }
  return void 0;
}
__name(resolveProviderState, "resolveProviderState");
function retireProviderState(config) {
  const key = resolveMetadataKey(config);
  return key ? { [`${PROVIDER_METADATA_NS}.${key}`]: { version: void 0 } } : void 0;
}
__name(retireProviderState, "retireProviderState");
function buildInstallPlan(config, inputs, existingModels = [], selection) {
  const inputProtocol = inputs.protocol ?? config.protocol;
  const protocol = resolveModelProtocol(inputProtocol, inputs);
  const isOpenAI = protocol === "openai" /* USE_OPENAI */ || protocol === "openai-responses" /* USE_OPENAI_RESPONSES */;
  const savedProtocol = isOpenAI ? "openai" /* USE_OPENAI */ : protocol;
  const wireApi = inputs.wireApi ?? (inputProtocol === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "responses" : void 0);
  if (inputProtocol === "openai-responses" /* USE_OPENAI_RESPONSES */) {
    inputs = { ...inputs, protocol: savedProtocol, wireApi };
  }
  let envKey = resolveEnvKey(config, inputs);
  const providerOwns = resolveOwnsModel(config);
  const builtModels = inputs.prebuiltModels ?? buildModelConfigs(config, inputs);
  const preserveSavedApis = isOpenAI && !config.protocolOptions && wireApi === void 0;
  let models = wireApi ? builtModels.map(
    (model) => model.wireApi === void 0 ? { ...model, wireApi } : model
  ) : builtModels;
  if (preserveSavedApis && existingModels.length) {
    const responsesModels = inputs.prebuiltModels ?? buildModelConfigs(config, {
      ...inputs,
      wireApi: "responses"
    });
    models = builtModels.flatMap((model, index) => {
      if (model.wireApi !== void 0) return [model];
      const saved = existingModels.filter(
        (entry) => providerOwns?.(entry) && entry.id === model.id && entry.baseUrl === model.baseUrl && tryResolveModelProtocol(savedProtocol, entry) !== void 0
      );
      if (!saved.length) return [model];
      const seen = /* @__PURE__ */ new Set();
      return saved.flatMap((entry) => {
        const route = resolveModelProtocol(savedProtocol, entry);
        if (seen.has(route)) return [];
        seen.add(route);
        return [
          {
            ...route === "openai-responses" /* USE_OPENAI_RESPONSES */ ? responsesModels[index] : model,
            ...entry.wireApi !== void 0 ? { wireApi: entry.wireApi } : {}
          }
        ];
      });
    });
  }
  const providerState = resolveProviderState(config, inputs.baseUrl, models);
  if (config.id === "custom-openai-compatible" && existingModels?.some(
    (entry) => providerOwns?.(entry) && (entry.imageOnly || entry.voiceOnly) && models.some((model) => model.id === entry.id) && typeof entry.baseUrl === "string" && entry.baseUrl !== inputs.baseUrl && resolveEnvKey(config, { ...inputs, baseUrl: entry.baseUrl }) === envKey
  )) {
    throw new ProviderInstallError(
      "A service model already uses this credential endpoint. Reconnect using its exact saved base URL.",
      "modelPurpose",
      protocol
    );
  }
  if (existingModels?.length && !inputs.advancedConfig?.purpose) {
    models = models.map((model) => {
      const existing = existingModels.find(
        (entry) => (providerOwns?.(entry) || config.mergeModelsByIdentity) && entry.id === model.id && entry.baseUrl === model.baseUrl && tryResolveModelProtocol(savedProtocol, entry) === resolveModelProtocol(savedProtocol, model)
      );
      if (!existing) return model;
      const preservedGeneration = { ...existing.generationConfig };
      const advanced = inputs.advancedConfig;
      if (!config.models && advanced) {
        if (advanced.replaceExisting) {
          delete preservedGeneration.contextWindowSize;
          if (preservedGeneration.samplingParams) {
            preservedGeneration.samplingParams = {
              ...preservedGeneration.samplingParams
            };
            delete preservedGeneration.samplingParams.max_tokens;
            if (!Object.keys(preservedGeneration.samplingParams).length)
              delete preservedGeneration.samplingParams;
          }
        }
        if (advanced.replaceExisting || advanced.multimodal !== void 0)
          delete preservedGeneration.modalities;
        if (advanced.replaceExisting || advanced.enableThinking !== void 0) {
          if (preservedGeneration.extra_body) {
            preservedGeneration.extra_body = {
              ...preservedGeneration.extra_body
            };
            delete preservedGeneration.extra_body["enable_thinking"];
            if (!Object.keys(preservedGeneration.extra_body).length)
              delete preservedGeneration.extra_body;
          }
          if (protocol === "openai-responses" /* USE_OPENAI_RESPONSES */)
            delete preservedGeneration.reasoning;
        }
      }
      const generationConfig = Object.keys(preservedGeneration).length || model.generationConfig ? {
        ...preservedGeneration,
        ...model.generationConfig,
        ...preservedGeneration.extra_body || model.generationConfig?.extra_body ? {
          extra_body: {
            ...preservedGeneration.extra_body,
            ...model.generationConfig?.extra_body
          }
        } : {},
        ...preservedGeneration.contextWindowSize !== void 0 && inputs.advancedConfig?.contextWindowSize === void 0 ? {
          contextWindowSize: preservedGeneration.contextWindowSize
        } : {},
        ...preservedGeneration.samplingParams || model.generationConfig?.samplingParams ? {
          samplingParams: {
            ...preservedGeneration.samplingParams,
            ...model.generationConfig?.samplingParams
          }
        } : {},
        ...preservedGeneration.customHeaders || model.generationConfig?.customHeaders ? {
          customHeaders: {
            ...preservedGeneration.customHeaders,
            ...model.generationConfig?.customHeaders
          }
        } : {}
      } : void 0;
      return {
        ...existing,
        ...model,
        name: existing?.name ?? model.name,
        generationConfig,
        ...existing?.supportsImageGeneration ? { supportsImageGeneration: true } : {},
        ...existing?.imageOnly ? { imageOnly: true } : {},
        ...existing?.voiceOnly ? { voiceOnly: true } : {},
        ...existing.envKey ? { envKey: existing.envKey } : {}
      };
    });
  }
  if (models.length > 0) {
    const conversation = models.filter(
      (model) => !model.imageOnly && !model.voiceOnly
    );
    const credentialModels = conversation.length ? conversation : models;
    const keys = new Set(credentialModels.map((model) => model.envKey));
    if (keys.size > 1 && inputs.apiKey) {
      throw new Error(
        "Reconnect models with different credential references separately to preserve their independent API keys."
      );
    }
    if (credentialModels[0]?.envKey) envKey = credentialModels[0].envKey;
  }
  const ownsModel = config.mergeModelsByIdentity ? void 0 : resolveOwnsModel(config);
  for (const model of models) {
    const modelProtocol = resolveModelProtocol(savedProtocol, model);
    if (model.voiceOnly && modelProtocol !== "openai" /* USE_OPENAI */) {
      throw new ProviderInstallError(
        "Voice transcription requires the OpenAI Chat Completions API.",
        "modelPurpose",
        protocol
      );
    }
  }
  const selectedModels = preserveSavedApis && selection?.id ? models.filter(
    (model) => !model.imageOnly && !model.voiceOnly && model.id === selection.id && (!selection.baseUrl || model.baseUrl === selection.baseUrl)
  ) : [];
  const firstModel = selectedModels.find(
    (model) => resolveModelProtocol(savedProtocol, model) === selection?.authType
  ) ?? selectedModels[0] ?? models.find((model) => !model.imageOnly && !model.voiceOnly);
  if (models.length === 0) {
    throw new Error(
      `No models configured for provider "${config.id}". Check model list or provider configuration.`
    );
  }
  const firstModelId = firstModel?.id;
  const modelSelection = firstModelId === void 0 ? void 0 : {
    modelId: firstModelId,
    ...config.mergeModelsByIdentity && firstModel?.baseUrl ? { baseUrl: firstModel.baseUrl } : {}
  };
  return {
    providerId: config.id,
    authType: firstModel ? resolveModelProtocol(savedProtocol, firstModel) : savedProtocol,
    env: { [envKey]: inputs.apiKey },
    ...modelSelection ? { modelSelection } : {},
    modelProviders: [
      {
        authType: savedProtocol,
        models,
        mergeStrategy: "prepend-and-remove-owned",
        ...ownsModel ? { ownsModel } : {}
      }
    ],
    // The drift check (findAllPendingUpdates) rebuilds the reference version
    // from the provider's own protocol template, which never stamps `wireApi`, so
    // any stamped install — on either wire — records nothing. Skipping alone
    // would let a version from an earlier default-route install survive, so
    // the retire shape deletes it instead.
    providerState: models.every((model) => model.wireApi === void 0) && protocol === config.protocol ? providerState : retireProviderState(config)
  };
}
__name(buildInstallPlan, "buildInstallPlan");
function computeModelListVersion(models) {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}
__name(computeModelListVersion, "computeModelListVersion");
var DEFAULT_BASE_URLS = {
  ["openai" /* USE_OPENAI */]: "https://api.openai.com/v1",
  ["openai-responses" /* USE_OPENAI_RESPONSES */]: "https://api.openai.com",
  ["anthropic" /* USE_ANTHROPIC */]: "https://api.anthropic.com/v1",
  ["gemini" /* USE_GEMINI */]: "https://generativelanguage.googleapis.com"
};
function getDefaultBaseUrlForProtocol(protocol) {
  if (protocol === void 0) return "";
  return DEFAULT_BASE_URLS[protocol] ?? "";
}
__name(getDefaultBaseUrlForProtocol, "getDefaultBaseUrlForProtocol");
function resolveBaseUrl(config, selectedBaseUrl) {
  if (typeof config.baseUrl === "string") {
    return config.baseUrl;
  }
  if (Array.isArray(config.baseUrl)) {
    const normalizedSelectedBaseUrl = normalizeBaseUrlForMatching(selectedBaseUrl);
    const match = config.baseUrl.find(
      (opt) => normalizeBaseUrlForMatching(opt.url) === normalizedSelectedBaseUrl
    );
    if (match) return match.url;
    return config.baseUrl[0]?.url ?? selectedBaseUrl ?? "";
  }
  return selectedBaseUrl ?? "";
}
__name(resolveBaseUrl, "resolveBaseUrl");
function normalizeBaseUrlForMatching(baseUrl) {
  if (baseUrl === void 0) return "";
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === baseUrl.length ? baseUrl : baseUrl.slice(0, end);
}
__name(normalizeBaseUrlForMatching, "normalizeBaseUrlForMatching");
function getDefaultModelIds(config) {
  return config.models?.map((s) => s.id) ?? [];
}
__name(getDefaultModelIds, "getDefaultModelIds");
function isProviderModelConfig(value) {
  return typeof value === "object" && value !== null && typeof value.id === "string";
}
__name(isProviderModelConfig, "isProviderModelConfig");
function getModelsForProviderProtocol(modelProviders, protocol, providerProtocol) {
  const canonicalProtocol = protocol === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "openai" /* USE_OPENAI */ : protocol;
  const result = [];
  for (const [providerId, raw] of Object.entries(modelProviders ?? {})) {
    if (!Array.isArray(raw)) continue;
    for (const model of raw) {
      if (!isProviderModelConfig(model)) continue;
      const effective = tryResolveModelProtocol(
        providerId,
        model,
        providerProtocol
      );
      if (effective !== canonicalProtocol && !(canonicalProtocol === "openai" /* USE_OPENAI */ && effective === "openai-responses" /* USE_OPENAI_RESPONSES */))
        continue;
      result.push(
        effective === "openai-responses" /* USE_OPENAI_RESPONSES */ ? { ...model, wireApi: "responses" } : canonicalProtocol === "openai" /* USE_OPENAI */ && providerId !== canonicalProtocol ? { ...model, wireApi: "chat-completions" } : model
      );
    }
  }
  return result;
}
__name(getModelsForProviderProtocol, "getModelsForProviderProtocol");
function findExistingProviderModels(config, modelProviders, mapping, selection) {
  const ownsModel = resolveOwnsModel(config);
  if (!ownsModel || !modelProviders) return void 0;
  const protocols = config.protocolOptions?.length ? config.protocolOptions : [config.protocol];
  for (const providerProtocol of protocols) {
    const models = getModelsForProviderProtocol(
      modelProviders,
      providerProtocol,
      mapping
    ).filter(ownsModel);
    if (!models.length) continue;
    const selectedModels = selection?.id ? models.filter(
      (model) => model.id === selection.id && (!selection.baseUrl || model.baseUrl === selection.baseUrl)
    ) : [];
    const selected = selectedModels.find(
      (model) => resolveModelProtocol(providerProtocol, model) === selection?.authType
    ) ?? selectedModels[0] ?? models[0];
    const protocol = resolveModelProtocol(providerProtocol, selected);
    return {
      protocol,
      models: models.filter(
        (model) => resolveModelProtocol(providerProtocol, model) === protocol
      )
    };
  }
  return void 0;
}
__name(findExistingProviderModels, "findExistingProviderModels");
function shouldShowStep(config, step, protocol = config.protocol) {
  switch (step) {
    case "protocol":
      return Array.isArray(config.protocolOptions) && config.protocolOptions.length > 1;
    case "wireApi":
      return Boolean(config.protocolOptions?.length) && (protocol === "openai" /* USE_OPENAI */ || protocol === "openai-responses" /* USE_OPENAI_RESPONSES */);
    case "baseUrl":
      return config.baseUrl === void 0 || Array.isArray(config.baseUrl);
    case "apiKey":
      return true;
    case "models":
      return !config.models || config.modelsEditable === true;
    case "advancedConfig":
      return config.showAdvancedConfig === true;
    default:
      return false;
  }
}
__name(shouldShowStep, "shouldShowStep");
function providerMatchesCredentials(config, baseUrl, envKey) {
  let configEnvKey;
  if (typeof config.envKey === "string") {
    configEnvKey = config.envKey;
  } else if (typeof config.envKey === "function" && baseUrl) {
    const protocols = config.protocolOptions?.length ? config.protocolOptions : [config.protocol];
    for (const proto of protocols) {
      try {
        const derived = config.envKey(proto, baseUrl);
        if (derived === envKey || config.id === "custom-openai-compatible" && (envKey === `${derived}_IMAGE` || envKey === `${derived}_VOICE`)) {
          configEnvKey = envKey;
          break;
        }
      } catch (err) {
        let safeHost;
        try {
          safeHost = new URL(baseUrl).hostname;
        } catch {
          safeHost = "[invalid]";
        }
        console.warn(
          `[providerMatchesCredentials] envKey(${proto}, ${safeHost}) threw (${err instanceof Error ? err.constructor.name : typeof err}); skipping this protocol`
        );
      }
    }
  }
  if (configEnvKey !== envKey) {
    return false;
  }
  if (typeof config.baseUrl === "string") {
    return config.baseUrl === baseUrl;
  }
  if (Array.isArray(config.baseUrl)) {
    return config.baseUrl.some((opt) => opt.url === baseUrl);
  }
  if (config.baseUrl === void 0 && configEnvKey !== void 0) {
    return Boolean(baseUrl);
  }
  return false;
}
__name(providerMatchesCredentials, "providerMatchesCredentials");
function buildProviderTemplate(config, baseUrl) {
  const resolved = resolveBaseUrl(config, baseUrl);
  return buildModelConfigs(config, {
    baseUrl: resolved,
    apiKey: "",
    modelIds: getDefaultModelIds(config)
  });
}
__name(buildProviderTemplate, "buildProviderTemplate");

// packages/core/src/providers/install.ts
var DENY_ENV_KEYS = /* @__PURE__ */ new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  // Windows temp redirect
  "TEMP"
  // Windows temp redirect
]);
function isSameModelIdentity(a, b) {
  return a.id === b.id && (a.baseUrl ?? "") === (b.baseUrl ?? "");
}
__name(isSameModelIdentity, "isSameModelIdentity");
function applyModelProvidersPatch(existingModelProviders, patch, mapping) {
  if (patch.authType === "openai" /* USE_OPENAI */ && resolveProviderProtocol(patch.authType, mapping) === "openai-responses" /* USE_OPENAI_RESPONSES */) {
    patch = {
      ...patch,
      models: patch.models.map((model) => ({
        ...model,
        wireApi: model.wireApi ?? "chat-completions"
      }))
    };
  }
  const existingModels = existingModelProviders[patch.authType] ?? [];
  let updatedModels = patch.models;
  if (patch.mergeStrategy === "append") {
    updatedModels = [...existingModels, ...patch.models];
  } else {
    const ownsModel = patch.ownsModel;
    const preservedModels = existingModels.filter((model) => {
      if (ownsModel) {
        return !ownsModel(model) || !patch.models.some(
          (newModel) => resolveModelProtocol(patch.authType, newModel) === tryResolveModelProtocol(patch.authType, model, mapping)
        );
      }
      return !patch.models.some(
        (newModel) => isSameModelIdentity(newModel, model) && resolveModelProtocol(patch.authType, newModel) === tryResolveModelProtocol(patch.authType, model, mapping)
      );
    });
    updatedModels = patch.mergeStrategy === "replace-owned" ? [...preservedModels, ...patch.models] : [...patch.models, ...preservedModels];
  }
  return {
    ...existingModelProviders,
    [patch.authType]: updatedModels
  };
}
__name(applyModelProvidersPatch, "applyModelProvidersPatch");
var ProviderInstallError = class extends Error {
  static {
    __name(this, "ProviderInstallError");
  }
  step;
  authType;
  constructor(message, step, authType, options) {
    super(message, options);
    this.name = "ProviderInstallError";
    this.step = step;
    this.authType = authType;
  }
};
async function applyProviderInstallPlan(plan, options) {
  const {
    settings,
    reloadModelProviders,
    syncAuthState,
    refreshAuth,
    doRefreshAuth = true
  } = options;
  const selectedAuthType = settings.getValue("security.auth.selectedType");
  const mapping = settings.getValue("providerProtocol");
  const serviceOnly = (plan.modelProviders ?? []).flatMap(
    (patch) => patch.models
  );
  const preserveSelection = serviceOnly.length > 0 && serviceOnly.every((model) => model.imageOnly || model.voiceOnly);
  const previousEnvValues = /* @__PURE__ */ new Map();
  const previousRuntimeProviders = {
    ...settings.getModelProviders()
  };
  const writeContext = settings.getModelProvidersForWrite?.();
  const writeMapping = writeContext ? writeContext.providerProtocol : mapping;
  for (const [providerId, models] of Object.entries(
    writeContext?.modelProviders ?? {}
  )) {
    if (!Array.isArray(models)) continue;
    if (providerId !== "openai-responses" /* USE_OPENAI_RESPONSES */ && resolveProviderProtocol(providerId, writeMapping) !== "openai-responses" /* USE_OPENAI_RESPONSES */)
      continue;
    const overwritten = models.filter(
      (existing) => plan.modelProviders?.some(
        (patch) => patch.authType === "openai" /* USE_OPENAI */ && patch.models.some(
          (model) => isSameModelIdentity(existing, model) && tryResolveModelProtocol(providerId, existing, writeMapping) === resolveModelProtocol(patch.authType, model)
        )
      )
    );
    if (overwritten.length && (writeContext?.shadowedProviders.includes(providerId) || overwritten.some(
      (model) => tryResolveModelProtocol(providerId, model, writeMapping) !== tryResolveModelProtocol(providerId, model, mapping)
    ))) {
      throw new ProviderInstallError(
        "A higher-precedence settings scope overrides this released provider declaration. Reconfigure it in the owning scope without that override.",
        "modelProviders",
        plan.authType
      );
    }
  }
  for (const patch of plan.modelProviders ?? []) {
    const existingModels = getModelsForProviderProtocol(
      previousRuntimeProviders,
      patch.authType,
      mapping
    );
    const ownBucketModels = previousRuntimeProviders[patch.authType] ?? [];
    const changesRole = existingModels.some(
      (existing) => patch.models.some(
        (model) => (isSameModelIdentity(existing, model) || existing.id === model.id && patch.ownsModel?.(existing) && (preserveSelection || patch.mergeStrategy !== "append")) && (Boolean(existing.imageOnly) !== Boolean(model.imageOnly) || Boolean(existing.voiceOnly) !== Boolean(model.voiceOnly) || isImageGenerationCapable(existing) && !isImageGenerationCapable(model))
      )
    );
    const removesConversation = preserveSelection && ownBucketModels.some(
      (existing) => !existing.imageOnly && !existing.voiceOnly && (patch.ownsModel?.(existing) ?? patch.models.some((model) => isSameModelIdentity(existing, model)))
    );
    const removesService = !preserveSelection && patch.mergeStrategy !== "append" && ownBucketModels.some(
      (existing) => (existing.imageOnly || existing.voiceOnly) && patch.ownsModel?.(existing) && !patch.models.some((model) => model.id === existing.id)
    );
    if (changesRole || removesConversation || removesService) {
      throw new ProviderInstallError(
        removesConversation ? "This install would remove existing conversation models. Include them in the provider selection, or add the service model with Custom Provider." : removesService ? "This install would remove existing service models. Include them in the provider selection, or add the conversation model with Custom Provider." : "This install would replace a model configured for another purpose. Use a different model ID or endpoint.",
        "modelPurpose",
        plan.authType
      );
    }
  }
  const voiceIds = new Set(
    [
      ...Object.values(previousRuntimeProviders).flatMap(
        (models) => Array.isArray(models) ? models : []
      ),
      ...serviceOnly
    ].filter((model) => model?.voiceOnly).map((model) => model.id)
  );
  const selectedVoice = settings.getValue("voiceModel");
  if (typeof selectedVoice === "string" && selectedVoice)
    voiceIds.add(selectedVoice);
  const changedVoiceIds = [...voiceIds].filter(
    (id) => plan.modelProviders?.some(
      (patch) => patch.models.some((model) => model.id === id)
    )
  );
  if (changedVoiceIds.length) {
    let prospective = previousRuntimeProviders;
    for (const patch of plan.modelProviders ?? []) {
      prospective = applyModelProvidersPatch(prospective, patch, mapping);
    }
    const configured = new ModelsConfig({
      modelProvidersConfig: Object.fromEntries(
        Object.entries(prospective).map(([providerId, models]) => [
          providerId,
          Array.isArray(models) ? models.filter(
            (model) => tryResolveModelProtocol(providerId, model, mapping) !== void 0
          ) : models
        ])
      ),
      providerProtocolConfig: mapping
    }).getAllConfiguredModels();
    if (changedVoiceIds.some(
      (id) => configured.filter((entry) => entry.id === id).length > 1
    )) {
      throw new ProviderInstallError(
        "A voice model with this ID is already configured at another endpoint. Edit that model or use a different model ID.",
        "modelPurpose",
        plan.authType
      );
    }
  }
  const previousModelId = settings.getValue("model.name");
  const previousBaseUrl = settings.getValue("model.baseUrl");
  let currentStep = "init";
  try {
    currentStep = "backup";
    settings.backup?.();
    currentStep = "env";
    const shadowedEnvKeys = [];
    for (const [key, value] of Object.entries(plan.env ?? {})) {
      if (DENY_ENV_KEYS.has(key.toUpperCase())) {
        throw new Error(
          `Install plan must not set reserved environment variable: ${key}`
        );
      }
      const previous = process.env[key];
      if (previous !== void 0 && previous !== "" && previous !== value) {
        shadowedEnvKeys.push(key);
      }
      previousEnvValues.set(key, previous);
      settings.setValue(`env.${key}`, value);
      process.env[key] = value;
    }
    if (shadowedEnvKeys.length > 0) {
      console.error(
        `[auth] Warning: ${shadowedEnvKeys.join(", ")} ${shadowedEnvKeys.length === 1 ? "is" : "are"} also set in your shell environment or .env file. The shell/file value will take priority on restart. To ensure your new key is used, update or remove the variable from your shell profile or .env file.`
      );
    }
    currentStep = "modelProviders";
    let updatedModelProviders = {
      ...previousRuntimeProviders
    };
    for (const patch of plan.modelProviders ?? []) {
      updatedModelProviders = applyModelProvidersPatch(
        updatedModelProviders,
        preserveSelection ? {
          ...patch,
          mergeStrategy: "replace-owned",
          ownsModel: /* @__PURE__ */ __name((existing) => (patch.ownsModel?.(existing) ?? false) || patch.models.some(
            (model) => isSameModelIdentity(existing, model)
          ), "ownsModel")
        } : patch,
        mapping
      );
      settings.setValue(
        `modelProviders.${patch.authType}`,
        updatedModelProviders[patch.authType] ?? []
      );
      if (patch.authType !== "openai" /* USE_OPENAI */) continue;
      const ownProviders = settings.getModelProvidersForWrite?.().modelProviders ?? settings.getModelProviders();
      for (const [providerId, models] of Object.entries(ownProviders)) {
        if (providerId === patch.authType || !Array.isArray(models)) continue;
        if (providerId.includes(".")) continue;
        if (providerId !== "openai-responses" /* USE_OPENAI_RESPONSES */ && resolveProviderProtocol(providerId, writeMapping) !== "openai-responses" /* USE_OPENAI_RESPONSES */)
          continue;
        const remaining = models.filter(
          (existing) => !patch.models.some(
            (model) => isSameModelIdentity(existing, model) && tryResolveModelProtocol(providerId, existing, writeMapping) === resolveModelProtocol(patch.authType, model)
          )
        );
        if (remaining.length !== models.length)
          settings.setValue(`modelProviders.${providerId}`, remaining);
      }
    }
    const effectiveProviders = settings.getModelProviders();
    for (const patch of plan.modelProviders ?? []) {
      const effectiveModels = getModelsForProviderProtocol(
        effectiveProviders,
        patch.authType,
        mapping
      );
      const expectedModels = getModelsForProviderProtocol(
        { [patch.authType]: patch.models },
        patch.authType
      );
      const ownProviders = settings.getModelProvidersForWrite?.().modelProviders;
      const installedModels = ownProviders ? getModelsForProviderProtocol(
        { [patch.authType]: ownProviders[patch.authType] ?? [] },
        patch.authType,
        mapping
      ) : expectedModels;
      if (expectedModels.some((model) => {
        const winner = effectiveModels.find(
          (effective) => isSameModelIdentity(model, effective) && resolveModelProtocol(patch.authType, model) === resolveModelProtocol(patch.authType, effective)
        );
        const installed = installedModels.find(
          (entry) => isSameModelIdentity(model, entry) && resolveModelProtocol(patch.authType, model) === resolveModelProtocol(patch.authType, entry)
        );
        return !winner || !installed || !isDeepStrictEqual(
          JSON.parse(JSON.stringify({ ...installed, wireApi: void 0 })),
          JSON.parse(JSON.stringify({ ...winner, wireApi: void 0 }))
        );
      })) {
        throw new ProviderInstallError(
          "A higher-precedence settings scope overrides the installed models. Update the scope that owns this provider.",
          "modelProviders",
          plan.authType
        );
      }
    }
    currentStep = "authType";
    if (!preserveSelection) {
      settings.setValue("security.auth.selectedType", plan.authType);
    }
    currentStep = "legacyCredentials";
    if (plan.legacyCredentials?.apiKey != null) {
      settings.setValue("security.auth.apiKey", plan.legacyCredentials.apiKey);
    }
    if (plan.legacyCredentials?.baseUrl != null) {
      settings.setValue(
        "security.auth.baseUrl",
        plan.legacyCredentials.baseUrl
      );
    }
    currentStep = "modelSelection";
    let effectiveModelSelection = preserveSelection ? void 0 : plan.modelSelection;
    let routeResyncSelection;
    if (effectiveModelSelection?.modelId) {
      const currentModelId = settings.getValue("model.name");
      const currentBaseUrl = settings.getValue("model.baseUrl");
      const planOffersCurrentModel = typeof currentModelId === "string" && currentModelId.length > 0 && (plan.modelProviders ?? []).some(
        (patch) => patch.models.some(
          (model) => resolveModelProtocol(patch.authType, model) === plan.authType && (currentBaseUrl === "" || currentBaseUrl === void 0 ? model.id === currentModelId : isSameModelIdentity(
            { id: currentModelId, baseUrl: currentBaseUrl },
            model
          ))
        )
      );
      if (planOffersCurrentModel) {
        effectiveModelSelection = void 0;
        let previousAuthType;
        if ((plan.authType === "openai" /* USE_OPENAI */ || plan.authType === "openai-responses" /* USE_OPENAI_RESPONSES */) && typeof selectedAuthType === "string") {
          try {
            previousAuthType = resolveModelSelectionAuthType(
              selectedAuthType,
              typeof previousModelId === "string" ? previousModelId : void 0,
              previousRuntimeProviders,
              settings.getValue("providerProtocol"),
              typeof previousBaseUrl === "string" ? previousBaseUrl : void 0
            );
          } catch {
            previousAuthType = void 0;
          }
        }
        if (previousAuthType !== void 0 && previousAuthType !== plan.authType) {
          routeResyncSelection = {
            modelId: currentModelId,
            ...currentBaseUrl ? { baseUrl: currentBaseUrl } : {}
          };
        }
      }
    }
    if (effectiveModelSelection?.modelId) {
      settings.setValue("model.name", effectiveModelSelection.modelId);
      if (effectiveModelSelection.baseUrl) {
        settings.setValue("model.baseUrl", effectiveModelSelection.baseUrl);
      } else {
        settings.setValue("model.baseUrl", "");
      }
    }
    currentStep = "providerState";
    for (const [key, entries] of Object.entries(plan.providerState ?? {})) {
      for (const [field, value] of Object.entries(entries)) {
        settings.setValue(`${key}.${field}`, value);
      }
    }
    currentStep = "persist";
    settings.persist();
    currentStep = "reloadModelProviders";
    updatedModelProviders = settings.getModelProviders();
    reloadModelProviders?.(updatedModelProviders);
    const syncSelection = effectiveModelSelection?.modelId ? effectiveModelSelection : routeResyncSelection;
    if (syncSelection) {
      currentStep = "syncAuthState";
      syncAuthState?.(
        plan.authType,
        syncSelection.modelId,
        syncSelection.baseUrl
      );
    }
    if (!preserveSelection && doRefreshAuth && refreshAuth) {
      currentStep = "refreshAuth";
      await refreshAuth(plan.authType);
    }
    currentStep = "cleanupBackup";
    settings.cleanupBackup?.();
    return { updatedModelProviders };
  } catch (error) {
    try {
      settings.restore?.();
    } catch (restoreErr) {
      console.error(
        "[applyProviderInstallPlan] settings.restore failed during rollback:",
        restoreErr
      );
    }
    try {
      for (const [key, prev] of previousEnvValues) {
        if (prev === void 0) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    } catch (envErr) {
      console.error("[applyProviderInstallPlan] env rollback failed:", envErr);
    }
    try {
      reloadModelProviders?.(previousRuntimeProviders);
    } catch (reloadErr) {
      console.error(
        "[applyProviderInstallPlan] reloadModelProviders failed during rollback:",
        reloadErr
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new ProviderInstallError(errMsg, currentStep, plan.authType, {
      cause: error instanceof Error ? error : void 0
    });
  }
}
__name(applyProviderInstallPlan, "applyProviderInstallPlan");

// packages/core/src/providers/all-providers.ts
init_esbuild_shims();

// packages/core/src/providers/presets/alibaba-coding-plan.ts
init_esbuild_shims();
var CODING_PLAN_ENV_KEY = "BAILIAN_CODING_PLAN_API_KEY";
var CODING_PLAN_CHINA_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
var CODING_PLAN_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
var MODELSTUDIO_MODELS = [
  {
    id: "qwen3.5-plus",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.6-plus",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    description: "Currently available to Pro subscribers only.",
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.7-plus",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true
  },
  { id: "glm-5", contextWindowSize: 202752, enableThinking: true },
  {
    id: "kimi-k2.5",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  { id: "MiniMax-M2.5", contextWindowSize: 196608, enableThinking: true },
  { id: "qwen3-coder-plus", contextWindowSize: 1e6 },
  { id: "qwen3-coder-next", contextWindowSize: 262144 },
  {
    id: "qwen3-max-2026-01-23",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 262144,
    enableThinking: true
  },
  { id: "glm-4.7", contextWindowSize: 202752, enableThinking: true }
];
var codingPlanProvider = {
  id: "coding-plan",
  label: "Coding Plan",
  description: "For individual developers \xB7 Weekly quota included",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "aliyun",
      label: "China (Beijing)",
      url: CODING_PLAN_CHINA_BASE_URL,
      documentationUrl: "https://help.aliyun.com/zh/model-studio/coding-plan"
    },
    {
      id: "alibabacloud",
      label: "Singapore (International)",
      url: CODING_PLAN_GLOBAL_BASE_URL,
      documentationUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan"
    }
  ],
  envKey: CODING_PLAN_ENV_KEY,
  models: MODELSTUDIO_MODELS,
  modelsEditable: true,
  supportsModelDiscovery: true,
  modelNamePrefix: /* @__PURE__ */ __name((baseUrl) => baseUrl === CODING_PLAN_GLOBAL_BASE_URL ? "ModelStudio Coding Plan for Global/Intl" : "ModelStudio Coding Plan", "modelNamePrefix"),
  apiKeyPlaceholder: "sk-sp-...",
  validateApiKey: /* @__PURE__ */ __name((key) => !key.startsWith("sk-sp-") ? 'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.' : null, "validateApiKey"),
  ownsModel: /* @__PURE__ */ __name((model) => model.envKey === CODING_PLAN_ENV_KEY && typeof model.baseUrl === "string" && (model.baseUrl === CODING_PLAN_CHINA_BASE_URL || model.baseUrl === CODING_PLAN_GLOBAL_BASE_URL), "ownsModel"),
  uiGroup: "alibaba",
  uiLabels: { flowTitle: "Alibaba ModelStudio", baseUrlStepTitle: "Region" }
};

// packages/core/src/providers/presets/alibaba-token-plan.ts
init_esbuild_shims();
var TOKEN_PLAN_ENV_KEY = "BAILIAN_TOKEN_PLAN_API_KEY";
var TOKEN_PLAN_CHINA_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
var TOKEN_PLAN_GLOBAL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
var TOKEN_PLAN_MODELS = [
  {
    id: "qwen3.7-plus",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.6-plus",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.7-max",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true
  },
  {
    id: "qwen3.8-max",
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["low", "medium", "xhigh"],
        defaultEffort: "xhigh",
        canDisable: false,
        disableField: "reasoning_effort"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true,
    thinkingMandatory: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.8-max-preview",
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["low", "medium", "xhigh"],
        defaultEffort: "xhigh",
        canDisable: false,
        disableField: "reasoning_effort"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true,
    thinkingMandatory: true,
    modalities: { image: true, video: true }
  },
  {
    id: "qwen3.6-flash",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6,
    enableThinking: true
  },
  {
    id: "deepseek-v4-pro",
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["high", "max"],
        defaultEffort: "high",
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6
  },
  {
    id: "deepseek-v4-flash-0731",
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["low", "high", "max"],
        defaultEffort: "high",
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 1e6
  },
  {
    id: "deepseek-v3.2",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 131072
  },
  {
    id: "kimi-k2.7-code",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        canDisable: false,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true },
    thinkingMandatory: true
  },
  {
    id: "kimi-k2.6",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 262144,
    enableThinking: true
  },
  {
    id: "kimi-k2.5",
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: "enable_thinking"
      }
    },
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true }
  },
  { id: "glm-5.2", contextWindowSize: 1e6, enableThinking: true },
  { id: "glm-5.1", contextWindowSize: 202752, enableThinking: true },
  { id: "glm-5", contextWindowSize: 202752, enableThinking: true },
  { id: "MiniMax-M2.5", contextWindowSize: 196608 },
  {
    id: "qwen3.8-flash",
    contextWindowSize: 1e6,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["low", "medium", "xhigh"],
        defaultEffort: "xhigh",
        disableField: "reasoning_effort"
      }
    },
    modalities: { image: true, video: true }
  },
  {
    id: "deepseek-v4-pro-0813",
    contextWindowSize: 1e6,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ["low", "high", "max"],
        defaultEffort: "high",
        disableField: "enable_thinking"
      }
    }
  }
];
var tokenPlanProvider = {
  id: "token-plan",
  label: "Token Plan",
  description: "For teams and companies \xB7 Usage-based billing with dedicated endpoint",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "cn-beijing",
      label: "China (Beijing)",
      url: TOKEN_PLAN_CHINA_BASE_URL,
      documentationUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856"
    },
    {
      id: "ap-southeast-1",
      label: "Singapore (International)",
      url: TOKEN_PLAN_GLOBAL_BASE_URL,
      documentationUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model"
    }
  ],
  envKey: TOKEN_PLAN_ENV_KEY,
  models: TOKEN_PLAN_MODELS,
  modelsEditable: true,
  supportsModelDiscovery: true,
  modelNamePrefix: /* @__PURE__ */ __name((baseUrl) => baseUrl === TOKEN_PLAN_GLOBAL_BASE_URL ? "ModelStudio Token Plan for Global/Intl" : "ModelStudio Token Plan", "modelNamePrefix"),
  ownsModel: /* @__PURE__ */ __name((model) => model.envKey === TOKEN_PLAN_ENV_KEY && (typeof model.baseUrl === "string" && (model.baseUrl === TOKEN_PLAN_CHINA_BASE_URL || model.baseUrl === TOKEN_PLAN_GLOBAL_BASE_URL) || typeof model.name === "string" && model.name.startsWith("[ModelStudio Token Plan]")), "ownsModel"),
  // Same server-side search tools as the Standard endpoints, billed against
  // the plan's quota (probe 2026-09-08: `web_search` + `web_extractor` both
  // execute and are reported under `usage.x_tools`).
  webSearch: { backend: "dashscope" },
  uiGroup: "alibaba",
  uiLabels: { flowTitle: "Alibaba ModelStudio", baseUrlStepTitle: "Region" }
};

// packages/core/src/providers/presets/alibaba-standard.ts
init_esbuild_shims();
var alibabaStandardProvider = {
  id: "alibabaStandard",
  label: "Standard API Key",
  description: "Connect with an existing ModelStudio API key",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "cn-beijing",
      label: "China (Beijing)",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      documentationUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=api#/api"
    },
    {
      id: "sg-singapore",
      label: "Singapore",
      url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      documentationUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=api#/api/?type=model&url=2712195"
    },
    {
      id: "us-virginia",
      label: "US (Virginia)",
      url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      documentationUrl: "https://modelstudio.console.alibabacloud.com/us-east-1?tab=api#/api/?type=model&url=2712195"
    },
    {
      id: "cn-hongkong",
      label: "China (Hong Kong)",
      url: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
      documentationUrl: "https://modelstudio.console.alibabacloud.com/cn-hongkong?tab=api#/api/?type=model&url=2712195"
    }
  ],
  envKey: "DASHSCOPE_API_KEY",
  models: [
    {
      id: "qwen3.6-plus",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: "enable_thinking"
        }
      },
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "qwen3.7-plus",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: "enable_thinking"
        }
      },
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "qwen3.7-max",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: "enable_thinking"
        }
      },
      contextWindowSize: 1e6,
      enableThinking: true
    },
    { id: "glm-5.1", contextWindowSize: 202752, enableThinking: true },
    {
      id: "deepseek-v4-pro",
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["high", "max"],
          defaultEffort: "high",
          disableField: "enable_thinking"
        }
      },
      contextWindowSize: 1e6
    },
    {
      id: "deepseek-v4-flash",
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["high", "max"],
          defaultEffort: "high",
          disableField: "enable_thinking"
        }
      },
      contextWindowSize: 1e6
    },
    {
      id: "qwen3.8-max",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "medium", "xhigh"],
          defaultEffort: "xhigh",
          disableField: "reasoning_effort"
        }
      },
      modalities: { image: true, video: true }
    },
    {
      id: "qwen3.8-max-0902",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "medium", "xhigh"],
          defaultEffort: "xhigh",
          disableField: "reasoning_effort"
        }
      },
      modalities: { image: true, video: true }
    },
    {
      id: "qwen3.8-flash",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "medium", "xhigh"],
          defaultEffort: "xhigh",
          disableField: "reasoning_effort"
        }
      },
      modalities: { image: true, video: true }
    },
    {
      id: "deepseek-v4-pro-0813",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "high",
          disableField: "enable_thinking"
        }
      }
    },
    {
      id: "deepseek-v4-flash-0731",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "high",
          disableField: "enable_thinking"
        }
      }
    },
    {
      id: "kimi-k3",
      thinkingMandatory: true,
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "max",
          canDisable: false,
          disableField: "reasoning_effort"
        }
      },
      modalities: { image: true }
    },
    {
      id: "kimi-k2.7-code",
      thinkingMandatory: true,
      enableThinking: true,
      contextWindowSize: 262144,
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: "enable_thinking"
        }
      },
      modalities: { image: true, video: true }
    },
    {
      id: "kimi-k2.6",
      enableThinking: true,
      contextWindowSize: 262144,
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: "enable_thinking"
        }
      },
      modalities: { image: true, video: true }
    }
  ],
  modelsEditable: true,
  modelNamePrefix: "ModelStudio Standard",
  // The Responses API on these endpoints serves the server-side `web_search`
  // / `web_extractor` tools with the same key, so the built-in tool needs no
  // extra configuration.
  webSearch: { backend: "dashscope" },
  uiGroup: "alibaba",
  uiLabels: { flowTitle: "Alibaba ModelStudio", baseUrlStepTitle: "Region" }
};

// packages/core/src/providers/presets/openrouter.ts
init_esbuild_shims();
var OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";
var OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
var openRouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  description: "Connect with an OpenRouter API key (get one from openrouter.ai/keys)",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: OPENROUTER_BASE_URL,
  envKey: OPENROUTER_ENV_KEY,
  models: [
    { id: "z-ai/glm-4.5-air:free", contextWindowSize: 128e3 },
    { id: "openai/gpt-oss-120b:free", contextWindowSize: 131072 }
  ],
  modelsEditable: true,
  modelNamePrefix: "OpenRouter",
  ownsModel: /* @__PURE__ */ __name((model) => {
    if (model.envKey !== OPENROUTER_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? "").hostname;
      return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
    } catch {
      return false;
    }
  }, "ownsModel"),
  customHeaders: {
    "HTTP-Referer": "https://github.com/QwenLM/qwen-code.git",
    "X-OpenRouter-Title": "Qwen Code"
  },
  documentationUrl: "https://openrouter.ai/docs",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/requesty.ts
init_esbuild_shims();
var REQUESTY_ENV_KEY = "REQUESTY_API_KEY";
var REQUESTY_BASE_URL = "https://router.requesty.ai/v1";
var requestyProvider = {
  id: "requesty",
  label: "Requesty",
  description: "Connect with a Requesty API key (get one from app.requesty.ai/api-keys)",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: REQUESTY_BASE_URL,
  envKey: REQUESTY_ENV_KEY,
  models: [
    { id: "openai/gpt-4o-mini", contextWindowSize: 128e3 },
    { id: "openai/gpt-4o", contextWindowSize: 128e3 }
  ],
  modelsEditable: true,
  modelNamePrefix: "Requesty",
  ownsModel: /* @__PURE__ */ __name((model) => {
    if (model.envKey !== REQUESTY_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? "").hostname;
      return host === "router.requesty.ai" || host.endsWith(".requesty.ai");
    } catch {
      return false;
    }
  }, "ownsModel"),
  customHeaders: {
    "HTTP-Referer": "https://github.com/QwenLM/qwen-code.git",
    "X-Title": "Qwen Code"
  },
  documentationUrl: "https://docs.requesty.ai",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/deepseek.ts
init_esbuild_shims();
var deepseekProvider = {
  id: "deepseek",
  label: "DeepSeek API Key",
  description: "Quick setup for DeepSeek (deepseek-v4-flash, deepseek-v4-pro)",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: "https://api.deepseek.com",
  envKey: "DEEPSEEK_API_KEY",
  models: [
    {
      id: "deepseek-v4-pro",
      contextWindowSize: 1e6,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "high",
          disableField: "thinking"
        }
      }
    },
    {
      id: "deepseek-v4-flash",
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "high",
          disableField: "thinking"
        }
      },
      contextWindowSize: 1e6
    }
  ],
  modelsEditable: true,
  modelNamePrefix: "DeepSeek",
  documentationUrl: "https://api-docs.deepseek.com/zh-cn/",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/grok.ts
init_esbuild_shims();
var GROK_ENV_KEY = "XAI_API_KEY";
var GROK_BASE_URL = "https://api.x.ai/v1";
var grokProvider = {
  id: "grok",
  label: "Grok (xAI) API Key",
  description: "Quick setup for xAI Grok chat & code models",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: GROK_BASE_URL,
  envKey: GROK_ENV_KEY,
  // xAI's API follows the standard OpenAI format. Grok models reason by
  // default (grok-4.5 exposes an optional reasoning_effort knob, default
  // high) and have no Qwen-style enable_thinking toggle, so the preset
  // carries only each model's context window.
  models: [
    { id: "grok-4.5", contextWindowSize: 5e5 },
    { id: "grok-4.3", contextWindowSize: 1e6 },
    { id: "grok-4.20-0309-reasoning", contextWindowSize: 1e6 },
    { id: "grok-4.20-0309-non-reasoning", contextWindowSize: 1e6 },
    { id: "grok-4.20-multi-agent-0309", contextWindowSize: 1e6 },
    { id: "grok-build-0.1", contextWindowSize: 262144 }
  ],
  modelsEditable: true,
  modelNamePrefix: "Grok",
  documentationUrl: "https://docs.x.ai/docs",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/minimax.ts
init_esbuild_shims();
var minimaxProvider = {
  id: "minimax",
  label: "MiniMax API Key",
  description: "Quick setup for MiniMax models",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "international",
      label: "International",
      url: "https://api.minimax.io/v1",
      documentationUrl: "https://www.minimax.io/platform"
    },
    {
      id: "china",
      label: "China",
      url: "https://api.minimaxi.com/v1",
      documentationUrl: "https://platform.minimaxi.com"
    }
  ],
  envKey: "MINIMAX_API_KEY",
  models: [
    {
      id: "MiniMax-M3",
      contextWindowSize: 1e6,
      modalities: { image: true, video: true }
    },
    { id: "MiniMax-M2.7", contextWindowSize: 204800 },
    { id: "MiniMax-M2.7-highspeed", contextWindowSize: 204800 },
    { id: "MiniMax-M2.5", contextWindowSize: 196608 },
    { id: "MiniMax-M2.5-highspeed", contextWindowSize: 196608 },
    { id: "image-01", imageOnly: true },
    { id: "image-01-live", imageOnly: true }
  ],
  modelsEditable: true,
  modelNamePrefix: "MiniMax",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/zai.ts
init_esbuild_shims();
var zaiProvider = {
  id: "zai",
  label: "Z.AI API Key",
  description: "Quick setup for Z.AI models",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "standard-api-key",
      label: "Standard API Key",
      url: "https://api.z.ai/api/paas/v4",
      documentationUrl: "https://docs.z.ai/"
    },
    {
      id: "coding-plan",
      label: "Coding Plan",
      url: "https://api.z.ai/api/coding/paas/v4",
      documentationUrl: "https://docs.z.ai/"
    }
  ],
  envKey: "ZAI_API_KEY",
  models: [
    { id: "GLM-5.2", contextWindowSize: 1e6, enableThinking: true },
    { id: "GLM-5.1", contextWindowSize: 204800, enableThinking: true },
    { id: "GLM-5", contextWindowSize: 204800 },
    { id: "GLM-5-Turbo", contextWindowSize: 204800 }
  ],
  modelsEditable: true,
  modelNamePrefix: "Z.AI",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/moonshot.ts
init_esbuild_shims();
var moonshotProvider = {
  id: "moonshot",
  label: "Kimi (Moonshot AI) API Key",
  description: "Quick setup for Kimi models",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: [
    {
      id: "international",
      label: "International",
      url: "https://api.moonshot.ai/v1",
      documentationUrl: "https://platform.kimi.ai/docs"
    },
    {
      id: "china",
      label: "China",
      url: "https://api.moonshot.cn/v1",
      documentationUrl: "https://platform.moonshot.cn/docs"
    }
  ],
  envKey: "MOONSHOT_API_KEY",
  models: [
    {
      id: "kimi-k3",
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ["low", "high", "max"],
          defaultEffort: "max",
          canDisable: false,
          disableField: "reasoning_effort"
        }
      },
      contextWindowSize: 1e6,
      // K3 always thinks: the API exposes `reasoning_effort` but no way to
      // turn thinking off, so never emit a disable shape on the wire.
      thinkingMandatory: true,
      modalities: { image: true, video: true }
    },
    {
      id: "kimi-k2.7-code",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: "thinking"
        }
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true },
      thinkingMandatory: true
    },
    {
      id: "kimi-k2.7-code-highspeed",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: "thinking"
        }
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true },
      thinkingMandatory: true
    },
    {
      id: "kimi-k2.6",
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: "thinking"
        }
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true }
    }
  ],
  modelsEditable: true,
  modelNamePrefix: "Kimi",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/idealab.ts
init_esbuild_shims();
var idealabProvider = {
  id: "idealab",
  label: "Idealab API Key",
  description: "Alibaba internal LLM service (Qwen3.6-Plus-DogFooding, DeepSeek V4, Kimi K2.6)",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: "https://idealab.alibaba-inc.com/api/openai/v1",
  envKey: "IDEALAB_API_KEY",
  models: [
    {
      id: "Qwen3.6-Plus-DogFooding",
      contextWindowSize: 1e6,
      enableThinking: true,
      modalities: { image: true, video: true }
    },
    {
      id: "bailian/deepseek-v4-pro",
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "bailian/deepseek-v4-flash",
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "bailian/kimi-k2.6",
      contextWindowSize: 262144,
      enableThinking: true
    }
  ],
  modelsEditable: true,
  modelNamePrefix: "Idealab",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/modelscope.ts
init_esbuild_shims();
var modelscopeProvider = {
  id: "modelscope",
  label: "ModelScope API Key",
  description: "Quick setup for ModelScope API Inference",
  protocol: "openai" /* USE_OPENAI */,
  baseUrl: "https://api-inference.modelscope.cn/v1",
  envKey: "MODELSCOPE_API_KEY",
  models: [
    {
      id: "deepseek-ai/DeepSeek-V4-Flash",
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "Qwen/Qwen3.5-397B-A17B",
      contextWindowSize: 1e6,
      enableThinking: true
    },
    {
      id: "ZhipuAI/GLM-5.1",
      contextWindowSize: 1e6,
      enableThinking: true
    }
  ],
  modelsEditable: true,
  modelNamePrefix: "ModelScope",
  documentationUrl: "https://modelscope.cn/docs/model-service/API-Inference/intro",
  uiGroup: "third-party"
};

// packages/core/src/providers/presets/custom-provider.ts
init_esbuild_shims();
import { createHash as createHash2 } from "node:crypto";
var CUSTOM_API_KEY_ENV_PREFIX = "QWEN_CUSTOM_API_KEY_";
function normalizeEnvSegment(value) {
  const upper = value.trim().toUpperCase();
  let result = "";
  let prevWasUnderscore = false;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    const isAlphaNum = code >= 65 && code <= 90 || code >= 48 && code <= 57;
    if (isAlphaNum) {
      result += upper[i];
      prevWasUnderscore = false;
    } else if (!prevWasUnderscore) {
      result += "_";
      prevWasUnderscore = true;
    }
  }
  let start = 0;
  let end = result.length;
  while (start < end && result.charCodeAt(start) === 95) start++;
  while (end > start && result.charCodeAt(end - 1) === 95) end--;
  return result.slice(start, end);
}
__name(normalizeEnvSegment, "normalizeEnvSegment");
function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
__name(stripTrailingSlashes, "stripTrailingSlashes");
function generateCustomEnvKey(protocol, baseUrl) {
  const canonicalBaseUrl = stripTrailingSlashes(baseUrl.trim());
  const suffix = createHash2("sha256").update(`${protocol}\0${canonicalBaseUrl}`).digest("hex").slice(0, 12).toUpperCase();
  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalizeEnvSegment(
    protocol
  )}_${normalizeEnvSegment(baseUrl)}_${suffix}`;
}
__name(generateCustomEnvKey, "generateCustomEnvKey");
var customProvider = {
  id: "custom-openai-compatible",
  label: "Custom Provider",
  description: "Manually connect a local server, proxy, or unsupported provider",
  protocol: "openai" /* USE_OPENAI */,
  protocolOptions: [
    "openai" /* USE_OPENAI */,
    "anthropic" /* USE_ANTHROPIC */,
    "gemini" /* USE_GEMINI */
  ],
  baseUrl: void 0,
  envKey: generateCustomEnvKey,
  models: void 0,
  modelNamePrefix: "",
  showAdvancedConfig: true,
  // Detect existing custom entries by our env-key namespace for UI/ACP flows,
  // but merge installs by id+baseUrl so /auth can add another custom model
  // without deleting models from other endpoints or different models on the
  // same endpoint.
  ownsModel: /* @__PURE__ */ __name((model) => typeof model.envKey === "string" && model.envKey.startsWith(CUSTOM_API_KEY_ENV_PREFIX), "ownsModel"),
  mergeModelsByIdentity: true,
  uiGroup: "custom"
};

// packages/core/src/providers/all-providers.ts
var ALL_PROVIDERS = [
  codingPlanProvider,
  tokenPlanProvider,
  alibabaStandardProvider,
  deepseekProvider,
  grokProvider,
  minimaxProvider,
  zaiProvider,
  moonshotProvider,
  idealabProvider,
  modelscopeProvider,
  openRouterProvider,
  requestyProvider,
  customProvider
];
var ALIBABA_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === "alibaba"
);
var THIRD_PARTY_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === "third-party"
);
function findProviderById(id) {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
__name(findProviderById, "findProviderById");
function findProviderByCredentials(baseUrl, envKey) {
  return ALL_PROVIDERS.find(
    (p) => providerMatchesCredentials(p, baseUrl, envKey)
  );
}
__name(findProviderByCredentials, "findProviderByCredentials");
function getAllProviderBaseUrls() {
  return ALL_PROVIDERS.flatMap((p) => {
    if (typeof p.baseUrl === "string") return [p.baseUrl];
    if (Array.isArray(p.baseUrl))
      return p.baseUrl.map((o) => o.url);
    return [];
  });
}
__name(getAllProviderBaseUrls, "getAllProviderBaseUrls");

// packages/core/src/core/reasoning-overrides.ts
init_esbuild_shims();

// packages/core/src/core/openaiContentGenerator/provider/openrouter.ts
init_esbuild_shims();
function isOpenRouterHostname(contentGeneratorConfig) {
  const baseUrl = contentGeneratorConfig.baseUrl ?? "";
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
__name(isOpenRouterHostname, "isOpenRouterHostname");

// packages/core/src/core/anthropic-reasoning.ts
init_esbuild_shims();
var CLAUDE_MODEL_FAMILIES = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "mythos"
];
function parseClaudeModelVersion(model) {
  const match = model.toLowerCase().match(
    new RegExp(
      `claude-(${CLAUDE_MODEL_FAMILIES.join(
        "|"
      )})-(\\d+)(?:[-.](\\d{1,2})(?!\\d))?`
    )
  );
  if (!match) {
    return null;
  }
  return {
    family: match[1],
    major: Number.parseInt(match[2], 10),
    minor: match[3] ? Number.parseInt(match[3], 10) : 0
  };
}
__name(parseClaudeModelVersion, "parseClaudeModelVersion");
function anthropicSupportedEffortTiers(model) {
  const tiers = ["low", "medium", "high"];
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) {
    return tiers;
  }
  const { family, major, minor } = parsed;
  const atLeast = /* @__PURE__ */ __name((maj, min) => major > maj || major === maj && minor >= min, "atLeast");
  if (major >= 5 || family === "opus" && atLeast(4, 7)) {
    tiers.push("xhigh");
  }
  if (major >= 5 || (family === "opus" || family === "sonnet") && atLeast(4, 6)) {
    tiers.push("max");
  }
  return tiers;
}
__name(anthropicSupportedEffortTiers, "anthropicSupportedEffortTiers");

// packages/core/src/core/reasoning-overrides.ts
var REASONING_PROFILES = [
  "openai-effort",
  "openai-reasoning",
  "deepseek-openai",
  "dashscope-effort",
  "dashscope-thinking",
  "qwen-chat-template",
  "anthropic-manual",
  "anthropic-adaptive",
  "deepseek-anthropic",
  "gemini"
];
function invalidReasoning(route) {
  throw new Error(
    `Model "${route.model}" capabilities.reasoning: invalid profile, efforts or defaultEffort`
  );
}
__name(invalidReasoning, "invalidReasoning");
function validateReasoningDeclaration(route, declaration) {
  if (declaration === void 0) return void 0;
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration))
    return invalidReasoning(route);
  const input = declaration;
  if (input.profile === void 0 && ("thinking" in input || "disableField" in input))
    return parseModelReasoningCapabilities(input);
  if (!Object.keys(input).length || Object.keys(input).some(
    (key) => ![
      "profile",
      "efforts",
      "defaultEffort",
      "thinking",
      "toggleOnly",
      "canDisable",
      "disableField"
    ].includes(key)
  ))
    return invalidReasoning(route);
  if (input.profile !== void 0 && !REASONING_PROFILES.includes(input.profile) || input.thinking !== void 0 && input.thinking !== true || input.toggleOnly !== void 0 && typeof input.toggleOnly !== "boolean" || input.canDisable !== void 0 && input.canDisable !== false)
    return invalidReasoning(route);
  if (input.efforts !== void 0 && (!Array.isArray(input.efforts) || !input.efforts.length || input.efforts.some((tier) => !REASONING_EFFORT_TIERS.includes(tier)) || new Set(input.efforts).size !== input.efforts.length))
    return invalidReasoning(route);
  if (input.defaultEffort !== void 0 && (!REASONING_EFFORT_TIERS.includes(input.defaultEffort) || input.efforts && !input.efforts.includes(input.defaultEffort)))
    return invalidReasoning(route);
  return input;
}
__name(validateReasoningDeclaration, "validateReasoningDeclaration");
function resolveReasoningCapabilities(route, declaration) {
  try {
    return validateReasoningCapabilities(route, declaration);
  } catch {
    return void 0;
  }
}
__name(resolveReasoningCapabilities, "resolveReasoningCapabilities");
function validateReasoningCapabilities(route, declaration) {
  const input = validateReasoningDeclaration(route, declaration);
  if (!input) return void 0;
  if (input.profile === void 0 && "thinking" in input)
    return parseModelReasoningCapabilities(input);
  const model = normalize(route.model);
  const provider = ALL_PROVIDERS.find(
    (candidate) => typeof candidate.baseUrl === "string" ? candidate.baseUrl === route.baseUrl : candidate.baseUrl?.some((option) => option.url === route.baseUrl)
  );
  const known = (provider?.models?.find((candidate) => candidate.id === route.model) ?? provider?.models?.find((candidate) => candidate.id === model))?.capabilities?.reasoning;
  const inherited = parseModelReasoningCapabilities(known);
  if (!input.profile && inherited?.toggleOnly) {
    if (input.efforts || input.defaultEffort) return invalidReasoning(route);
    return parseModelReasoningCapabilities({ ...inherited, ...input });
  }
  const gpt = getGptReasoningCapabilities(route.model);
  const claude = route.authType === "anthropic" ? parseClaudeModelVersion(route.model) : void 0;
  if (!inherited && !gpt && !claude && !input.profile)
    return invalidReasoning(route);
  const auth = route.authType;
  let host = "";
  try {
    host = new URL(route.baseUrl ?? "").hostname.toLowerCase();
  } catch {
    host = "";
  }
  const dashscope = auth === "qwen-oauth" || /(^|\.)(dashscope(?:-intl|-us)?\.aliyuncs\.com|alibaba-inc\.com|aliyun-inc\.com|alicloudapi\.com)$/.test(
    host
  ) || /^token-plan\..+\.maas\.aliyuncs\.com$/.test(host);
  const profile = input.profile ?? (auth === "gemini" || auth === "vertex-ai" ? "gemini" : auth === "openai-responses" ? "openai-reasoning" : auth === "openai" && isOpenRouterHostname(route) ? "openai-reasoning" : auth === "anthropic" ? model.includes("deepseek") ? "deepseek-anthropic" : claude && (claude.major > 4 || claude.major === 4 && claude.minor >= 6) ? "anthropic-adaptive" : "anthropic-manual" : model.startsWith("qwen") ? dashscope ? inherited?.disableField === "reasoning_effort" ? "dashscope-effort" : "dashscope-thinking" : "qwen-chat-template" : inherited?.disableField === "thinking" ? "deepseek-openai" : "openai-effort");
  const protocol = profile === "gemini" ? "gemini" : profile.startsWith("anthropic-") || profile === "deepseek-anthropic" ? "anthropic" : "openai";
  if (auth === "openai-responses" && profile !== "openai-reasoning" || auth && protocol !== (auth === "vertex-ai" ? "gemini" : auth === "qwen-oauth" || auth === "openai-responses" ? "openai" : auth))
    return invalidReasoning(route);
  const toggleOnly = profile === "dashscope-thinking" || profile === "qwen-chat-template";
  const disableField = !input.profile && inherited?.disableField || (toggleOnly ? "enable_thinking" : profile === "openai-effort" || profile === "dashscope-effort" ? "reasoning_effort" : "thinking");
  const inheritedEfforts = inherited && !inherited.toggleOnly ? inherited.efforts : gpt?.efforts ?? (claude ? anthropicSupportedEffortTiers(route.model) : void 0);
  const efforts = input.efforts ?? inheritedEfforts;
  const inheritedDefault = inherited && !inherited.toggleOnly ? inherited.defaultEffort : gpt?.defaultEffort;
  const defaultEffort = input.defaultEffort ?? (inheritedDefault && efforts ? clampReasoningEffort(inheritedDefault, efforts) : void 0);
  if (toggleOnly && (input.efforts !== void 0 || input.defaultEffort !== void 0) || !toggleOnly && (!efforts || !defaultEffort) || profile === "gemini" && efforts?.some((tier) => tier === "xhigh" || tier === "max"))
    return invalidReasoning(route);
  const result = {
    ...input,
    thinking: true,
    profile,
    toggleOnly,
    disableField,
    ...toggleOnly ? {} : { efforts, defaultEffort },
    ...route.thinkingMandatory || inherited?.canDisable === false || gpt?.thinkingMandatory ? { canDisable: false } : {}
  };
  const parsed = parseModelReasoningCapabilities(result);
  if (!parsed) return invalidReasoning(route);
  return {
    ...parsed,
    profile,
    ...gpt && input.defaultEffort === void 0 ? { defaultEnabled: gpt.defaultEnabled } : {}
  };
}
__name(validateReasoningCapabilities, "validateReasoningCapabilities");
function captureReasoningSnapshot(models) {
  return Object.freeze(
    models.map(
      (model) => Object.freeze({
        id: model.id,
        authType: model.authType,
        baseUrl: model.baseUrl,
        registryBaseUrl: model.registryBaseUrl,
        reasoning: model.capabilities?.reasoning && typeof model.capabilities.reasoning === "object" ? Object.freeze({
          ...structuredClone(model.capabilities.reasoning),
          ..."efforts" in model.capabilities.reasoning && Array.isArray(model.capabilities.reasoning.efforts) ? {
            efforts: Object.freeze([
              ...model.capabilities.reasoning.efforts
            ])
          } : {}
        }) : model.capabilities?.reasoning
      })
    )
  );
}
__name(captureReasoningSnapshot, "captureReasoningSnapshot");
function resolveReasoningForModel(config, generation, model = generation.model, strict = false) {
  let declaration;
  if (generation.reasoningSnapshot) {
    const rows = generation.reasoningSnapshot.filter(
      (row2) => row2.authType === generation.authType && row2.id === model
    );
    const row = generation.reasoningRouteBaseUrl === null && model === generation.model ? rows.find((row2) => row2.registryBaseUrl === void 0) : typeof generation.reasoningRouteBaseUrl === "string" && model === generation.model ? rows.find(
      (row2) => row2.registryBaseUrl === generation.reasoningRouteBaseUrl
    ) : rows.find((row2) => row2.registryBaseUrl === generation.baseUrl) ?? rows.find(
      (row2) => row2.registryBaseUrl === void 0 && row2.baseUrl === generation.baseUrl
    );
    declaration = row?.reasoning;
  } else {
    declaration = generation.authType ? config?.getResolvedModelConfig?.(
      generation.authType,
      model,
      generation.baseUrl
    )?.capabilities?.reasoning : void 0;
  }
  return (strict ? validateReasoningCapabilities : resolveReasoningCapabilities)(
    {
      ...generation,
      model,
      thinkingMandatory: model === generation.model ? generation.thinkingMandatory : void 0
    },
    declaration
  );
}
__name(resolveReasoningForModel, "resolveReasoningForModel");
function getEffectiveReasoning(generation, resolved) {
  if (!resolved) return generation.reasoning;
  if (generation.reasoning === false && resolved.canDisable !== false)
    return false;
  const selected = generation.reasoning || void 0;
  if (!selected && resolved.defaultEnabled === false && resolved.canDisable !== false)
    return false;
  if (resolved.toggleOnly)
    return selected ?? (resolved.profile ? {} : void 0);
  const effort = selected?.effort ?? resolved.defaultEffort;
  return effort ? {
    ...selected,
    effort: resolved.profile && REASONING_EFFORT_TIERS.includes(effort) ? clampReasoningEffort(effort, resolved.efforts) : effort
  } : selected;
}
__name(getEffectiveReasoning, "getEffectiveReasoning");

// packages/core/src/core/outbound-session-id.ts
init_esbuild_shims();

// packages/core/src/core/outbound-dynamic-headers.ts
init_esbuild_shims();
var debugLogger3 = createDebugLogger("OUTBOUND_CORRELATION");
var PLACEHOLDERS = [{ token: "${session_id}", resolve: /* @__PURE__ */ __name((config) => config.getSessionId(), "resolve") }];
var SESSION_ID_PLACEHOLDER_PATTERN = /\$(?:session_id|QWEN_CODE_SESSION_ID)(?!\w)|\$\{(?:session_id|QWEN_CODE_SESSION_ID)\}/gi;
var warnedGateOff = /* @__PURE__ */ new Set();
function warnIfDynamicHeadersDisabled(customHeaders, config) {
  try {
    const names = Object.entries(customHeaders ?? {}).filter(
      ([, value]) => typeof value === "string" && hasDynamicPlaceholder(value)
    ).map(([name]) => name);
    if (names.length === 0) return;
    if (config.getOutboundAllowDynamicHeaderValues()) return;
    const key = names.slice().sort().join(",");
    if (warnedGateOff.has(key)) return;
    warnedGateOff.add(key);
    console.warn(
      `customHeaders ${names.join(", ")} contain a runtime placeholder, but outboundCorrelation.allowDynamicHeaderValues is not enabled \u2014 the header(s) will not be sent. Set it to true in settings.json to allow the value to be filled in per request.`
    );
  } catch {
  }
}
__name(warnIfDynamicHeadersDisabled, "warnIfDynamicHeadersDisabled");
function hasDynamicPlaceholder(value) {
  return value.search(SESSION_ID_PLACEHOLDER_PATTERN) !== -1;
}
__name(hasDynamicPlaceholder, "hasDynamicPlaceholder");
function resolveDynamicHeaderValue(value, config) {
  if (typeof value !== "string") return void 0;
  if (!hasDynamicPlaceholder(value)) return value;
  try {
    if (!config.getOutboundAllowDynamicHeaderValues()) {
      debugLogger3.warn(
        `Dropping a customHeaders value containing a runtime placeholder: outboundCorrelation.allowDynamicHeaderValues is not enabled.`
      );
      return void 0;
    }
    let expanded = value.replace(
      SESSION_ID_PLACEHOLDER_PATTERN,
      "${session_id}"
    );
    for (const { token, resolve } of PLACEHOLDERS) {
      if (!expanded.includes(token)) continue;
      const resolved = resolve(config);
      if (!resolved) return void 0;
      expanded = expanded.split(token).join(resolved);
    }
    return expanded;
  } catch (error) {
    debugLogger3.warn(
      `Unable to expand a customHeaders placeholder: ${error instanceof Error ? error.message : String(error)}`
    );
    return void 0;
  }
}
__name(resolveDynamicHeaderValue, "resolveDynamicHeaderValue");
function applyDynamicHeaderValues(headers, config) {
  const pending = [];
  headers.forEach((value, key) => {
    if (hasDynamicPlaceholder(value)) pending.push([key, value]);
  });
  for (const [key, value] of pending) {
    const resolved = resolveDynamicHeaderValue(value, config);
    if (resolved === void 0) {
      headers.delete(key);
    } else {
      headers.set(key, resolved);
    }
  }
}
__name(applyDynamicHeaderValues, "applyDynamicHeaderValues");
function expandDynamicHeaders(customHeaders, config) {
  if (!customHeaders) return {};
  const expanded = {};
  for (const [key, value] of Object.entries(customHeaders)) {
    if (typeof value !== "string" || !hasDynamicPlaceholder(value)) continue;
    const resolved = resolveDynamicHeaderValue(value, config);
    if (resolved !== void 0) expanded[key] = resolved;
  }
  return expanded;
}
__name(expandDynamicHeaders, "expandDynamicHeaders");

// packages/core/src/core/outbound-session-id.ts
var debugLogger4 = createDebugLogger("OUTBOUND_CORRELATION");
var SESSION_ID_HEADER = "session_id";
var SESSION_ID_HEADER_HOSTS = [
  "routify.alibaba-inc.com",
  "routify-online.alibaba-inc.com",
  "routify-pub.alibaba-inc.com"
];
function requestUrl(input) {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return void 0;
  }
}
__name(requestUrl, "requestUrl");
function buildSessionIdHeaders(config, destination) {
  try {
    const url = requestUrl(destination);
    if (url?.protocol !== "https:" || !SESSION_ID_HEADER_HOSTS.includes(url.hostname.toLowerCase())) {
      return {};
    }
    const sessionId = config.getSessionId();
    return sessionId ? { [SESSION_ID_HEADER]: sessionId } : {};
  } catch (error) {
    debugLogger4.warn(
      `Unable to add ${SESSION_ID_HEADER} to outbound request: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}
__name(buildSessionIdHeaders, "buildSessionIdHeaders");
function wrapFetchWithSessionId(baseFetch, config, customHeaders) {
  const fetchLike = baseFetch;
  const expandsHeaders = Object.values(customHeaders ?? {}).some(
    (value) => typeof value === "string" && hasDynamicPlaceholder(value)
  );
  if (expandsHeaders) warnIfDynamicHeadersDisabled(customHeaders, config);
  const wrapped = /* @__PURE__ */ __name(async (input, init) => {
    const sessionHeaders = buildSessionIdHeaders(config, input);
    const sessionId = sessionHeaders[SESSION_ID_HEADER];
    if (!sessionId && !expandsHeaders) return fetchLike(input, init);
    const headers = new Headers(
      input instanceof Request ? input.headers : void 0
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (expandsHeaders) applyDynamicHeaderValues(headers, config);
    if (sessionId) headers.set(SESSION_ID_HEADER, sessionId);
    return fetchLike(input, { ...init, headers });
  }, "wrapped");
  return wrapped;
}
__name(wrapFetchWithSessionId, "wrapFetchWithSessionId");
function buildSessionAwareFetch(runtimeFetch, config, customHeaders) {
  const baseFetch = runtimeFetch ?? globalThis.fetch;
  return wrapFetchWithSessionId(baseFetch, config, customHeaders);
}
__name(buildSessionAwareFetch, "buildSessionAwareFetch");

export {
  DISABLED_REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
  DEFAULT_MAX_RETRIES,
  DEFAULT_DASHSCOPE_BASE_URL,
  DASHSCOPE_PROXY_BASE_URL,
  normalizeOpenAiWireBaseUrl,
  isOpenRouterHostname,
  isImageGenerationCapable,
  RUNTIME_SNAPSHOT_PREFIX,
  buildRuntimeSnapshotId,
  stripRuntimeSnapshotPrefix,
  ModelsConfig,
  ProviderInstallError,
  applyProviderInstallPlan,
  resolveOwnsModel,
  resolveMetadataKey,
  PROVIDER_METADATA_NS,
  buildInstallPlan,
  computeModelListVersion,
  getDefaultBaseUrlForProtocol,
  resolveBaseUrl,
  getDefaultModelIds,
  getModelsForProviderProtocol,
  findExistingProviderModels,
  shouldShowStep,
  providerMatchesCredentials,
  buildProviderTemplate,
  customProvider,
  ALL_PROVIDERS,
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  findProviderById,
  findProviderByCredentials,
  getAllProviderBaseUrls,
  parseClaudeModelVersion,
  anthropicSupportedEffortTiers,
  resolveReasoningCapabilities,
  validateReasoningCapabilities,
  captureReasoningSnapshot,
  resolveReasoningForModel,
  getEffectiveReasoning,
  warnIfDynamicHeadersDisabled,
  hasDynamicPlaceholder,
  expandDynamicHeaders,
  buildSessionIdHeaders,
  buildSessionAwareFetch,
  resolveProviderProtocol,
  resolveModelProtocol,
  tryResolveModelProtocol,
  validateModelProvidersConfig,
  resolveModelSelectionAuthType
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider registry — imports all provider definitions and assembles the
 * lookup tables used by the UI and CLI commands.
 */
