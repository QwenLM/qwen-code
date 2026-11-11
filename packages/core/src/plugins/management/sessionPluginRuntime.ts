/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings, MergedSettings } from '@qwen-code/resource';
import {
  applyPluginConfigsToPlugins,
  type PluginConfigsRoot,
} from '../configuration/pluginConfigSubstitution.js';
import { invalidateInstalledPluginsCache } from './installedPluginsManager.js';
import type {
  PluginManagerFactory,
  PluginSessionLoadResult,
} from './pluginManager.js';
import { createCorePluginManager } from './pluginManagerSettings.js';

export interface SessionPluginRuntime extends PluginSessionLoadResult {
  reload(): Promise<PluginSessionLoadResult>;
}

export async function loadSessionPluginRuntime(
  settings: LoadedSettings,
  options: {
    cwd: string;
    initialSettings: MergedSettings;
    factory?: PluginManagerFactory;
    pluginDirs?: string[];
    skipAdditionalPlugins: boolean;
  },
): Promise<SessionPluginRuntime> {
  const { cwd, initialSettings, factory, pluginDirs, skipAdditionalPlugins } =
    options;
  const manager = createCorePluginManager(settings, { cwd, factory });
  const initial = await manager.loadSessionPlugins({
    pluginDirs,
    skipAdditionalPlugins,
  });
  applyPluginConfigsToPlugins(
    initial.plugins,
    (initialSettings as { pluginConfigs?: PluginConfigsRoot }).pluginConfigs,
    manager.getMcpConfigStringFields(),
  );

  return {
    ...initial,
    async reload() {
      invalidateInstalledPluginsCache();
      // Read edits from other processes while preserving invocation flags.
      settings.reload();
      const { pluginConfigs } = settings.merged as {
        pluginConfigs?: PluginConfigsRoot;
      };
      const result = await manager.loadSessionPlugins({
        pluginDirs,
        collectPluginDirFailure: true,
      });
      applyPluginConfigsToPlugins(
        result.plugins,
        pluginConfigs,
        manager.getMcpConfigStringFields(),
      );
      return result;
    },
  };
}
