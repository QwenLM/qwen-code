/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';
import type {
  ConfigSource,
  ConfigSourceKind,
  ConfigSources,
} from '../utils/configResolver.js';
import {
  getDefaultApiKeyEnvVar,
  getDefaultModelEnvVar,
  MissingAnthropicBaseUrlEnvError,
  MissingApiKeyError,
  MissingBaseUrlError,
  MissingModelError,
  StrictMissingCredentialsError,
  StrictMissingModelIdError,
} from '../models/modelConfigErrors.js';
import { PROVIDER_SOURCED_FIELDS } from '../models/modelsConfig.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  useSummarizedThinking(): boolean;
}

export enum AuthType {
  USE_OPENAI = 'openai',
  QWEN_OAUTH = 'qwen-oauth',
  USE_GEMINI = 'gemini',
  USE_VERTEX_AI = 'vertex-ai',
  USE_ANTHROPIC = 'anthropic',
}

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  apiKeyEnvKey?: string;
  baseUrl?: string;
  vertexai?: boolean;
  authType?: AuthType | undefined;
  enableOpenAILogging?: boolean;
  openAILoggingDir?: string;
  timeout?: number; // Timeout configuration in milliseconds
  maxRetries?: number; // Maximum retries for failed requests
  disableCacheControl?: boolean; // Disable cache control for DashScope providers
  samplingParams?: {
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    temperature?: number;
    max_tokens?: number;
  };
  reasoning?:
    | false
    | {
        effort?: 'low' | 'medium' | 'high';
        budget_tokens?: number;
      };
  proxy?: string | undefined;
  userAgent?: string;
  // Schema compliance mode for tool definitions
  schemaCompliance?: 'auto' | 'openapi_30';
  // Custom HTTP headers to be sent with requests
  customHeaders?: Record<string, string>;
};

// Keep the public ContentGeneratorConfigSources API, but reuse the generic
// source-tracking types from utils/configResolver to avoid duplication.
export type ContentGeneratorConfigSourceKind = ConfigSourceKind;
export type ContentGeneratorConfigSource = ConfigSource;
export type ContentGeneratorConfigSources = ConfigSources;

export type ResolvedContentGeneratorConfig = {
  config: ContentGeneratorConfig;
  sources: ContentGeneratorConfigSources;
};

function setSource(
  sources: ContentGeneratorConfigSources,
  path: string,
  source: ContentGeneratorConfigSource,
): void {
  sources[path] = source;
}

function getSeedSource(
  seed: ContentGeneratorConfigSources | undefined,
  path: string,
): ContentGeneratorConfigSource | undefined {
  return seed?.[path];
}

/**
 * Resolve ContentGeneratorConfig while tracking the source of each effective field.
 *
 * This function now primarily validates and finalizes the configuration that has
 * already been resolved by ModelConfigResolver. The env fallback logic has been
 * moved to the unified resolver to eliminate duplication.
 *
 * Note: The generationConfig passed here should already be fully resolved with
 * proper source tracking from the caller (CLI/SDK layer).
 */
export function resolveContentGeneratorConfigWithSources(
  config: Config,
  authType: AuthType | undefined,
  generationConfig?: Partial<ContentGeneratorConfig>,
  seedSources?: ContentGeneratorConfigSources,
  options?: { strictModelProvider?: boolean },
): ResolvedContentGeneratorConfig {
  const sources: ContentGeneratorConfigSources = { ...(seedSources || {}) };
  const strictModelProvider = options?.strictModelProvider === true;

  // Build config with computed fields
  const newContentGeneratorConfig: Partial<ContentGeneratorConfig> = {
    ...(generationConfig || {}),
    authType,
    proxy: config?.getProxy(),
  };

  // Set sources for computed fields
  setSource(sources, 'authType', {
    kind: 'computed',
    detail: 'provided by caller',
  });
  if (config?.getProxy()) {
    setSource(sources, 'proxy', {
      kind: 'computed',
      detail: 'Config.getProxy()',
    });
  }

  // Preserve seed sources for fields that were passed in
  const seedOrUnknown = (path: string): ContentGeneratorConfigSource =>
    getSeedSource(seedSources, path) ?? { kind: 'unknown' };

  for (const field of PROVIDER_SOURCED_FIELDS) {
    if (generationConfig && field in generationConfig && !sources[field]) {
      setSource(sources, field, seedOrUnknown(field));
    }
  }

  // Validate required fields based on authType. This does not perform any
  // fallback resolution (resolution is handled by ModelConfigResolver).
  const validation = validateModelConfig(
    newContentGeneratorConfig as ContentGeneratorConfig,
    strictModelProvider,
  );
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join('\n'));
  }

  return {
    config: newContentGeneratorConfig as ContentGeneratorConfig,
    sources,
  };
}

export interface ModelConfigValidationResult {
  valid: boolean;
  errors: Error[];
}

/**
 * Validate a resolved model configuration.
 * This is the single validation entry point used across Core.
 */
export function validateModelConfig(
  config: ContentGeneratorConfig,
  isStrictModelProvider: boolean = false,
): ModelConfigValidationResult {
  const errors: Error[] = [];

  // Qwen OAuth doesn't need validation - it uses dynamic tokens
  if (config.authType === AuthType.QWEN_OAUTH) {
    return { valid: true, errors: [] };
  }

  // API key is required for all other auth types
  if (!config.apiKey) {
    if (isStrictModelProvider) {
      errors.push(
        new StrictMissingCredentialsError(
          config.authType,
          config.model,
          config.apiKeyEnvKey,
        ),
      );
    } else {
      const envKey =
        config.apiKeyEnvKey || getDefaultApiKeyEnvVar(config.authType);
      errors.push(
        new MissingApiKeyError({
          authType: config.authType,
          model: config.model,
          baseUrl: config.baseUrl,
          envKey,
        }),
      );
    }
  }

  // Model is required
  if (!config.model) {
    if (isStrictModelProvider) {
      errors.push(new StrictMissingModelIdError(config.authType));
    } else {
      const envKey = getDefaultModelEnvVar(config.authType);
      errors.push(new MissingModelError({ authType: config.authType, envKey }));
    }
  }

  // Explicit baseUrl is required for Anthropic; Migrated from existing code.
  if (config.authType === AuthType.USE_ANTHROPIC && !config.baseUrl) {
    if (isStrictModelProvider) {
      errors.push(
        new MissingBaseUrlError({
          authType: config.authType,
          model: config.model,
        }),
      );
    } else if (config.authType === AuthType.USE_ANTHROPIC) {
      errors.push(new MissingAnthropicBaseUrlEnvError());
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  generationConfig?: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return resolveContentGeneratorConfigWithSources(
    config,
    authType,
    generationConfig,
  ).config;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  isInitialAuth?: boolean,
): Promise<ContentGenerator> {
  const validation = validateModelConfig(config, false);
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join('\n'));
  }

  if (config.authType === AuthType.USE_OPENAI) {
    // Import OpenAIContentGenerator dynamically to avoid circular dependencies
    const { createOpenAIContentGenerator } = await import(
      './openaiContentGenerator/index.js'
    );

    // Always use OpenAIContentGenerator, logging is controlled by enableOpenAILogging flag
    const generator = createOpenAIContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  if (config.authType === AuthType.QWEN_OAUTH) {
    // Import required classes dynamically
    const { getQwenOAuthClient: getQwenOauthClient } = await import(
      '../qwen/qwenOAuth2.js'
    );
    const { QwenContentGenerator } = await import(
      '../qwen/qwenContentGenerator.js'
    );

    try {
      // Get the Qwen OAuth client (now includes integrated token management)
      // If this is initial auth, require cached credentials to detect missing credentials
      const qwenClient = await getQwenOauthClient(
        gcConfig,
        isInitialAuth ? { requireCachedCredentials: true } : undefined,
      );

      // Create the content generator with dynamic token management
      const generator = new QwenContentGenerator(qwenClient, config, gcConfig);
      return new LoggingContentGenerator(generator, gcConfig);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (config.authType === AuthType.USE_ANTHROPIC) {
    const { createAnthropicContentGenerator } = await import(
      './anthropicContentGenerator/index.js'
    );

    const generator = createAnthropicContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  if (
    config.authType === AuthType.USE_GEMINI ||
    config.authType === AuthType.USE_VERTEX_AI
  ) {
    const { createGeminiContentGenerator } = await import(
      './geminiContentGenerator/index.js'
    );
    const generator = createGeminiContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  throw new Error(
    `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
  );
}
