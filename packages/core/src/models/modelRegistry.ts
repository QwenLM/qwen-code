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

/**
 * Whether the providers config pins the qwen-oauth model list explicitly
 * empty — the operator signal to disable the hard-coded qwen-oauth built-ins.
 * Resolved through the same protocol mapping as everything else, so a
 * custom id mapped to `qwen-oauth` via `providerProtocol` with an empty list
 * pins the built-ins exactly like the literal key does.
 */
export function isQwenOAuthBuiltinsPinnedEmpty(
  modelProviders?: ModelProvidersConfig,
  providerProtocol?: ProviderProtocolConfig,
): boolean {
  if (!modelProviders) return false;
  return Object.entries(modelProviders).some(([providerId, models]) => {
    if (!Array.isArray(models) || models.length !== 0) return false;
    return (
      resolveProviderProtocol(providerId, providerProtocol) ===
      AuthType.QWEN_OAUTH
    );
  });
}

/**
 * Parse a URL for allowlist comparison; undefined when the value does not
 * parse (the caller falls back to the string comparison).
 */
function parseUrlForMatch(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a base URL for allowlist comparison (string fallback): trim
 * whitespace and trailing slashes, then lowercase the scheme and host
 * (hostnames are case-insensitive) while leaving the path case-sensitive.
 * Strings without a scheme keep the previous full-lowercase behavior on
 * both sides, so comparisons remain consistent.
 */
function normalizeBaseUrlForMatch(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parts = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]+)(.*)$/.exec(trimmed);
  if (!parts) return trimmed.toLowerCase();
  return `${parts[1].toLowerCase()}${parts[2].toLowerCase()}${parts[3]}`;
}

/**
 * Decide whether a single target baseUrl matches a single allowlist entry.
 *
 * When both sides parse as URLs, compare URL semantics: the origins must be
 * equal (URL origins elide explicit default ports, so
 * `https://corp.example:443` and `https://corp.example` are the same
 * origin, while a non-default port like `:8443` is not), and the entry path
 * must be a path-boundary prefix of the target path. When either side is
 * not a URL, fall back to the case-normalized string comparison.
 */
function baseUrlMatchesEntry(target: string, entry: string): boolean {
  const t = parseUrlForMatch(target);
  const e = parseUrlForMatch(entry);
  if (t && e) {
    if (t.origin !== e.origin) return false;
    if (t.pathname === e.pathname) return true;
    const prefix = e.pathname.endsWith('/') ? e.pathname : `${e.pathname}/`;
    return t.pathname.startsWith(prefix);
  }
  const targetNorm = normalizeBaseUrlForMatch(target);
  if (targetNorm.length === 0) return false;
  const allowedNorm = normalizeBaseUrlForMatch(entry);
  if (allowedNorm.length === 0) return false;
  return targetNorm === allowedNorm || targetNorm.startsWith(`${allowedNorm}/`);
}

/**
 * Validate a managed endpoint allowlist (`model.allowedBaseUrls`).
 * `undefined` means no policy and is kept as-is. A non-array value is a
 * runtime data error (a hand-edited settings file): warn and fail closed
 * with an empty list (every model blocked) instead of throwing an opaque
 * TypeError out of the constructor. Entries that are not parseable URLs
 * with a non-empty host (e.g. a template placeholder that rendered to
 * `https://`) are rejected with a warning — one degenerate entry must not
 * disable the control fail-open, and an all-invalid list still blocks
 * everything rather than becoming no-policy.
 */
export function validateAllowedBaseUrls(
  allowedBaseUrls: readonly string[] | undefined,
): readonly string[] | undefined {
  if (allowedBaseUrls === undefined) return undefined;
  if (!Array.isArray(allowedBaseUrls)) {
    debugLogger.warn(
      'model.allowedBaseUrls is not an array; no model endpoint can match ' +
        'and every model is blocked (fail closed). Fix the settings value.',
    );
    return [];
  }
  const valid: string[] = [];
  for (const entry of allowedBaseUrls) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      debugLogger.warn(
        `model.allowedBaseUrls entry ${JSON.stringify(entry)} is not a ` +
          'non-empty string; it is ignored.',
      );
      continue;
    }
    const url = parseUrlForMatch(entry.trim());
    if (!url || url.hostname.length === 0) {
      debugLogger.warn(
        `model.allowedBaseUrls entry "${entry}" is not a URL with a host ` +
          '(a scheme-only value like "https://" matches every endpoint); ' +
          'it is ignored.',
      );
      continue;
    }
    valid.push(entry.trim());
  }
  return valid;
}

/**
 * Decide whether a resolved model baseUrl passes a managed allowlist.
 *
 * A baseUrl passes when it matches an entry: same origin (explicit default
 * ports elided, so `https://corp.example:443/v1` matches an entry
 * `https://corp.example`) and the entry path is a path-boundary prefix of
 * the target path (`https://corp.example` covers `https://corp.example/v1`
 * but not `https://corp.example.evil.com`). Scheme and host compare
 * case-insensitively; the path is case-sensitive. An empty or missing
 * baseUrl, a non-array list, and a list with no matching entry never pass —
 * fail closed, so a model whose endpoint the operator did not list cannot
 * slip through.
 */
export function isBaseUrlAllowed(
  baseUrl: string | undefined,
  allowedBaseUrls: readonly string[] | undefined,
): boolean {
  if (typeof baseUrl !== 'string') return false;
  if (!Array.isArray(allowedBaseUrls)) return false;
  const target = baseUrl.trim();
  if (target.length === 0) return false;
  return allowedBaseUrls.some((entry) => {
    if (typeof entry !== 'string') return false;
    return baseUrlMatchesEntry(target, entry.trim());
  });
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

  /**
   * Managed endpoint allowlist (`model.allowedBaseUrls`), validated in the
   * constructor (see {@link validateAllowedBaseUrls}). `undefined` means no
   * policy — every model registers as before. Any array, including an empty
   * one, filters: a model registers only when its resolved baseUrl matches
   * an entry (see {@link isBaseUrlAllowed}).
   */
  private allowedModelBaseUrls?: readonly string[];

  /**
   * Models the managed allowlist filter dropped at registration (id + the
   * resolved baseUrl it was judged against). Lets callers surface a
   * user-visible explanation — the picker and the /model list cannot name
   * models they never contain.
   */
  private allowlistDroppedModels: Array<{ id: string; baseUrl: string }> = [];

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

  /**
   * The baseUrl a model of this authType resolves to: its explicit baseUrl
   * or the protocol default. The single expression both the allowlist filter
   * and the registered model use, so the URL the allowlist judges and the URL
   * the model carries are the same value.
   */
  private resolveRegistryBaseUrl(
    config: ModelConfig,
    authType: AuthType,
  ): string {
    return config.baseUrl || this.getDefaultBaseUrl(authType);
  }

  constructor(
    modelProvidersConfig?: ModelProvidersConfig,
    providerProtocolConfig?: ProviderProtocolConfig,
    allowedModelBaseUrls?: readonly string[],
    /**
     * Whether the hard-coded qwen-oauth built-ins are disabled by an
     * operator-scope pin (an explicitly empty qwen-oauth model list).
     * `true` suppresses the built-ins; `false` keeps them even when the
     * merged config carries a workspace-only pin (which the caller must not
     * honor). `undefined` falls back to detecting the pin in the merged
     * config itself (see {@link isQwenOAuthBuiltinsPinnedEmpty}).
     */
    qwenOAuthBuiltinsDisabled?: boolean,
  ) {
    validateModelProvidersConfig(modelProvidersConfig, providerProtocolConfig);
    this.modelsByAuthType = new Map();
    this.providerProtocolConfig = providerProtocolConfig ?? {};
    this.modelProvidersConfig = modelProvidersConfig;
    this.allowedModelBaseUrls = validateAllowedBaseUrls(allowedModelBaseUrls);

    // Register the hard-coded qwen-oauth models unless an operator pins the
    // qwen-oauth list explicitly empty — an empty list is a signal to disable
    // the built-in provider, not "unconfigured" (a missing key keeps the
    // built-ins, preserving today's default). Callers with scope visibility
    // pass the explicit flag so a trusted workspace's pin does not disable
    // the built-ins; without it the merged config decides.
    const builtinsDisabled =
      qwenOAuthBuiltinsDisabled ??
      isQwenOAuthBuiltinsPinnedEmpty(
        modelProvidersConfig,
        providerProtocolConfig,
      );
    if (!builtinsDisabled) {
      this.registerAuthTypeModels(AuthType.QWEN_OAUTH, QWEN_OAUTH_MODELS);
    }

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

      // qwen-oauth uses hard-coded models: entries under a qwen-oauth id are
      // never registered (the built-ins are, unless the operator pins them
      // off — see the constructor). The loop still validates wireApi so a
      // malformed entry fails startup instead of vanishing.
      if (protocol === AuthType.QWEN_OAUTH) {
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
      // Managed endpoint allowlist: a model only registers when its resolved
      // baseUrl (explicit, or the protocol default) is on the list. An
      // `undefined` allowlist keeps today's behavior; an empty list blocks
      // everything, including protocol-default endpoints. The URL judged
      // here is the same one the registered model carries
      // (resolveRegistryBaseUrl).
      const resolvedBaseUrl = this.resolveRegistryBaseUrl(
        config,
        modelAuthType,
      );
      if (
        this.allowedModelBaseUrls !== undefined &&
        !isBaseUrlAllowed(resolvedBaseUrl, this.allowedModelBaseUrls)
      ) {
        // Record the drop so user-visible channels (advisor errors, skipped
        // provider warnings) can name the cause — the picker only ever sees
        // models that registered.
        this.allowlistDroppedModels.push({
          id: config.id,
          baseUrl: resolvedBaseUrl,
        });
        debugLogger.warn(
          `Model "${config.id}" for protocol "${modelAuthType}" (resolved ` +
            `baseUrl "${resolvedBaseUrl}") is not in the ` +
            `model.allowedBaseUrls allowlist; not registered.`,
        );
        continue;
      }
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
      (model) => !model.imageOnly && !model.voiceOnly && !model.realtimeOnly,
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
      shouldUseCanonicalModalities(config.id)
    ) {
      generationConfig.modalities = defaultModalities(config.id);
    }

    return {
      ...config,
      authType,
      name: config.name || config.id,
      // Same expression the allowlist filter judges (resolveRegistryBaseUrl),
      // so the URL the policy checked and the URL the model carries are equal.
      baseUrl: this.resolveRegistryBaseUrl(config, authType),
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

  /**
   * Reload models from updated configuration.
   * Clears existing user-configured models and re-registers from new config.
   * Preserves hard-coded qwen-oauth models unless the new config pins an
   * explicit empty list.
   *
   * @param providerProtocolConfig - Updated provider->protocol map. `undefined`
   *   PRESERVES the existing map (so a reload carrying only modelProviders does
   *   not lose the mapping); any object value REPLACES it, so passing `{}`
   *   clears the mapping. Callers that want to preserve must omit the argument,
   *   not pass `settings.providerProtocol ?? {}`.
   *
   * The managed endpoint allowlist is boot-frozen (like providerProtocol): a
   * reload always re-applies the boot-time policy and cannot widen or drop it.
   */
  reloadModels(
    modelProvidersConfig?: ModelProvidersConfig,
    providerProtocolConfig?: ProviderProtocolConfig,
  ): void {
    const reloaded = new ModelRegistry(
      modelProvidersConfig,
      providerProtocolConfig ?? this.providerProtocolConfig,
      this.allowedModelBaseUrls,
    );
    this.modelsByAuthType = reloaded.modelsByAuthType;
    this.providerProtocolConfig = reloaded.providerProtocolConfig;
    this.modelProvidersConfig = reloaded.modelProvidersConfig;
  }

  /** The raw providers config this registry was last built from. */
  getModelProvidersConfig(): ModelProvidersConfig | undefined {
    return this.modelProvidersConfig;
  }

  getProviderProtocolConfig(): ProviderProtocolConfig {
    return this.providerProtocolConfig;
  }

  /**
   * The models the managed allowlist filter dropped at registration (id +
   * the resolved baseUrl it was judged against); empty when no policy is in
   * force or nothing was dropped.
   */
  getAllowlistDroppedModels(): Array<{ id: string; baseUrl: string }> {
    return this.allowlistDroppedModels;
  }
}
