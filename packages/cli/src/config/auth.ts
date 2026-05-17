/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type ModelProvidersConfig,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import { loadEnvironment, loadSettings, type Settings } from './settings.js';
import { t } from '../i18n/index.js';

/**
 * Default environment variable names for each auth type
 */
const DEFAULT_ENV_KEYS: Record<string, string> = {
  [AuthType.USE_OPENAI]: 'OPENAI_API_KEY',
  [AuthType.USE_ANTHROPIC]: 'ANTHROPIC_API_KEY',
  [AuthType.USE_GEMINI]: 'GEMINI_API_KEY',
  [AuthType.USE_VERTEX_AI]: 'GOOGLE_API_KEY',
};

/**
 * Find model configuration from modelProviders by authType and modelId.
 * When multiple models share the same id (different baseUrls), returns the
 * first match. Callers that need an exact match should also compare baseUrl.
 */
function findModelConfig(
  modelProviders: ModelProvidersConfig | undefined,
  authType: string,
  modelId: string | undefined,
  baseUrl?: string,
): ProviderModelConfig | undefined {
  if (!modelProviders || !modelId) {
    return undefined;
  }

  const models = modelProviders[authType];
  if (!Array.isArray(models)) {
    return undefined;
  }

  if (baseUrl) {
    return models.find((m) => m.id === modelId && m.baseUrl === baseUrl);
  }
  return models.find((m) => m.id === modelId);
}

/**
 * Check if API key is available for the given auth type and model configuration.
 * Prioritizes custom envKey from modelProviders over default environment variables.
 */
function hasApiKeyForAuth(
  authType: string,
  settings: Settings,
  config?: Config,
): {
  hasKey: boolean;
  checkedEnvKey: string | undefined;
  isExplicitEnvKey: boolean;
} {
  const modelProviders = settings.modelProviders as
    | ModelProvidersConfig
    | undefined;

  // Use config.getModelsConfig().getModel() if available for accurate model ID resolution
  // that accounts for CLI args, env vars, and settings. Fall back to settings.model.name.
  const modelId = config?.getModelsConfig().getModel() ?? settings.model?.name;

  // Try to find model-specific envKey from modelProviders
  const modelConfig = findModelConfig(modelProviders, authType, modelId);

  // If a Config is available, prefer the API key already resolved into the
  // generation config. The unified resolver folds CLI flags (e.g.
  // --openai-api-key), env vars, settings.security.auth.apiKey, and
  // modelProvider envKey lookups into this single value, so it is the same
  // key that refreshAuth will actually use at runtime. Validating against it
  // keeps pre-flight checks consistent with runtime behavior — without this,
  // CLI-provided credentials are silently ignored when no env var is set
  // (issue #3171).
  const resolvedApiKey = config
    ?.getModelsConfig()
    .getGenerationConfig()?.apiKey;
  if (resolvedApiKey) {
    return {
      hasKey: true,
      checkedEnvKey: modelConfig?.envKey ?? DEFAULT_ENV_KEYS[authType],
      isExplicitEnvKey: !!modelConfig?.envKey,
    };
  }

  if (modelConfig?.envKey) {
    // Explicit envKey configured - only check this env var, no apiKey fallback
    const hasKey = !!process.env[modelConfig.envKey];
    return {
      hasKey,
      checkedEnvKey: modelConfig.envKey,
      isExplicitEnvKey: true,
    };
  }

  // Using default environment variable - apiKey fallback is allowed
  const defaultEnvKey = DEFAULT_ENV_KEYS[authType];
  if (defaultEnvKey) {
    const hasKey = !!process.env[defaultEnvKey];
    if (hasKey) {
      return { hasKey, checkedEnvKey: defaultEnvKey, isExplicitEnvKey: false };
    }
  }

  // Also check settings.security.auth.apiKey as fallback (only for default env key)
  if (settings.security?.auth?.apiKey) {
    return {
      hasKey: true,
      checkedEnvKey: defaultEnvKey || undefined,
      isExplicitEnvKey: false,
    };
  }

  return {
    hasKey: false,
    checkedEnvKey: defaultEnvKey,
    isExplicitEnvKey: false,
  };
}

/**
 * Generate API key error message based on auth check result.
 * Returns null if API key is present, otherwise returns the appropriate error message.
 */
function getApiKeyError(
  authMethod: string,
  settings: Settings,
  config?: Config,
): string | null {
  const { hasKey, checkedEnvKey, isExplicitEnvKey } = hasApiKeyForAuth(
    authMethod,
    settings,
    config,
  );
  if (hasKey) {
    return null;
  }

  const envKeyHint = checkedEnvKey || DEFAULT_ENV_KEYS[authMethod];
  if (isExplicitEnvKey) {
    return t(
      '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.',
      { envKeyHint },
    );
  }
  return t(
    '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.',
    { envKeyHint },
  );
}

/**
 * Validate that the required credentials and configuration exist for the given auth method.
 */
export function validateAuthMethod(
  authMethod: string,
  config?: Config,
): string | null {
  const settings = loadSettings();
  loadEnvironment(settings.merged);

  if (authMethod === AuthType.USE_OPENAI) {
    const { hasKey, checkedEnvKey, isExplicitEnvKey } = hasApiKeyForAuth(
      authMethod,
      settings.merged,
      config,
    );
    if (!hasKey) {
      const envKeyHint = checkedEnvKey
        ? `'${checkedEnvKey}'`
        : "'OPENAI_API_KEY'";
      if (isExplicitEnvKey) {
        // Explicit envKey configured - only suggest setting the env var
        return t(
          'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.',
          { envKeyHint },
        );
      }
      // Default env key - can use either apiKey or env var
      return t(
        'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.',
        { envKeyHint },
      );
    }
    return null;
  }

  if (authMethod === AuthType.QWEN_OAUTH) {
    // Qwen OAuth free tier was discontinued on 2026-04-15.
    // Block new OAuth setups; existing cached tokens still work until server rejects them.
    return t(
      'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.',
    );
  }

  if (authMethod === AuthType.USE_ANTHROPIC) {
    const apiKeyError = getApiKeyError(authMethod, settings.merged, config);
    if (apiKeyError) {
      return apiKeyError;
    }

    // Check baseUrl - can come from modelProviders or environment
    const modelProviders = settings.merged.modelProviders as
      | ModelProvidersConfig
      | undefined;
    // Use config.getModelsConfig().getModel() if available for accurate model ID
    const modelId =
      config?.getModelsConfig().getModel() ?? settings.merged.model?.name;
    const modelConfig = findModelConfig(modelProviders, authMethod, modelId);

    if (modelConfig && !modelConfig.baseUrl) {
      return t(
        'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.',
      );
    }
    if (!modelConfig && !process.env['ANTHROPIC_BASE_URL']) {
      return t('ANTHROPIC_BASE_URL environment variable not found.');
    }

    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    const apiKeyError = getApiKeyError(authMethod, settings.merged, config);
    if (apiKeyError) {
      return apiKeyError;
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const apiKeyError = getApiKeyError(authMethod, settings.merged, config);
    if (apiKeyError) {
      return apiKeyError;
    }

    process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
    return null;
  }

  return t('Invalid auth method selected.');
}
