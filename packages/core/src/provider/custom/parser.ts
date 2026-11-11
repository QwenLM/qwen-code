/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ALIBABA_FIRST_PAYLOAD_TIMEOUT_MS,
  BUILTIN_ALIBABA_MODELS,
  createAlibabaThinkingCapabilities,
  DEFAULT_CUSTOM_PROVIDER_ANTHROPIC_CONFIG,
  DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_PROVIDER_FIRST_PAYLOAD_TIMEOUT_MS,
  DEFAULT_IMPLICIT_ALIBABA_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
  DEFAULT_IMPLICIT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
} from './builtins.js';
import {
  ALIBABA_PROVIDER,
  ALIYUN_BAILIAN_PROVIDER_ALIAS,
  CUSTOM_PROVIDER_TYPES,
  CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS,
  type CustomProviderAnthropicConfig,
  type CustomProviderModelCapabilities,
  type CustomProviderModelRuntime,
  type CustomProviderAdapterKind,
  type CustomProviderAuthType,
  type CustomProviderParseResult,
  type CustomProviderRoutingPurpose,
  type CustomProviderRuntime,
  type CustomProviderType,
  type CustomProviderValidationIssue,
  CUSTOM_PROVIDER_THINKING_WIRE_MODES,
  type CustomProviderThinkingCapabilities,
  supportsCustomProviderModelThinking,
} from './types.js';
import {
  cloneLlmGenerationConfig,
  type LlmGenerationConfig,
} from '../../config/generation-config.js';
import { normalizeCustomProviderBaseUrl } from './baseUrl.js';

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Anthropic beta tokens share the provider-id grammar; keep one source of truth.
const ANTHROPIC_BETA_PATTERN = PROVIDER_ID_PATTERN;
const UNRESOLVED_ENV_PATTERN = /\$\{[^}]+\}/;
const ROUTING_PURPOSES = new Set<CustomProviderRoutingPurpose>([
  'utility',
  'session_title',
  'summary',
  'compact',
  'subagent',
]);
// Generation params are no longer accepted inline on providers/models; they
// live under `model.preferences[provider/model]`. Both surfaces reject the same
// set of retired keys, differing only in the extra limit fields each carries.
export const REMOVED_GENERATION_FIELDS = [
  'temperature',
  'top_p',
  'topP',
  'top_k',
  'topK',
  'thinking',
  'reasoning',
  'preserve_thinking',
  'preserveThinking',
  'generation',
] as const;
// Limit fields that describe model capacity rather than generation behavior;
// they belong on a `providers[provider].models[]` entry, not inline here.
export const REMOVED_LIMIT_FIELDS = [
  'contextWindow',
  'maxOutputTokens',
] as const;
export const REMOVED_PROVIDER_MODEL_FIELDS = [
  'image',
  ...REMOVED_LIMIT_FIELDS,
  ...REMOVED_GENERATION_FIELDS,
] as const;
export const REMOVED_MODEL_GENERATION_FIELDS = [
  ...REMOVED_GENERATION_FIELDS,
  'maxTokens',
] as const;

export function getRemovedCustomProviderFieldMessage(field: string): string {
  if ((REMOVED_LIMIT_FIELDS as readonly string[]).includes(field)) {
    return 'Model limits must be configured on a providers[provider].models[] entry.';
  }
  if (field === 'image') {
    return 'providers[provider].image has been removed; use tools.imageGen';
  }
  if (field === 'maxTokens') {
    return '`maxTokens` is a generation preference and must be configured under model.preferences[provider/model]. To declare the model output capacity here, use `maxOutputTokens`.';
  }
  return 'Generation parameters must be configured under model.preferences[provider/model].';
}

/** Provider ids owned by account-backed providers, never by user settings. */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'qoder',
  'qwen-subscription',
]);

export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId);
}

/** Drops account-owned ids so the generic parser never reports them. */
export function withoutReservedProviderSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([providerId]) => !isReservedProviderId(providerId),
    ),
  );
}

export function parseCustomProviderSettings(
  value: unknown,
): CustomProviderParseResult {
  if (value == null) return { providers: [], issues: [] };
  if (!isRecord(value)) {
    return {
      providers: [],
      issues: [
        {
          providerId: '*',
          message: 'providers must be an object',
        },
      ],
    };
  }

  const providers: CustomProviderRuntime[] = [];
  const issues: CustomProviderValidationIssue[] = [];
  for (const [providerId, rawProvider] of Object.entries(value)) {
    const parsed = parseProvider(providerId, rawProvider);
    issues.push(...parsed.issues);
    if (parsed.provider) {
      providers.push(parsed.provider);
    }
  }
  return { providers, issues };
}

function parseProvider(
  providerId: string,
  value: unknown,
): {
  provider?: CustomProviderRuntime;
  issues: CustomProviderValidationIssue[];
} {
  const issues: CustomProviderValidationIssue[] = [];
  const issue = (field: string | undefined, message: string) => {
    issues.push({ providerId, ...(field ? { field } : {}), message });
  };

  if (
    isReservedProviderId(providerId) ||
    !PROVIDER_ID_PATTERN.test(providerId)
  ) {
    issue(
      undefined,
      'provider id must start with an alphanumeric character, contain only alphanumeric characters, dot, underscore, or dash, and must not be qoder or qwen-subscription',
    );
    return { issues };
  }

  if (!isRecord(value)) {
    issue(undefined, 'provider configuration must be an object');
    return { issues };
  }

  rejectRemovedFields(value, REMOVED_PROVIDER_MODEL_FIELDS, issue);

  const baseUrl = normalizeCustomProviderBaseUrl(
    readString(value['baseUrl']),
  );
  if (!baseUrl)
    issue(
      'baseUrl',
      'baseUrl must be an http(s) URL without credentials, query, or fragment',
    );

  const apiKey = value['apiKey'] === '' ? '' : readString(value['apiKey']);
  const providerType = resolveProviderType(providerId, value['type'], issue);
  const isAlibaba = providerType === 'alibaba';
  if (
    apiKey === undefined ||
    (apiKey === '' && isAlibaba) ||
    (apiKey !== '' && isUnresolvedApiKey(apiKey))
  ) {
    issue('apiKey', 'apiKey is required and must resolve from the environment');
  }
  const adapter = resolveProviderAdapter(
    providerType,
    value['protocol'],
    issue,
  );
  const authType = resolveProviderAuthType(value['authType'], issue);
  const anthropic = parseAnthropicConfig(
    value['anthropic'],
    adapter === 'anthropic-compatible',
    issue,
  );
  const builtinModels = isAlibaba ? BUILTIN_ALIBABA_MODELS : [];
  const modelOverrides = parseModels(
    providerId,
    value['models'],
    builtinModels,
    issues,
  );
  const models = mergeModels(builtinModels, modelOverrides);

  const configuredDefaultModel = readString(value['model']);
  // Builtins are seeded first, so models[0] is also the provider's builtin
  // default (e.g. the first builtin model for alibaba).
  const defaultModel = configuredDefaultModel ?? models[0]?.modelId;
  if (!defaultModel) {
    issue('model', 'model or models[0].model is required');
  } else if (!models.some((model) => model.modelId === defaultModel)) {
    // A concise custom-provider config may declare only `model`.
    if (!isAlibaba && modelOverrides.length === 0) {
      models.push(createDefaultModel(defaultModel));
    } else {
      models.push(createImplicitCustomProviderModel(defaultModel, providerType));
    }
  }

  const routing = parseRouting(providerId, value['routing'], issues);
  const modelIds = new Set(models.map((model) => model.modelId));
  for (const modelId of Object.values(routing)) {
    if (!modelId) continue;
    if (!modelIds.has(modelId)) {
      models.push(createImplicitCustomProviderModel(modelId, providerType));
      modelIds.add(modelId);
    }
  }

  const firstPayloadTimeoutMs =
    readPositiveInteger(value['firstPayloadTimeoutMs']) ??
    (isAlibaba
      ? ALIBABA_FIRST_PAYLOAD_TIMEOUT_MS
      : DEFAULT_CUSTOM_PROVIDER_FIRST_PAYLOAD_TIMEOUT_MS);
  const streamIdleTimeoutMs = readNonNegativeInteger(
    value['streamIdleTimeoutMs'],
  );
  if (
    issues.length > 0 ||
    !baseUrl ||
    apiKey === undefined ||
    !defaultModel
  ) {
    return { issues };
  }

  return {
    provider: {
      providerId,
      type: providerType,
      displayName:
        readString(value['displayName']) ?? formatProviderName(providerId),
      adapter,
      authType,
      baseUrl,
      apiKey,
      defaultModel,
      routing,
      models: new Map(models.map((model) => [model.modelId, model])),
      timeouts: {
        firstPayloadTimeoutMs,
        ...(streamIdleTimeoutMs && streamIdleTimeoutMs > 0
          ? { streamIdleTimeoutMs }
          : {}),
      },
      ...(anthropic ? { anthropic } : {}),
    },
    issues,
  };
}

function resolveProviderAdapter(
  providerType: CustomProviderType,
  value: unknown,
  issue: (field: string | undefined, message: string) => void,
): CustomProviderAdapterKind {
  if (value === undefined || value === 'openai') {
    return providerType;
  }
  if (value === 'openai-responses') {
    return 'openai-responses';
  }
  if (value === 'anthropic') {
    return 'anthropic-compatible';
  }
  if (value === 'gemini') {
    return 'gemini';
  }
  issue(
    'protocol',
    'protocol must be openai, openai-responses, anthropic, or gemini',
  );
  return providerType;
}

function resolveProviderAuthType(
  value: unknown,
  issue: (field: string | undefined, message: string) => void,
): CustomProviderAuthType {
  if (
    value === 'bearer' ||
    value === 'api-key' ||
    value === 'google-api-key'
  ) {
    return value;
  }
  if (value !== undefined) {
    issue(
      'authType',
      'authType must be bearer, api-key, or google-api-key',
    );
  }
  return 'bearer';
}

function resolveProviderType(
  providerId: string,
  value: unknown,
  issue: (field: string | undefined, message: string) => void,
): CustomProviderType {
  if (value === undefined) {
    return providerId === ALIBABA_PROVIDER ||
      providerId === ALIYUN_BAILIAN_PROVIDER_ALIAS
      ? 'alibaba'
      : 'openai-compatible';
  }
  if (value === ALIYUN_BAILIAN_PROVIDER_ALIAS) return 'alibaba';
  const parsed = readEnum(value, CUSTOM_PROVIDER_TYPES);
  if (parsed) return parsed;
  issue(
    'type',
    'type must be openai-compatible, alibaba, or aliyun-bailian',
  );
  return 'openai-compatible';
}

function parseAnthropicConfig(
  value: unknown,
  enabled: boolean,
  issue: (field: string | undefined, message: string) => void,
): CustomProviderAnthropicConfig | undefined {
  if (!enabled) {
    if (value !== undefined) {
      issue('anthropic', 'anthropic settings require protocol to be anthropic');
    }
    return undefined;
  }

  if (value !== undefined && !isRecord(value)) {
    issue('anthropic', 'anthropic must be an object');
  }
  const record = isRecord(value) ? value : {};

  let version: string | false = DEFAULT_CUSTOM_PROVIDER_ANTHROPIC_CONFIG.version;
  const rawVersion = record['version'];
  if (rawVersion === false) {
    version = false;
  } else if (typeof rawVersion === 'string') {
    const normalized = rawVersion.trim();
    if (!normalized || !hasNoControlCharacters(normalized)) {
      issue(
        'anthropic.version',
        'anthropic.version must be a non-empty HTTP header value or false',
      );
    } else {
      version = normalized;
    }
  } else if (rawVersion !== undefined) {
    issue(
      'anthropic.version',
      'anthropic.version must be a non-empty HTTP header value or false',
    );
  }

  const betas = parseBetaList(record['betas'], 'anthropic.betas', issue);
  const queryParams: Record<string, string> = {};
  const rawQueryParams = record['queryParams'];
  if (rawQueryParams !== undefined && !isRecord(rawQueryParams)) {
    issue('anthropic.queryParams', 'anthropic.queryParams must be an object');
  } else if (isRecord(rawQueryParams)) {
    for (const [key, rawValue] of Object.entries(rawQueryParams)) {
      if (
        !key ||
        !hasNoControlCharacters(key) ||
        typeof rawValue !== 'string'
      ) {
        issue(
          `anthropic.queryParams.${key}`,
          'Anthropic query parameter names must be safe and values must be strings',
        );
        continue;
      }
      if (!hasNoControlCharacters(rawValue)) {
        issue(
          `anthropic.queryParams.${key}`,
          'Anthropic query parameter values must not contain control characters',
        );
        continue;
      }
      queryParams[key] = rawValue;
    }
  }

  const rawCache = record['cache'];
  if (rawCache !== undefined && !isRecord(rawCache)) {
    issue('anthropic.cache', 'anthropic.cache must be an object');
  }
  const cacheRecord = isRecord(rawCache) ? rawCache : {};
  const mode = parseEnumOption(
    cacheRecord['mode'],
    ['off', 'auto'] as const,
    DEFAULT_CUSTOM_PROVIDER_ANTHROPIC_CONFIG.cache.mode,
    'anthropic.cache.mode',
    'anthropic.cache.mode must be either off or auto',
    issue,
  );
  const ttl = parseEnumOption(
    cacheRecord['ttl'],
    ['5m', '1h'] as const,
    DEFAULT_CUSTOM_PROVIDER_ANTHROPIC_CONFIG.cache.ttl,
    'anthropic.cache.ttl',
    'anthropic.cache.ttl must be either 5m or 1h',
    issue,
  );

  return {
    version,
    betas,
    queryParams,
    cache: { mode, ttl },
  };
}

function parseBetaList(
  value: unknown,
  field: string,
  issue: (field: string | undefined, message: string) => void,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(field, `${field} must be an array of beta identifiers`);
    return [];
  }

  const betas: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const beta = readString(value[index]);
    if (!beta || !ANTHROPIC_BETA_PATTERN.test(beta)) {
      issue(
        `${field}[${index}]`,
        'Anthropic beta identifiers may contain only letters, digits, dot, underscore, and dash',
      );
      continue;
    }
    if (!seen.has(beta)) {
      seen.add(beta);
      betas.push(beta);
    }
  }
  return betas;
}

function parseModels(
  providerId: string,
  value: unknown,
  builtins: readonly CustomProviderModelRuntime[],
  issues: CustomProviderValidationIssue[],
): CustomProviderModelRuntime[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    issues.push({
      providerId,
      field: 'models',
      message: 'models must be an array',
    });
    return [];
  }

  const models: CustomProviderModelRuntime[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const rawModel = value[index];
    const field = `models[${index}]`;
    if (!isRecord(rawModel)) {
      issues.push({
        providerId,
        field,
        message: 'model configuration must be an object',
      });
      continue;
    }
    const modelId = readString(rawModel['model']);
    if (!modelId) {
      issues.push({
        providerId,
        field: `${field}.model`,
        message: 'model is required',
      });
      continue;
    }
    if (seen.has(modelId)) {
      issues.push({
        providerId,
        field: `${field}.model`,
        message: 'model must be unique within a provider',
      });
      continue;
    }
    seen.add(modelId);
    rejectRemovedFields(
      rawModel,
      REMOVED_MODEL_GENERATION_FIELDS,
      (removedField, message) => {
        issues.push({
          providerId,
          field: `${field}.${removedField}`,
          message,
        });
      },
    );

    const builtin = builtins.find((model) => model.modelId === modelId);
    const capabilities = parseCapabilities(
      providerId,
      `${field}.capabilities`,
      rawModel['capabilities'],
      builtin?.capabilities,
      issues,
    );
    const generationDefaults = generationDefaultsForCapabilities(
      builtin?.generationDefaults,
      capabilities,
    );
    const declaredContext = readPositiveInteger(rawModel['contextWindow']);
    models.push({
      modelId,
      displayName:
        readString(rawModel['displayName']) ?? builtin?.displayName ?? modelId,
      contextWindow:
        declaredContext ??
        builtin?.contextWindow ??
        DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
      ...(declaredContext === undefined && !builtin
        ? { contextWindowEstimated: true as const }
        : {}),
      maxOutputTokens:
        readPositiveInteger(rawModel['maxOutputTokens']) ??
        builtin?.maxOutputTokens ??
        DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
      capabilities,
      ...(generationDefaults ? { generationDefaults } : {}),
      maxTokensField:
        readEnum(rawModel['maxTokensField'], [
          'max_tokens',
          'max_completion_tokens',
        ]) ??
        builtin?.maxTokensField ??
        'max_tokens',
    });
  }
  return models;
}

function createDefaultModel(modelId: string): CustomProviderModelRuntime {
  return createFallbackModel(modelId, DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW);
}

/**
 * Creates a conservative runtime descriptor for a provider-native model that
 * was referenced without a matching `models` metadata entry.
 */
export function createImplicitCustomProviderModel(
  modelId: string,
  providerType: CustomProviderType,
): CustomProviderModelRuntime {
  if (providerType === 'alibaba') {
    return createFallbackModel(
      modelId,
      DEFAULT_IMPLICIT_ALIBABA_CONTEXT_WINDOW,
      createAlibabaThinkingCapabilities(),
    );
  }
  return createFallbackModel(
    modelId,
    DEFAULT_IMPLICIT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  );
}

function createFallbackModel(
  modelId: string,
  contextWindow: number,
  thinking: CustomProviderThinkingCapabilities = disabledThinkingCapabilities(),
): CustomProviderModelRuntime {
  return {
    modelId,
    displayName: modelId,
    contextWindow,
    contextWindowEstimated: true,
    maxOutputTokens: DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
    implicit: true,
    capabilities: {
      tools: true,
      vision: false,
      thinking,
    },
    maxTokensField: 'max_tokens',
  };
}

function mergeModels(
  builtins: readonly CustomProviderModelRuntime[],
  overrides: readonly CustomProviderModelRuntime[],
): CustomProviderModelRuntime[] {
  const merged = new Map(
    builtins.map((model) => [model.modelId, cloneCustomProviderModel(model)]),
  );
  for (const model of overrides) merged.set(model.modelId, model);
  return [...merged.values()];
}

/** Deep-clones a runtime model so callers can mutate copies independently. */
export function cloneCustomProviderModel(
  model: CustomProviderModelRuntime,
): CustomProviderModelRuntime {
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      thinking: cloneThinkingCapabilities(model.capabilities.thinking),
    },
    ...(model.generationDefaults
      ? {
          generationDefaults: cloneLlmGenerationConfig(
            model.generationDefaults,
          ),
        }
      : {}),
  };
}

function parseRouting(
  providerId: string,
  value: unknown,
  issues: CustomProviderValidationIssue[],
): Partial<Record<CustomProviderRoutingPurpose, string>> {
  if (value == null) return {};
  if (!isRecord(value)) {
    issues.push({
      providerId,
      field: 'routing',
      message: 'routing must be an object',
    });
    return {};
  }
  const routing: Partial<Record<CustomProviderRoutingPurpose, string>> = {};
  for (const [purpose, rawModel] of Object.entries(value)) {
    if (!ROUTING_PURPOSES.has(purpose as CustomProviderRoutingPurpose)) {
      issues.push({
        providerId,
        field: `routing.${purpose}`,
        message: 'unsupported routing purpose',
      });
      continue;
    }
    const modelId = readString(rawModel);
    if (!modelId) {
      issues.push({
        providerId,
        field: `routing.${purpose}`,
        message: 'routing target must be a non-empty model id',
      });
      continue;
    }
    routing[purpose as CustomProviderRoutingPurpose] = modelId;
  }
  return routing;
}

function parseCapabilities(
  providerId: string,
  field: string,
  value: unknown,
  fallback: CustomProviderModelCapabilities | undefined,
  issues: CustomProviderValidationIssue[],
): CustomProviderModelCapabilities {
  const record = isRecord(value) ? value : {};
  const cacheControl =
    readBoolean(record['cacheControl']) ?? fallback?.cacheControl;
  return {
    tools: readBoolean(record['tools']) ?? fallback?.tools ?? true,
    vision: readBoolean(record['vision']) ?? fallback?.vision ?? false,
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    thinking: parseThinkingCapabilities(
      providerId,
      `${field}.thinking`,
      record['thinking'],
      fallback?.thinking,
      issues,
    ),
  };
}

function parseThinkingCapabilities(
  providerId: string,
  field: string,
  value: unknown,
  fallback: CustomProviderThinkingCapabilities | undefined,
  issues: CustomProviderValidationIssue[],
): CustomProviderThinkingCapabilities {
  const addIssue = (suffix: string, message: string) => {
    issues.push({
      providerId,
      field: suffix ? `${field}.${suffix}` : field,
      message,
    });
  };

  if (value === undefined) {
    return fallback
      ? cloneThinkingCapabilities(fallback)
      : disabledThinkingCapabilities();
  }
  if (!isRecord(value)) {
    addIssue('', 'thinking capability must be an object');
    return fallback
      ? cloneThinkingCapabilities(fallback)
      : disabledThinkingCapabilities();
  }

  const rawModes = value['modes'];
  if (rawModes === undefined) {
    addIssue('modes', 'thinking.modes is required for object configuration');
  }
  const modes = parseEnumList(
    rawModes,
    CUSTOM_PROVIDER_THINKING_WIRE_MODES,
    'modes',
    'thinking modes must be enabled or adaptive',
    addIssue,
  );

  const rawPreferredMode = value['preferredMode'];
  const preferredMode = readEnum(
    rawPreferredMode,
    CUSTOM_PROVIDER_THINKING_WIRE_MODES,
  );
  if (rawPreferredMode !== undefined && preferredMode === undefined) {
    addIssue(
      'preferredMode',
      'thinking.preferredMode must be enabled or adaptive',
    );
  } else if (preferredMode && !modes.includes(preferredMode)) {
    addIssue(
      'preferredMode',
      'thinking.preferredMode must be included in thinking.modes',
    );
  }

  if ('mode' in value) {
    addIssue('mode', 'thinking.mode has been removed; use thinking.modes');
  }
  if ('supportsBudget' in value) {
    addIssue(
      'supportsBudget',
      'thinking.supportsBudget has been removed; budget support is derived from thinking.modes',
    );
  }
  const rawRequiresBudgetForEnabled = value['requiresBudgetForEnabled'];
  const configuredRequiresBudgetForEnabled = readBoolean(
    rawRequiresBudgetForEnabled,
  );
  if (
    rawRequiresBudgetForEnabled !== undefined &&
    configuredRequiresBudgetForEnabled === undefined
  ) {
    addIssue(
      'requiresBudgetForEnabled',
      'thinking.requiresBudgetForEnabled must be a boolean',
    );
  } else if (
    configuredRequiresBudgetForEnabled !== undefined &&
    !modes.includes('enabled')
  ) {
    addIssue(
      'requiresBudgetForEnabled',
      'thinking.requiresBudgetForEnabled requires thinking.modes to include enabled',
    );
  }
  const requiresBudgetForEnabled = modes.includes('enabled')
    ? (configuredRequiresBudgetForEnabled ??
      fallback?.requiresBudgetForEnabled ??
      true)
    : undefined;
  const rawSupportsEffort = value['supportsEffort'];
  if (
    rawSupportsEffort !== undefined &&
    readBoolean(rawSupportsEffort) === undefined
  ) {
    addIssue('supportsEffort', 'thinking.supportsEffort must be a boolean');
  }
  const explicitEffortLevels = parseEnumList(
    value['supportedEffortLevels'],
    CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS,
    'supportedEffortLevels',
    'thinking effort levels must be low, medium, high, xhigh, or max',
    addIssue,
  );
  const supportsEffort =
    readBoolean(rawSupportsEffort) ??
    (value['supportedEffortLevels'] !== undefined
      ? explicitEffortLevels.length > 0
      : undefined) ??
    false;
  const requiredBetasForEffort =
    value['requiredBetasForEffort'] === undefined
      ? []
      : parseBetaList(
          value['requiredBetasForEffort'],
          `${field}.requiredBetasForEffort`,
          (issueField, message) =>
            issues.push({
              providerId,
              ...(issueField ? { field: issueField } : {}),
              message,
            }),
        );

  if (requiredBetasForEffort.length > 0 && !supportsEffort) {
    addIssue(
      'requiredBetasForEffort',
      'requiredBetasForEffort requires supportsEffort to be true',
    );
  }
  if (explicitEffortLevels.length > 0 && !supportsEffort) {
    addIssue(
      'supportedEffortLevels',
      'supportedEffortLevels requires supportsEffort to be true',
    );
  }
  // Settings declare effort support either coarsely (`supportsEffort`) or as an
  // explicit level list. Both collapse into one resolved list here so no
  // consumer has to re-derive "omitted means every level".
  return {
    modes,
    ...(preferredMode ? { preferredMode } : {}),
    ...(requiresBudgetForEnabled !== undefined
      ? { requiresBudgetForEnabled }
      : {}),
    supportedEffortLevels: !supportsEffort
      ? []
      : explicitEffortLevels.length > 0
        ? explicitEffortLevels
        : [...CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS],
    requiredBetasForEffort,
  };
}

/**
 * Validates a `thinking.<property>` array of enum strings, dropping duplicates
 * and reporting one issue per rejected entry. `undefined` yields an empty list
 * without an issue so callers own the "required" rule.
 */
function parseEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  property: string,
  itemMessage: string,
  addIssue: (suffix: string, message: string) => void,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addIssue(property, `thinking.${property} must be an array`);
    return [];
  }

  const parsed: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const candidate = readEnum(value[index], allowed);
    if (candidate === undefined) {
      addIssue(`${property}[${index}]`, itemMessage);
    } else if (!parsed.includes(candidate)) {
      parsed.push(candidate);
    }
  }
  return parsed;
}

function disabledThinkingCapabilities(): CustomProviderThinkingCapabilities {
  return {
    modes: [],
    supportedEffortLevels: [],
    requiredBetasForEffort: [],
  };
}

function cloneThinkingCapabilities(
  capabilities: CustomProviderThinkingCapabilities,
): CustomProviderThinkingCapabilities {
  return {
    ...capabilities,
    modes: [...capabilities.modes],
    supportedEffortLevels: [...capabilities.supportedEffortLevels],
    requiredBetasForEffort: [...capabilities.requiredBetasForEffort],
  };
}

function generationDefaultsForCapabilities(
  defaults: LlmGenerationConfig | undefined,
  capabilities: CustomProviderModelCapabilities,
): LlmGenerationConfig | undefined {
  if (!defaults) return undefined;
  const cloned = cloneLlmGenerationConfig(defaults);
  if (supportsCustomProviderModelThinking(capabilities)) return cloned;

  const preserve = cloned.reasoning?.preserve;
  if (preserve === undefined) delete cloned.reasoning;
  else cloned.reasoning = { preserve };
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function rejectRemovedFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  issue: (field: string, message: string) => void,
): void {
  for (const field of fields) {
    if (!(field in value)) continue;
    issue(field, getRemovedCustomProviderFieldMessage(field));
  }
}

/** An API key is unusable when absent or still an unexpanded env reference. */
function isUnresolvedApiKey(value: string | undefined): boolean {
  return !value || UNRESOLVED_ENV_PATTERN.test(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function hasNoControlCharacters(value: string): boolean {
  // Hand-rolled rather than a regex: `no-control-regex` rejects the
  // equivalent character class.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

// Undefined falls back to the default; any other unexpected value is reported.
function parseEnumOption<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  message: string,
  issue: (path: string, message: string) => void,
): T {
  const parsed = readEnum(raw, allowed);
  if (parsed !== undefined) return parsed;
  if (raw !== undefined) issue(path, message);
  return fallback;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
