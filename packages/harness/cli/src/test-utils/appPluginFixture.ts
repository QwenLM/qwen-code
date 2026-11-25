/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { vi } from 'vitest';
import type { BuiltinPluginContext } from '@qwen-code/core';
import { AppPluginRegistry } from '../app-plugins/registry.js';
import type { AppPlugin } from '../app-plugins/types.js';

/** 每个测试文件显式拥有自己的 Registry，不依赖生产代码的全局状态。 */
export function createAppPluginFixture(ready = false) {
  let context: Partial<BuiltinPluginContext> = {};
  let registry: AppPluginRegistry;
  const registerAppPlugins = (plugins: readonly AppPlugin[]) => {
    registry = new AppPluginRegistry(plugins, {
      get mode() {
        return context.mode ?? 'interactive';
      },
      isSettingSourceAllowed: (source) =>
        context.isSettingSourceAllowed?.(source) ?? true,
      getLaunchSetting: (section) => context.getLaunchSetting?.(section),
      runtime: {
        prepare: async (workspace) => {
          await context.runtime?.prepare(workspace);
        },
        getSetting: async (workspace, section) =>
          context.runtime?.getSetting(workspace, section),
      },
    });
    if (ready) vi.spyOn(registry, 'isReady').mockReturnValue(true);
  };
  registerAppPlugins([]);
  return {
    registerAppPlugins,
    getAppPluginRegistry: () => registry,
    initializeAppPlugins: async (value: Partial<BuiltinPluginContext>) => {
      context = value;
      await registry.initialize();
    },
    disposeAppPlugins: () => registry.dispose(),
    getAppPluginTools: () => registry.getTools(),
    getAppPluginSlashCommands: () =>
      registry.getAppPluginSlashCommands(),
    getAppPluginPromptSuggestionContributions: () =>
      registry.getAppPluginPromptSuggestionContributions(),
    getAppPluginRootOptions: () => registry.getAppPluginRootOptions(),
    getAppPluginTerminalCommands: () =>
      registry.getAppPluginTerminalCommands(),
  };
}
