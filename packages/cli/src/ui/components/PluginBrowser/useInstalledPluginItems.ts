/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  loadInstalledPluginsFromDisk,
  type LoadedPlugin,
  type PluginError,
} from '@qwen-code/core';
import { createCorePluginManager } from '@qwen-code/core/plugin-management';
import type { ManagePluginsProps } from './ManagePlugins.js';
import type { UnifiedInstalledItem, McpServerStatus } from './unifiedTypes.js';
import {
  collectPluginMcpServerStatuses,
  subscribeToPluginMcpChanges,
} from './pluginMcpStatuses.js';
import { getPluginBrowserCwd } from './pluginBrowserCwd.js';
import type { Config } from '@qwen-code/core';

function buildUnifiedList(
  runtimePlugins: LoadedPlugin[],
  pluginErrors: PluginError[],
  enabledPlugins: Readonly<Record<string, boolean>> | undefined,
  blockedMarketplaces: readonly string[],
  cwd: string,
  config?: Config | null,
  mcpServerStatuses?: ReadonlyMap<string, McpServerStatus>,
): UnifiedInstalledItem[] {
  let installedState: ReturnType<typeof loadInstalledPluginsFromDisk> = {
    version: 2,
    plugins: {},
  };
  try {
    installedState = loadInstalledPluginsFromDisk();
  } catch {
    // Runtime-only plugins can still be rendered if installed state is bad.
  }

  return createCorePluginManager(undefined, {
    mergedSettings: {
      enabledPlugins: enabledPlugins ? { ...enabledPlugins } : undefined,
      blockedMarketplaces: [...blockedMarketplaces],
    },
    cwd,
    factory: config?.getPluginManagerFactory?.(),
  }).buildRuntimeItems({
    runtimePlugins,
    pluginErrors,
    enabledPlugins,
    blockedMarketplaces,
    installedState,
    cwd,
    mcpServerStatuses,
  });
}

export function useInstalledPluginItems({
  config,
  settings,
  refreshKey,
}: Pick<
  ManagePluginsProps,
  'config' | 'settings' | 'refreshKey'
>): UnifiedInstalledItem[] {
  const mountedRef = useRef(true);
  const cwd = getPluginBrowserCwd(config);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // All loaded plugins
  const allPlugins = useMemo(
    () => config?.getPlugins?.() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, refreshKey],
  );

  // Plugin errors from Config (populated during load/reload)
  const pluginErrors = useMemo<PluginError[]>(
    () => config?.getPluginErrors?.() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, refreshKey],
  );

  const mcpServerNames = useMemo(
    () => allPlugins.flatMap((plugin) => Object.keys(plugin.mcpServers ?? {})),
    [allPlugins],
  );

  // MCP connections settle (and can reconnect) while this dialog is open;
  // re-read them on manager updates instead of showing the mount-time snapshot.
  const [mcpStatusNonce, setMcpStatusNonce] = useState(0);
  const mcpStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const schedule = () => {
      if (mcpStatusTimerRef.current !== null) {
        clearTimeout(mcpStatusTimerRef.current);
      }
      mcpStatusTimerRef.current = setTimeout(() => {
        mcpStatusTimerRef.current = null;
        if (mountedRef.current) {
          setMcpStatusNonce((nonce) => nonce + 1);
        }
      }, 300);
    };
    const unsubscribe = subscribeToPluginMcpChanges(schedule);
    return () => {
      unsubscribe();
      if (mcpStatusTimerRef.current !== null) {
        clearTimeout(mcpStatusTimerRef.current);
        mcpStatusTimerRef.current = null;
      }
    };
  }, []);

  const [mcpServerStatuses, setMcpServerStatuses] = useState<
    ReadonlyMap<string, McpServerStatus>
  >(() => new Map());
  useEffect(() => {
    setMcpServerStatuses(
      collectPluginMcpServerStatuses(config, mcpServerNames),
    );
  }, [config, mcpServerNames, mcpStatusNonce]);

  return useMemo(
    () =>
      buildUnifiedList(
        allPlugins,
        pluginErrors,
        settings.merged.enabledPlugins,
        settings.merged.blockedMarketplaces,
        cwd,
        config,
        mcpServerStatuses,
      ),
    [
      allPlugins,
      pluginErrors,
      settings.merged.enabledPlugins,
      settings.merged.blockedMarketplaces,
      cwd,
      config,
      mcpServerStatuses,
    ],
  );
}
