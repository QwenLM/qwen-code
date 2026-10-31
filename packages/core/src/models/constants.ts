/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_QWEN_MODEL, MAINLINE_CODER_MODEL } from '../config/models.js';

import type { ModelConfig } from './types.js';

type AuthType = import('../core/contentGenerator.js').AuthType;
type ContentGeneratorConfig =
  import('../core/contentGenerator.js').ContentGeneratorConfig;

/**
 * Field keys for model-scoped generation config.
 *
 * Kept in a small standalone module to avoid circular deps. The `import('...')`
 * usage is type-only and does not emit runtime imports.
 */
export const MODEL_GENERATION_CONFIG_FIELDS = [
  'samplingParams',
  'timeout',
  'streamIdleTimeoutMs',
  'maxRetries',
  'retryInitialDelayMs',
  'retryMaxDelayMs',
  'retryErrorCodes',
  'enableCacheControl',
  'enableRequestMetadata',
  'forceGlobalCacheScope',
  'cacheRetention',
  'cacheRetentionByBlock',
  'schemaCompliance',
  'reasoning',
  'contextWindowSize',
  'customHeaders',
  'extra_body',
  'thinkingMandatory',
  'modalities',
  'splitToolMedia',
  'toolResultContentFormat',
] as const satisfies ReadonlyArray<keyof ContentGeneratorConfig>;

/**
 * Credential-related fields that are part of ContentGeneratorConfig
 * but not ModelGenerationConfig.
 */
export const CREDENTIAL_FIELDS = [
  'model',
  'apiKey',
  'apiKeyEnvKey',
  'baseUrl',
] as const satisfies ReadonlyArray<keyof ContentGeneratorConfig>;

/**
 * All provider-sourced fields that need to be tracked for source attribution
 * and cleared when switching from provider to manual credentials.
 */
export const PROVIDER_SOURCED_FIELDS = [
  ...CREDENTIAL_FIELDS,
  ...MODEL_GENERATION_CONFIG_FIELDS,
] as const;

/**
 * Environment variable mappings per authType.
 */
export interface AuthEnvMapping {
  apiKey: string[];
  baseUrl: string[];
  model: string[];
}

export const AUTH_ENV_MAPPINGS = {
  openai: {
    apiKey: ['OPENAI_API_KEY'],
    baseUrl: ['OPENAI_BASE_URL'],
    model: ['OPENAI_MODEL', 'QWEN_MODEL'],
  },
  'openai-responses': {
    apiKey: ['OPENAI_API_KEY'],
    baseUrl: ['OPENAI_BASE_URL'],
    model: ['OPENAI_MODEL'],
  },
  anthropic: {
    apiKey: ['ANTHROPIC_API_KEY'],
    baseUrl: ['ANTHROPIC_BASE_URL'],
    model: ['ANTHROPIC_MODEL'],
  },
  gemini: {
    apiKey: ['GEMINI_API_KEY'],
    baseUrl: [],
    model: ['GEMINI_MODEL'],
  },
  'vertex-ai': {
    apiKey: ['GOOGLE_API_KEY'],
    baseUrl: [],
    model: ['GOOGLE_MODEL'],
  },
  'qwen-oauth': {
    apiKey: [],
    baseUrl: [],
    model: [],
  },
} as const satisfies Record<AuthType, AuthEnvMapping>;

export const DEFAULT_MODELS = {
  openai: MAINLINE_CODER_MODEL,
  'qwen-oauth': DEFAULT_QWEN_MODEL,
} as Partial<Record<AuthType, string>>;

/**
 * Placeholder standing in for the Qwen OAuth endpoint, which is discovered
 * dynamically at login and therefore has no static URL. No allowlist entry
 * can ever match it (validateAllowedBaseUrls rejects host-less values), so
 * any model.allowedBaseUrls in operator scope excludes the built-ins — the
 * allowlist and personal Qwen login are mutually exclusive in that
 * deployment.
 */
export const DYNAMIC_QWEN_OAUTH_BASE_URL = 'DYNAMIC_QWEN_OAUTH_BASE_URL';

/**
 * Hard-coded Qwen OAuth models. User configuration can neither add to nor
 * replace them; they are only disabled by the operator-scope setting
 * model.qwenOAuthBuiltinsDisabled (System, User, or SystemDefaults), or by
 * an operator-scope model.allowedBaseUrls, which cannot list their
 * dynamically discovered endpoint.
 */
export const QWEN_OAUTH_MODELS: ModelConfig[] = [
  {
    id: 'coder-model',
    name: 'coder-model',
    description:
      'Qwen 3.7 Max — efficient hybrid model with leading coding performance',
    capabilities: { vision: true },
  },
];

/**
 * Derive allowed models from QWEN_OAUTH_MODELS for authorization.
 * This ensures single source of truth (SSOT).
 */
export const QWEN_OAUTH_ALLOWED_MODELS = QWEN_OAUTH_MODELS.map(
  (model) => model.id,
) as readonly string[];
