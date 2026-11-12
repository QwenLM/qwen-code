/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';

import stripJsonComments from 'strip-json-comments';
import { Storage } from '../../config/storage.js';
import { runLogger } from '../../utils/runLogger.js';
import { CustomClientImpl } from '../../client/customClientImpl.js';
import type {
  CustomProviderModelRuntime,
  CustomProviderRuntime,
} from '../custom/types.js';
import {
  parseCustomProviderSettings,
  withoutReservedProviderSettings,
} from '../custom/parser.js';
import { customProviderModelKey } from '../custom/types.js';
import type { Model } from '../model/model.js';
import type { ModelProvider } from '../modelProvider.js';
import type { ModelProtocol } from '../transport/modelProtocol.js';
import {
  ANTHROPIC_MESSAGES,
  OPENAI_CHAT_COMPLETIONS,
  OPENAI_RESPONSES,
  GOOGLE_GEMINI,
} from '../transport/modelProtocol.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import { CustomModelProvider } from './customModelProvider.js';
import { CustomProviderConfig } from './customProviderConfig.js';
import type { ModelConfigStoreScope } from './modelConfigStore.js';

/** adapter 即 wire 形态：按 adapter 定协议，与 parser 的 protocol 解析一一对应。 */
const ADAPTER_PROTOCOLS: Record<
  CustomProviderRuntime['adapter'],
  ModelProtocol
> = {
  'openai-compatible': OPENAI_CHAT_COMPLETIONS,
  alibaba: OPENAI_CHAT_COMPLETIONS,
  'openai-responses': OPENAI_RESPONSES,
  'anthropic-compatible': ANTHROPIC_MESSAGES,
  gemini: GOOGLE_GEMINI,
};

/** 运行时模型投影成新栈 Model：source 归属 provider，key 带 providerId 前缀。 */
export function customModelFromRuntime(
  provider: Pick<CustomProviderRuntime, 'providerId'>,
  model: CustomProviderModelRuntime,
): Model {
  const thinking = model.capabilities.thinking;
  const reasoningSupported = thinking.modes.length > 0;
  return {
    source: provider.providerId,
    key: customProviderModelKey(provider.providerId, model.modelId),
    displayName: model.displayName,
    capabilities: {
      tools: model.capabilities.tools,
      vision: model.capabilities.vision,
      reasoning: {
        supported: reasoningSupported,
        // 'none' 在首位表示支持显式关闭思考；其余档位沿用配置声明。
        supportedEfforts: reasoningSupported
          ? ['none', ...thinking.supportedEffortLevels]
          : [],
      },
      contextWindows: [{ tokens: model.contextWindow }],
    },
    limits: {
      maxContextTokens: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    },
  };
}

/** CustomProviderRuntime → CustomProviderConfig：模型清单与 routing 表随投影带入。 */
export function customProviderConfigFromRuntime(
  provider: CustomProviderRuntime,
): CustomProviderConfig {
  return new CustomProviderConfig({
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authType: provider.authType,
    models: [...provider.models.values()].map((model) =>
      customModelFromRuntime(provider, model),
    ),
    protocol: ADAPTER_PROTOCOLS[provider.adapter],
    firstPayloadTimeoutMs: provider.timeouts.firstPayloadTimeoutMs,
    routing: provider.routing,
  });
}

/**
 * settings providers 块 → CustomModelProvider 列表。
 * 坏配置按条目降级为缺席并逐条 warn，不阻塞其余 provider 装配。
 */
export function createCustomModelProviders(
  providersSettings: unknown,
  transportManager: ModelTransportManager,
  settingsService: SettingsService,
  scope: ModelConfigStoreScope,
  cwd?: string,
): ModelProvider[] {
  // Account-owned ids are composed by their own provider classes, never here.
  const { providers, issues } = parseCustomProviderSettings(
    withoutReservedProviderSettings(providersSettings),
  );
  for (const issue of issues) {
    runLogger.warn(
      `[custom-provider] ${issue.providerId}${issue.field ? `.${issue.field}` : ''}: ${issue.message}`,
    );
  }
  return providers.map((runtime) => {
    const config = customProviderConfigFromRuntime(runtime);
    return new CustomModelProvider({
      transportManager,
      config,
      client: new CustomClientImpl({ customProviderConfig: config }),
      settingsService,
      scope,
      cwd,
    });
  });
}

/**
 * 共用工厂：若干份 settings 文件文本（按优先级排列，后者覆盖同 providerId）
 * → CustomModelProvider 列表。逐份取 providers 块浅合并后交给
 * createCustomModelProviders；文本缺失/块缺失/坏块按空处理。JSON 解析
 * 异常由调用方 try/catch 定归属 warn，这里直接抛。
 */
export function createCustomModelProvidersFromSettingsTexts(
  texts: ReadonlyArray<string | undefined | null>,
  transportManager: ModelTransportManager,
  settingsService: SettingsService,
  scope: ModelConfigStoreScope,
  cwd?: string,
): ModelProvider[] {
  return createCustomModelProviders(
    mergeProviderSettingsTexts(texts),
    transportManager,
    settingsService,
    scope,
    cwd,
  );
}

function mergeProviderSettingsTexts(
  texts: ReadonlyArray<string | undefined | null>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const text of texts) {
    if (!text) continue;
    const block = (
      JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''))) as {
        providers?: unknown;
      }
    )['providers'];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      Object.assign(merged, block);
    }
  }
  return merged;
}

/**
 * 项目级 CustomProviderConfig 读取：按会话 cwd 读 project + local 两档
 * settings 的 providers 块（local 覆盖 project），只返回配置，不创建实例。
 * 工作区是 home 目录时不读项目层；文件缺失/损坏/读取异常只 warn 留空，
 * 不在装配期抛错。
 */
export function loadProjectCustomProviderConfigs(
  settingsService: SettingsService,
  cwd = process.cwd(),
): CustomProviderConfig[] {
  try {
    const storage = new Storage(cwd);
    if (storage.isWorkspaceHomeDir()) return [];
    const sources = settingsService.getProjectSettingsSources(
      storage.getWorkspaceSettingsPath(),
      storage.getWorkspaceLocalSettingsPath(),
    );
    const { providers, issues } = parseCustomProviderSettings(
      withoutReservedProviderSettings(
        mergeProviderSettingsTexts([sources.project.read(), sources.local.read()]),
      ),
    );
    for (const issue of issues) {
      runLogger.warn(
        `[custom-provider] ${issue.providerId}${issue.field ? `.${issue.field}` : ''}: ${issue.message}`,
      );
    }
    return providers.map(customProviderConfigFromRuntime);
  } catch (error) {
    runLogger.warn(
      `[custom-model-provider] build project custom providers failed: ${error}`,
    );
    return [];
  }
}
