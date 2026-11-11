/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncInitializer } from './asyncInitializer.js';
import { AppFramework, type FrameworkInitInput } from './appFramework.js';
import {
  ResourceService,
  type SettingsService,
} from '@qwen-code/resource';
import {
  EnvConfigService,
  DefaultI18nService,
  installI18nService,
  initializeI18nService,
  resetI18nService,
  getI18nService as installedI18nService,
  type I18nService,
  ModelTransportManager,
  CustomProviderManager,
  Storage,
  installConfigService,
  initializeConfigService,
  stopConfigService,
  getConfigService as installedConfigService,
  raceWithAbortSignal,
  type ConfigParameters,
  type ConfigService,
  type ModelProvider,
  type ModelTransport,
  type McpManager,
  ProxyInstance,
} from '@qwen-code/core';
import { getSettingsResolveOptions } from '../config/settings.js';
import { AppPluginRegistry } from '../app-plugins/registry.js';
import type { AppPlugin } from '../app-plugins/types.js';
import { QwenInstallationPlugin } from '../installation/plugin.js';
import { AuthPlugin } from '../auth/authPlugin.js';
import {
  createDefaultFrameworkMcpManager,
  createMcpManagerSettings,
  collectUserMcpRegistrations,
} from '../mcp/framework.js';
import {
  createPublicTransports,
  createPublicProviders,
  disposeInOrder,
  initializeResources,
  initializePlugins,
  initializeMcp,
} from './resourceInitialization.js';

export class CommandAppFramework extends AppFramework {
  readonly mode = 'command' as const;
  resources?: AsyncInitializer<ResourceService>;
  configService?: AsyncInitializer<ConfigService>;
  i18nService?: AsyncInitializer<I18nService>;
  mcpManager?: AsyncInitializer<McpManager>;
  modelTransportManager?: AsyncInitializer<ModelTransportManager>;
  customProviderManager?: AsyncInitializer<CustomProviderManager>;
  proxyInstance?: AsyncInitializer<ProxyInstance>;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  protected disposed = false;
  constructor(
    readonly signal: AbortSignal,
    readonly settingsService: SettingsService,
    readonly input: FrameworkInitInput,
  ) {
    super();
  }

  init(): Promise<void> {
    this.assertStarting();
    this.initialization ??= super.initializeRuntime(
      this.signal,
      this.input,
      () => this.initialize(),
    );
    void this.initialization.catch(() => {});
    return this.initialization;
  }
  private async initialize(): Promise<void> {
    this.assertStarting();
    await this.prepareResources();
    this.assertStarting();
    await this.prepareI18nService();
    this.assertStarting();
    if (this.input.command === 'local') this.startI18nService();
    if (this.input.command === 'plugins') this.startPlugins();
    if (this.input.command === 'plugins' || this.input.command === 'client')
      this.startConfigService();
  }
  protected async prepareResources(): Promise<void> {
    this.settingsService.getUserSettingsSource(Storage.getGlobalSettingsPath());
    this.proxyInstance ??= new AsyncInitializer<ProxyInstance>({
      create: () =>
        new ProxyInstance({ settingsService: this.settingsService }),
      dispose: async () => {},
    });
    this.resources ??= new AsyncInitializer({
      create: () =>
        initializeResources(
          this.createResourceService(),
          this.input.settings,
          this.signal,
          !this.input.argv.bare &&
            (this.input.command === 'resources' ||
              this.input.command === 'plugins'),
        ),
      dispose: (resource) => resource.dispose(),
    });
    await this.resources.whenReady();
    await this.proxyInstance.whenReady();
    this.assertStarting();
    this.modelTransportManager ??= new AsyncInitializer({
      create: () => new ModelTransportManager(this.createModelTransports()),
      dispose: async () => {},
    });
    await this.modelTransportManager.whenReady();
    this.assertStarting();
    this.customProviderManager ??= new AsyncInitializer({
      create: () => new CustomProviderManager(this.settingsService),
      dispose: async () => {},
    });
    await this.customProviderManager.whenReady();
    // The source must be available to Client/login before identity-dependent start.
    this.configService ??= new AsyncInitializer({
      create: () => this.createConfigService(),
      dispose: (source) =>
        installedConfigService() === source
          ? stopConfigService()
          : source.stop(),
    });
    await this.configService.whenReady();
  }
  // Product services may depend on resources prepared by the derived Framework.
  protected async prepareI18nService(): Promise<void> {
    this.i18nService ??= new AsyncInitializer({
      create: () => this.createI18nService(),
      dispose: (service) => {
        if (installedI18nService() === service) resetI18nService();
        else service.dispose();
      },
    });
    await this.i18nService.whenReady();
  }
  protected createResourceService(): ResourceService {
    return new ResourceService();
  }
  protected createI18nService(): I18nService {
    return new DefaultI18nService();
  }
  protected startI18nService(): void {
    installI18nService(this.i18nService!.get());
    initializeI18nService();
  }
  protected createConfigService(): ConfigService | Promise<ConfigService> {
    return new EnvConfigService();
  }
  protected createModelTransports(): readonly ModelTransport[] {
    return createPublicTransports();
  }
  /**
   * 会话级 provider 贡献钩子：每次调用都新建一组实例，归调用方会话的 manager
   * 启停。公共层贡献 user scope settings 解析的 CustomModelProvider；产品子类
   * 覆写时追加自己的 provider。
   */
  protected createModelProviders(): readonly ModelProvider[] {
    return createPublicProviders(
      this.settingsService,
      this.modelTransportManager!.get(),
      this.input.settings.merged.security?.auth?.selectedType,
      this.input.settings.merged.security?.auth?.qoderRegion,
    );
  }
  /** 会话装配点的取用面：只交出工厂，实例在会话 Config 构造时才建。 */
  getModelProviderFactory(): NonNullable<
    ConfigParameters['modelProviderFactory']
  > {
    return () => this.createModelProviders();
  }
  protected createAppPlugins(): readonly AppPlugin[] {
    return [new QwenInstallationPlugin(), new AuthPlugin()];
  }
  protected isLocalSession(): boolean {
    return false;
  }
  startPlugins(): AsyncInitializer<AppPluginRegistry> {
    this.assertStarting();
    this.appPlugins ??= new AsyncInitializer({
      create: async () => {
        const registry = new AppPluginRegistry(this.createAppPlugins(), {
          signal: this.signal,
          mode: 'headless',
          localSession: this.isLocalSession(),
          getLaunchSetting: (section) =>
            (
              this.input.settings.flag.originalSettings as
                | Record<string, unknown>
                | undefined
            )?.[section],
          isSettingSourceAllowed: (source) =>
            this.input.argv.settingSources?.includes(source) ?? true,
          runtime: {
            prepare: (path) => this.prepareCommandWorkspace(path),
            getSetting: async (path, section) =>
              (
                this.settingsService.resolve(getSettingsResolveOptions(path))
                  .merged as unknown as Record<string, unknown>
              )[section],
          },
        });
        return initializePlugins(registry, this.signal);
      },
      dispose: (registry) => registry.dispose(),
    });
    return this.appPlugins;
  }
  protected async prepareCommandWorkspace(_path: string): Promise<void> {
    this.assertStarting();
  }
  protected startConfigService(): void {
    this.startI18nService();
    installConfigService(this.configService!.get());
    void this.whenConfigReady().catch(() => {});
  }
  whenConfigReady(): Promise<void> {
    return raceWithAbortSignal(initializeConfigService(), this.signal);
  }
  protected createMcpManager(): McpManager {
    const settings = createMcpManagerSettings(this.input.settings);
    return createDefaultFrameworkMcpManager(
      this.resources!.get(),
      settings.clientVersion,
      this.input.argv.debug === true,
      settings.sanitizationConfig,
    );
  }
  // Commands such as remote-control request MCP only when they actually use it.
  startMcp(): AsyncInitializer<McpManager> {
    this.assertStarting();
    return (this.mcpManager ??= new AsyncInitializer({
      create: async () => {
        await this.resources!.whenReady();
        await this.appPlugins!.whenReady();
        this.assertStarting();
        const manager = this.createMcpManager();
        return initializeMcp(manager, {
          userServers: collectUserMcpRegistrations(this.input.settings),
          signal: this.signal,
        });
      },
      dispose: (manager) => manager.dispose(),
    }));
  }
  protected assertStarting(): void {
    if (this.disposed) throw new Error('Framework is disposed');
    this.signal.throwIfAborted();
  }
  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= Promise.resolve().then(async () => {
      await this.initialization?.catch(() => {});
      await disposeInOrder([
        () => this.disposeResources(),
        () => this.disposeRuntimePreparation(),
      ]);
    });
    void this.disposal.catch(() => {});
    return this.disposal;
  }
  protected disposeResources(): Promise<void> {
    return disposeInOrder([
      () => this.mcpManager?.dispose(),
      () => this.permissionManager?.dispose(),
      () => this.appPlugins?.dispose(),
      () => this.i18nService?.dispose(),
      () => this.configService?.dispose(),
      () => this.customProviderManager?.dispose(),
      () => this.modelTransportManager?.dispose(),
      () => this.resources?.dispose(),
      () => this.proxyInstance?.dispose(),
    ]);
  }
}
