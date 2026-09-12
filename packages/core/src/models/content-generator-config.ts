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
  parseModelReasoningCapabilities,
  reasoningEffortsForCapability,
  setGeneratorReasoningEffort,
  type ReasoningEffort,
} from '../core/reasoning-effort.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_CONTENT_GENERATOR');

export interface AuthOverrides {
  authType: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentContentGeneratorOptions {
  /**
   * Reasoning effort for this agent alone, written onto the agent's own copy of
   * the config and never onto the session's. Limited to the tiers `/effort`
   * offers for the agent's model; see {@link applyAgentReasoningEffort}.
   */
  reasoningEffort?: ReasoningEffort;
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
 * Put a per-agent tier on `target`, limited to the tiers `/effort` offers for
 * the agent's model. `/effort` refuses a tier outside that set; an agent gets
 * the closest tier the model does offer instead (the next stronger one, else
 * the strongest), so a script written for one model still runs on another. A
 * model that offers no tiers, or has thinking turned off, keeps the tier the
 * agent inherited. The tier is then written with the rule the session setter
 * uses, and each provider clamps it per request as it does the session tier.
 */
function applyAgentReasoningEffort(
  base: Config,
  target: ContentGeneratorConfig,
  requested: ReasoningEffort,
): void {
  const capability =
    target.authType && target.model
      ? base
          .getModelsConfig()
          .getResolvedModel(target.authType, target.model, target.baseUrl)
          ?.capabilities?.reasoning
      : undefined;
  const offered = reasoningEffortsForCapability(
    parseModelReasoningCapabilities(capability),
  );
  if (offered.length === 0) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' ignored: model '${target.model}' offers no reasoning effort tiers.`,
    );
    return;
  }
  const tier = clampReasoningEffort(requested, offered);
  if (!setGeneratorReasoningEffort(target, tier)) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' ignored: thinking is disabled for model '${target.model}'.`,
    );
    return;
  }
  if (tier !== requested) {
    debugLogger.debug(
      `Per-agent reasoning effort '${requested}' is not offered by model '${target.model}'; using '${tier}'.`,
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
        authOverrides.baseUrl,
      )
    : undefined;
  if (resolvedModel?.imageOnly) {
    throw new Error(
      `Image-only model '${resolvedModel.id}' cannot be used for content generation`,
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
  const contentGenerator = await createContentGenerator(
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
      (sameProvider ? parentConfig.apiKey : undefined);
    targetConfig.apiKeyEnvKey = resolvedModel.envKey;
  } else {
    targetConfig.apiKey = resolveCredentialField(
      authOverrides.apiKey,
      sameProvider ? parentConfig.apiKey : undefined,
      authOverrides.authType,
      'apiKey',
    );
    targetConfig.apiKeyEnvKey = sameProvider
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
