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
import { PROVIDER_SOURCED_FIELDS } from '../models/constants.js';

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

export type AuthType = string;

export const AuthType = {
  USE_OPENAI: 'openai',
  QWEN_OAUTH: 'qwen-oauth',
  USE_GEMINI: 'gemini',
  USE_VERTEX_AI: 'vertex-ai',
  USE_ANTHROPIC: 'anthropic',
} as const;

export enum Protocol {
  OPENAI = 'openai',
  QWEN_OAUTH = 'qwen-oauth',
  GEMINI = 'gemini',
  ANTHROPIC = 'anthropic',
}

/**
 * Supported input modalities for a model.
 * Omitted or false fields mean the model does not support that input type.
 */
export type InputModalities = {
  image?: boolean;
  pdf?: boolean;
  audio?: boolean;
  video?: boolean;
};

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  apiKeyEnvKey?: string;
  baseUrl?: string;
  vertexai?: boolean;
  authType?: AuthType | undefined;
  protocol?: Protocol;
  enableOpenAILogging?: boolean;
  openAILoggingDir?: string;
  timeout?: number; // Timeout configuration in milliseconds
  maxRetries?: number; // Maximum retries for rate-limit errors
  retryErrorCodes?: number[]; // Additional error codes that trigger rate-limit retry
  enableCacheControl?: boolean; // Enable cache control for DashScope providers
  samplingParams?: {
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    temperature?: number;
    max_tokens?: number;
    // Additional provider-specific keys pass through verbatim
    // (e.g. `max_completion_tokens` for GPT-5 / o-series, `reasoning_effort`).
    [key: string]: unknown;
  };
  reasoning?:
    | false
    | {
        // 'max' is supported by providers that document an extra-strong
        // reasoning tier — currently DeepSeek's `reasoning_effort` (see
        // https://api-docs.deepseek.com/zh-cn/api/create-chat-completion).
        // Real Anthropic only accepts low/medium/high; the Anthropic
        // generator clamps 'max' down to 'high' (logged once per generator
        // via debugLogger.warn) when the baseURL doesn't look like a
        // DeepSeek-compatible endpoint, so configurations targeting
        // DeepSeek don't 400 when the same auth profile is reused against
        // api.anthropic.com.
        effort?: 'low' | 'medium' | 'high' | 'max';
        budget_tokens?: number;
      };
  proxy?: string | undefined;
  userAgent?: string;
  // Schema compliance mode for tool definitions
  schemaCompliance?: 'auto' | 'openapi_30';
  // Context window size override. If set to a positive number, it will override
  // the automatic detection. Leave undefined to use automatic detection.
  contextWindowSize?: number;
  // Custom HTTP headers to be sent with requests
  customHeaders?: Record<string, string>;
  // Extra body parameters to be merged into the request body
  extra_body?: Record<string, unknown>;
  // Supported input modalities. Unsupported media types are replaced with text
  // placeholders. Leave undefined to use automatic detection from model name.
  modalities?: InputModalities;
  // When true, media parts in tool responses (including the built-in read_file
  // and MCP tools) are split into a follow-up `role: "user"` message instead of
  // being embedded inside the `role: "tool"` message. The OpenAI Chat
  // Completions spec only permits string / text-part content on tool messages;
  // strict OpenAI-compatible servers (e.g. doubao / new-api / LM Studio) drop or
  // reject anything else (HTTP 400 "Invalid 'messages' in payload"), so an image
  // read via read_file never reaches the model. Default: true (spec-compliant
  // and safe for permissive providers); set false to restore the legacy
  // embed-in-tool-message behavior. See QwenLM/qwen-code#4876, #3616.
  splitToolMedia?: boolean;
  // OpenAI Chat Completions accepts tool result content as either a plain
  // string or an array of text content parts. Some older OpenAI-compatible
  // tool templates only read the string form, so this opt-in serializes
  // text-only tool results as strings while leaving the default spec-compliant
  // content-part shape unchanged.
  toolResultContentFormat?: 'parts' | 'string';
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

function getModuleNotFoundError(
  error: unknown,
): NodeJS.ErrnoException | undefined {
  let current = error;

  while (current instanceof Error) {
    if (
      'code' in current &&
      (current as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return current as NodeJS.ErrnoException;
    }
    current = current.cause;
  }

  return undefined;
}

export async function createContentGenerator(
  generatorConfig: ContentGeneratorConfig,
  config: Config,
  isInitialAuth?: boolean,
): Promise<ContentGenerator> {
  const validation = validateModelConfig(generatorConfig, false);
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join('\n'));
  }

  const protocol = generatorConfig.protocol;
  if (!protocol) {
    throw new Error('ContentGeneratorConfig must have a protocol');
  }

  let baseGenerator: ContentGenerator;

  try {
    if (protocol === Protocol.OPENAI) {
      const { createOpenAIContentGenerator } = await import(
        './openaiContentGenerator/index.js'
      );
      baseGenerator = createOpenAIContentGenerator(generatorConfig, config);
    } else if (protocol === Protocol.QWEN_OAUTH) {
      const { getQwenOAuthClient: getQwenOauthClient } = await import(
        '../qwen/qwenOAuth2.js'
      );
      const { QwenContentGenerator } = await import(
        '../qwen/qwenContentGenerator.js'
      );

      try {
        const qwenClient = await getQwenOauthClient(
          config,
          isInitialAuth ? { requireCachedCredentials: true } : undefined,
        );
        baseGenerator = new QwenContentGenerator(
          qwenClient,
          generatorConfig,
          config,
        );
      } catch (error) {
        if (getModuleNotFoundError(error)) {
          throw error;
        }
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    } else if (protocol === Protocol.ANTHROPIC) {
      const { createAnthropicContentGenerator } = await import(
        './anthropicContentGenerator/index.js'
      );
      baseGenerator = createAnthropicContentGenerator(generatorConfig, config);
    } else if (protocol === Protocol.GEMINI) {
      const { createGeminiContentGenerator } = await import(
        './geminiContentGenerator/index.js'
      );
      baseGenerator = createGeminiContentGenerator(generatorConfig, config);
    } else {
      throw new Error(
        `Error creating contentGenerator: Unknown protocol: ${protocol}`,
      );
    }
  } catch (error) {
    const moduleNotFoundError = getModuleNotFoundError(error);
    if (moduleNotFoundError) {
      throw new Error(
        `Qwen Code was updated in the background and needs to be restarted.\n` +
          `Please exit and restart Qwen Code to use the '${protocol}' provider.`,
        { cause: moduleNotFoundError },
      );
    }
    throw error;
  }

  return new LoggingContentGenerator(baseGenerator, config, generatorConfig);
}
