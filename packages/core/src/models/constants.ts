/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_QWEN_MODEL } from '../config/models.js';

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
  'maxRetries',
  'enableCacheControl',
  'schemaCompliance',
  'reasoning',
  'contextWindowSize',
  'customHeaders',
  'extra_body',
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
  openai: 'qwen3.5-plus',
  'qwen-oauth': DEFAULT_QWEN_MODEL,
} as Partial<Record<AuthType, string>>;

/**
 * Hard-coded Qwen OAuth models that are always available.
 * These cannot be overridden by user configuration.
 */
export const QWEN_OAUTH_MODELS: ModelConfig[] = [
  {
    id: 'qwen3.5-plus',
    name: 'qwen3.5-plus',
    description:
      'The Qwen3.5 native vision-language series Plus models deliver outstanding performance comparable to the very latest state-of-the-art models, with significant leaps in both pure-text and multimodal capabilities compared to the 3 series.',
    capabilities: { vision: true },
  },
  {
    id: 'coder-model',
    name: 'coder-model',
    description:
      'The stable qwen3-coder-plus model from Alibaba Cloud ModelStudio',
    capabilities: { vision: false },
  },
];

/**
 * Derive allowed models from QWEN_OAUTH_MODELS for authorization.
 * This ensures single source of truth (SSOT).
 */
export const QWEN_OAUTH_ALLOWED_MODELS = QWEN_OAUTH_MODELS.map(
  (model) => model.id,
) as readonly string[];
