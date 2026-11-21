/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP 认证策略协调器。
 *
 * 将不同认证方式（Qwen Subscription / Qoder OAuth）的协议声明、设备码登录、
 * 设置持久化与会话级 Provider 注册从 `AcpServer` 的协议路由层解耦出来，
 * 新增认证方式只需追加策略实现，无需修改 `AcpServer` 分派逻辑。
 */

import * as acp from '@agentclientprotocol/sdk';
import {
  AuthType,
  getQwenSubscriptionAuthorizationUrl,
  getQwenSubscriptionPlansUrl,
  isPaidQwenSubscriptionPlan,
  qwenSubscriptionModelKey,
  selectQwenSubscriptionModel,
  type Config,
  type ModelProvider,
  type ModelTransportManager,
  type QoderAccountRegion,
  type QwenSubscriptionSession,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';
import {
  createQoderProviders,
  resolveConfiguredQoderRegion,
} from '../auth/qoderProviders.js';
import { createQwenSubscriptionProvider } from '../auth/subscriptionProviders.js';
import { SettingScope, type LoadedSettings } from '../config/settings.js';

export type AccountProviderFactory = (
  settingsService: SettingsService,
  transportManager: ModelTransportManager,
) => readonly ModelProvider[];

export interface QoderDeviceLoginHandle {
  readonly authUrl: string;
  readonly completion: Promise<unknown>;
}

export interface AcpAuthRuntimeDeps {
  readonly createSubscriptionSession: () => QwenSubscriptionSession;
  readonly startQoderDeviceLogin: (
    region: QoderAccountRegion,
  ) => QoderDeviceLoginHandle;
  readonly notifyAuthUri: (authUri: string) => void;
  readonly getAuthMethods: () => readonly acp.AuthMethod[];
  readonly settings: LoadedSettings | undefined;
}

export interface AcpAuthStrategy {
  readonly methods: readonly acp.AuthMethod[];
  resolveKey(methodId: string): string | undefined;
  authenticate(
    methodId: string,
    deps: AcpAuthRuntimeDeps,
  ): Promise<AccountProviderFactory>;
}

class QwenSubscriptionAuthStrategy implements AcpAuthStrategy {
  readonly methods: readonly acp.AuthMethod[] = [
    {
      id: AuthType.QWEN_SUBSCRIPTION,
      name: 'Sign in with Qwen',
      description:
        'Sign in with your Qwen subscription account in the browser',
    },
  ];

  resolveKey(methodId: string): string | undefined {
    return methodId === AuthType.QWEN_SUBSCRIPTION ? methodId : undefined;
  }

  async authenticate(
    _methodId: string,
    deps: AcpAuthRuntimeDeps,
  ): Promise<AccountProviderFactory> {
    const session = deps.createSubscriptionSession();
    const info = await session.signIn((device) => {
      deps.notifyAuthUri(getQwenSubscriptionAuthorizationUrl(device, 'cli'));
    });
    if (!isPaidQwenSubscriptionPlan(info.member_type)) {
      throw acp.RequestError.authRequired(
        { authMethods: deps.getAuthMethods() },
        `An active Qwen subscription is required. Visit ${getQwenSubscriptionPlansUrl('cli')}`,
      );
    }
    const { models } = await session.getModels();
    deps.settings?.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QWEN_SUBSCRIPTION,
    );
    const defaultModel = selectQwenSubscriptionModel(models);
    if (defaultModel) {
      const currentSettingModel = deps.settings?.merged?.model?.name;
      if (!currentSettingModel || currentSettingModel === 'auto') {
        deps.settings?.setValue(
          SettingScope.User,
          'model.name',
          qwenSubscriptionModelKey(defaultModel),
        );
      }
    }
    return (settingsService, transportManager) => [
      createQwenSubscriptionProvider(settingsService, transportManager, session),
    ];
  }
}

class QoderOAuthStrategy implements AcpAuthStrategy {
  readonly methods: readonly acp.AuthMethod[] = [
    {
      id: `${AuthType.QODER_OAUTH}:global`,
      name: 'Sign in with Qoder (International)',
      description: 'Sign in with a Qoder account on qoder.com',
    },
    {
      id: `${AuthType.QODER_OAUTH}:cn`,
      name: 'Sign in with Qoder (China)',
      description: 'Sign in with a Qoder account on qoder.cn',
    },
  ];

  resolveKey(methodId: string): string | undefined {
    const region = this.parseRegion(methodId);
    return region ? `${AuthType.QODER_OAUTH}:${region}` : undefined;
  }

  async authenticate(
    methodId: string,
    deps: AcpAuthRuntimeDeps,
  ): Promise<AccountProviderFactory> {
    const region = this.parseRegion(methodId);
    if (!region) {
      throw new acp.RequestError(-32602, `Unknown auth method: ${methodId}`);
    }
    const handle = deps.startQoderDeviceLogin(region);
    deps.notifyAuthUri(handle.authUrl);
    await handle.completion;
    deps.settings?.setValue(
      SettingScope.User,
      'security.auth.qoderRegion',
      region,
    );
    deps.settings?.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QODER_OAUTH,
    );
    return (settingsService, transportManager) =>
      createQoderProviders(settingsService, transportManager, region);
  }

  private parseRegion(methodId: string): QoderAccountRegion | undefined {
    if (methodId === AuthType.QODER_OAUTH) {
      return resolveConfiguredQoderRegion();
    }
    if (methodId === `${AuthType.QODER_OAUTH}:global`) {
      return 'global';
    }
    if (methodId === `${AuthType.QODER_OAUTH}:cn`) {
      return 'cn';
    }
    return undefined;
  }
}

export async function registerAccountProvidersOnConfig(
  config: Config,
  createProviders: AccountProviderFactory,
): Promise<boolean> {
  const manager = config.getModelProviderManager?.();
  const settingsService = config.getSettingsService?.();
  const transportManager = config.getModelTransportManager?.();
  if (
    !manager?.registerAccountProvider ||
    !settingsService ||
    !transportManager
  ) {
    return false;
  }
  for (const provider of createProviders(settingsService, transportManager)) {
    await manager.registerAccountProvider(provider);
  }
  return true;
}

export async function hasUsableSessionModels(config: Config): Promise<boolean> {
  if (config.hasModelProviderManager?.() === false) {
    return false;
  }
  const manager = config.getModelProviderManager?.();
  if (!manager?.listModels) {
    return true;
  }
  try {
    const models = await manager.listModels();
    return models.length > 0;
  } catch {
    return false;
  }
}

export class AcpAuthCoordinator {
  private readonly strategies: readonly AcpAuthStrategy[];
  private readonly pendingAuth = new Map<string, Promise<void>>();

  constructor(
    strategies: readonly AcpAuthStrategy[] = [
      new QwenSubscriptionAuthStrategy(),
      new QoderOAuthStrategy(),
    ],
  ) {
    this.strategies = strategies;
  }

  buildAuthMethods(): acp.AuthMethod[] {
    return this.strategies.flatMap((strategy) => [...strategy.methods]);
  }

  authenticate(
    methodId: string,
    deps: AcpAuthRuntimeDeps,
    onAuthenticated: (factory: AccountProviderFactory) => Promise<void>,
  ): Promise<void> {
    for (const strategy of this.strategies) {
      const key = strategy.resolveKey(methodId);
      if (key === undefined) {
        continue;
      }
      return this.dedupe(key, async () => {
        const providerFactory = await strategy.authenticate(methodId, deps);
        await onAuthenticated(providerFactory);
      });
    }
    throw new acp.RequestError(-32602, `Unknown auth method: ${methodId}`);
  }

  private dedupe(key: string, action: () => Promise<void>): Promise<void> {
    let pending = this.pendingAuth.get(key);
    if (!pending) {
      pending = action().finally(() => {
        if (this.pendingAuth.get(key) === pending) {
          this.pendingAuth.delete(key);
        }
      });
      this.pendingAuth.set(key, pending);
    }
    return pending;
  }
}
