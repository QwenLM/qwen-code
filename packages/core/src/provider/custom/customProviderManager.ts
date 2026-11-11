/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import stripJsonComments from 'strip-json-comments';
import {
  resolveEnvVarsInObject,
  toPlainJsonValue,
  type CustomProviderModelSetting,
  type CustomProviderSetting,
  type SettingsService,
} from '@qwen-code/resource';
import { Storage } from '../../config/storage.js';
import { parseCustomProviderSettings } from './parser.js';
import {
  supportsCustomProviderModelThinking,
  type CustomProviderRuntime,
} from './types.js';
import {
  addCredentialSecrets,
  customModelProviderConfigError,
  createConfigOperationLog,
  isCustomProviderConfigInput,
  requireBoolean,
  requireEnum,
  requireEnumArray,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireStringArray,
  rethrowConfigPersistFailure,
} from '../impl/customModelProviderConfigCommon.js';
import { CustomModelProviderConfigLog } from '../impl/customModelProviderConfigLog.js';

export type CustomModelProviderProtocol =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

export interface CustomModelProviderConfigInfo {
  providerId: string;
  displayName: string;
  baseUrl: string;
  providerType: 'openai-compatible' | 'alibaba';
  protocol: CustomModelProviderProtocol;
  authType: 'bearer' | 'api-key' | 'google-api-key';
  defaultModelId: string;
  models: Array<{
    id: string;
    displayName: string;
    vision: boolean;
    reasoning: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
    reasoningEfforts?: string[];
  }>;
}

export interface CustomModelProviderConfigInput {
  providerId: string;
  baseUrl: string;
  /** For compatible providers, an empty value configures an unauthenticated endpoint. */
  apiKey: string;
  type?: 'openai-compatible' | 'alibaba' | 'aliyun-bailian';
  protocol?: CustomModelProviderProtocol;
  authType?: 'bearer' | 'api-key' | 'google-api-key';
  displayName?: string;
  model?: string;
  models?: CustomProviderModelSetting[];
}

export interface UpdateCustomModelProviderConfigInput {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  type?: 'openai-compatible' | 'alibaba' | 'aliyun-bailian';
  protocol?: CustomModelProviderProtocol;
  authType?: 'bearer' | 'api-key' | 'google-api-key';
  displayName?: string;
  model?: string;
  models?: CustomProviderModelSetting[];
}

/** 单模型配置的编辑快照；不包含凭据。 */
export interface CustomProviderModelEdit {
  providerId: string;
  modelKey: string;
  revision: string;
  protocol: CustomModelProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  model: CustomProviderModelSetting;
}

/**
 * user settings 里 `providers` 的控制面增删改查；只接受 providerId 形状的入参。
 * 不含任何账号或运行时准入判定，调用方负责在写入前自行过门。
 */
export class CustomProviderManager {
  constructor(private readonly settingsService: SettingsService) {}

  list(requestId?: string): Promise<CustomModelProviderConfigInfo[]> {
    return this.readProviders(requestId);
  }

  /** 只返回本地配置摘要；列出配置不授予执行权限，实际推理仍经过权限校验。 */
  async listCached(
    uid: string,
    requestId?: string,
  ): Promise<CustomModelProviderConfigInfo[]> {
    if (!uid.trim())
      throw customModelProviderConfigError(
        'invalid',
        'Cached provider listing requires uid',
      );
    return this.readProviders(requestId);
  }

  async create(
    input: unknown,
    requestId?: string,
  ): Promise<{ providerId: string }> {
    const log = createConfigOperationLog('create', input, requestId);
    return log.run(async () => {
      const parsed = parseCustomCreate(requireCustomProviderRecord(input));
      log.context({ stage: 'validation' });
      const setting = toCustomProviderSetting(parsed);
      validateCustomProvider(parsed.providerId, setting);
      await this.mutateProviders((providers) => {
        log.context({ stage: 'lookup' });
        if (Object.hasOwn(providers, parsed.providerId)) {
          throw customModelProviderConfigError(
            'alreadyExists',
            'Custom Provider already exists',
          );
        }
        providers[parsed.providerId] = setting;
      }, log);
      log.context({ provider_id: parsed.providerId });
      return { providerId: parsed.providerId };
    });
  }

  async update(input: unknown, requestId?: string): Promise<void> {
    const log = createConfigOperationLog('update', input, requestId);
    return log.run(async () => {
      const parsed = parseCustomUpdate(requireCustomProviderRecord(input));
      await this.mutateProviders((providers) => {
        log.context({ stage: 'lookup' });
        const current = providers[parsed.providerId];
        if (!isRecord(current)) {
          throw customModelProviderConfigError(
            'notFound',
            'Custom Provider was not found',
          );
        }
        const next = patchCustomProviderSetting(current, parsed);
        log.context({ stage: 'validation' });
        validateCustomProvider(parsed.providerId, next);
        providers[parsed.providerId] = next;
      }, log);
    });
  }

  async delete(input: unknown, requestId?: string): Promise<void> {
    const log = createConfigOperationLog('delete', input, requestId);
    return log.run(async () => {
      const providerId = requireString(
        requireCustomProviderRecord(input, 'target')['providerId'],
        'providerId',
      );
      await this.mutateProviders((providers) => {
        log.context({ stage: 'lookup' });
        if (!Object.hasOwn(providers, providerId)) {
          throw customModelProviderConfigError(
            'notFound',
            'Custom Provider was not found',
          );
        }
        delete providers[providerId];
      }, log);
    });
  }

  async check(
    input: unknown,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<void> {
    const log = createConfigOperationLog('check', input, requestId);
    return log.run(async () => {
      const parsed = parseCustomCreate(requireCustomProviderRecord(input));
      log.context({ stage: 'validation' });
      // 配置校验只在本地执行，保存时不得发起可能计费的模型请求。
      validateCustomProvider(
        parsed.providerId,
        toCustomProviderSetting(parsed),
      );
    }, signal);
  }

  /** 主动读取最新 user 配置，生成不含凭据的单模型编辑快照。 */
  getModelEdit(modelKey: string): CustomProviderModelEdit | undefined {
    const providerId = modelKey.slice(0, modelKey.indexOf('/'));
    const providers = this.readUserProviders();
    const own = providers[providerId];
    const parsed = parseCustomProviderSettings(
      resolveEnvVarsInObject({ [providerId]: own }),
    );
    const provider = parsed.providers[0];
    const descriptor = provider?.models.values().next().value;
    if (
      !isRecord(own) ||
      parsed.issues.length ||
      provider?.models.size !== 1 ||
      !descriptor ||
      `${providerId}/${descriptor.modelId}` !== modelKey ||
      ![
        'openai-compatible',
        'openai-responses',
        'anthropic-compatible',
        'gemini',
      ].includes(provider.adapter)
    )
      return undefined;
    const setting = own as unknown as CustomProviderSetting;
    const raw = setting.models?.find(
      (model) => model.model === descriptor.modelId,
    );
    return {
      providerId,
      modelKey,
      revision: providerRevision(own),
      protocol: protocolFromAdapter(provider.adapter),
      baseUrl: provider.baseUrl,
      hasApiKey: Boolean(provider.apiKey),
      model: {
        ...raw,
        model: descriptor.modelId,
        displayName: raw?.displayName ?? descriptor.displayName,
        ...(!descriptor.contextWindowEstimated
          ? { contextWindow: descriptor.contextWindow }
          : {}),
        maxOutputTokens: descriptor.maxOutputTokens,
        capabilities: {
          ...raw?.capabilities,
          tools: descriptor.capabilities.tools,
          vision: descriptor.capabilities.vision,
          thinking: {
            ...descriptor.capabilities.thinking,
            modes: [...descriptor.capabilities.thinking.modes],
            supportedEffortLevels: [
              ...descriptor.capabilities.thinking.supportedEffortLevels,
            ],
            requiredBetasForEffort: [
              ...descriptor.capabilities.thinking.requiredBetasForEffort,
            ],
          },
        },
      },
    };
  }

  /** 修改单模型配置；在持久化事务内校验版本并保留原始凭据和扩展字段。 */
  async updateModel(
    original: CustomProviderModelEdit,
    input: {
      baseUrl: string;
      apiKey?: string;
      model: CustomProviderModelSetting;
    },
    requestId?: string,
  ): Promise<void> {
    const log = createConfigOperationLog('update_model', input, requestId);
    await log.run(async () => {
      await this.mutateProviders((providers) => {
        const previous = requireSingleModelSetting(
          providers,
          original.modelKey,
        );
        if (
          providerRevision(previous) !== original.revision ||
          original.modelKey !== `${original.providerId}/${input.model.model}` ||
          input.model.model !== original.model.model
        ) {
          throw customModelProviderConfigError(
            'accessDenied',
            'Configuration changed or is not editable',
          );
        }
        const updated: CustomProviderSetting = {
          ...previous,
          baseUrl: input.baseUrl,
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          displayName: input.model.displayName || input.model.model,
          models: [
            {
              ...previous.models?.find(
                (model) => model.model === input.model.model,
              ),
              ...input.model,
            },
          ],
        };
        validateCustomProvider(original.providerId, updated);
        providers[original.providerId] = updated;
      }, log);
    });
  }

  /** 只删除独占一个模型的 user 配置；事务内重读，避免误删并发新增的模型。 */
  async deleteModel(modelKey: string, requestId?: string): Promise<void> {
    const log = createConfigOperationLog(
      'delete_model',
      { key: modelKey },
      requestId,
    );
    await log.run(async () => {
      await this.mutateProviders((providers) => {
        requireSingleModelSetting(providers, modelKey);
        delete providers[modelKey.slice(0, modelKey.indexOf('/'))];
      }, log);
    });
  }

  private async mutateProviders(
    mutate: (providers: Record<string, unknown>) => void,
    log: CustomModelProviderConfigLog,
  ): Promise<void> {
    try {
      log.context({ stage: 'lock', storage: 'settings.providers' });
      const source = this.settingsService.peekUserSettingsSource(
        Storage.getGlobalSettingsPath(),
      );
      if (!source) throw new Error('User settings are not writable');
      let mutationError: unknown;
      source.mutate((latest) => {
        const current = latest['providers'];
        const providers = isRecord(current)
          ? toPlainJsonValue<Record<string, unknown>>(current)
          : {};
        for (const provider of Object.values(providers))
          addCredentialSecrets(log, provider);
        try {
          mutate(providers);
        } catch (error) {
          mutationError = error;
          return false;
        }
        log.context({
          stage: 'persist',
          storage: 'settings.providers',
          storage_step: 'write',
        });
        latest['providers'] = providers;
        return true;
      });
      if (mutationError) throw mutationError;
      log.context({ persisted: true, storage_step: 'complete' });
    } catch (error) {
      if (error instanceof SyntaxError) log.context({ stage: 'parse' });
      rethrowConfigPersistFailure(error);
    }
  }

  private readUserProviders(): Record<string, unknown> {
    const source = this.settingsService.peekUserSettingsSource(
      Storage.getGlobalSettingsPath(),
    );
    if (!source) throw new Error('User settings source is unavailable');
    source.invalidate();
    const text = source.read();
    const settings = requireRecord(
      text === undefined ? {} : JSON.parse(stripJsonComments(text)),
      'settings',
    );
    return isRecord(settings['providers']) ? settings['providers'] : {};
  }

  private async readProviders(
    requestId: string | undefined,
  ): Promise<CustomModelProviderConfigInfo[]> {
    const log = new CustomModelProviderConfigLog('list', requestId);
    return log.run(async () => {
      log.context({ storage: 'settings.providers', stage: 'read' });
      log.context({ stage: 'parse' });
      const stored = this.readUserProviders();
      for (const provider of Object.values(stored))
        addCredentialSecrets(log, provider);
      log.context({ stage: 'validation' });
      const providers = projectCustomProviders(stored, log);
      log.context({
        stage: 'list',
        custom_provider_count: providers.length,
      });
      return providers;
    });
  }
}

/** 无 providerId 的入参属于宿主扩展的配置形状，不归本管理器处理。 */
function requireCustomProviderRecord(
  input: unknown,
  field = 'config',
): Record<string, unknown> {
  const record = requireRecord(input, field);
  if (!isCustomProviderConfigInput(record)) {
    throw customModelProviderConfigError(
      'accessDenied',
      'Only Custom Provider configurations are available in this runtime',
    );
  }
  return record;
}

function projectCustomProviders(
  value: unknown,
  log: CustomModelProviderConfigLog,
): CustomModelProviderConfigInfo[] {
  const resolved = resolveEnvVarsInObject(value);
  const parsed = parseCustomProviderSettings(resolved);
  for (const issue of parsed.issues) {
    log.warning('invalid_custom_provider_field', new Error(issue.message), {
      stage: 'validation',
      provider_id: issue.providerId,
      field: issue.field ?? 'provider',
    });
  }
  log.context({ custom_provider_issue_count: parsed.issues.length });
  return parsed.providers.map(projectCustomProvider);
}

function projectCustomProvider(
  provider: CustomProviderRuntime,
): CustomModelProviderConfigInfo {
  const protocol = protocolFromAdapter(provider.adapter);
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    defaultModelId: provider.defaultModel,
    providerType: provider.type,
    protocol,
    authType: provider.authType,
    models: [...provider.models.values()].map((model) => ({
      id: model.modelId,
      displayName: model.displayName,
      vision: model.capabilities.vision,
      reasoning: supportsCustomProviderModelThinking(model.capabilities),
      maxInputTokens: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      ...(model.capabilities.thinking.supportedEffortLevels.length > 0
        ? {
            reasoningEfforts: [
              ...model.capabilities.thinking.supportedEffortLevels,
            ],
          }
        : {}),
    })),
  };
}

function protocolFromAdapter(adapter: string): CustomModelProviderProtocol {
  if (adapter === 'openai-responses') return 'openai-responses';
  if (adapter === 'anthropic-compatible') return 'anthropic';
  if (adapter === 'gemini') return 'gemini';
  return 'openai';
}

function toCustomProviderSetting(
  input: CustomModelProviderConfigInput,
): CustomProviderSetting {
  return {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    ...(input.authType !== undefined ? { authType: input.authType } : {}),
    ...(input.displayName !== undefined
      ? { displayName: input.displayName }
      : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.models !== undefined
      ? { models: structuredClone(input.models) }
      : {}),
  };
}

function patchCustomProviderSetting(
  current: Record<string, unknown>,
  input: UpdateCustomModelProviderConfigInput,
): Record<string, unknown> {
  const next = structuredClone(current);
  for (const key of [
    'baseUrl',
    'apiKey',
    'type',
    'protocol',
    'authType',
    'displayName',
    'model',
    'models',
  ] as const) {
    if (input[key] !== undefined) next[key] = structuredClone(input[key]);
  }
  return next;
}

function validateCustomProvider(providerId: string, setting: unknown): void {
  const parsed = parseCustomProviderSettings(
    resolveEnvVarsInObject({ [providerId]: setting }),
  );
  if (parsed.providers.some((provider) => provider.providerId === providerId)) {
    return;
  }
  const message = parsed.issues
    .filter((issue) => issue.providerId === providerId)
    .map((issue) => `${issue.field ? `${issue.field}: ` : ''}${issue.message}`)
    .join('; ');
  throw customModelProviderConfigError(
    'invalid',
    message || 'Invalid Custom Provider',
    undefined,
    parsed.issues
      .filter((issue) => issue.providerId === providerId)
      .map((issue) => issue.field ?? 'provider')
      .join(','),
  );
}

function providerRevision(provider: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(resolveEnvVarsInObject(provider)))
    .digest('hex');
}

function requireSingleModelSetting(
  providers: Record<string, unknown>,
  modelKey: string,
): CustomProviderSetting {
  const providerId = modelKey.slice(0, modelKey.indexOf('/'));
  const own = providers[providerId];
  const parsed = parseCustomProviderSettings(
    resolveEnvVarsInObject({ [providerId]: own }),
  );
  const models = parsed.providers[0]?.models;
  if (
    !isRecord(own) ||
    parsed.issues.length ||
    models?.size !== 1 ||
    `${providerId}/${models.keys().next().value}` !== modelKey
  ) {
    throw customModelProviderConfigError(
      'accessDenied',
      'Configuration changed or is not editable',
    );
  }
  return own as unknown as CustomProviderSetting;
}

function parseCustomCreate(
  record: Record<string, unknown>,
): CustomModelProviderConfigInput {
  return {
    providerId: requireString(record['providerId'], 'providerId'),
    baseUrl: requireString(record['baseUrl'], 'baseUrl'),
    apiKey: requireApiKey(record['apiKey']),
    ...readOptionalCustomProviderFields(record),
  };
}

function parseCustomUpdate(
  record: Record<string, unknown>,
): UpdateCustomModelProviderConfigInput {
  return {
    providerId: requireString(record['providerId'], 'providerId'),
    ...readOptionalCustomProviderFields(record),
    ...(record['baseUrl'] !== undefined
      ? { baseUrl: requireString(record['baseUrl'], 'baseUrl') }
      : {}),
    ...(record['apiKey'] !== undefined
      ? { apiKey: requireApiKey(record['apiKey']) }
      : {}),
  };
}

function readOptionalCustomProviderFields(record: Record<string, unknown>) {
  const type = record['type'];
  const protocol = record['protocol'];
  const authType = record['authType'];
  return {
    ...(type !== undefined
      ? {
          type: requireEnum(
            type,
            ['openai-compatible', 'alibaba', 'aliyun-bailian'] as const,
            'type',
          ),
        }
      : {}),
    ...(protocol !== undefined
      ? {
          protocol: requireEnum(
            protocol,
            ['openai', 'openai-responses', 'anthropic', 'gemini'] as const,
            'protocol',
          ),
        }
      : {}),
    ...(authType !== undefined
      ? {
          authType: requireEnum(
            authType,
            ['bearer', 'api-key', 'google-api-key'] as const,
            'authType',
          ),
        }
      : {}),
    ...(record['displayName'] !== undefined
      ? { displayName: requireString(record['displayName'], 'displayName') }
      : {}),
    ...(record['model'] !== undefined
      ? { model: requireString(record['model'], 'model') }
      : {}),
    ...(record['models'] !== undefined
      ? { models: parseCustomProviderModels(record['models']) }
      : {}),
  };
}

function parseCustomProviderModels(
  value: unknown,
): CustomProviderModelSetting[] {
  if (!Array.isArray(value))
    throw customModelProviderConfigError('invalid', 'models must be an array');
  return value.map((item, index) => {
    const model = requireRecord(item, `models[${index}]`);
    return {
      model: requireString(model['model'], `models[${index}].model`),
      ...(model['displayName'] !== undefined
        ? {
            displayName: requireString(
              model['displayName'],
              `models[${index}].displayName`,
            ),
          }
        : {}),
      ...(model['contextWindow'] !== undefined
        ? {
            contextWindow: requirePositiveInteger(
              model['contextWindow'],
              `models[${index}].contextWindow`,
            ),
          }
        : {}),
      ...(model['maxOutputTokens'] !== undefined
        ? {
            maxOutputTokens: requirePositiveInteger(
              model['maxOutputTokens'],
              `models[${index}].maxOutputTokens`,
            ),
          }
        : {}),
      ...(model['capabilities'] !== undefined
        ? {
            capabilities: parseCustomProviderCapabilities(
              model['capabilities'],
              `models[${index}].capabilities`,
            ),
          }
        : {}),
    };
  });
}

function parseCustomProviderCapabilities(
  value: unknown,
  field: string,
): NonNullable<CustomProviderModelSetting['capabilities']> {
  const capabilities = requireRecord(value, field);
  return {
    ...(capabilities['tools'] !== undefined
      ? { tools: requireBoolean(capabilities['tools'], `${field}.tools`) }
      : {}),
    ...(capabilities['vision'] !== undefined
      ? { vision: requireBoolean(capabilities['vision'], `${field}.vision`) }
      : {}),
    ...(capabilities['cacheControl'] !== undefined
      ? {
          cacheControl: requireBoolean(
            capabilities['cacheControl'],
            `${field}.cacheControl`,
          ),
        }
      : {}),
    ...(capabilities['thinking'] !== undefined
      ? {
          thinking: parseCustomProviderThinkingCapabilities(
            capabilities['thinking'],
            `${field}.thinking`,
          ),
        }
      : {}),
  };
}

function parseCustomProviderThinkingCapabilities(
  value: unknown,
  field: string,
): NonNullable<
  NonNullable<CustomProviderModelSetting['capabilities']>['thinking']
> {
  const thinking = requireRecord(value, field);
  return {
    modes: requireEnumArray(
      thinking['modes'],
      ['enabled', 'adaptive'] as const,
      `${field}.modes`,
    ),
    ...(thinking['preferredMode'] !== undefined
      ? {
          preferredMode: requireEnum(
            thinking['preferredMode'],
            ['enabled', 'adaptive'] as const,
            `${field}.preferredMode`,
          ),
        }
      : {}),
    ...(thinking['requiresBudgetForEnabled'] !== undefined
      ? {
          requiresBudgetForEnabled: requireBoolean(
            thinking['requiresBudgetForEnabled'],
            `${field}.requiresBudgetForEnabled`,
          ),
        }
      : {}),
    ...(thinking['supportsEffort'] !== undefined
      ? {
          supportsEffort: requireBoolean(
            thinking['supportsEffort'],
            `${field}.supportsEffort`,
          ),
        }
      : {}),
    ...(thinking['supportedEffortLevels'] !== undefined
      ? {
          supportedEffortLevels: requireEnumArray(
            thinking['supportedEffortLevels'],
            ['low', 'medium', 'high', 'xhigh', 'max'] as const,
            `${field}.supportedEffortLevels`,
          ),
        }
      : {}),
    ...(thinking['requiredBetasForEffort'] !== undefined
      ? {
          requiredBetasForEffort: requireStringArray(
            thinking['requiredBetasForEffort'],
            `${field}.requiredBetasForEffort`,
          ),
        }
      : {}),
  };
}

function requireApiKey(value: unknown): string {
  return value === '' ? '' : requireString(value, 'apiKey');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
