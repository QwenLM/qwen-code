/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDefaultPluginManager,
  prepareWindowsEnvironment,
  HookSystem,
  setShellIfWindows,
  startupProfiler,
  traceStartupStepAsync,
  type Config,
  type HookRunner,
  type PermissionManager,
  type PluginManager,
  type PluginManagerFactory,
  type PluginManagerHost,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';
import type { AppPluginRegistry } from '../app-plugins/registry.js';
import type { AsyncInitializer } from './asyncInitializer.js';
import type { SessionHandle, SessionSettings } from '../session/session.js';
import type { CliArgs } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import type { WorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
import {
  setCliSettingsServiceFactory,
  type SettingsServiceFactory,
} from '../config/createCliSettingsService.js';

/** Each entry owns its resource preparation and shutdown order. */
export abstract class AppFramework {
  /** Install product Settings before the entry creates its first service. */
  static setSettingsServiceFactory(
    factory: SettingsServiceFactory,
  ): () => void {
    return setCliSettingsServiceFactory(factory);
  }

  /** The entry's Settings；进程级权限管理器从它读规则与设置。 */
  abstract readonly settingsService: SettingsService;

  appPlugins?: AsyncInitializer<AppPluginRegistry>;
  permissionManager?: AsyncInitializer<PermissionManager>;

  private stopBackgroundPreparation?: () => Promise<void>;
  private restoreHookRunner?: () => void;

  /** Registers background work; products may override the download sources. */
  protected readonly prepareEnvironment: (
    signal: AbortSignal,
  ) => Promise<() => Promise<void>> = (signal) =>
    prepareWindowsEnvironment(signal);

  protected initializeRuntime(
    signal: AbortSignal,
    { argv, createHookRunner }: FrameworkInitInput,
    initialize: () => Promise<void>,
  ): Promise<void> {
    if (createHookRunner) {
      this.restoreHookRunner = HookSystem.setRunnerFactory(createHookRunner);
    }
    if (process.platform !== 'win32' || argv.bare) return initialize();
    return this.prepareWindowsShell(signal).then(initialize);
  }

  private async prepareWindowsShell(signal: AbortSignal): Promise<void> {
    const setupShell = startupProfiler.start('setup_shell');
    try {
      await traceStartupStepAsync('framework.setup_shell', async () => {
        this.stopBackgroundPreparation =
          await this.prepareEnvironment(signal);
        signal.throwIfAborted();
        await setShellIfWindows();
      });
    } finally {
      setupShell?.end();
    }
  }

  protected async disposeRuntimePreparation(): Promise<void> {
    try {
      await this.stopBackgroundPreparation?.();
    } finally {
      this.restoreHookRunner?.();
    }
  }

  readonly pluginManagerFactory: PluginManagerFactory = (host) =>
    this.createPluginManager(host);

  createPluginManager(host: PluginManagerHost): PluginManager {
    return createDefaultPluginManager(host);
  }

  abstract init(): Promise<void>;
  abstract dispose(): Promise<void>;
  /** Product handoff only. Ordinary local TUI keeps its existing creation path. */
  async prepareSession(_fallbackSettings: SessionSettings): Promise<SessionHandle | undefined> {
    return undefined;
  }
}

export interface FrameworkInitInput {
  argv: CliArgs;
  settings: LoadedSettings;
  /** Product factory for new session hook runners. */
  createHookRunner?: (config: Config) => HookRunner;
  /** 入口已确定的会话工作目录；会话打开时用它声明 cwd，不再回读入口 Config。 */
  workspaceRoot?: string;
  /** 启动期继承到的 Worktree 请求；入口只做传递，由会话在 Writer 就绪后处理。 */
  inheritedWorktreeRequest?: WorktreeStartupRequest;
  /** 短操作在发起时就确定需要的节点，action 不再补启动。 */
  command?: 'local' | 'resources' | 'auth' | 'client' | 'plugins';
}
export type FrameworkMode =
  | 'tui'
  | 'headless'
  | 'sdk'
  | 'acp'
  | 'daemon'
  | 'remoteWorker'
  | 'command';
