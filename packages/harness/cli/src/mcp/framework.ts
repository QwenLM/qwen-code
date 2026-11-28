/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Process-level MCP helpers shared by AppFramework and its product subclass.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  applyPluginConfigsToPlugins,
  createDefaultMcpConnectorMap,
  fileMcpSourceId,
  getVersionSync,
  mcpServerKey,
  McpManager,
  pluginMcpRegistrations,
  runLogger,
  Storage,
  toMcpPluginOwner,
  type EnvironmentSanitizationConfig,
  type MCPServerConfig,
  type McpServerKey,
  type McpServerRegistration,
  type PluginConfigsRoot,
  type PluginManagerFactory,
} from '@qwen-code/core';
import type { ResourceService } from '@qwen-code/resource';
import type { LoadedSettings } from '../config/settings.js';
import { createCorePluginManager } from '@qwen-code/core/plugin-management';

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function createMcpManagerSettings(
  settings: LoadedSettings,
): {
  readonly clientVersion: string;
  readonly sanitizationConfig: EnvironmentSanitizationConfig;
} {
  const redaction = settings.merged.security?.environmentVariableRedaction;
  return {
    clientVersion: getVersionSync() ?? 'unknown',
    sanitizationConfig: {
      allowedEnvironmentVariables: redaction?.allowed ?? [],
      blockedEnvironmentVariables: redaction?.blocked ?? [],
      enableEnvironmentVariableRedaction: redaction?.enabled ?? false,
    },
  };
}

/** Pool key for a user-level server: the realpath'd user settings file + name. */
export function userMcpServerKey(name: string): McpServerKey {
  const settingsPath = realpathOrSelf(Storage.getGlobalSettingsPath());
  return mcpServerKey(fileMcpSourceId(settingsPath), name);
}

/**
 * User-level servers the pool keeps warm for the process. Entries marked
 * `disabled` are skipped: no session uses them, so connecting them only costs
 * a process or socket. A server enabled later is picked up by the session that
 * registers it.
 */
export function collectUserMcpRegistrations(
  settings: LoadedSettings,
): McpServerRegistration[] {
  const userServers = settings.user.settings.mcpServers as
    | Record<string, MCPServerConfig>
    | undefined;
  if (!userServers) return [];
  const rootsDir = dirname(realpathOrSelf(Storage.getGlobalSettingsPath()));
  return Object.entries(userServers)
    .filter(([, config]) => config.disabled !== true)
    .map(([name, config]) => ({
      key: userMcpServerKey(name),
      config,
      rootsDir,
    }));
}

/**
 * MCP servers of the plugins enabled at user level, built by the same
 * `pluginMcpRegistrations` as `SessionMcpManager.startPlugin`, so a session
 * that later loads the same plugin with the same config shares the pooled
 * connection (and one with a different config gets its own).
 *
 * `userSettings` must hold the user scope only: project-scope plugins and
 * installs are not user-level and stay with the sessions that load them.
 * Product (enterprise) plugins are included unless
 * `skipAdditionalPlugins` says this process has no identity yet; loading never
 * starts sign-in. `factory` is the product's plugin manager factory, which is
 * what makes those plugins available at all. Throws when plugins cannot be
 * loaded.
 */
export interface UserPluginLoadOptions {
  readonly factory?: PluginManagerFactory;
  readonly skipAdditionalPlugins?: boolean;
}

export async function collectUserPluginMcpRegistrations(
  userSettings: LoadedSettings,
  options: UserPluginLoadOptions = {},
): Promise<McpServerRegistration[]> {
  const { plugins } = await createCorePluginManager(userSettings, {
    mergedSettings: userSettings.merged,
    ...(options.factory ? { factory: options.factory } : {}),
  }).loadUserPlugins({
    skipAdditionalPlugins: options.skipAdditionalPlugins,
  });
  applyPluginConfigsToPlugins(
    plugins,
    (userSettings.merged as { pluginConfigs?: PluginConfigsRoot })
      .pluginConfigs,
  );
  return plugins
    .filter((plugin) => plugin.enabled !== false && plugin.mcpServers)
    .flatMap((plugin) =>
      pluginMcpRegistrations(toMcpPluginOwner(plugin), plugin.path),
    );
}

/**
 * Everything a daemon keeps warm at user level: the user settings servers and
 * the MCP servers of user-level plugins. Undefined when plugins could not be
 * loaded — a caller syncing the pool must then skip the sync, or the plugin
 * servers would be released as if they had been removed.
 */
export async function collectDaemonUserMcpRegistrations(
  userSettings: LoadedSettings,
  options: UserPluginLoadOptions = {},
): Promise<McpServerRegistration[] | undefined> {
  try {
    return [
      ...collectUserMcpRegistrations(userSettings),
      ...(await collectUserPluginMcpRegistrations(userSettings, options)),
    ];
  } catch (error) {
    runLogger.warn('[mcp] loading user-level plugin MCP servers failed', error);
    return undefined;
  }
}

export function createDefaultFrameworkMcpManager(
  resourceService: ResourceService,
  clientVersion: string,
  debugMode: boolean,
  sanitizationConfig: EnvironmentSanitizationConfig,
): McpManager {
  return new McpManager(
    resourceService,
    createDefaultMcpConnectorMap(),
    clientVersion,
    debugMode,
    sanitizationConfig,
  );
}
