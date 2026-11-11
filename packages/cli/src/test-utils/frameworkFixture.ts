/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { PermissionManager } from '@qwen-code/core';
import { TuiAppFramework } from '../framework/tuiAppFramework.js';
import { AsyncInitializer } from '../framework/asyncInitializer.js';
import { ThreadManager } from '../thread-manager/threadManager.js';
import { SdkServer, type SdkServerParams } from '../sdk/sdkServer.js';
import { AcpServer, type AcpServerParams } from '../acp/acpServer.js';
import type {
  FrameworkInitInput,
  FrameworkMode,
} from '../framework/appFramework.js';
import { createCliSettingsService } from '../config/createCliSettingsService.js';
import { createMockSettings } from './mockConfig.js';

/** Legacy test adapter only. Production entries never own Settings or change modes. */
export class FrameworkFixture extends TuiAppFramework {
  declare input: FrameworkInitInput;
  threadManager?: AsyncInitializer<ThreadManager>;
  private prepared?: Promise<void>;
  private initialized?: Promise<void>;
  constructor(
    signal: AbortSignal,
    settings = createCliSettingsService({ environmentPolicy: 'session' }),
    input: FrameworkInitInput = {
      argv: {} as FrameworkInitInput['argv'],
      settings: createMockSettings(),
    },
    mode: FrameworkMode = 'tui',
  ) {
    super(signal, settings, input);
    Object.defineProperty(this, 'mode', { value: mode, writable: true });
  }
  override init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.initForMain();
      this.startMode(this.mode, this.input);
      await this.threadManager?.whenCreated();
    })();
    void this.initialized.catch(() => {});
    return this.initialized;
  }
  initForMain() {
    return (this.prepared ??= (async () => {
      await this.prepareResources();
      await this.prepareI18nService();
    })());
  }
  async start(mode: FrameworkMode, input: FrameworkInitInput) {
    await this.initForMain();
    this.startMode(mode, input);
    return this;
  }
  private startMode(mode: FrameworkMode, input: FrameworkInitInput) {
    this.input = input;
    Object.defineProperty(this, 'mode', { value: mode, writable: true });
    if (input.argv.bare && (mode === 'sdk' || mode === 'headless')) return;
    // 与产品框架一致：命令态不建进程级权限管理器。
    if (mode !== 'command') {
      this.permissionManager ??= new AsyncInitializer({
        create: () => new PermissionManager(this.settingsService),
        init: (manager) => manager.initialize(),
        dispose: (manager) => manager.dispose(),
      });
    }
    if (mode !== 'command' || input.command === 'plugins') this.startPlugins();
    if (
      mode !== 'command' ||
      input.command === 'client' ||
      input.command === 'plugins'
    )
      this.startConfigService();
    if (mode !== 'command') this.startMcp();
    if (mode === 'acp' || mode === 'daemon') {
      this.threadManager ??= new AsyncInitializer({
        create: async () => {
          await this.appPlugins!.whenReady();
          await this.mcpManager!.whenReady();
          return new ThreadManager({
            resourceService: this.resources!.get(),
            settingsService: this.settingsService,
            permissionManager: await this.permissionManager!.whenReady(),
            modelProviderFactory: this.getModelProviderFactory(),
            modelTransportManager: this.modelTransportManager!.get(),
            mcpManager: this.mcpManager!.get(),
          });
        },
        init: (manager, signal) =>
          manager.initializeRuntime({
            builtinPlugins: this.appPlugins!.get(),
            signal: AbortSignal.any([this.signal, signal]),
          }),
        dispose: (manager) => manager.shutdown(),
      });
    }
  }
  createSdkServer(params: SdkServerParams): SdkServer | Promise<SdkServer> {
    return new SdkServer(params);
  }
  createAcpServer(params: AcpServerParams) {
    return new AcpServer(params);
  }
  getSettingsService() {
    return this.settingsService;
  }
  getAppPlugins() {
    return this.appPlugins!.get();
  }
  awaitInitAppPlugins() {
    return this.appPlugins!.whenReady();
  }
  awaitDisposeAppPlugins() {
    return this.appPlugins?.dispose() ?? Promise.resolve();
  }
  getCliDisplayName() {
    return this.displayName;
  }
  awaitDispose() {
    return this.dispose();
  }
  initForTUI(input: FrameworkInitInput) {
    this.startMode('tui', input);
  }
  initForACP(input: FrameworkInitInput) {
    this.startMode('acp', input);
  }
  initForSDK(input: FrameworkInitInput) {
    this.startMode('sdk', input);
  }
  initForHeadless(input: FrameworkInitInput) {
    this.startMode('headless', input);
  }
  initForDaemon(input: FrameworkInitInput) {
    this.startMode('daemon', input);
  }
  initForRemoteWorker(input: FrameworkInitInput) {
    this.startMode('remoteWorker', input);
  }
  initForCommand(input: FrameworkInitInput) {
    this.startMode('command', input);
  }
  protected override async disposeResources() {
    try {
      await this.threadManager?.dispose();
    } finally {
      try {
        await super.disposeResources();
      } finally {
        await this.settingsService.dispose();
      }
    }
  }
}
