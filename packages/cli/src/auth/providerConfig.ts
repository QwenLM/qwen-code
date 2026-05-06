/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { AuthType, ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { ProviderInstallPlan, ProviderInstallState } from './types.js';

// ---------------------------------------------------------------------------
// Declarative provider config — every built-in provider is an instance of this
// ---------------------------------------------------------------------------

export interface ModelSpec {
  id: string;
  contextWindowSize?: number;
  enableThinking?: boolean;
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
  protocol: AuthType;

  /**
   * - `string`            → fixed, skip UI step
   * - `BaseUrlOption[]`   → show option selector
   * - `undefined`         → user types freely (custom provider)
   */
  baseUrl?: string | BaseUrlOption[];

  /** Environment variable key, or a function to generate one. */
  envKey: string | ((protocol: AuthType, baseUrl: string) => string);

  /** API key acquisition method. */
  authMethod: 'input' | 'oauth';

  /**
   * - `ModelSpec[]`  → model definitions with optional per-model metadata
   * - `undefined`    → user must type all model IDs (custom provider)
   */
  models?: ModelSpec[];

  /**
   * Whether the user can add/remove models in the setup UI.
   * - `true`  → show model editing step; known IDs inherit their ModelSpec metadata
   * - `false` → skip model step; use models as-is (e.g. Coding Plan)
   * Defaults to `false` when `models` is set, ignored when `models` is `undefined`.
   */
  modelsEditable?: boolean;

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

  /** Documentation URL for the provider. */
  documentationUrl?: string | ((baseUrl: string) => string);

  /**
   * Settings key for version tracking (e.g. 'codingPlan', 'tokenPlan').
   * When set, the provider participates in auto-update detection.
   */
  metadataKey?: string;

  /** Build extra provider state to persist (e.g. version tracking). */
  getProviderState?: (
    baseUrl: string,
    models: ProviderModelConfig[],
  ) => ProviderInstallState;

  /**
   * Custom ownership check — identifies models belonging to this provider.
   * Auto-derived from `envKey` (string) + `modelNamePrefix` (string) when omitted.
   * Only needed for providers with function-typed envKey/prefix or non-standard logic.
   */
  ownsModel?: (model: ProviderModelConfig) => boolean;

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
// Collected user inputs from the setup wizard
// ---------------------------------------------------------------------------

export interface ProviderSetupInputs {
  /** Override protocol (only for custom provider). Defaults to config.protocol. */
  protocol?: AuthType;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /** Pre-built model configs (e.g. OpenRouter fetches models from API). Overrides modelIds. */
  prebuiltModels?: ProviderModelConfig[];
  advancedConfig?: {
    enableThinking?: boolean;
    multimodal?: { image?: boolean; video?: boolean; audio?: boolean };
    maxTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Build model configs from a ProviderConfig + user inputs
// ---------------------------------------------------------------------------

function resolveEnvKey(
  config: ProviderConfig,
  inputs: ProviderSetupInputs,
): string {
  const protocol = inputs.protocol ?? config.protocol;
  return typeof config.envKey === 'function'
    ? config.envKey(protocol, inputs.baseUrl)
    : config.envKey;
}

function resolveModelNamePrefix(
  config: ProviderConfig,
  baseUrl: string,
): string {
  return typeof config.modelNamePrefix === 'function'
    ? config.modelNamePrefix(baseUrl)
    : config.modelNamePrefix;
}

function resolveOwnsModel(
  config: ProviderConfig,
): ((model: ProviderModelConfig) => boolean) | undefined {
  if (config.ownsModel) return config.ownsModel;
  if (
    typeof config.envKey !== 'string' ||
    typeof config.modelNamePrefix !== 'string'
  ) {
    return undefined;
  }
  const envKey = config.envKey;
  const prefix = config.modelNamePrefix;
  if (!prefix) return (model) => model.envKey === envKey;
  const namePrefix = `[${prefix}] `;
  return (model) =>
    model.envKey === envKey &&
    typeof model.name === 'string' &&
    model.name.startsWith(namePrefix);
}

function specToModelConfig(
  spec: ModelSpec,
  prefix: string,
  baseUrl: string,
  envKey: string,
): ProviderModelConfig {
  return {
    id: spec.id,
    name: prefix ? `[${prefix}] ${spec.id}` : spec.id,
    ...(spec.description ? { description: spec.description } : {}),
    baseUrl,
    envKey,
    generationConfig: {
      ...(spec.enableThinking ? { extra_body: { enable_thinking: true } } : {}),
      ...(spec.contextWindowSize
        ? { contextWindowSize: spec.contextWindowSize }
        : {}),
    },
  };
}

function buildModelConfigs(
  config: ProviderConfig,
  inputs: ProviderSetupInputs,
): ProviderModelConfig[] {
  const envKey = resolveEnvKey(config, inputs);
  const prefix = resolveModelNamePrefix(config, inputs.baseUrl);

  // Fixed ModelSpec[] (not editable) — use specs directly
  if (config.models && !config.modelsEditable) {
    return config.models.map((spec) =>
      specToModelConfig(spec, prefix, inputs.baseUrl, envKey),
    );
  }

  // Editable ModelSpec[] — look up per-model metadata for known IDs
  if (config.models && config.modelsEditable) {
    const specMap = new Map(config.models.map((s) => [s.id, s]));
    return inputs.modelIds.map((id) => {
      const spec = specMap.get(id);
      if (spec) {
        return specToModelConfig(spec, prefix, inputs.baseUrl, envKey);
      }
      return {
        id,
        name: prefix ? `[${prefix}] ${id}` : id,
        baseUrl: inputs.baseUrl,
        envKey,
      };
    });
  }

  // No predefined models (custom provider) — use advancedConfig
  const advCfg = inputs.advancedConfig;
  const genConfig: ProviderModelConfig['generationConfig'] = {};
  let hasGenConfig = false;

  if (advCfg?.enableThinking) {
    genConfig.extra_body = { enable_thinking: true };
    hasGenConfig = true;
  }
  if (advCfg?.multimodal) {
    genConfig.modalities = {
      image: advCfg.multimodal.image ?? false,
      video: advCfg.multimodal.video ?? false,
      audio: advCfg.multimodal.audio ?? false,
    };
    hasGenConfig = true;
  }
  if (advCfg?.maxTokens && advCfg.maxTokens > 0) {
    genConfig.samplingParams = { max_tokens: advCfg.maxTokens };
    hasGenConfig = true;
  }

  const displayName = (id: string) => (prefix ? `[${prefix}] ${id}` : id);

  return inputs.modelIds.map((id) => ({
    id,
    name: displayName(id),
    baseUrl: inputs.baseUrl,
    envKey,
    ...(hasGenConfig ? { generationConfig: genConfig } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Build ProviderInstallPlan from config + inputs
// ---------------------------------------------------------------------------

export function buildInstallPlan(
  config: ProviderConfig,
  inputs: ProviderSetupInputs,
): ProviderInstallPlan {
  const protocol = inputs.protocol ?? config.protocol;
  const envKey = resolveEnvKey(config, inputs);
  const models = inputs.prebuiltModels ?? buildModelConfigs(config, inputs);
  const firstModelId = models[0]?.id;

  return {
    providerId: config.id,
    authType: protocol,
    env: { [envKey]: inputs.apiKey },
    ...(firstModelId ? { modelSelection: { modelId: firstModelId } } : {}),
    modelProviders: [
      {
        authType: protocol,
        models,
        mergeStrategy: 'prepend-and-remove-owned' as const,
        ownsModel: resolveOwnsModel(config),
      },
    ],
    providerState: config.getProviderState?.(inputs.baseUrl, models),
  };
}

// ---------------------------------------------------------------------------
// Utility: version hash from model list (used by Alibaba plans)
// ---------------------------------------------------------------------------

export function computeModelListVersion(models: ProviderModelConfig[]): string {
  return createHash('sha256').update(JSON.stringify(models)).digest('hex');
}

// ---------------------------------------------------------------------------
// Resolve base URL from config + user selection
// ---------------------------------------------------------------------------

export function resolveBaseUrl(
  config: ProviderConfig,
  selectedBaseUrl?: string,
): string {
  if (typeof config.baseUrl === 'string') {
    return config.baseUrl;
  }
  if (Array.isArray(config.baseUrl)) {
    const match = config.baseUrl.find((opt) => opt.url === selectedBaseUrl);
    return match?.url ?? config.baseUrl[0].url;
  }
  return selectedBaseUrl ?? '';
}

// ---------------------------------------------------------------------------
// Resolve model IDs from config
// ---------------------------------------------------------------------------

export function getDefaultModelIds(config: ProviderConfig): string[] {
  return config.models?.map((s) => s.id) ?? [];
}

// ---------------------------------------------------------------------------
// Check if a step should be shown in the UI
// ---------------------------------------------------------------------------

export function shouldShowStep(
  config: ProviderConfig,
  step: 'protocol' | 'baseUrl' | 'apiKey' | 'models' | 'advancedConfig',
): boolean {
  switch (step) {
    case 'protocol':
      return (
        Array.isArray(config.protocolOptions) &&
        config.protocolOptions.length > 1
      );
    case 'baseUrl':
      return config.baseUrl === undefined || Array.isArray(config.baseUrl);
    case 'apiKey':
      return true; // always needed
    case 'models':
      return !config.models || config.modelsEditable === true;
    case 'advancedConfig':
      return config.showAdvancedConfig === true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Match a provider by model credentials (baseUrl + envKey)
// ---------------------------------------------------------------------------

export function providerMatchesCredentials(
  config: ProviderConfig,
  baseUrl: string | undefined,
  envKey: string | undefined,
): boolean {
  if (typeof config.envKey !== 'string' || config.envKey !== envKey) {
    return false;
  }
  if (typeof config.baseUrl === 'string') {
    return config.baseUrl === baseUrl;
  }
  if (Array.isArray(config.baseUrl)) {
    return config.baseUrl.some((opt) => opt.url === baseUrl);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build template models for a provider (for version tracking / auto-update)
// ---------------------------------------------------------------------------

export function buildProviderTemplate(
  config: ProviderConfig,
  baseUrl?: string,
): ProviderModelConfig[] {
  const resolved = resolveBaseUrl(config, baseUrl);
  return buildModelConfigs(config, {
    baseUrl: resolved,
    apiKey: '',
    modelIds: getDefaultModelIds(config),
  });
}
