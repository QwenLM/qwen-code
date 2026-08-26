/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType, InputModalities } from '../core/contentGenerator.js';
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
  thinkingMandatory?: boolean;
  modalities?: InputModalities;
  description?: string;
  supportsImageGeneration?: boolean;
  imageOnly?: boolean;
}

export interface BaseUrlOption {
  id: string;
  label: string;
  url: string;
  /** Override the provider's model list when this endpoint is selected. */
  models?: ModelSpec[];
  documentationUrl?: string;
  apiKeyUrl?: string;
}

export interface ProviderConfig {
  id: string;
  label: string;
  description: string;

  /** Always fixed for current providers. */
  protocol: AuthType;

  /**
   * - `string`            → fixed, skip UI step
   * - `BaseUrlOption[]`   → show option selector
   * - `undefined`         → user types freely (custom provider)
   */
  baseUrl?: string | BaseUrlOption[];

  /** Environment variable key, or a function to generate one. */
  envKey: string | ((protocol: AuthType, baseUrl: string) => string);

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

  /** Load the account's current model recommendations from `/models`. */
  supportsModelDiscovery?: boolean;

  /** Display name prefix for model entries, or a function of baseUrl. */
  modelNamePrefix: string | ((baseUrl: string) => string);

  /**
   * Protocol options for manual selection (custom provider only).
   * If provided with >1 entry, shows a protocol selection step.
   */
  protocolOptions?: AuthType[];

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
   * Reports whether a stored env key belongs to the endpoint
   * (`protocol`, `baseUrl`), recognizing historical key shapes this provider
   * used to generate in addition to the current one. Used to attribute
   * baseUrl-less legacy model entries (which predate baseUrl stamping) to an
   * endpoint — their env key is the only endpoint signal they carry. When
   * omitted, only an exact match with the endpoint's currently derived env
   * key attributes such an entry.
   */
  ownsEnvKeyShape?: (
    envKey: string,
    protocol: AuthType,
    baseUrl: string,
  ) => boolean;

  /**
   * Reports whether a stored env key is a key this provider generated for
   * SOME endpoint under `protocol` — selected or not. Used to tell a
   * baseUrl-less legacy entry that affirmatively names a sibling endpoint
   * (never adopt, never claim) apart from a floating hand-written key that
   * names no endpoint (an explicit selection may adopt it). When omitted,
   * array-baseUrl providers fall back to comparing against every endpoint's
   * derived key, and any key that is not the selected endpoint's own is
   * treated as floating.
   */
  envKeyNamesAnEndpoint?: (envKey: string, protocol: AuthType) => boolean;

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
  protocol?: AuthType;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /** Pre-built model configs (e.g. OpenRouter fetches models from API). Overrides modelIds. */
  prebuiltModels?: ProviderModelConfig[];
  /** Existing custom models that a defaults-only/headless reconnect cannot display. */
  preserveModels?: ProviderModelConfig[];
  /**
   * Ids of baseUrl-less legacy entries this very run migrated toward the
   * selected endpoint — either freshly stamped into `preserveModels` or
   * dropped from it because a stamped twin already exists there. Only these
   * ids may be claimed by id-collision when owning baseUrl-less stored
   * entries; every other baseUrl-less entry is owned only through its env
   * key. Inferring this set from "any preserved model stamped at the
   * selected endpoint" is unsound: a normally-stamped entry whose id merely
   * collides with another endpoint's legacy entry would claim and delete it
   * (R40-2).
   */
  migratedLegacyModelIds?: readonly string[];
  /**
   * Ids of baseUrl-less legacy entries the caller EXPOSED for a deselection
   * decision — i.e. round-tripped from saved state into the selection the
   * submitted `modelIds` reflects. The free-form env-key ownership clause
   * (which removes an attributable baseUrl-less entry omitted from the
   * submission) treats omission as deselection intent ONLY for these ids.
   *
   * A caller that cannot round-trip saved ids — the serve route exposes no
   * existingConfig, so Web Shell/SDK selections are defaults-seeded and can
   * never carry or deliberately omit a saved baseUrl-less id (R42-1, R44-2) —
   * passes an EMPTY list, so absence is never treated as deselection there.
   * A seeded caller passes the ids it actually surfaced; an entry it never
   * surfaced (e.g. the CLI dialog hides an attributable entry whose endpoint
   * it could not restore, R44-4) is likewise protected.
   *
   * When OMITTED (undefined) the historical behavior applies — the env-key
   * clause owns every attributable entry — which keeps callers that fully
   * round-trip (CLI wizard, VS Code) unchanged. The ACP route seeds
   * existingConfig but not every entry is exposed on every seeding surface,
   * so it passes the ids its list-time seed actually exposed.
   */
  roundTrippedLegacyModelIds?: readonly string[];
  /**
   * Ids of FLOATING baseUrl-less legacy entries — env keys that name NO
   * endpoint — that this very run explicitly ADOPTED at the selected endpoint
   * (an explicit selection requested the id, so the entry is stamped into
   * `preserveModels` and re-keyed). Floating entries can never satisfy the
   * id-collision claim's `namesSelectedEndpoint` attribution gate, so they
   * are threaded through this separate channel for claiming; keeping them out
   * of `migratedLegacyModelIds` leaves that set's over-claim guard (a floating
   * entry whose id merely COLLIDES with a migrated attributable entry must not
   * be claimed) intact (R45-2).
   */
  adoptedFloatingModelIds?: readonly string[];
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
  /** Keep a selected sibling endpoint model when it survives this patch. */
  retainCurrentModelAcrossEndpoints?: boolean;
  /** Identify this provider's models across all of its sibling endpoints. */
  ownsModelAcrossEndpoints?: (model: ProviderModelConfig) => boolean;
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
