/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  ContentGeneratorConfig,
  InputModalities,
} from '../core/contentGenerator.js';
import type { ConfigSources } from '../utils/configResolver.js';

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  /** Supports image/vision inputs */
  vision?: boolean;
}

/**
 * Model-scoped generation configuration.
 *
 * Keep this consistent with {@link ContentGeneratorConfig} so modelProviders can
 * feed directly into content generator resolution without shape conversion.
 */
export type ModelGenerationConfig = Pick<
  ContentGeneratorConfig,
  | 'samplingParams'
  | 'timeout'
  | 'maxRetries'
  | 'retryErrorCodes'
  | 'enableCacheControl'
  | 'schemaCompliance'
  | 'reasoning'
  | 'customHeaders'
  | 'extra_body'
  | 'contextWindowSize'
  | 'modalities'
>;

/**
 * Type relationship guide:
 * - `ModelConfig`: model-only fields stored under `ProviderConfig.models[]` in settings.
 * - `ProviderConfig`: provider-level fields (`authType`, `baseUrl`, `envKey`) + `models`.
 * - `ModelProvidersConfig`: top-level settings map `{ [providerId]: ProviderConfig }`.
 * - `ProviderModelConfig`: runtime working shape after provider fields are merged into one model.
 * - `ResolvedModelConfig`: fully resolved runtime shape with defaults applied (non-optional core fields).
 *
 * Read order when tracing data flow:
 * settings (`ModelProvidersConfig`) -> registry input (`ProviderConfig` + `ModelConfig`) ->
 * runtime merge (`ProviderModelConfig`) -> runtime defaults (`ResolvedModelConfig`).
 */

/**
 * Runtime model entry used before defaults are applied.
 * This includes provider-level fields (`baseUrl`, `envKey`) flattened onto one model.
 */
export interface ProviderModelConfig {
  /** Unique model ID within authType (e.g., "qwen-coder", "gpt-4-turbo") */
  id: string;
  /** Display name (defaults to id) */
  name?: string;
  /** Model description */
  description?: string;
  /** Environment variable name to read API key from (e.g., "OPENAI_API_KEY") */
  envKey?: string;
  /** API endpoint override */
  baseUrl?: string;
  /** Model capabilities, reserve for future use. Now we do not read this to determine multi-modal support or other capabilities. */
  capabilities?: ModelCapabilities;
  /** Generation configuration (sampling parameters) */
  generationConfig?: ModelGenerationConfig;
}

/**
 * Settings model entry inside `ProviderConfig.models`.
 * This is intentionally model-only: provider-scoped fields stay on `ProviderConfig`.
 */
export interface ModelConfig {
  id: string;
  name?: string;
  description?: string;
  generationConfig?: ModelGenerationConfig;
  /** Model capabilities (e.g., vision). Optional; reserves for future use. */
  capabilities?: ModelCapabilities;
}

/**
 * Settings provider entry (value type in `ModelProvidersConfig`).
 * Holds provider-scoped access fields and the list of model entries for that provider.
 */
export interface ProviderConfig {
  authType: string;
  baseUrl?: string;
  envKey?: string;
  /** When true, this provider is system-managed (e.g. Coding Plan) and can be replaced by template updates. */
  managed?: boolean;
  models: ModelConfig[];
}

/**
 * Settings-level `modelProviders` object keyed by providerId.
 * This is the canonical persisted shape consumed by runtime code.
 */
export type ModelProvidersConfig = {
  [providerId: string]: ProviderConfig;
};

/**
 * Final runtime model config after defaults and normalization.
 * Compared to `ProviderModelConfig`, fields like `name`, `baseUrl`,
 * `generationConfig`, and `capabilities` are guaranteed to be present.
 */
export interface ResolvedModelConfig extends ProviderModelConfig {
  /** AuthType this model belongs to (always present from map key) */
  authType: AuthType;
  /** Display name (always present, defaults to id) */
  name: string;
  /** Environment variable name to read API key from (optional, provider-specific) */
  envKey?: string;
  /** API base URL (always present, has default per authType) */
  baseUrl: string;
  /** Generation config (always present, merged with defaults) */
  generationConfig: ModelGenerationConfig;
  /** Capabilities (always present, defaults to {}) */
  capabilities: ModelCapabilities;
  /** Provider ID this model belongs to (if sourced from modelProviders). */
  providerId?: string;
}

/**
 * Model info for UI display
 */
export interface AvailableModel {
  id: string;
  label: string;
  description?: string;
  capabilities?: ModelCapabilities;
  authType: AuthType;
  isVision?: boolean;
  contextWindowSize?: number;
  modalities?: InputModalities;
  baseUrl?: string;
  envKey?: string;

  /** Provider ID this model belongs to */
  providerId?: string;

  /** Whether this is a runtime model (not from modelProviders) */
  isRuntimeModel?: boolean;

  /** Runtime model snapshot ID (if isRuntimeModel is true) */
  runtimeSnapshotId?: string;
}

/**
 * Metadata for model switch operations
 */
export interface ModelSwitchMetadata {
  /** Reason for the switch */
  reason?: string;
  /** Additional context */
  context?: string;
}

/**
 * Runtime model snapshot - captures complete model configuration from non-modelProviders sources
 */
export interface RuntimeModelSnapshot {
  /** Snapshot unique identifier */
  id: string;

  /** Associated AuthType */
  authType: AuthType;

  /** Model ID */
  modelId: string;

  /** API Key (may come from env/cli/manual input) */
  apiKey?: string;

  /** Base URL (may come from env/cli/settings/credentials) */
  baseUrl?: string;

  /** Environment variable name (if apiKey comes from env) */
  apiKeyEnvKey?: string;

  /** Generation config (sampling parameters, etc.) */
  generationConfig?: ModelGenerationConfig;

  /** Configuration source tracking */
  sources: ConfigSources;

  /** Snapshot creation timestamp */
  createdAt: number;
}
