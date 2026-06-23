/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  InputModalities,
  Protocol,
} from '../core/contentGenerator.js';
import type { ModelConfig, ModelProvidersConfig } from '../models/types.js';

// Re-export for convenience
export type ProviderModelConfig = ModelConfig;

// ---------------------------------------------------------------------------
// Provider Config — declarative provider definition
// ---------------------------------------------------------------------------

export type ProviderId = string;

export interface ModelSpec {
  id: string;
  contextWindowSize?: number;
  enableThinking?: boolean;
  modalities?: InputModalities;
  description?: string;
}

export interface BaseUrlOption {
  id: string;
  label: string;
  url: string;
  documentationUrl?: string;
  apiKeyUrl?: string;
}

export interface ProviderConfig {
  id: string;
  label: string;
  description: string;

  /** Always fixed for current providers. */
  protocol: Protocol;

  /**
   * - `string`            → fixed, skip UI step
   * - `BaseUrlOption[]`   → show option selector
   * - `undefined`         → user types freely (custom provider)
   */
  baseUrl?: string | BaseUrlOption[];

  /** Environment variable key, or a function to generate one. */
  envKey: string | ((protocol: Protocol, baseUrl: string) => string);

  /**
   * - `ModelSpec[]`  → model definitions with optional per-model metadata
   * - `undefined`    → user must type all model IDs (custom provider)
   */
  models?: ModelSpec[];

  /**
   * Whether the user can add/remove models in the setup UI.
   * - `true`  → show model editing step; known IDs inherit their ModelSpec metadata
   * - `false` → skip model step; use models as-is
   * Defaults to `false` when `models` is set, ignored when `models` is `undefined`.
   */
  modelsEditable?: boolean;

  /** Display name prefix for model entries, or a function of baseUrl. */
  modelNamePrefix: string | ((baseUrl: string) => string);

  /**
   * Protocol options for manual selection (custom provider only).
   * If provided with >1 entry, shows a protocol selection step.
   */
  protocolOptions?: Protocol[];

  /** Show advanced config step (thinking, modalities). */
  showAdvancedConfig?: boolean;

  /** Validate the API key before submission. */
  validateApiKey?: (key: string, baseUrl: string) => string | null;

  /** API key input placeholder. */
  apiKeyPlaceholder?: string;

  /**
   * Custom HTTP headers to send with every request to this provider.
   * Used for attribution headers (e.g. `HTTP-Referer`, `X-Title`) that
   * gateways like OpenRouter and Requesty expect. Merged into each model's
   * `generationConfig.customHeaders` at install time.
   */
  customHeaders?: Record<string, string>;

  /** Documentation URL for the provider. */
  documentationUrl?: string | ((baseUrl: string) => string);

  /**
   * Custom ownership check — identifies models belonging to this provider.
   * Auto-derived from `envKey` (string) + `modelNamePrefix` (string) when omitted.
   * Only needed for providers with function-typed envKey/prefix or non-standard logic.
   */
  ownsModel?: (model: ProviderModelConfig) => boolean;

  /**
   * Install-time merge behavior. When true, installs replace only incoming
   * model identities (id + baseUrl) instead of every model matched by
   * ownsModel. Useful for user-defined providers where multiple endpoints and
   * model IDs can coexist under one provider config.
   */
  mergeModelsByIdentity?: boolean;

  /**
   * UI grouping hint — used by AuthDialog to organize providers into sections.
   * Providers with the same `uiGroup` appear together under a shared heading.
   */
  uiGroup?: string;

  /** Step label overrides for the UI. */
  uiLabels?: {
    flowTitle?: string;
    baseUrlStepTitle?: string;
  };
}

// ---------------------------------------------------------------------------
// Provider Setup Inputs — collected from user during setup wizard
// ---------------------------------------------------------------------------

export interface ProviderSetupInputs {
  /** Override protocol (only for custom provider). Defaults to config.protocol. */
  protocol?: Protocol;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /** Pre-built model configs (e.g. OpenRouter fetches models from API). Overrides modelIds. */
  prebuiltModels?: ProviderModelConfig[];
  advancedConfig?: {
    enableThinking?: boolean;
    multimodal?: InputModalities;
    contextWindowSize?: number;
    maxTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Provider Install Plan — output of buildInstallPlan
// ---------------------------------------------------------------------------

export interface ProviderModelProvidersPatch {
  authType: AuthType;
  models: ProviderModelConfig[];
  mergeStrategy: 'prepend-and-remove-owned' | 'replace-owned' | 'append';
  ownsModel?: (model: ProviderModelConfig) => boolean;
}

/**
 * Arbitrary key-value metadata to persist alongside a provider install.
 * Each top-level key becomes a settings path prefix (e.g. `codingPlan.version`).
 */
export type ProviderInstallState = Record<string, Record<string, string>>;

export interface ProviderInstallPlan {
  providerId: ProviderId;
  authType: AuthType;
  env?: Record<string, string>;
  legacyCredentials?: {
    apiKey?: string;
    baseUrl?: string;
  };
  modelSelection?: {
    modelId: string;
    baseUrl?: string;
  };
  modelProviders?: ProviderModelProvidersPatch[];
  providerState?: ProviderInstallState;
  display?: {
    successMessage?: string;
    nextSteps?: string[];
  };
}

// ---------------------------------------------------------------------------
// Provider Settings Adapter — abstraction for settings read/write
// ---------------------------------------------------------------------------

export interface ProviderSettingsAdapter {
  /** Get a value by dotted key path (e.g. 'security.auth.selectedType'). */
  getValue(key: string): unknown;
  /**
   * Set a value by dotted key path.
   *
   * IMPORTANT: implementations MAY flush to disk on every call (the CLI's
   * LoadedSettings-backed adapter does — each setValue triggers a
   * saveSettings). Callers must therefore NOT assume the on-disk file is
   * untouched until `persist()`; if the process crashes mid-sequence, disk
   * can hold a partial write. `backup()`/`restore()` are the rollback path
   * for that, not deferred persistence. Don't insert new pre-persist steps
   * assuming atomicity.
   */
  setValue(key: string, value: unknown): void;
  /** Get the current model providers config. */
  getModelProviders(): ModelProvidersConfig;
  /**
   * Flush changes to disk. NOTE: this may be a no-op for adapters whose
   * `setValue` already persists eagerly (see the warning on `setValue`).
   * It remains in the contract as the explicit commit point for adapters
   * that *do* buffer (e.g. the VS Code file adapter writes here).
   */
  persist(): void;
  /** Create a backup before making changes (for rollback on error). */
  backup?(): void;
  /** Restore from backup (on error). */
  restore?(): void;
  /** Clean up backup after successful operation. */
  cleanupBackup?(): void;
}
