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

export interface AuthOverrides {
  authType: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Build a ContentGeneratorConfig for a per-agent ContentGenerator.
 * Inherits model options only within the same endpoint and auth type, while
 * retaining process-level options such as proxy and logging.
 *
 * For cross-provider agents the parent's API key / base URL are invalid,
 * so independently configured endpoints require their own credentials.
 * Default provider environment variables are used only without an explicit
 * endpoint or credential declaration.
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
    model: resolvedModel?.id ?? modelId ?? parentConfig.model,
    authType: authOverrides.authType as AuthType,
    baseUrl:
      authOverrides.baseUrl ??
      resolvedModel?.baseUrl ??
      resolveCredentialField(
        undefined,
        sameProvider ? parentConfig.baseUrl : undefined,
        authOverrides.authType,
        'baseUrl',
      ),
  };
  const sameEndpoint =
    sameProvider && nextConfig.baseUrl === parentConfig.baseUrl;
  const envKey = resolvedModel?.envKey;

  // A declared key variable is authoritative. Protocol compatibility alone
  // must not send a cloud credential to an unrelated (including local) URL.
  const useDefaultCredentials =
    sameEndpoint ||
    (!sameProvider &&
      resolvedModel?.registryBaseUrl === undefined &&
      (authOverrides.baseUrl === undefined ||
        authOverrides.baseUrl === resolvedModel?.baseUrl));
  nextConfig.apiKey =
    authOverrides.apiKey ??
    (envKey
      ? process.env[envKey]
      : useDefaultCredentials
        ? resolveCredentialField(
            undefined,
            sameEndpoint ? parentConfig.apiKey : undefined,
            authOverrides.authType,
            'apiKey',
          )
        : undefined);
  nextConfig.apiKeyEnvKey =
    envKey ?? (sameEndpoint ? parentConfig.apiKeyEnvKey : undefined);

  // Different endpoints may share a protocol but not request options.
  if (!sameEndpoint) {
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (nextConfig as any)[field] = undefined;
    }
  }
  if (
    (envKey && envKey !== parentConfig.apiKeyEnvKey) ||
    (authOverrides.apiKey !== undefined &&
      authOverrides.apiKey !== parentConfig.apiKey)
  ) {
    nextConfig.customHeaders = undefined;
  }

  if (resolvedModel) {
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      const registryValue = resolvedModel.generationConfig[field];
      if (registryValue !== undefined || field === 'thinkingMandatory') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (nextConfig as any)[field] = registryValue;
      }
    }
  } else if (modelId && modelId !== parentConfig.model) {
    nextConfig.thinkingMandatory = undefined;
  }

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
): Promise<RuntimeContentGeneratorView> {
  const contentGeneratorConfig = buildAgentContentGeneratorConfig(
    base,
    modelId,
    authOverrides,
  );
  const contentGenerator = await createContentGenerator(
    contentGeneratorConfig,
    contentGeneratorOwner,
  );
  return { contentGenerator, contentGeneratorConfig };
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
