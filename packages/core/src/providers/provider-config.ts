/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ModelSpec,
  ProviderConfig,
  ProviderInstallPlan,
  ProviderInstallState,
  ProviderModelConfig,
  ProviderSetupInputs,
} from './types.js';

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

export function resolveOwnsModel(
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

function buildGenerationConfig(
  spec: Pick<ModelSpec, 'enableThinking' | 'contextWindowSize' | 'modalities'>,
): ProviderModelConfig['generationConfig'] | undefined {
  const parts: ProviderModelConfig['generationConfig'] = {};
  let hasAny = false;
  if (spec.enableThinking) {
    parts.extra_body = { enable_thinking: true };
    hasAny = true;
  }
  if (spec.contextWindowSize) {
    parts.contextWindowSize = spec.contextWindowSize;
    hasAny = true;
  }
  if (spec.modalities && Object.values(spec.modalities).some(Boolean)) {
    parts.modalities = spec.modalities;
    hasAny = true;
  }
  return hasAny ? parts : undefined;
}

function specToModelConfig(
  spec: ModelSpec,
  prefix: string,
  baseUrl: string,
  envKey: string,
): ProviderModelConfig {
  const genConfig = buildGenerationConfig(spec);
  return {
    id: spec.id,
    name: prefix ? `[${prefix}] ${spec.id}` : spec.id,
    ...(spec.description ? { description: spec.description } : {}),
    baseUrl,
    envKey,
    ...(genConfig ? { generationConfig: genConfig } : {}),
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

  function buildCustomGenConfig():
    | ProviderModelConfig['generationConfig']
    | undefined {
    const cfg: ProviderModelConfig['generationConfig'] = {};
    let hasAny = false;
    if (advCfg?.enableThinking) {
      cfg.extra_body = { enable_thinking: true };
      hasAny = true;
    }
    if (advCfg?.multimodal && Object.values(advCfg.multimodal).some(Boolean)) {
      cfg.modalities = advCfg.multimodal;
      hasAny = true;
    }
    if (advCfg?.contextWindowSize && advCfg.contextWindowSize > 0) {
      cfg.contextWindowSize = advCfg.contextWindowSize;
      hasAny = true;
    }
    if (advCfg?.maxTokens && advCfg.maxTokens > 0) {
      cfg.samplingParams = { max_tokens: advCfg.maxTokens };
      hasAny = true;
    }
    return hasAny ? cfg : undefined;
  }

  const displayName = (id: string) => (prefix ? `[${prefix}] ${id}` : id);

  return inputs.modelIds.map((id) => {
    const genConfig = buildCustomGenConfig();
    return {
      id,
      name: displayName(id),
      baseUrl: inputs.baseUrl,
      envKey,
      ...(genConfig ? { generationConfig: genConfig } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Version tracking — auto-derived for providers with static model lists
// ---------------------------------------------------------------------------

/**
 * Returns the provider's metadata key (same as `config.id`).
 * Only defined for providers with a static `models` list.
 */
export function resolveMetadataKey(config: ProviderConfig): string | undefined {
  if (config.models) return config.id;
  return undefined;
}

/**
 * Namespace prefix used for all provider metadata in settings.
 * e.g. `providerMetadata.coding-plan.version`
 */
export const PROVIDER_METADATA_NS = 'providerMetadata';

function resolveProviderState(
  config: ProviderConfig,
  baseUrl: string,
  models: ProviderModelConfig[],
): ProviderInstallState | undefined {
  const key = resolveMetadataKey(config);
  if (key) {
    return {
      [`${PROVIDER_METADATA_NS}.${key}`]: {
        version: computeModelListVersion(models),
        baseUrl,
      },
    };
  }
  return undefined;
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
  if (models.length === 0) {
    throw new Error(
      `No models configured for provider "${config.id}". Check model list or provider configuration.`,
    );
  }
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
    providerState: resolveProviderState(config, inputs.baseUrl, models),
  };
}

// ---------------------------------------------------------------------------
// Utility: version hash from model list
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
    if (match) return match.url;
    // Defensive: an empty baseUrl array would crash `config.baseUrl[0].url`
    // and bring down the install flow. Fall back to the caller-supplied
    // value (or empty string) instead.
    return config.baseUrl[0]?.url ?? selectedBaseUrl ?? '';
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
      return true;
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
  // Resolve envKey first: presets carry a string literal, but the custom
  // provider carries a function that derives the key from (protocol, baseUrl).
  // Treating "non-string" as no-match made custom providers invisible to
  // findProviderByCredentials → /doctor and system-info diagnostics.
  let configEnvKey: string | undefined;
  if (typeof config.envKey === 'string') {
    configEnvKey = config.envKey;
  } else if (typeof config.envKey === 'function' && baseUrl) {
    try {
      configEnvKey = config.envKey(config.protocol, baseUrl);
    } catch {
      configEnvKey = undefined;
    }
  }
  if (configEnvKey !== envKey) {
    return false;
  }
  if (typeof config.baseUrl === 'string') {
    return config.baseUrl === baseUrl;
  }
  if (Array.isArray(config.baseUrl)) {
    return config.baseUrl.some((opt) => opt.url === baseUrl);
  }
  // Custom providers leave baseUrl `undefined` because every user picks
  // their own — accept any non-empty baseUrl whose derived envKey already
  // matched above.
  if (config.baseUrl === undefined && configEnvKey !== undefined) {
    return Boolean(baseUrl);
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
