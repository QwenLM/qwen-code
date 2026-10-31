/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ModelConfigResolver - Unified resolver for model-related configuration.
 *
 * This module consolidates all model configuration resolution logic,
 * eliminating duplicate code between CLI and Core layers.
 *
 * Configuration priority (highest to lowest):
 * 1. modelProvider - Explicit selection from ModelProviders config
 * 2. CLI arguments - Command line flags (--model, --openaiApiKey, etc.)
 * 3. Environment variables - OPENAI_API_KEY, OPENAI_MODEL, etc.
 * 4. Settings - User/workspace settings file
 * 5. Defaults - Built-in default values
 */

import { AuthType } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { FatalConfigError } from '../utils/errors.js';
import { getDefaultBaseUrlForProtocol } from '../providers/provider-config.js';
import { isBaseUrlAllowed, scrubBaseUrlForMessage } from './modelRegistry.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { knownTokenLimit } from '../core/tokenLimits.js';
import {
  resolveField,
  resolveOptionalField,
  layer,
  envLayer,
  cliSource,
  settingsSource,
  modelProvidersSource,
  defaultSource,
  computedSource,
  type ConfigSource,
  type ConfigSources,
  type ConfigLayer,
} from '../utils/configResolver.js';
import {
  AUTH_ENV_MAPPINGS,
  DEFAULT_MODELS,
  QWEN_OAUTH_ALLOWED_MODELS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ModelConfig as ModelProviderConfig } from './types.js';
export {
  validateModelConfig,
  type ModelConfigValidationResult,
} from '../core/contentGenerator.js';

/**
 * CLI-provided configuration values
 */
export interface ModelConfigCliInput {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Settings-provided configuration values
 */
export interface ModelConfigSettingsInput {
  /** Model name from settings.model.name */
  model?: string;
  /** API key from settings.security.auth.apiKey */
  apiKey?: string;
  /** Base URL from settings.security.auth.baseUrl */
  baseUrl?: string;
  /** Generation config from settings.model.generationConfig */
  generationConfig?: Partial<ContentGeneratorConfig>;
}

/**
 * All input sources for model configuration resolution
 */
export interface ModelConfigSourcesInput {
  /** Authentication type */
  authType?: AuthType;

  /** CLI arguments (highest priority for user-provided values) */
  cli?: ModelConfigCliInput;

  /** Settings file configuration */
  settings?: ModelConfigSettingsInput;

  /** Environment variables (injected for testability) */
  env: Record<string, string | undefined>;

  /** Model from ModelProviders (explicit selection, highest priority) */
  modelProvider?: ModelProviderConfig;

  /** Proxy URL (computed from Config) */
  proxy?: string;

  /**
   * Managed endpoint allowlist (`model.allowedBaseUrls`). When defined (an
   * array, possibly empty), the resolved outbound endpoint must match one of
   * the entries or resolution fails closed with a FatalConfigError that names
   * the setting (issue #12805). `undefined` = no policy, legacy behavior.
   */
  allowedBaseUrls?: readonly string[];

  /**
   * Whether the operator scopes disabled the built-in Qwen OAuth models
   * (model.qwenOAuthBuiltinsDisabled in system, user, or systemDefaults
   * settings). When true, Qwen OAuth resolution fails closed instead of
   * falling back to the default built-in model (issue #12805).
   */
  qwenOAuthBuiltinsDisabled?: boolean;

  /**
   * True when the effective allowlist was set ONLY in workspace scope (no
   * operator scope). A workspace list still narrows the configured provider
   * endpoints, but it must not fail closed for the Qwen OAuth dynamic
   * endpoint — disabling personal Qwen login is an operator decision
   * (issue #12805).
   */
  allowedBaseUrlsWorkspaceOnly?: boolean;
}

/**
 * Result of model configuration resolution
 */
export interface ModelConfigResolutionResult {
  /** The fully resolved configuration */
  config: ContentGeneratorConfig;
  /** Source attribution for each field */
  sources: ConfigSources;
  /** Warnings generated during resolution */
  warnings: string[];
}

/**
 * Applies QWEN_CODE_API_TIMEOUT_MS env override if modelProvider has not set a timeout.
 * Precedence: modelProvider > env > settings > default
 * Mutates generationConfig and sources in-place.
 */
function applyTimeoutEnvOverride(
  env: Record<string, string | undefined>,
  generationConfig: Partial<ContentGeneratorConfig>,
  sources: ConfigSources,
  modelProvider?: ModelProviderConfig,
): void {
  if (modelProvider?.generationConfig?.timeout !== undefined) return;

  const raw = env['QWEN_CODE_API_TIMEOUT_MS'];
  if (raw === undefined) return;

  const trimmed = raw.trim();
  // Accept a non-negative integer; `0` disables the request timeout downstream
  // (see resolveRequestTimeout). Malformed values are ignored (keep default).
  if (!/^\d+$/.test(trimmed)) return;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return;
  generationConfig.timeout = parsed;
  sources['timeout'] = {
    kind: 'env',
    envKey: 'QWEN_CODE_API_TIMEOUT_MS',
  };
}

/**
 * Resolve model configuration from all input sources.
 *
 * This is the single entry point for model configuration resolution.
 * It replaces the duplicate logic in:
 * - packages/cli/src/utils/modelProviderUtils.ts (resolveCliGenerationConfig)
 * - packages/core/src/core/contentGenerator.ts (resolveContentGeneratorConfigWithSources)
 *
 * @param input - All configuration sources
 * @returns Resolved configuration with source tracking
 */
export function resolveModelConfig(
  input: ModelConfigSourcesInput,
): ModelConfigResolutionResult {
  const { authType, cli, settings, env, modelProvider, proxy } = input;
  const warnings: string[] = [];
  const sources: ConfigSources = {};

  // Special handling for Qwen OAuth
  if (authType === AuthType.QWEN_OAUTH) {
    return resolveQwenOAuthConfig(input, warnings);
  }

  // Get auth-specific env var mappings.
  // If authType is not provided, do not read any auth env vars.
  const envMapping = authType
    ? AUTH_ENV_MAPPINGS[authType]
    : { model: [], apiKey: [], baseUrl: [] };

  // Build layers for each field in priority order
  // Priority: modelProvider > cli > env > settings > default

  // ---- Model ----
  const modelLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider) {
    modelLayers.push(
      layer(
        modelProvider.id,
        modelProvidersSource(authType, modelProvider.id, 'model.id'),
      ),
    );
  }
  if (cli?.model) {
    modelLayers.push(layer(cli.model, cliSource('--model')));
  }
  for (const envKey of envMapping.model) {
    modelLayers.push(envLayer(env, envKey));
  }
  if (settings?.model) {
    modelLayers.push(layer(settings.model, settingsSource('model.name')));
  }

  const defaultModel = authType ? DEFAULT_MODELS[authType] : '';
  const modelResult = resolveField(
    modelLayers,
    defaultModel,
    defaultSource(defaultModel),
  );
  sources['model'] = modelResult.source;

  // ---- API Key ----
  const apiKeyLayers: Array<ConfigLayer<string>> = [];

  // For modelProvider, read from the specified envKey
  if (authType && modelProvider?.envKey) {
    const apiKeyFromEnv = env[modelProvider.envKey];
    if (apiKeyFromEnv) {
      apiKeyLayers.push(
        layer(apiKeyFromEnv, {
          kind: 'env',
          envKey: modelProvider.envKey,
          via: modelProvidersSource(authType, modelProvider.id, 'envKey'),
        }),
      );
    }
  }
  if (cli?.apiKey) {
    apiKeyLayers.push(layer(cli.apiKey, cliSource('--openaiApiKey')));
  }
  for (const envKey of envMapping.apiKey) {
    apiKeyLayers.push(envLayer(env, envKey));
  }
  if (settings?.apiKey) {
    apiKeyLayers.push(
      layer(settings.apiKey, settingsSource('security.auth.apiKey')),
    );
  }

  const apiKeyResult = resolveOptionalField(apiKeyLayers);
  if (apiKeyResult) {
    sources['apiKey'] = apiKeyResult.source;
  }

  // ---- Base URL ----
  const baseUrlLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider?.baseUrl) {
    baseUrlLayers.push(
      layer(
        modelProvider.baseUrl,
        modelProvidersSource(authType, modelProvider.id, 'baseUrl'),
      ),
    );
  }
  if (cli?.baseUrl) {
    baseUrlLayers.push(layer(cli.baseUrl, cliSource('--openaiBaseUrl')));
  }
  for (const envKey of envMapping.baseUrl) {
    baseUrlLayers.push(envLayer(env, envKey));
  }
  if (settings?.baseUrl) {
    baseUrlLayers.push(
      layer(settings.baseUrl, settingsSource('security.auth.baseUrl')),
    );
  }

  const baseUrlResult = resolveOptionalField(baseUrlLayers);
  if (baseUrlResult) {
    sources['baseUrl'] = baseUrlResult.source;
  }

  // ---- API Key Env Key (for error messages) ----
  let apiKeyEnvKey: string | undefined;
  if (authType && modelProvider?.envKey) {
    apiKeyEnvKey = modelProvider.envKey;
    sources['apiKeyEnvKey'] = {
      ...modelProvidersSource(authType, modelProvider.id, 'envKey'),
      envKey: modelProvider.envKey,
    };
  }

  // ---- Generation Config (from settings or modelProvider) ----
  const generationConfig = resolveGenerationConfig(
    settings?.generationConfig,
    modelProvider?.generationConfig,
    authType,
    modelProvider?.id ?? modelResult.value,
    sources,
  );

  // ---- Env override: QWEN_CODE_API_TIMEOUT_MS ----
  applyTimeoutEnvOverride(env, generationConfig, sources, modelProvider);

  // Build final config
  const config: ContentGeneratorConfig = {
    authType,
    model: modelResult.value || '',
    apiKey: apiKeyResult?.value,
    apiKeyEnvKey,
    baseUrl: baseUrlResult?.value,
    proxy,
    ...generationConfig,
  };

  // Add proxy source
  if (proxy) {
    sources['proxy'] = computedSource('Config.getProxy()');
  }

  // Add authType source
  sources['authType'] = computedSource('provided by caller');

  // Managed endpoint allowlist gate (issue #12805). The registration filter
  // alone is not enough: the outbound baseUrl is resolved HERE (cli
  // --model/--openaiBaseUrl, env vars, security.auth, provider defaults), and
  // the preserve/capture paths in ModelsConfig can re-admit credentials for
  // endpoints the registry never registered. Gate the resolved selection on
  // the same predicate. The endpoint judged is the explicit baseUrl whenever
  // any source resolved one — even before an auth type is selected, so a
  // boot-time env/CLI endpoint cannot slip past — else the protocol default
  // the SDK would dial. QWEN_OAUTH returns above; its dynamic endpoint is
  // handled in resolveQwenOAuthConfig.
  if (input.allowedBaseUrls !== undefined) {
    // Who owns the list decides the remedy: a workspace-only list lives in
    // the workspace settings file, not with the operator.
    const allowlistOwner = input.allowedBaseUrlsWorkspaceOnly
      ? `Add it to model.allowedBaseUrls in this workspace's settings (.qwen/settings.json)`
      : `Ask the operator to add it to the allowlist in system or user settings`;
    if (config.baseUrl) {
      if (!isBaseUrlAllowed(config.baseUrl, input.allowedBaseUrls)) {
        throw new FatalConfigError(
          `Model endpoint '${scrubBaseUrlForMessage(config.baseUrl)}'` +
            (authType ? ` (auth type '${authType}')` : '') +
            describeBaseUrlSource(sources['baseUrl']) +
            ` is not in the managed allowlist 'model.allowedBaseUrls'. ` +
            `${allowlistOwner}, or choose a model on an allowed endpoint.`,
        );
      }
    } else if (authType) {
      const protocolDefault = getDefaultBaseUrlForProtocol(authType);
      if (protocolDefault) {
        if (!isBaseUrlAllowed(protocolDefault, input.allowedBaseUrls)) {
          throw new FatalConfigError(
            `Model endpoint '${protocolDefault}' (the protocol default for auth type '${authType}') is not in the managed allowlist 'model.allowedBaseUrls'. ` +
              `${allowlistOwner}, set an explicit baseUrl on the model, or choose a model on an allowed endpoint.`,
          );
        }
      } else {
        throw new FatalConfigError(
          `Auth type '${authType}' has no protocol default endpoint and no explicit baseUrl was resolved, so no endpoint can be checked against the managed allowlist 'model.allowedBaseUrls'. ` +
            `Set an explicit baseUrl (model.baseUrl or a modelProviders entry) that matches an allowlist entry.`,
        );
      }
    }
    // No explicit baseUrl and no auth type: nothing is dialed yet (pre-auth
    // boot); the gate re-runs once auth is selected.
  }

  return { config, sources, warnings };
}

/**
 * Name the source that supplied an off-list baseUrl (issue #12805), so a
 * user's own env/CLI typo is distinguishable from a provider entry hitting
 * the policy. Empty when the source carries nothing nameable.
 */
function describeBaseUrlSource(source: ConfigSource | undefined): string {
  switch (source?.kind) {
    case 'env':
      return source.envKey
        ? ` (from environment variable ${source.envKey})`
        : '';
    case 'cli':
      return source.detail ? ` (from ${source.detail})` : '';
    case 'settings':
      return source.settingsPath
        ? ` (from settings ${source.settingsPath})`
        : '';
    case 'modelProviders':
      return source.modelId
        ? ` (from modelProviders entry '${source.modelId}')`
        : '';
    default:
      return '';
  }
}

/**
 * Special resolver for Qwen OAuth authentication.
 * Qwen OAuth has fixed model options and uses dynamic tokens.
 */
function resolveQwenOAuthConfig(
  input: ModelConfigSourcesInput,
  warnings: string[],
): ModelConfigResolutionResult {
  const { cli, settings, proxy, modelProvider } = input;
  const sources: ConfigSources = {};

  // Operator-scope disable (issue #12805): personal Qwen login is disabled
  // by model.qwenOAuthBuiltinsDisabled in system, user, or systemDefaults
  // settings. Fail closed with an actionable error instead of falling back
  // to the default built-in model, which would silently re-admit the dynamic
  // Qwen endpoint the operator locked down.
  if (input.qwenOAuthBuiltinsDisabled) {
    throw new FatalConfigError(
      `Qwen OAuth (personal Qwen login) is disabled by operator settings: ` +
        `model.qwenOAuthBuiltinsDisabled is set in system, user, or systemDefaults settings. ` +
        `Remove that setting from the operator scope or choose another authentication type.`,
    );
  }

  // An operator-scope model.allowedBaseUrls can never list the Qwen OAuth
  // endpoint: it is discovered dynamically at login. Such a deployment
  // therefore excludes personal Qwen login — fail closed rather than dial
  // the unlisted dynamic endpoint (issue #12805). A workspace-scope list
  // still narrows configured providers but must not disable personal login.
  if (
    input.allowedBaseUrls !== undefined &&
    !input.allowedBaseUrlsWorkspaceOnly
  ) {
    throw new FatalConfigError(
      `The Qwen OAuth (personal Qwen login) endpoint is discovered dynamically at login and cannot be listed in the managed allowlist 'model.allowedBaseUrls', which this deployment sets in operator scope. ` +
        `Personal Qwen login and an operator-scope allowlist are mutually exclusive: removing model.allowedBaseUrls is the only way to re-enable it, or choose another authentication type.`,
    );
  }

  // Qwen OAuth only allows specific models
  const allowedModels = new Set<string>(QWEN_OAUTH_ALLOWED_MODELS);

  // Determine requested model
  const requestedModel = cli?.model || settings?.model;
  let resolvedModel: string;
  let modelSource: ConfigSource;

  if (requestedModel && allowedModels.has(requestedModel)) {
    resolvedModel = requestedModel;
    modelSource = cli?.model
      ? cliSource('--model')
      : settingsSource('model.name');
  } else {
    if (requestedModel) {
      const isVisionModel =
        requestedModel.includes('vl') || requestedModel.includes('vision');
      const extraMessage = isVisionModel
        ? ` Note: vision-model has been removed since coder-model now supports vision capabilities.`
        : '';
      warnings.push(
        `Warning: Unsupported Qwen OAuth model '${requestedModel}', falling back to '${DEFAULT_QWEN_MODEL}'.${extraMessage}`,
      );
    }
    resolvedModel = DEFAULT_QWEN_MODEL;
    modelSource = defaultSource(`fallback to '${DEFAULT_QWEN_MODEL}'`);
  }

  sources['model'] = modelSource;
  sources['apiKey'] = computedSource('Qwen OAuth dynamic token');
  sources['authType'] = computedSource('provided by caller');

  if (proxy) {
    sources['proxy'] = computedSource('Config.getProxy()');
  }

  // Resolve generation config from settings and modelProvider
  const generationConfig = resolveGenerationConfig(
    settings?.generationConfig,
    modelProvider?.generationConfig,
    AuthType.QWEN_OAUTH,
    resolvedModel,
    sources,
  );

  // ---- Env override: QWEN_CODE_API_TIMEOUT_MS ----
  applyTimeoutEnvOverride(input.env, generationConfig, sources, modelProvider);

  const config: ContentGeneratorConfig = {
    authType: AuthType.QWEN_OAUTH,
    model: resolvedModel,
    apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
    proxy,
    ...generationConfig,
  };

  return { config, sources, warnings };
}

/**
 * Resolve generation config fields (samplingParams, timeout, etc.)
 */
function resolveGenerationConfig(
  settingsConfig: Partial<ContentGeneratorConfig> | undefined,
  modelProviderConfig: Partial<ContentGeneratorConfig> | undefined,
  authType: AuthType | undefined,
  modelId: string | undefined,
  sources: ConfigSources,
): Partial<ContentGeneratorConfig> {
  const result: Partial<ContentGeneratorConfig> = {};

  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    // ModelProvider config takes priority over settings config
    if (authType && modelProviderConfig && field in modelProviderConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = modelProviderConfig[field];
      sources[field] = modelProvidersSource(
        authType,
        modelId || '',
        `generationConfig.${field}`,
      );
    } else if (settingsConfig && field in settingsConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = settingsConfig[field];
      sources[field] = settingsSource(`model.generationConfig.${field}`);
    }
  }

  // contextWindowSize fallback: auto-detect from model when neither
  // modelProvider nor settings supplied it. Only known models are stamped —
  // unknown models keep `undefined` so downstream `?? DEFAULT_TOKEN_LIMIT`
  // consumers apply the generic default without a misleading
  // 'auto-detected' source label.
  if (result.contextWindowSize === undefined && modelId) {
    const knownLimit = knownTokenLimit(modelId, 'input');
    if (knownLimit !== undefined) {
      result.contextWindowSize = knownLimit;
      sources['contextWindowSize'] = computedSource('auto-detected from model');
    }
  }

  // modalities fallback: auto-detect from model when neither modelProvider nor
  // settings supplied it. Mirrors modelRegistry.resolveModelConfig and
  // modelsConfig.applyResolvedModelDefaults so all paths agree on which models
  // are multimodal — without this, env-var-only setups silently drop @image
  // attachments for image-capable models (issue #4219).
  //
  // Invariant: defaultModalities() returns `{}` (text-only) for unknown
  // models, never `undefined`. After this fallback runs with a known modelId,
  // `result.modalities` is always defined. Downstream code must NOT branch
  // on `modalities === undefined` to mean "unresolved" — use the sources map
  // (kind === 'computed' vs 'modelProviders'/'settings') if that distinction
  // matters.
  if (result.modalities === undefined && modelId) {
    result.modalities = defaultModalities(modelId);
    sources['modalities'] = computedSource('auto-detected from model');
  }

  return result;
}
