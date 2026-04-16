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
  type AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import {
  AUTH_ENV_MAPPINGS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ResolvedModelConfig } from './types.js';

export interface AuthOverrides {
  authType: string;
  apiKey?: string;
  baseUrl?: string;
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
): ContentGeneratorConfig {
  const parentConfig = base.getContentGeneratorConfig();
  const sameProvider = authOverrides.authType === parentConfig.authType;
  const modelsConfig = base.getModelsConfig();
  const resolvedModel = modelId
    ? modelsConfig.getResolvedModel(authOverrides.authType as AuthType, modelId)
    : undefined;

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

  // Apply registry-defined generation config fields. Cross-provider
  // clearing is already handled by buildAgentContentGeneratorConfig,
  // so here we only overwrite when the registry provides a value.
  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    const registryValue = resolvedModel.generationConfig[field];
    if (registryValue !== undefined) {
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
