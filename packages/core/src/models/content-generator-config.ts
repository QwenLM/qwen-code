/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared utilities for building per-agent ContentGeneratorConfig.
 *
 * Used by both InProcessBackend (Arena agents) and SubagentManager (regular
 * subagents) to create dedicated ContentGenerators when an agent targets a
 * different model or provider than the parent process.
 */

import type { Config } from '../config/config.js';
import {
  resolveReasoningForModel,
  resolveReasoningCapabilities,
} from '../core/reasoning-overrides.js';
import {
  createContentGenerator,
  type AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import {
  AUTH_ENV_MAPPINGS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import { tryResolveModelProtocol } from './modelRegistry.js';
import type { ProviderProtocolConfig } from './types.js';
import type { ModelConfig, ResolvedModelConfig } from './types.js';
import type {
  ContentGeneratorConfigSource,
  ContentGeneratorConfigSources,
  InputModalities,
} from '../core/contentGenerator.js';
import {
  clampReasoningEffort,
  getGptReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  reasoningEffortsForCapability,
  setGeneratorReasoningEffort,
  type ReasoningEffort,
} from '../core/reasoning-effort.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_CONTENT_GENERATOR');

export interface AuthOverrides {
  registryBaseUrl?: string | null;
  authType: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentContentGeneratorOptions {
  /**
   * Reasoning effort for this agent alone, written onto the agent's own copy of
   * the config and never onto the session's; {@link resolveAgentReasoningTier}
   * decides which tier lands. An explicit tier also drops a thinking budget the
   * copy inherited, because Anthropic honours an explicit budget before the
   * tier. A thinking knob fixed in the provider settings (`extra_body`,
   * `samplingParams`) is left alone and still outranks the tier on the wire,
   * exactly as it outranks the session tier set by `/effort`.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Refuse to start an interactive login while building this generator. A
   * derived per-agent generator runs headless, so missing credentials must
   * fail fast instead of opening a device-authorization flow; a refresh of
   * cached credentials still happens.
   */
  requireCachedCredentials?: boolean;
}

/**
 * Build a ContentGeneratorConfig for a per-agent ContentGenerator.
 * Inherits operational settings (timeout, retries, proxy, sampling, etc.)
 * from the parent's config and overlays the agent-specific auth fields.
 *
 * For cross-provider agents the parent's API key / base URL are invalid,
 * so we resolve credentials from the provider-specific environment
 * variables (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). This mirrors
 * what a PTY subprocess does during its own initialization.
 */
export function buildAgentContentGeneratorConfig(
  base: Config,
  modelId: string | undefined,
  authOverrides: AuthOverrides,
  options: AgentContentGeneratorOptions = {},
): ContentGeneratorConfig {
  const nextConfig = buildInheritedAgentContentGeneratorConfig(
    base,
    modelId,
    authOverrides,
  );
  if (options.reasoningEffort !== undefined) {
    applyAgentReasoningEffort(base, nextConfig, options.reasoningEffort);
  }
  return nextConfig;
}

/**
 * The tier a per-agent `reasoningEffort` request lands as on a config shaped
 * like `target`, or `undefined` when it cannot land and the agent keeps the
 * effort it would otherwise have.
 *
 * The tier is limited to the tiers `/effort` offers for the target model
 * ({@link reasoningEffortsForCapability}). A model whose settings declare no
 * tiers falls back to its provider's built-in table, because the Responses
 * wire forwards a tier verbatim with no provider-side clamp. `/effort` refuses a
 * tier outside the set; an agent gets the closest tier the model does offer
 * instead (the next stronger one, else the strongest), so a script written for
 * one model still runs on another. Nothing lands when the model offers no
 * tiers, or when thinking is turned off for the session or on the target
 * config: a per-agent tier never re-enables thinking that was switched off,
 * including across a provider switch that cleared the session's
 * `reasoning: false` from the copy.
 */
export function resolveAgentReasoningTier(
  base: Config,
  target: Pick<
    ContentGeneratorConfig,
    'authType' | 'model' | 'baseUrl' | 'reasoning'
  >,
  requested: ReasoningEffort,
): ReasoningEffort | undefined {
  if (
    target.reasoning === false ||
    base.getContentGeneratorConfig().reasoning === false
  ) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' ignored: thinking is turned off.`,
    );
    return undefined;
  }
  const offered = offeredReasoningEfforts(base, target);
  if (offered.length === 0) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' ignored: model '${target.model}' offers no reasoning effort tiers.`,
    );
    return undefined;
  }
  const tier = clampReasoningEffort(requested, offered);
  if (tier !== requested) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' is not offered by model '${target.model}'; using '${tier}'.`,
    );
  }
  return tier;
}

function offeredReasoningEfforts(
  base: Config,
  target: Pick<ContentGeneratorConfig, 'authType' | 'model' | 'baseUrl'>,
): readonly ReasoningEffort[] {
  if ('reasoningSnapshot' in target && target.reasoningSnapshot) {
    const resolved = resolveReasoningForModel(
      base,
      target as ContentGeneratorConfig,
    );
    if (resolved) return reasoningEffortsForCapability(resolved);
    return (
      getGptReasoningCapabilities(target.model)?.efforts ??
      REASONING_EFFORT_TIERS
    );
  }
  if (target.authType && target.model) {
    const models = base.getModelsConfig();
    // Exact id + baseUrl first, then any entry with the same id: a gateway or
    // proxy base URL must not hide the tiers the registry declares (the same
    // fallback modelsConfig applies to this miss).
    const resolved =
      (target.baseUrl !== undefined
        ? models.getResolvedModel(target.authType, target.model, target.baseUrl)
        : undefined) ?? models.getResolvedModel(target.authType, target.model);
    const declared = resolveReasoningCapabilities(
      target,
      resolved?.capabilities?.reasoning,
    );
    if (declared) return reasoningEffortsForCapability(declared);
  }
  return (
    getGptReasoningCapabilities(target.model)?.efforts ?? REASONING_EFFORT_TIERS
  );
}

/**
 * Put the landed tier on `target` with the session setter's rule, then make it
 * authoritative on this copy: an inherited `budget_tokens` would otherwise
 * outrank it, because Anthropic honours an explicit budget before the tier, so
 * the copy drops it. The session's own block is never touched.
 */
function applyAgentReasoningEffort(
  base: Config,
  target: ContentGeneratorConfig,
  requested: ReasoningEffort,
): void {
  const tier = resolveAgentReasoningTier(base, target, requested);
  if (tier === undefined || !setGeneratorReasoningEffort(target, tier)) {
    return;
  }
  if (target.reasoning && target.reasoning.budget_tokens !== undefined) {
    const { budget_tokens: inheritedBudget, ...rest } = target.reasoning;
    target.reasoning = rest;
    debugLogger.debug(
      `Per-agent reasoning effort '${tier}' replaces an inherited thinking budget of ${inheritedBudget} tokens.`,
    );
  }
}

/** Call a Config accessor, treating a missing or throwing one as absent. */
function safeCall<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Track where a per-agent config's `modalities` came from.
 *
 * The session's sources map describes the primary model and only the primary
 * model; reusing it for an agent on another model makes a refusal name a
 * setting the agent never read (QwenLM/qwen-code#16185). Resolution here
 * mirrors the two layers the builder applies, in the same order, so the answer
 * matches the value actually on the agent's config.
 *
 * Registry-vs-raw is decided on the model's own `generationConfig` entry, not
 * on `ResolvedModelConfig.generationConfig`: the registry fills a missing
 * modalities with the name-based default, which would make every model look
 * provider-declared.
 */
export function resolveAgentModalitiesSource(
  base: Config,
  authOverrides: AuthOverrides,
  model: string,
  resolvedModel?: ResolvedModelConfig,
): ContentGeneratorConfigSource {
  // A partially-built Config (tests, a view created before models are loaded)
  // can throw here; the fallback below is the correct answer for it anyway.
  const providers = safeCall(() => base.getModelProvidersConfig?.());
  if (resolvedModel && providers) {
    const declared = findProviderEntry(
      providers,
      resolvedModel,
      safeCall(() => base.getModelsConfig?.()?.getProviderProtocolConfig?.()),
    );
    if (
      declared?.generationConfig?.modalities !== undefined &&
      // The registry canonicalises `modalities` away for a family whose
      // capabilities are fixed by the name, so the entry's value is not what
      // the agent runs with. Labelling that as provider-declared would aim a
      // refusal at a key that already asks for the refused modality — the same
      // false declaration ModelsConfig guards against on the primary path.
      sameModalities(
        declared.generationConfig.modalities,
        resolvedModel.generationConfig.modalities,
      )
    ) {
      return {
        kind: 'modelProviders',
        authType: resolvedModel.authType,
        modelId: resolvedModel.id,
        detail: 'generationConfig.modalities',
      };
    }
  }
  // Same provider with no registry route: the builder kept the parent's
  // settings-declared modalities, which the session's map already describes.
  if (!resolvedModel && base.getAuthType?.() === authOverrides.authType) {
    return base.getContentGeneratorConfigSources?.()['modalities'] ?? COMPUTED;
  }
  // Everything else was either name-detected by the registry or left as the
  // field's default; neither was read from a setting that names this model.
  // `via` still records the provider route the value was derived through, so a
  // refusal does not offer `model.generationConfig.modalities` to an agent
  // whose route came from `modelProviders` (QwenLM/qwen-code#16185).
  return {
    ...COMPUTED,
    detail: `auto-detected from '${model}'`,
    ...(resolvedModel
      ? {
          via: {
            kind: 'modelProviders' as const,
            authType: resolvedModel.authType,
            modelId: resolvedModel.id,
            detail: 'generationConfig',
          },
        }
      : {}),
  };
}

const COMPUTED: ContentGeneratorConfigSource = { kind: 'computed' };

/** Field-by-field equality, with absent and `false` treated alike. */
function sameModalities(
  declared: InputModalities | undefined,
  used: InputModalities | undefined,
): boolean {
  const keys: Array<keyof InputModalities> = ['image', 'pdf', 'audio', 'video'];
  return keys.every((key) => Boolean(declared?.[key]) === Boolean(used?.[key]));
}

/** The raw provider entry the agent's route was built from, if any. */
function findProviderEntry(
  providers: Record<string, ModelConfig[]>,
  resolvedModel: ResolvedModelConfig,
  protocolMap?: ProviderProtocolConfig,
): ModelConfig | undefined {
  for (const [providerId, entries] of Object.entries(providers)) {
    if (!Array.isArray(entries)) continue;
    const entry = entries.find(
      (candidate) =>
        candidate.id === resolvedModel.id &&
        (candidate.baseUrl ?? undefined) === resolvedModel.registryBaseUrl,
    );
    if (!entry) continue;
    // The registry resolves this entry's protocol with the user's map, so a
    // custom provider id routed through `providerProtocol` must be matched the
    // same way. The lenient resolver keeps an invalid entry from aborting view
    // creation — the registry already rejected it at startup.
    const protocol =
      tryResolveModelProtocol(providerId, entry, protocolMap) ??
      resolvedModel.authType;
    if (protocol === resolvedModel.authType) return entry;
  }
  return undefined;
}

function buildInheritedAgentContentGeneratorConfig(
  base: Config,
  modelId: string | undefined,
  authOverrides: AuthOverrides,
): ContentGeneratorConfig {
  const parentConfig = base.getContentGeneratorConfig();
  const sameProvider = authOverrides.authType === parentConfig.authType;
  const modelsConfig = base.getModelsConfig();
  const resolvedModel = modelId
    ? modelsConfig.getResolvedModel(
        authOverrides.authType as AuthType,
        modelId,
        authOverrides.registryBaseUrl !== undefined
          ? authOverrides.registryBaseUrl
          : authOverrides.baseUrl,
      )
    : undefined;
  if (
    modelId &&
    authOverrides.registryBaseUrl !== undefined &&
    (!resolvedModel ||
      (resolvedModel.registryBaseUrl ?? null) !== authOverrides.registryBaseUrl)
  ) {
    throw new Error(
      `Model '${modelId}' is no longer configured at the selected endpoint`,
    );
  }
  if (
    resolvedModel?.imageOnly ||
    resolvedModel?.voiceOnly ||
    resolvedModel?.realtimeOnly
  ) {
    throw new Error(
      `${resolvedModel.imageOnly ? 'Image' : resolvedModel.voiceOnly ? 'Voice' : 'Realtime'}-only model '${resolvedModel.id}' cannot be used for content generation`,
    );
  }

  const nextConfig: ContentGeneratorConfig = {
    ...parentConfig,
    model: modelId ?? parentConfig.model,
    authType: authOverrides.authType as AuthType,
  };

  // When switching providers, clear generation config fields so parent
  // settings (samplingParams, reasoning, extra_body, etc.) don't leak.
  if (!sameProvider) {
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (nextConfig as any)[field] = undefined;
    }
  }

  if (resolvedModel) {
    applyResolvedModelConfig(
      nextConfig,
      resolvedModel,
      parentConfig,
      authOverrides,
    );
    return nextConfig;
  }

  if (modelId && modelId !== parentConfig.model) {
    nextConfig.thinkingMandatory = undefined;
  }

  nextConfig.apiKey = resolveCredentialField(
    authOverrides.apiKey,
    sameProvider ? parentConfig.apiKey : undefined,
    authOverrides.authType,
    'apiKey',
  );
  if (
    !sameProvider ||
    nextConfig.model !== parentConfig.model ||
    (authOverrides.baseUrl !== undefined &&
      authOverrides.baseUrl !== parentConfig.baseUrl)
  )
    nextConfig.reasoningRouteBaseUrl = authOverrides.baseUrl;
  nextConfig.baseUrl =
    authOverrides.baseUrl ??
    resolveCredentialField(
      undefined,
      sameProvider ? parentConfig.baseUrl : undefined,
      authOverrides.authType,
      'baseUrl',
    );
  nextConfig.apiKeyEnvKey = sameProvider
    ? parentConfig.apiKeyEnvKey
    : undefined;

  return nextConfig;
}

/**
 * Compose `buildAgentContentGeneratorConfig` + `createContentGenerator` into
 * a single {@link RuntimeContentGeneratorView}. Both InProcessBackend and
 * SubagentManager need the same three-step recipe; this helper centralizes
 * it so the two paths can't drift.
 *
 * `contentGeneratorOwner` is the Config instance the new ContentGenerator
 * should bind to for cwd / workspace / telemetry purposes — typically the
 * per-agent override Config when one exists, or the parent Config otherwise.
 */
export async function createRuntimeContentGeneratorView(
  base: Config,
  contentGeneratorOwner: Config,
  modelId: string | undefined,
  authOverrides: AuthOverrides,
  options: AgentContentGeneratorOptions = {},
): Promise<RuntimeContentGeneratorView> {
  const contentGeneratorConfig = buildAgentContentGeneratorConfig(
    base,
    modelId,
    authOverrides,
    options,
  );
  const sameProvider =
    authOverrides.authType === base.getContentGeneratorConfig().authType;
  // The session's source map describes the primary model only; an agent on a
  // different model must carry its own, or a refusal quotes a setting the
  // agent never read (QwenLM/qwen-code#16185).
  const configSources: ContentGeneratorConfigSources =
    modelId === undefined && sameProvider
      ? // Same model, same provider: the session's sources describe this copy.
        { ...(base.getContentGeneratorConfigSources?.() ?? {}) }
      : {
          modalities: resolveAgentModalitiesSource(
            base,
            authOverrides,
            contentGeneratorConfig.model,
            modelId
              ? resolveRouteModel(base, modelId, authOverrides)
              : undefined,
          ),
        };
  const contentGenerator = options.requireCachedCredentials
    ? await createContentGenerator(
        contentGeneratorConfig,
        contentGeneratorOwner,
        // isInitialAuth: refuse an interactive login for a derived generator.
        true,
      )
    : await createContentGenerator(
        contentGeneratorConfig,
        contentGeneratorOwner,
      );
  return { contentGenerator, contentGeneratorConfig, configSources };
}

/** The registry entry `buildAgentContentGeneratorConfig` resolves for `modelId`. */
function resolveRouteModel(
  base: Config,
  modelId: string,
  authOverrides: AuthOverrides,
): ResolvedModelConfig | undefined {
  const modelsConfig = base.getModelsConfig?.();
  return modelsConfig?.getResolvedModel?.(
    authOverrides.authType as AuthType,
    modelId,
    authOverrides.registryBaseUrl !== undefined
      ? authOverrides.registryBaseUrl
      : authOverrides.baseUrl,
  );
}

function applyResolvedModelConfig(
  targetConfig: ContentGeneratorConfig,
  resolvedModel: ResolvedModelConfig,
  parentConfig: ContentGeneratorConfig,
  authOverrides: AuthOverrides,
): void {
  const sameProvider = authOverrides.authType === parentConfig.authType;
  const inheritCredentials =
    sameProvider &&
    (authOverrides.registryBaseUrl === undefined ||
      (resolvedModel.baseUrl === parentConfig.baseUrl &&
        resolvedModel.envKey === parentConfig.apiKeyEnvKey));
  if (!inheritCredentials) targetConfig.customHeaders = undefined;
  targetConfig.reasoningRouteBaseUrl = resolvedModel.registryBaseUrl ?? null;
  targetConfig.model = resolvedModel.id;
  targetConfig.authType = resolvedModel.authType;
  targetConfig.baseUrl =
    authOverrides.baseUrl ??
    resolvedModel.baseUrl ??
    (sameProvider ? parentConfig.baseUrl : undefined);

  if (resolvedModel.envKey) {
    targetConfig.apiKey =
      authOverrides.apiKey ??
      process.env[resolvedModel.envKey] ??
      (inheritCredentials ? parentConfig.apiKey : undefined);
    targetConfig.apiKeyEnvKey = resolvedModel.envKey;
  } else {
    targetConfig.apiKey =
      authOverrides.registryBaseUrl !== undefined && !inheritCredentials
        ? authOverrides.apiKey
        : resolveCredentialField(
            authOverrides.apiKey,
            sameProvider ? parentConfig.apiKey : undefined,
            authOverrides.authType,
            'apiKey',
          );
    targetConfig.apiKeyEnvKey = inheritCredentials
      ? parentConfig.apiKeyEnvKey
      : undefined;
  }

  // Cross-provider fields are cleared by buildAgentContentGeneratorConfig.
  // Same-provider fields inherit unless the registry overrides them, except
  // model capabilities such as thinkingMandatory, which must not leak, and
  // enableRequestMetadata, which is a per-model decision: an inherited true
  // would ship the DashScope tracing object to a vendor-forwarded side model.
  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    const registryValue = resolvedModel.generationConfig[field];
    if (
      registryValue !== undefined ||
      field === 'thinkingMandatory' ||
      field === 'enableRequestMetadata'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (targetConfig as any)[field] = registryValue;
    }
  }
}

/**
 * Resolve a credential field (apiKey or baseUrl) with the following
 * priority: explicit override → same-provider parent value → env var.
 */
export function resolveCredentialField(
  explicitValue: string | undefined,
  inheritedValue: string | undefined,
  authType: string,
  field: 'apiKey' | 'baseUrl',
): string | undefined {
  if (explicitValue) return explicitValue;
  if (inheritedValue) return inheritedValue;

  const envMapping =
    AUTH_ENV_MAPPINGS[authType as keyof typeof AUTH_ENV_MAPPINGS];
  if (!envMapping) return undefined;

  for (const envKey of envMapping[field]) {
    const value = process.env[envKey];
    if (value) return value;
  }
  return undefined;
}
