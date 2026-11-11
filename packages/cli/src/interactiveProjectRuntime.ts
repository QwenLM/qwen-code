/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import type { Config, SessionResumeData } from '@qwen-code/core';
import { loadCliConfig, type CliArgs } from './config/config.js';
import { applyEnvironmentDefaults } from './config/cliEnvironment.js';
import { enableInteractiveConfigFeatures } from './startup/interactiveConfig.js';
import {
  clearSettingsCache,
  getSettingsResolveOptions,
  restoreLoadedEnvironment,
  type LoadedSettings,
} from './config/settings.js';
import { validateTheme } from './core/theme.js';

export interface InteractiveProjectRuntime {
  config: Config;
  settings: LoadedSettings;
  themeError: string | null;
}

export type RebuildInteractiveProject = (
  current: Config,
  data: SessionResumeData,
) => Promise<InteractiveProjectRuntime>;

function getResumeResourceRoot(
  config: Config,
  data: SessionResumeData,
): string {
  return path.resolve(
    data.worktreeSession?.originalCwd ??
      data.originalCwd ??
      data.transcriptProjectRoot ??
      config.storage.getProjectRoot(),
  );
}

export function needsProjectRebuild(
  config: Config,
  data: SessionResumeData,
): boolean {
  return (
    getResumeResourceRoot(config, data) !==
    path.resolve(config.storage.getProjectRoot())
  );
}

/** 仅重建本地 TUI 的项目对象，不重跑进程启动、路由或终端初始化。 */
export async function rebuildInteractiveProject(
  current: Config,
  data: SessionResumeData,
  argv: CliArgs,
): Promise<InteractiveProjectRuntime> {
  const cwd = getResumeResourceRoot(current, data);
  // transports 挂在 framework 上而旧 Config 持有引用；dispose 前先取出供新 Config 复用。
  const modelTransportManager = current.getModelTransportManager?.();
  const customProviderManager = current.getCustomProviderManager();
  const mcpInitializationWaitStrategy =
    current.getMcpInitializationWaitStrategy();
  // Ink 的终端模式属于进程，Resume 只重建项目对象，不切换已建立的终端协议。
  const screenReader = current.getScreenReader();
  const alternateBuffer = current.getUseAlternateBuffer();
  await current.dispose();
  restoreLoadedEnvironment();
  clearSettingsCache();
  let config: Config | undefined;
  try {
    process.chdir(cwd);
    const settings = current
      .getSettingsService()
      .resolve(getSettingsResolveOptions(cwd));
    const projectArgs: CliArgs & Record<string, unknown> = { ...argv };
    // 仅撤销旧环境展开的值，显式 CLI 参数仍优先于目标项目环境。
    for (const name of argv.environmentOptionNames ?? []) {
      delete projectArgs[name];
    }
    // Resume 的项目目录、会话名称和身份由已选会话决定，不重新展开环境默认值。
    projectArgs.environmentOptionNames = applyEnvironmentDefaults(projectArgs, [
      'cwd',
      'name',
      'sessionId',
    ]);
    config = await loadCliConfig(
      settings,
      data.sessionId,
      {
        ...projectArgs,
        cwd,
        resume: undefined,
        continue: undefined,
        forkSession: undefined,
        worktree: undefined,
        name: undefined,
        screenReader,
        alternateBuffer,
      },
      {
        cwd,
        projectHooks: settings.project.settings.hooks,
        localHooks: settings.local.settings.hooks,
        userHooks: settings.user.settings.hooks,
        flagHooks: settings.flag.settings.hooks,
        mcpInitializationWaitStrategy,
        // 复用当前 Config 的进程级 ResourceService，重建后仍与同进程其他会话共享同一实例。
        resourceService: current.getResourceService(),
        pluginManagerFactory: current.getPluginManagerFactory(),
        settingsService: current.getSettingsService(),
        builtinPlugins: current.getBuiltinPluginContributions(),
        builtinPluginsInitialization: current.getBuiltinPluginsInitialization(),
        // 复用装配工厂，新 Config 创建独立 provider、偏好存储和主模型锚点。
        modelProviderFactory: current.getModelProviderFactory(),
        permissionManager: current.getProcessPermissionManager()!,
        modelTransportManager,
        customProviderManager,
      },
    );
    await config.storage.initialize();
    await enableInteractiveConfigFeatures(config, { localSession: true });
    const themeError = validateTheme(settings);
    // 完整初始化仍由挂载后的 TUI 执行，此时权限队列和错误展示已经可用。
    return { config, settings, themeError };
  } catch (error) {
    try {
      await config?.dispose();
    } finally {
      restoreLoadedEnvironment();
      clearSettingsCache();
    }
    throw error;
  }
}
