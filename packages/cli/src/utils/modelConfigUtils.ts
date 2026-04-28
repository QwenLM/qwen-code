/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type ContentGeneratorConfig,
  type ContentGeneratorConfigSources,
  resolveModelConfig,
  type ModelConfigSourcesInput,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import type { Settings } from '../config/settings.js';

export interface CliGenerationConfigInputs {
  argv: {
    model?: string | undefined;
    openaiApiKey?: string | undefined;
    openaiBaseUrl?: string | undefined;
    openaiLogging?: boolean | undefined;
    openaiLoggingDir?: string | undefined;
  };
  settings: Settings;
  selectedAuthType: AuthType | undefined;
  /**
   * Injectable env for testability. Defaults to process.env at callsites.
   */
  env?: Record<string, string | undefined>;
}

export interface ResolvedCliGenerationConfig {
  /** The resolved model id (may be empty string if not resolvable at CLI layer) */
  model: string;
  /** API key for OpenAI-compatible auth */
  apiKey: string;
  /** Base URL for OpenAI-compatible auth */
  baseUrl: string;
  /** The full generation config to pass to core Config */
  generationConfig: Partial<ContentGeneratorConfig>;
  /** Source attribution for each resolved field */
  sources: ContentGeneratorConfigSources;
  /** Warnings generated during resolution */
  warnings: string[];
}

export function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env['QWEN_OAUTH']) {
    return AuthType.QWEN_OAUTH;
  }

  if (
    process.env['OPENAI_API_KEY'] &&
    process.env['OPENAI_MODEL'] &&
    process.env['OPENAI_BASE_URL']
  ) {
    return AuthType.USE_OPENAI;
  }

  if (process.env['GEMINI_API_KEY'] && process.env['GEMINI_MODEL']) {
    return AuthType.USE_GEMINI;
  }

  if (process.env['GOOGLE_API_KEY'] && process.env['GOOGLE_MODEL']) {
    return AuthType.USE_VERTEX_AI;
  }

  if (
    process.env['ANTHROPIC_API_KEY'] &&
    process.env['ANTHROPIC_MODEL'] &&
    process.env['ANTHROPIC_BASE_URL']
  ) {
    return AuthType.USE_ANTHROPIC;
  }

  return undefined;
}

/**
 * Unified resolver for CLI generation config.
 *
 * Precedence (for OpenAI auth):
 * - model: argv.model > settings.model.name > OPENAI_MODEL > QWEN_MODEL
 * - apiKey: argv.openaiApiKey > OPENAI_API_KEY > settings.security.auth.apiKey
 * - baseUrl: argv.openaiBaseUrl > OPENAI_BASE_URL > settings.security.auth.baseUrl
 *
 * For non-OpenAI auth, only argv.model override is respected at CLI layer.
 */
export function resolveCliGenerationConfig(
  inputs: CliGenerationConfigInputs,
): ResolvedCliGenerationConfig {
  const { argv, settings, selectedAuthType } = inputs;
  const env = inputs.env ?? (process.env as Record<string, string | undefined>);

  const authType = selectedAuthType;

  // Resolve the target model based on strict precedence:
  // argv.model > settings.model.name > OPENAI_MODEL > QWEN_MODEL
  // Env vars are ONLY considered when neither argv.model nor settings.model.name is set.
  let resolvedModel: string | undefined;
  if (argv.model) {
    resolvedModel = argv.model;
  } else if (settings.model?.name) {
    resolvedModel = settings.model.name;
  } else if (authType === AuthType.USE_OPENAI) {
    resolvedModel = env['OPENAI_MODEL'] || env['QWEN_MODEL'];
  }

  // Find a matching provider for the resolved model (for metadata: generationConfig, envKey, etc.)
  // When resolvedModel is from settings and matches a provider, modelProvider.id == settings.model.name,
  // so the resolver correctly uses the settings-selected model (no override occurs).
  // The old candidate-loop code that fell through to OPENAI_MODEL is gone.
  let modelProvider: ProviderModelConfig | undefined;
  if (resolvedModel && authType && settings.modelProviders) {
    const providers = settings.modelProviders[authType];
    if (providers && Array.isArray(providers)) {
      modelProvider = providers.find((p) => p.id === resolvedModel);
    }
  }

  // Filter env to prevent OPENAI_MODEL/QWEN_MODEL from overriding higher-priority sources.
  // Only pass these env vars when we actually resolved the model from them.
  const filteredEnv = { ...env };
  if (
    resolvedModel !== env['OPENAI_MODEL'] &&
    resolvedModel !== env['QWEN_MODEL']
  ) {
    delete filteredEnv['OPENAI_MODEL'];
    delete filteredEnv['QWEN_MODEL'];
  }

  const configSources: ModelConfigSourcesInput = {
    authType,
    cli: {
      model: argv.model,
      apiKey: argv.openaiApiKey,
      baseUrl: argv.openaiBaseUrl,
    },
    settings: {
      model: settings.model?.name,
      apiKey: settings.security?.auth?.apiKey,
      baseUrl: settings.security?.auth?.baseUrl,
      generationConfig: settings.model?.generationConfig as
        | Partial<ContentGeneratorConfig>
        | undefined,
    },
    modelProvider,
    env: filteredEnv,
  };

  const resolved = resolveModelConfig(configSources);

  // Resolve OpenAI logging config (CLI-specific, not part of core resolver)
  const enableOpenAILogging =
    (typeof argv.openaiLogging === 'undefined'
      ? settings.model?.enableOpenAILogging
      : argv.openaiLogging) ?? false;

  const openAILoggingDir =
    argv.openaiLoggingDir || settings.model?.openAILoggingDir;

  // Build the full generation config
  // Note: we merge the resolved config with logging settings
  const generationConfig: Partial<ContentGeneratorConfig> = {
    ...resolved.config,
    enableOpenAILogging,
    openAILoggingDir,
  };

  return {
    model: resolved.config.model || '',
    apiKey: resolved.config.apiKey || '',
    baseUrl: resolved.config.baseUrl || '',
    generationConfig,
    sources: resolved.sources,
    warnings: resolved.warnings,
  };
}
