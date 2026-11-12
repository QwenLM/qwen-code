/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChatCompletionsTransport,
  MessagesTransport,
  ResponsesTransport,
  GeminiTransport,
  createCustomModelProvidersFromSettingsTexts,
  getDefaultAuthType,
  isQoderAccountRegion,
  QODER_ENV_ACCOUNT_REGION,
  resolveEffectiveAuthType,
  Storage,
  runLogger,
} from '@qwen-code/core';
import { AuthType } from '@qwen-code/resource';
import type { ResourceService } from '@qwen-code/resource';
import type {
  ModelProvider,
  McpManager,
  ModelTransportManager,
  QoderAccountRegion,
} from '@qwen-code/core';
import { initializeUserResources } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import type { AppPluginRegistry } from '../app-plugins/registry.js';
import type { SettingsService } from '@qwen-code/resource';
import {
  createQoderProviders,
  isQoderAccountConfigured,
  resolveConfiguredQoderRegion,
} from '../auth/qoderProviders.js';
import { createQwenSubscriptionProviders } from '../auth/subscriptionProviders.js';

export function createPublicTransports() {
  return [
    new ChatCompletionsTransport(),
    new MessagesTransport(),
    new ResponsesTransport(),
    new GeminiTransport(),
  ];
}
function resolveQoderProviderRegion(
  savedRegion?: string,
  env: NodeJS.ProcessEnv = process.env,
): QoderAccountRegion {
  const envRegion = env[QODER_ENV_ACCOUNT_REGION]?.trim().toLowerCase();
  if (isQoderAccountRegion(envRegion)) return envRegion;
  if (isQoderAccountRegion(savedRegion)) return savedRegion;
  return resolveConfiguredQoderRegion();
}

/**
 * 会话级 provider 贡献：每次调用新建一组实例，归调用方会话的 manager 启停。
 * 主模型在选模时由 manager 通过 context 传入，构造期不绑定会话查询。
 *
 * Qwen Account 由 settings.providers 里的保留条目组合而成（见订阅 provider 的
 * composer）；未登录时不生成，条目也不会列出不可用模型。
 *
 * Qoder provider 在认证类型为 `qoder-oauth` 或已存在 Qoder 账号时构造。
 */
export function createPublicProviders(
  settings: SettingsService,
  transports: ModelTransportManager,
  selectedAuthType?: AuthType | string,
  qoderRegion?: string,
): readonly ModelProvider[] {
  const providers: ModelProvider[] = [];
  try {
    const source = settings.peekUserSettingsSource(
      Storage.getGlobalSettingsPath(),
    );
    providers.push(
      ...createCustomModelProvidersFromSettingsTexts(
        [source?.read()],
        transports,
        settings,
        'user',
      ),
    );
  } catch (error) {
    runLogger.warn(
      `[app-framework] build user-level custom providers failed: ${error}`,
    );
  }
  try {
    providers.push(...createQwenSubscriptionProviders(settings, transports));
  } catch (error) {
    runLogger.warn(
      `[app-framework] build Qwen subscription provider failed: ${error}`,
    );
  }

  const effectiveAuthType = resolveEffectiveAuthType(selectedAuthType);
  // Register the Qoder provider for `qoder-oauth`, and also when a Qoder
  // account already exists while settings point at another provider, so an
  // existing login keeps contributing models to `/model`.
  const defaultQoderOAuth =
    getDefaultAuthType() === AuthType.QODER_OAUTH;
  const useQoderProvider =
    effectiveAuthType === AuthType.QODER_OAUTH ||
    (defaultQoderOAuth && isQoderAccountConfigured());
  if (useQoderProvider) {
    try {
      providers.push(
        ...createQoderProviders(
          settings,
          transports,
          resolveQoderProviderRegion(qoderRegion),
        ),
      );
    } catch (error) {
      runLogger.warn(
        `[app-framework] build Qoder OAuth providers failed: ${error}`,
      );
    }
  } else {
    runLogger.debug(
      `[app-framework] Qoder OAuth provider skipped (authType=${effectiveAuthType})`,
    );
  }
  return providers;
}
/** Every release is attempted; callers list dependencies in their own shutdown order. */
export async function disposeInOrder(
  actions: Array<() => unknown | Promise<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Framework disposal failed');
}

/** Initialization helpers own partial-failure cleanup, not entry selection or state. */
export async function initializeResources(
  resource: ResourceService,
  settings: LoadedSettings,
  signal: AbortSignal,
  snapshot: boolean,
): Promise<ResourceService> {
  try {
    if (snapshot) await initializeUserResources(resource, settings);
    signal.throwIfAborted();
    return resource;
  } catch (error) {
    try {
      await resource.dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Resource initialization and cleanup failed',
      );
    }
    throw error;
  }
}
export async function initializePlugins(
  registry: AppPluginRegistry,
  signal: AbortSignal,
): Promise<AppPluginRegistry> {
  try {
    await registry.initialize();
    signal.throwIfAborted();
    return registry;
  } catch (error) {
    try {
      await registry.dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Plugin initialization and cleanup failed',
      );
    }
    throw error;
  }
}
export async function initializeMcp(
  manager: McpManager,
  input: Parameters<McpManager['init']>[0],
): Promise<McpManager> {
  try {
    await manager.init(input);
    return manager;
  } catch (error) {
    try {
      await manager.dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'MCP initialization and cleanup failed',
      );
    }
    throw error;
  }
}

