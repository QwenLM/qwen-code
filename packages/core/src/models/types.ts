/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  ContentGeneratorConfig,
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
  | 'enableCacheControl'
  | 'schemaCompliance'
  | 'reasoning'
  | 'customHeaders'
  | 'extra_body'
  | 'contextWindowSize'
>;

/**
 * Model configuration for a single model within an authType
 */
export interface ModelConfig {
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
 * Model providers configuration grouped by authType
 */
export type ModelProvidersConfig = {
  [authType: string]: ModelConfig[];
};

/**
 * Resolved model config with all defaults applied
 */
export interface ResolvedModelConfig extends ModelConfig {
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
