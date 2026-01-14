/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ModelConfigResolver - Unified resolver for model-related configuration.
 *
 * This module consolidates all model configuration resolution logic,
 * eliminating duplicate code between CLI and Core layers.
 *
 * Configuration priority (highest to lowest):
 * 1. modelProvider - Explicit selection from ModelProviders config
 * 2. CLI arguments - Command line flags (--model, --openaiApiKey, etc.)
 * 3. Environment variables - OPENAI_API_KEY, OPENAI_MODEL, etc.
 * 4. Settings - User/workspace settings file
 * 5. Defaults - Built-in default values
 */

import { AuthType } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import {
  resolveField,
  resolveOptionalField,
  layer,
  envLayer,
  cliSource,
  settingsSource,
  modelProvidersSource,
  defaultSource,
  computedSource,
  type ConfigSource,
  type ConfigSources,
  type ConfigLayer,
} from '../utils/configResolver.js';
import {
  AUTH_ENV_MAPPINGS,
  DEFAULT_MODELS,
  QWEN_OAUTH_ALLOWED_MODELS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ModelConfig as ModelProviderConfig } from './types.js';
export {
  validateModelConfig,
  type ModelConfigValidationResult,
} from '../core/contentGenerator.js';

/**
 * CLI-provided configuration values
 */
export interface ModelConfigCliInput {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Settings-provided configuration values
 */
export interface ModelConfigSettingsInput {
  /** Model name from settings.model.name */
  model?: string;
  /** API key from settings.security.auth.apiKey */
  apiKey?: string;
  /** Base URL from settings.security.auth.baseUrl */
  baseUrl?: string;
  /** Generation config from settings.model.generationConfig */
  generationConfig?: Partial<ContentGeneratorConfig>;
}

/**
 * All input sources for model configuration resolution
 */
export interface ModelConfigSourcesInput {
  /** Authentication type */
  authType?: AuthType;

  /** CLI arguments (highest priority for user-provided values) */
  cli?: ModelConfigCliInput;

  /** Settings file configuration */
  settings?: ModelConfigSettingsInput;

  /** Environment variables (injected for testability) */
  env: Record<string, string | undefined>;

  /** Model from ModelProviders (explicit selection, highest priority) */
  modelProvider?: ModelProviderConfig;

  /** Proxy URL (computed from Config) */
  proxy?: string;
}

/**
 * Result of model configuration resolution
 */
export interface ModelConfigResolutionResult {
  /** The fully resolved configuration */
  config: ContentGeneratorConfig;
  /** Source attribution for each field */
  sources: ConfigSources;
  /** Warnings generated during resolution */
  warnings: string[];
}

/**
 * Resolve model configuration from all input sources.
 *
 * This is the single entry point for model configuration resolution.
 * It replaces the duplicate logic in:
 * - packages/cli/src/utils/modelProviderUtils.ts (resolveCliGenerationConfig)
 * - packages/core/src/core/contentGenerator.ts (resolveContentGeneratorConfigWithSources)
 *
 * @param input - All configuration sources
 * @returns Resolved configuration with source tracking
 */
export function resolveModelConfig(
  input: ModelConfigSourcesInput,
): ModelConfigResolutionResult {
  const { authType, cli, settings, env, modelProvider, proxy } = input;
  const warnings: string[] = [];
  const sources: ConfigSources = {};

  // Special handling for Qwen OAuth
  if (authType === AuthType.QWEN_OAUTH) {
    return resolveQwenOAuthConfig(input, warnings);
  }

  // Get auth-specific env var mappings.
  // If authType is not provided, do not read any auth env vars.
  const envMapping = authType
    ? AUTH_ENV_MAPPINGS[authType]
    : { model: [], apiKey: [], baseUrl: [] };

  // Build layers for each field in priority order
  // Priority: modelProvider > cli > env > settings > default

  // ---- Model ----
  const modelLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider) {
    modelLayers.push(
      layer(
        modelProvider.id,
        modelProvidersSource(authType, modelProvider.id, 'model.id'),
      ),
    );
  }
  if (cli?.model) {
    modelLayers.push(layer(cli.model, cliSource('--model')));
  }
  for (const envKey of envMapping.model) {
    modelLayers.push(envLayer(env, envKey));
  }
  if (settings?.model) {
    modelLayers.push(layer(settings.model, settingsSource('model.name')));
  }

  const defaultModel = authType ? DEFAULT_MODELS[authType] : '';
  const modelResult = resolveField(
    modelLayers,
    defaultModel,
    defaultSource(defaultModel),
  );
  sources['model'] = modelResult.source;

  // ---- API Key ----
  const apiKeyLayers: Array<ConfigLayer<string>> = [];

  // For modelProvider, read from the specified envKey
  if (authType && modelProvider?.envKey) {
    const apiKeyFromEnv = env[modelProvider.envKey];
    if (apiKeyFromEnv) {
      apiKeyLayers.push(
        layer(apiKeyFromEnv, {
          kind: 'env',
          envKey: modelProvider.envKey,
          via: modelProvidersSource(authType, modelProvider.id, 'envKey'),
        }),
      );
    }
  }
  if (cli?.apiKey) {
    apiKeyLayers.push(layer(cli.apiKey, cliSource('--openaiApiKey')));
  }
  for (const envKey of envMapping.apiKey) {
    apiKeyLayers.push(envLayer(env, envKey));
  }
  if (settings?.apiKey) {
    apiKeyLayers.push(
      layer(settings.apiKey, settingsSource('security.auth.apiKey')),
    );
  }

  const apiKeyResult = resolveOptionalField(apiKeyLayers);
  if (apiKeyResult) {
    sources['apiKey'] = apiKeyResult.source;
  }

  // ---- Base URL ----
  const baseUrlLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider?.baseUrl) {
    baseUrlLayers.push(
      layer(
        modelProvider.baseUrl,
        modelProvidersSource(authType, modelProvider.id, 'baseUrl'),
      ),
    );
  }
  if (cli?.baseUrl) {
    baseUrlLayers.push(layer(cli.baseUrl, cliSource('--openaiBaseUrl')));
  }
  for (const envKey of envMapping.baseUrl) {
    baseUrlLayers.push(envLayer(env, envKey));
  }
  if (settings?.baseUrl) {
    baseUrlLayers.push(
      layer(settings.baseUrl, settingsSource('security.auth.baseUrl')),
    );
  }

  const baseUrlResult = resolveOptionalField(baseUrlLayers);
  if (baseUrlResult) {
    sources['baseUrl'] = baseUrlResult.source;
  }

  // ---- API Key Env Key (for error messages) ----
  let apiKeyEnvKey: string | undefined;
  if (authType && modelProvider?.envKey) {
    apiKeyEnvKey = modelProvider.envKey;
    sources['apiKeyEnvKey'] = modelProvidersSource(
      authType,
      modelProvider.id,
      'envKey',
    );
  }

  // ---- Generation Config (from settings or modelProvider) ----
  const generationConfig = resolveGenerationConfig(
    settings?.generationConfig,
    modelProvider?.generationConfig,
    authType,
    modelProvider?.id,
    sources,
  );

  // Build final config
  const config: ContentGeneratorConfig = {
    authType,
    model: modelResult.value || '',
    apiKey: apiKeyResult?.value,
    apiKeyEnvKey,
    baseUrl: baseUrlResult?.value,
    proxy,
    ...generationConfig,
  };

  // Add proxy source
  if (proxy) {
    sources['proxy'] = computedSource('Config.getProxy()');
  }

  // Add authType source
  sources['authType'] = computedSource('provided by caller');

  return { config, sources, warnings };
}

/**
 * Special resolver for Qwen OAuth authentication.
 * Qwen OAuth has fixed model options and uses dynamic tokens.
 */
function resolveQwenOAuthConfig(
  input: ModelConfigSourcesInput,
  warnings: string[],
): ModelConfigResolutionResult {
  const { cli, settings, proxy, modelProvider } = input;
  const sources: ConfigSources = {};

  // Qwen OAuth only allows specific models
  const allowedModels = new Set<string>(QWEN_OAUTH_ALLOWED_MODELS);

  // Determine requested model
  const requestedModel = cli?.model || settings?.model;
  let resolvedModel: string;
  let modelSource: ConfigSource;

  if (requestedModel && allowedModels.has(requestedModel)) {
    resolvedModel = requestedModel;
    modelSource = cli?.model
      ? cliSource('--model')
      : settingsSource('model.name');
  } else {
    if (requestedModel) {
      warnings.push(
        `Unsupported Qwen OAuth model '${requestedModel}', falling back to '${DEFAULT_QWEN_MODEL}'.`,
      );
    }
    resolvedModel = DEFAULT_QWEN_MODEL;
    modelSource = defaultSource(`fallback to '${DEFAULT_QWEN_MODEL}'`);
  }

  sources['model'] = modelSource;
  sources['apiKey'] = computedSource('Qwen OAuth dynamic token');
  sources['authType'] = computedSource('provided by caller');

  if (proxy) {
    sources['proxy'] = computedSource('Config.getProxy()');
  }

  // Resolve generation config from settings and modelProvider
  const generationConfig = resolveGenerationConfig(
    settings?.generationConfig,
    modelProvider?.generationConfig,
    AuthType.QWEN_OAUTH,
    resolvedModel,
    sources,
  );

  const config: ContentGeneratorConfig = {
    authType: AuthType.QWEN_OAUTH,
    model: resolvedModel,
    apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
    proxy,
    ...generationConfig,
  };

  return { config, sources, warnings };
}

/**
 * Resolve generation config fields (samplingParams, timeout, etc.)
 */
function resolveGenerationConfig(
  settingsConfig: Partial<ContentGeneratorConfig> | undefined,
  modelProviderConfig: Partial<ContentGeneratorConfig> | undefined,
  authType: AuthType | undefined,
  modelId: string | undefined,
  sources: ConfigSources,
): Partial<ContentGeneratorConfig> {
  const result: Partial<ContentGeneratorConfig> = {};

  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    // ModelProvider config takes priority over settings config
    if (authType && modelProviderConfig && field in modelProviderConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = modelProviderConfig[field];
      sources[field] = modelProvidersSource(
        authType,
        modelId || '',
        `generationConfig.${field}`,
      );
    } else if (settingsConfig && field in settingsConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = settingsConfig[field];
      sources[field] = settingsSource(`model.generationConfig.${field}`);
    }
  }

  return result;
}
