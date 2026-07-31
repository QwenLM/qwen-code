/**
 * Model Fetcher — Centralized Model Discovery
 *
 * Type-safe plugin interface for fetching available models from Qwen Code.
 */

import type { ModelDefinition } from './models';
import type { LlmProviderType, LlmConnection } from './llm-connections';

// ============================================================
// Types
// ============================================================

/** Providers that support automatic model fetching. */
export type FetchableProvider = LlmProviderType;

/**
 * Result of a model fetch operation.
 */
export interface ModelFetchResult {
  models: ModelDefinition[];
  /** Which model the provider considers the default (optional) */
  serverDefault?: string;
}

/**
 * Credentials needed to fetch models from a provider.
 * The ModelRefreshService resolves these from the credential manager.
 */
export interface ModelFetcherCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

/**
 * Plugin interface for provider-specific model discovery.
 *
 * Implementations live in apps/electron/src/main/model-fetchers/.
 * Each provider implements fetchModels() with its own SDK/API call.
 */
export interface ModelFetcher {
  /**
   * Fetch models from the provider API/SDK.
   * Throws on failure — the ModelRefreshService handles fallback.
   */
  fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult>;

  /**
   * Refresh interval in milliseconds.
   * 0 = fetch on auth/startup only, no periodic refresh.
   */
  readonly refreshIntervalMs: number;
}

/**
 * Type-safe fetcher map. Every FetchableProvider MUST have a fetcher.
 * Adding a new LlmProviderType without registering a fetcher → compile error.
 */
export type ModelFetcherMap = Record<FetchableProvider, ModelFetcher>;
