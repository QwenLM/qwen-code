/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType } from '../core/contentGenerator.js';

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  /** Supports image/vision inputs */
  vision?: boolean;
}

/**
 * Generation configuration for model sampling parameters
 */
export interface ModelGenerationConfig {
  /** Temperature for sampling (0.0 - 2.0) */
  temperature?: number;
  /** Top-p for nucleus sampling (0.0 - 1.0) */
  top_p?: number;
  /** Top-k for sampling */
  top_k?: number;
  /** Maximum output tokens */
  max_tokens?: number;
  /** Presence penalty (-2.0 - 2.0) */
  presence_penalty?: number;
  /** Frequency penalty (-2.0 - 2.0) */
  frequency_penalty?: number;
  /** Repetition penalty (provider-specific) */
  repetition_penalty?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Disable cache control for DashScope providers */
  disableCacheControl?: boolean;
}

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
  /** Model capabilities */
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
}

/**
 * Selection source for tracking and observability.
 * This tracks how a model was selected but does not enforce any priority rules.
 */
export enum SelectionSource {
  /** Default selection (first model in registry) */
  DEFAULT = 'default',
  /** From environment variables */
  ENVIRONMENT = 'environment',
  /** From settings.json */
  SETTINGS = 'settings',
  /** Programmatic override (e.g., VLM auto-switch, control requests) */
  PROGRAMMATIC_OVERRIDE = 'programmatic_override',
  /** User explicitly switched via /model command */
  USER_MANUAL = 'user_manual',
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
 * Current model information
 */
export interface CurrentModelInfo {
  authType: AuthType;
  modelId: string;
  model: ResolvedModelConfig;
  selectionSource: SelectionSource;
}

/**
 * Default generation configuration values
 */
export const DEFAULT_GENERATION_CONFIG: ModelGenerationConfig = {
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 4096,
  timeout: 60000,
  maxRetries: 3,
};

/**
 * Default base URLs per authType
 */
export const DEFAULT_BASE_URLS: Partial<Record<AuthType, string>> = {
  'qwen-oauth': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
};
