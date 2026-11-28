/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingsService } from '@qwen-code/resource';
import { vi } from 'vitest';
import type { Model, ReasoningEffortLevel } from '../provider/model/model.js';
import type { ListedModelEntryFixture } from './listed-model-entry.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import type { Config } from '../config/config.js';

/**
 * 把 snake_case 条目夹具还原成 provider 查询返回的 Model：
 * 'custom' 条目归 provider 自身来源，
 * 'user'（直连模型）带 connection，其余保留为服务端来源桶。
 */
export function entryToListedModel(entry: ListedModelEntryFixture): Model {
  const efforts = [
    ...new Set([
      ...(entry.supports_disabled ? ['none'] : []),
      ...(entry.efforts ?? []),
    ]),
  ] as ReasoningEffortLevel[];
  const isCustom = entry.source === 'custom';
  const isDirect = entry.source === 'user';
  const defaultModelConfig = {
    ...(entry.default_effort
      ? { reasoning: { effort: entry.default_effort as ReasoningEffortLevel } }
      : {}),
    ...(entry.default_context_window !== undefined
      ? { context: { contextWindow: entry.default_context_window } }
      : {}),
  };
  return {
    source: isCustom ? (entry.provider ?? 'custom') : 'qoder',
    key: entry.key,
    displayName: entry.display_name,
    enabled: entry.enable,
    isDefault: entry.is_default,
    capabilities: {
      tools: true,
      vision: entry.is_vl,
      reasoning: { supported: entry.is_reasoning, supportedEfforts: efforts },
      contextWindows: (entry.available_context_windows ?? []).map((tokens) => ({
        tokens,
      })),
    },
    limits: {
      maxContextTokens: entry.max_input_tokens,
      ...(entry.max_output_tokens
        ? { maxOutputTokens: entry.max_output_tokens }
        : {}),
    },
    ...(Object.keys(defaultModelConfig).length > 0
      ? { defaultModelConfig }
      : {}),
    isNew: entry.is_new,
    ...(entry.is_free !== undefined ? { isFree: entry.is_free } : {}),
    ...(entry.price_factor !== undefined
      ? { priceFactor: entry.price_factor }
      : {}),
    ...(entry.original_price_factor !== undefined
      ? { originalPriceFactor: entry.original_price_factor }
      : {}),
    ...(entry.promotion ? { promotion: entry.promotion } : {}),
    tags: entry.tags,
    ...(!isCustom && !isDirect ? { catalogSource: entry.source } : {}),
    ...(entry.server_scene !== undefined
      ? { serverScene: entry.server_scene }
      : {}),
    ...(entry.outer_provider ? { outerProvider: entry.outer_provider } : {}),
    format: entry.format,
    ...(entry.strategies ? { strategies: entry.strategies } : {}),
    ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
    ...(isDirect
      ? {
          connection: {
            provider: entry.provider,
            model: entry.model,
            type: entry.type,
            url: entry.url,
            format: entry.format,
          },
        }
      : {}),
  } as Model;
}

/** 以默认可用的服务端条目为底，按覆盖字段生成 Model。 */
export function testListedModel(
  key: string,
  overrides: Partial<ListedModelEntryFixture> = {},
): Model {
  return entryToListedModel({
    key,
    display_name: key,
    is_default: false,
    enable: true,
    is_reasoning: false,
    is_vl: false,
    is_new: false,
    max_input_tokens: 200_000,
    max_output_tokens: 16_384,
    source: 'system',
    format: 'openai',
    tags: [],
    ...overrides,
  });
}

/**
 * 只回答固定清单的会话上下文：底下是一个真实 ModelProviderManager，
 * 查询方法用异步桩返回给定清单，并保留精确优先及大小写宽松查找。
 */
export function listedModelSource(models: readonly Model[]): Config {
  const manager = new ModelProviderManager({
    userProviders: [],
    modelTransportManager: new ModelTransportManager([]),
    settingsService: new SettingsService(),
  });
  vi.spyOn(manager, 'listModels').mockResolvedValue([...models]);
  vi.spyOn(manager, 'getModel').mockImplementation(
    async (key) =>
      models.find((model) => model.key === key) ??
      models.find((model) => model.key.toLowerCase() === key.toLowerCase()),
  );
  return { getModelProviderManager: () => manager } as unknown as Config;
}

/** 同 {@link listedModelSource}，按旧条目夹具给出清单。 */
export function listedEntrySource(
  entries: readonly ListedModelEntryFixture[],
): Config {
  return listedModelSource(entries.map(entryToListedModel));
}

/**
 * 空快照的会话上下文：任何模型都查不到，等价于会话尚未列举模型。手写 Config
 * 桩可直接挂 `getModelProviderManager: emptySnapshotSource.getModelProviderManager`。
 * 不含 vi.fn，不受 `vi.resetAllMocks()` 影响。
 */
export const emptySnapshotSource = {
  getModelProviderManager: () => ({
    getModel: async () => undefined,
    listModels: async () => [],
    getModelConfig: () => undefined,
  }),
} as unknown as Config;

/**
 * 两个异步查询方法都是 vi.fn 的会话上下文，供逐次打桩或断言调用的测试使用；
 * 默认清单为空。
 */
export function stubSnapshotSource() {
  const manager = {
    getModel: vi
      .fn<(key: string) => Promise<Model | undefined>>()
      .mockResolvedValue(undefined),
    listModels: vi.fn<() => Promise<Model[]>>().mockResolvedValue([]),
    getModelConfig: vi.fn(() => undefined),
  };
  const source = {
    getModelProviderManager: () => manager,
  } as unknown as Config;
  return { manager, source };
}

/**
 * 让所有 ModelProviderManager 实例的异步查询返回给定清单；
 * 由 `vi.restoreAllMocks()` 撤销。夹具模型的 owner 可能不在被测 manager
 * 的 provider 集合里，此时按「无偏好」读取，而不是抛 owner 缺失。
 */
export function mockListedModels(models: readonly Model[]) {
  vi.spyOn(ModelProviderManager.prototype, 'getModel').mockImplementation(
    async (key) =>
      models.find((model) => model.key === key) ??
      models.find((model) => model.key.toLowerCase() === key.toLowerCase()),
  );
  const getModelConfig = ModelProviderManager.prototype.getModelConfig;
  vi.spyOn(ModelProviderManager.prototype, 'getModelConfig').mockImplementation(
    function (this: ModelProviderManager, target) {
      try {
        return getModelConfig.call(this, target);
      } catch (error) {
        if (typeof target !== 'string') return undefined;
        throw error;
      }
    },
  );
  return vi
    .spyOn(ModelProviderManager.prototype, 'listModels')
    .mockResolvedValue([...models]);
}

/** 同 {@link mockListedModels}，按旧条目夹具给出清单。 */
export function mockListedEntries(entries: readonly ListedModelEntryFixture[]) {
  return mockListedModels(entries.map(entryToListedModel));
}
