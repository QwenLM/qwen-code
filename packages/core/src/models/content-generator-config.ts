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
  createContentGenerator,
  type AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import {
  AUTH_ENV_MAPPINGS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ResolvedModelConfig } from './types.js';
import {
  clampReasoningEffort,
  getGptReasoningCapabilities,
  parseModelReasoningCapabilities,
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
  if (target.authType && target.model) {
    const models = base.getModelsConfig();
    // Exact id + baseUrl first, then any entry with the same id: a gateway or
    // proxy base URL must not hide the tiers the registry declares (the same
    // fallback modelsConfig applies to this miss).
    const resolved =
      (target.baseUrl !== undefined
        ? models.getResolvedModel(target.authType, target.model, target.baseUrl)
        : undefined) ?? models.getResolvedModel(target.authType, target.model);
    const declared = parseModelReasoningCapabilities(
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
  if (resolvedModel?.imageOnly || resolvedModel?.voiceOnly) {
    throw new Error(
      `${resolvedModel.imageOnly ? 'Image' : 'Voice'}-only model '${resolvedModel.id}' cannot be used for content generation`,
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
  return { contentGenerator, contentGeneratorConfig };
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
  // model capabilities such as thinkingMandatory, which must not leak.
  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    const registryValue = resolvedModel.generationConfig[field];
    if (registryValue !== undefined || field === 'thinkingMandatory') {
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
